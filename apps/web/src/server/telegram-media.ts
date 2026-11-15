import 'server-only'

import { markAttachmentReady, prisma } from '@repo/db'
import { isDomainError } from '@repo/domain'
import { attachmentRefusalText } from '@repo/domain/attachments/labels'
import {
  attachmentLimits,
  attachmentTypeByName,
  sniffAttachmentType,
} from '@repo/domain/attachments/rules'
import { throttledLogger } from '@repo/observability'
import { createTelegramBotApi, type TelegramBotApi, type TelegramConfig } from '@repo/telegram'
import { startAttachmentForTelegram, toTRPCError, type TelegramMedia } from '@repo/trpc'
import { z } from 'zod'

import { chatServices } from './chat-services'
import { oggOpusSeconds, splitOggOpus } from './ogg-opus'
import { SPEECH_HOURLY_LIMIT } from './speech'
import { speechConfig } from './speech-runtime'

// The files and the voice of a message in Telegram (docs/plan/80-telegram.md, 80.4). Web takes the
// file from Telegram through the same proxy as core, checks it by the rules of an attachment of the
// cabinet and stores it in raditi-inbox; a voice goes to SpeechKit — servers in Russia (rule 1) —
// in pieces of 28 seconds, and is never stored. Nothing of a file or a voice is logged.

/** The longest voice the bot recognises: 11 pieces. */
export const TELEGRAM_VOICE_MAX_SECONDS = 300

export const telegramMediaText = Object.freeze({
  tooLarge: 'Файл больше 20 МБ — Telegram не отдаёт такие боту. Пришлите его в чат кабинета.',
  failed: 'Не удалось получить файл из Telegram. Пришлите его ещё раз немного позже.',
  voiceOff: 'Голосовые сейчас не распознаю. Напишите текстом.',
  voiceLong: `Голосовое длиннее ${TELEGRAM_VOICE_MAX_SECONDS / 60} минут. Запишите короче или напишите текстом.`,
  voiceLimit: 'Вы много диктовали за последний час. Попробуйте немного позже или напишите текстом.',
  voiceFailed: 'Не удалось распознать голосовое. Попробуйте ещё раз или напишите текстом.',
  voiceEmpty: 'Не разобрал слов в голосовом. Попробуйте ещё раз или напишите текстом.',
})

const log = throttledLogger((line) => console.error(`[telegram] ${line}`))
const recognition = z.object({ result: z.string().max(5000) })

let bot: { config: TelegramConfig; api: TelegramBotApi } | undefined

function botOf(config: TelegramConfig): TelegramBotApi {
  if (bot?.config === config) return bot.api
  const api = createTelegramBotApi({ token: config.botToken, proxyUrl: config.proxyUrl })
  bot = { config, api }
  return api
}

async function download(
  api: TelegramBotApi,
  fileId: string,
  maxBytes: number,
): Promise<Uint8Array | { refused: string }> {
  const file = await api.downloadFile(fileId, maxBytes)
  if (file.ok) return file.result.bytes
  log(`download failed: ${file.errorCode ?? '?'} ${file.description}`, undefined)
  return {
    refused:
      file.description === 'File is too large'
        ? telegramMediaText.tooLarge
        : telegramMediaText.failed,
  }
}

export function telegramMedia(config: TelegramConfig): TelegramMedia {
  const api = botOf(config)
  return {
    async attach(input) {
      const type = attachmentTypeByName(input.name)
      if (type === null) return { refused: attachmentRefusalText.type_not_allowed }
      if (input.size !== null && input.size > attachmentLimits.fileBytes)
        return { refused: telegramMediaText.tooLarge }
      const bytes = await download(api, input.fileId, attachmentLimits.fileBytes)
      if (!(bytes instanceof Uint8Array)) return bytes
      const sniff = sniffAttachmentType(bytes.subarray(0, attachmentLimits.sniffBytes), type.mime)
      if (!sniff.ok) return { refused: attachmentRefusalText[sniff.reason] }
      const chat = chatServices()
      if (chat === null) return { refused: telegramMediaText.failed }
      let started: { attachmentId: string; key: string }
      try {
        started = await startAttachmentForTelegram(prisma, {
          userId: input.userId,
          appEnv: chat.appEnv,
          name: input.name,
          size: bytes.byteLength,
          type: type.mime,
        })
      } catch (error) {
        // The refusals of `attachment.start` (the type, too many files waiting) in its words.
        if (isDomainError(error) && error.httpStatus < 500)
          return { refused: toTRPCError(error).message }
        throw error
      }
      const storage = chat.storage()
      await storage.put('inbox', started.key, bytes, {
        contentType: type.mime,
        sizeBytes: bytes.byteLength,
      })
      const stat = await storage.stat('inbox', started.key)
      if (stat === null || stat.sizeBytes !== bytes.byteLength) {
        await storage.delete('inbox', started.key).catch(() => undefined)
        return { refused: telegramMediaText.failed }
      }
      const ready = await markAttachmentReady(prisma, {
        id: started.attachmentId,
        sizeBytes: bytes.byteLength,
        contentType: type.mime,
      })
      if (!ready) return { refused: telegramMediaText.failed }
      return { attachmentId: started.attachmentId }
    },

    async transcribe(input) {
      const speech = speechConfig()
      if (speech === null) return { refused: telegramMediaText.voiceOff }
      if (input.seconds > TELEGRAM_VOICE_MAX_SECONDS)
        return { refused: telegramMediaText.voiceLong }
      const sound = await download(api, input.fileId, attachmentLimits.fileBytes)
      if (!(sound instanceof Uint8Array)) return sound
      const seconds = oggOpusSeconds(sound)
      if (seconds === null) return { refused: telegramMediaText.voiceFailed }
      if (seconds > TELEGRAM_VOICE_MAX_SECONDS) return { refused: telegramMediaText.voiceLong }
      const pieces = splitOggOpus(sound)
      if (pieces === null) return { refused: telegramMediaText.voiceFailed }
      const used = await prisma.speechCall.count({
        where: { userId: input.userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
      })
      if (used + pieces.length > SPEECH_HOURLY_LIMIT)
        return { refused: telegramMediaText.voiceLimit }

      const words: string[] = []
      for (const [index, piece] of pieces.entries()) {
        const pieceSeconds = Math.min(
          30,
          Math.ceil(index === pieces.length - 1 ? seconds - index * 28 : 28),
        )
        const url = new URL(speech.url)
        url.searchParams.set('lang', 'ru-RU')
        url.searchParams.set('format', 'oggopus')
        url.searchParams.set('folderId', speech.folderId)
        let text = ''
        let outcome: 'recognized' | 'empty' | 'failed' = 'failed'
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Api-Key ${speech.apiKey}` },
            body: new Uint8Array(piece),
            signal: AbortSignal.timeout(20_000),
          })
          if (response.ok) {
            const parsed = recognition.safeParse(await response.json().catch(() => null))
            text = parsed.success ? parsed.data.result.trim() : ''
            outcome = text === '' ? 'empty' : 'recognized'
          } else log(`speech refused status=${response.status}`, undefined)
        } catch (error) {
          log(`speech fetch failed ${error instanceof Error ? error.name : 'unknown'}`, undefined)
        }
        await prisma.speechCall.create({
          data: { userId: input.userId, seconds: Math.max(0, pieceSeconds), outcome },
        })
        if (outcome === 'failed') return { refused: telegramMediaText.voiceFailed }
        if (text !== '') words.push(text)
      }
      if (words.length === 0) return { refused: telegramMediaText.voiceEmpty }
      return { text: words.join(' ') }
    },
  }
}
