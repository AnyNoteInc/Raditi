import {
  enqueueTelegramProgress,
  enqueueTelegramSend,
  enqueueTelegramTopic,
  type PrismaClient,
} from '@repo/db'
import {
  feedInputText,
  isDomainError,
  looksLikeSecret,
  missingRequiredConsents,
  type TelegramButton,
  type TelegramSendJob,
} from '@repo/domain'
import {
  messageCommand,
  messageWords,
  type TelegramIncoming,
  type TelegramMessage,
  type TelegramPress,
} from '@repo/telegram'

import { toTRPCError } from '../../errors.ts'
import type { ChatContext } from '../chat/context.ts'
import { cancelDialog, continueDialog, createDialog, postDialogMessage } from '../chat/tasks.ts'
import { removeDialog } from '../chat/dialog-manage.ts'
import { queueDialogWords } from '../chat/queue.ts'
import { loadLatestConsents } from '../consents.ts'
import { deterministicUuidV7 } from '../deterministic-uuid.ts'
import { takeTelegramLink, unlinkTelegram } from './link.ts'
import { telegramText } from './texts.ts'

// The words of a client in Telegram (docs/plan/80-telegram.md, 80.2): core reads the updates of the
// bot and hands each here; the chat services take them as they take the words of the cabinet, and
// what the bot answers goes to the outbox for core to send. Every id is derived from the update, so
// an update handed again writes nothing twice: a new chat, a message and an answer are each made
// once, and the update itself is kept (`telegram_updates`) only after it is done.

/** Files of a message, as the web stores them (80.4). */
export interface TelegramMedia {
  /**
   * Stores a photo or a document of the message as an unsent attachment of the user: its id, or
   * the words that tell the client why not.
   */
  attach(input: {
    userId: string
    /** The project of the chat the file goes to; null — a chat without one. */
    siteId: string | null
    fileId: string
    name: string
    contentType: string | null
    size: number | null
  }): Promise<{ attachmentId: string } | { refused: string }>
  /** The words of a voice message, recognised; or the words that tell why not. */
  transcribe(input: {
    userId: string
    fileId: string
    seconds: number
  }): Promise<{ text: string } | { refused: string }>
}

export interface TelegramIntakeDeps {
  db: PrismaClient
  chat: ChatContext
  /** The public origin of the cabinet (APP_URL): the bot links to the chat under it. */
  appUrl: string
  /** null — files and voice are not taken here: the bot asks for words. */
  media: TelegramMedia | null
  now?: () => Date
}

export type IntakeAnswer = 'done' | 'repeated' | 'skipped'

/** At most this many chats `/chats` offers. */
export const TELEGRAM_CHATS_LISTED = 8
/** At most this many projects `/new` offers. */
export const TELEGRAM_PROJECTS_LISTED = 12

/**
 * A UUID of version 7 derived from the update (RFC 9562): the time of the message in the first 48
 * bits, the rest from a hash of the salt. The same update gives the same id, so a chat it starts
 * is recognised as the chat it started.
 */
export function updateUuid(salt: string, at: Date): string {
  return deterministicUuidV7('telegram', salt, at)
}

/** The time part of the ids of presses (they carry no time of their own). */
const PRESS_EPOCH = new Date(Date.UTC(2026, 10, 1))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** What a button of the bot says it does: `stop:<id>`, `go:<id>`, `proj:<id|none>`, `chat:<id>`. */
export type TelegramPressAction =
  { kind: 'stop' | 'go' | 'chat'; taskId: string } | { kind: 'project'; siteId: string | null }

export function readPressData(data: string | undefined): TelegramPressAction | null {
  const match = /^(stop|go|chat|proj):(.+)$/u.exec(data ?? '')
  if (!match) return null
  const [, kind, value] = match
  if (kind === 'proj') {
    if (value === 'none') return { kind: 'project', siteId: null }
    return UUID.test(value!) ? { kind: 'project', siteId: value! } : null
  }
  return UUID.test(value!) ? { kind: kind as 'stop' | 'go' | 'chat', taskId: value! } : null
}

export const pressData = {
  stop: (taskId: string) => `stop:${taskId}`,
  go: (taskId: string) => `go:${taskId}`,
  chat: (taskId: string) => `chat:${taskId}`,
  project: (siteId: string | null) => `proj:${siteId ?? 'none'}`,
}

interface Where {
  chatId: string
  threadId: number | undefined
}

/** Handles one update; throws only on a failure worth trying again (the database is away). */
export async function handleTelegramUpdate(
  deps: TelegramIntakeDeps,
  update: TelegramIncoming,
): Promise<IntakeAnswer> {
  const { db } = deps
  const seen = await db.telegramUpdate.findUnique({
    where: { updateId: BigInt(update.updateId) },
    select: { updateId: true },
  })
  if (seen) return 'repeated'
  const intake = new Intake(deps, update.updateId)
  if (update.kind === 'message') await intake.message(update.message)
  else if (update.kind === 'press') await intake.press(update.press)
  await db.telegramUpdate.createMany({
    data: [{ updateId: BigInt(update.updateId) }],
    skipDuplicates: true,
  })
  return update.kind === 'other' ? 'skipped' : 'done'
}

class Intake {
  readonly #deps: TelegramIntakeDeps
  readonly #updateId: number
  #replies = 0

  constructor(deps: TelegramIntakeDeps, updateId: number) {
    this.#deps = deps
    this.#updateId = updateId
  }

  get #now(): Date {
    return this.#deps.now?.() ?? new Date()
  }

  #chatLink(taskId: string): string {
    return `${this.#deps.appUrl.replace(/\/+$/, '')}/chats/${taskId}`
  }

  async #reply(
    where: Where,
    text: string,
    extra: { buttons?: TelegramButton[][]; pressId?: string; taskId?: string } = {},
  ): Promise<void> {
    const job: TelegramSendJob = { chatId: where.chatId, text: text.slice(0, 4096) }
    if (where.threadId !== undefined) job.threadId = where.threadId
    if (extra.taskId !== undefined) job.taskId = extra.taskId
    if (extra.buttons !== undefined && extra.buttons.length > 0) job.buttons = extra.buttons
    if (extra.pressId !== undefined) job.pressId = extra.pressId
    this.#replies += 1
    await enqueueTelegramSend(this.#deps.db, job, `u:${this.#updateId}:${this.#replies}`)
  }

  async #userOf(externalId: string) {
    return this.#deps.db.channelIdentity.findUnique({
      where: { channel_externalId: { channel: 'telegram', externalId } },
      select: { id: true, userId: true, currentTaskId: true, newChat: true, newChatSiteId: true },
    })
  }

  /** null — the user may write; else the words that say why not. */
  async #refusalOf(userId: string): Promise<string | null> {
    const latest = await loadLatestConsents(this.#deps.db, userId)
    return missingRequiredConsents(latest).length > 0
      ? telegramText.consents(this.#deps.appUrl)
      : null
  }

  async message(message: TelegramMessage): Promise<void> {
    const where: Where = { chatId: String(message.chat.id), threadId: message.message_thread_id }
    const externalId = String(message.from!.id)
    const username = message.from!.username ?? null
    const command = messageCommand(message)

    if (command?.name === 'start' && command.arg !== '') {
      const answer = await takeTelegramLink(this.#deps.db, {
        code: command.arg,
        externalId,
        username,
        now: this.#now,
      })
      await this.#reply(
        where,
        answer.linked
          ? telegramText.linked(this.#deps.appUrl)
          : answer.reason === 'taken'
            ? telegramText.linkTaken
            : telegramText.linkCodeBad(this.#deps.appUrl),
      )
      return
    }

    const identity = await this.#userOf(externalId)
    if (!identity) {
      await this.#reply(where, telegramText.notLinked(this.#deps.appUrl))
      return
    }
    if (command?.name === 'stop') {
      await unlinkTelegram(this.#deps.db, { externalId })
      await this.#reply(where, telegramText.unlinked)
      return
    }
    if (command?.name === 'start' || command?.name === 'help') {
      await this.#reply(where, telegramText.help(this.#deps.appUrl))
      return
    }
    const refusal = await this.#refusalOf(identity.userId)
    if (refusal !== null) {
      await this.#reply(where, refusal)
      return
    }
    if (command?.name === 'new') {
      await this.#newChat(where, identity.userId, identity.id)
      return
    }
    if (command?.name === 'delete') {
      await this.#delete(where, identity)
      return
    }
    if (command?.name === 'chats') {
      await this.#chats(where, identity.userId)
      return
    }

    // An update handed again after a failure finds the chat it started: the same way again, which
    // createDialog repeats safely — never the words a second time into that chat.
    const started = await this.#deps.db.task.findUnique({
      where: { id: updateUuid(`task:${this.#updateId}`, new Date(message.date * 1000)) },
      select: { siteId: true },
    })
    const target = started ? { siteId: started.siteId } : await this.#targetOf(where, identity)
    const siteId =
      'siteId' in target
        ? target.siteId
        : ((
            await this.#deps.db.task.findUnique({
              where: { id: target.taskId },
              select: { siteId: true },
            })
          )?.siteId ?? null)
    const words = await this.#wordsOf(message, identity.userId, siteId, where)
    if (words === null) return
    await this.#post(where, identity, words, message, target)
  }

  /** The words and the files of a message; null — the bot already said why it takes nothing. */
  async #wordsOf(
    message: TelegramMessage,
    userId: string,
    siteId: string | null,
    where: Where,
  ): Promise<{ text: string; attachments: string[] } | null> {
    const media = this.#deps.media
    let text = messageWords(message)
    const attachments: string[] = []
    const files = [
      ...(message.photo?.length
        ? [
            {
              fileId: message.photo.at(-1)!.file_id,
              name: `фото-${message.message_id}.jpg`,
              contentType: 'image/jpeg',
              size: message.photo.at(-1)!.file_size ?? null,
            },
          ]
        : []),
      ...(message.document
        ? [
            {
              fileId: message.document.file_id,
              name: message.document.file_name ?? `файл-${message.message_id}`,
              contentType: message.document.mime_type ?? null,
              size: message.document.file_size ?? null,
            },
          ]
        : []),
    ]
    const voice = message.voice ?? message.audio
    if ((files.length > 0 || voice) && media === null) {
      await this.#reply(where, telegramText.wordsOnly)
      return null
    }
    if (voice && media) {
      const heard = await media.transcribe({
        userId,
        fileId: voice.file_id,
        seconds: voice.duration ?? 0,
      })
      if ('refused' in heard) {
        await this.#reply(where, heard.refused)
        return null
      }
      // A password said aloud is refused as typed words are, and never repeated back (rule 2).
      if (looksLikeSecret(heard.text)) {
        await this.#reply(where, feedInputText.secret)
        return null
      }
      text = text === '' ? heard.text : `${text}\n\n${heard.text}`
      await this.#reply(where, telegramText.heard(heard.text))
    }
    for (const file of files) {
      const stored = await media!.attach({ userId, siteId, ...file })
      if ('refused' in stored) {
        await this.#reply(where, stored.refused)
        return null
      }
      attachments.push(stored.attachmentId)
    }
    if (text === '' && attachments.length === 0) {
      await this.#reply(where, telegramText.empty)
      return null
    }
    return { text: text === '' ? telegramText.filesOnly : text, attachments }
  }

  /** The chat the words go to: its topic, `/new`, the current chat, or a new one. */
  async #targetOf(
    where: Where,
    identity: { userId: string; currentTaskId: string | null; newChat: boolean },
  ): Promise<{ taskId: string } | { siteId: string | null }> {
    const { db } = this.#deps
    if (where.threadId !== undefined) {
      const session = await db.chatSession.findFirst({
        where: {
          channel: 'telegram',
          externalChatId: where.chatId,
          telegramTopicId: where.threadId,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          tasks: {
            where: { deletedAt: null, createdById: identity.userId },
            select: { id: true },
            take: 1,
          },
        },
      })
      const task = session?.tasks[0]
      // A topic the client opened in Telegram is a new chat without a project.
      return task ? { taskId: task.id } : { siteId: null }
    }
    if (identity.newChat) {
      const pending = await db.channelIdentity.findUnique({
        where: { userId_channel: { userId: identity.userId, channel: 'telegram' } },
        select: { newChatSiteId: true },
      })
      return { siteId: pending?.newChatSiteId ?? null }
    }
    if (identity.currentTaskId !== null) {
      const task = await db.task.findFirst({
        where: { id: identity.currentTaskId, deletedAt: null, createdById: identity.userId },
        select: { id: true },
      })
      if (task) return { taskId: task.id }
    }
    return { siteId: null }
  }

  async #post(
    where: Where,
    identity: { id: string; userId: string; currentTaskId: string | null; newChat: boolean },
    words: { text: string; attachments: string[] },
    message: TelegramMessage,
    target: { taskId: string } | { siteId: string | null },
  ): Promise<void> {
    const { db, chat } = this.#deps
    const now = this.#now
    const at = new Date(message.date * 1000)
    const attachments = words.attachments.length > 0 ? { attachments: words.attachments } : {}
    try {
      if ('siteId' in target) {
        const taskId = updateUuid(`task:${this.#updateId}`, at)
        await createDialog(db, chat, {
          userId: identity.userId,
          siteId: target.siteId,
          taskId,
          text: words.text,
          ...attachments,
          now,
        })
        await this.#bind(taskId, where)
        await db.channelIdentity.update({
          where: { id: identity.id },
          data: { currentTaskId: taskId, newChat: false, newChatSiteId: null },
        })
        if (where.threadId === undefined) await enqueueTelegramTopic(db, { taskId })
        // No «Принято»: the message of the work of the agent says it (owner, 15.11.2026).
        await enqueueTelegramProgress(db, taskId, `u:${this.#updateId}`)
        return
      }
      const requestId = updateUuid(`request:${this.#updateId}`, at)
      const taskId = target.taskId
      try {
        await postDialogMessage(db, {
          userId: identity.userId,
          taskId,
          requestId,
          text: words.text,
          ...attachments,
          now,
        })
        await this.#bind(taskId, where)
        await enqueueTelegramProgress(db, taskId, `u:${this.#updateId}`)
        return
      } catch (error) {
        if (!isDomainError(error) || error.code !== 'TASK_BUSY') throw error
        // The agent works: the words wait in the queue of the chat (docs/plan/75, ВВ1).
        await queueDialogWords(db, {
          userId: identity.userId,
          taskId,
          requestId,
          text: words.text,
          ...attachments,
        })
        await this.#bind(taskId, where)
        await this.#reply(where, telegramText.queued, { taskId })
      }
    } catch (error) {
      if (!isDomainError(error)) throw error
      await this.#reply(where, toTRPCError(error).message)
    }
  }

  /**
   * Binds the chat to this Telegram chat (and topic): what the agent says goes here (Т7). A chat
   * of the cabinet chosen in `/chats` is bound too, a topic stays its own.
   */
  async #bind(taskId: string, where: Where): Promise<void> {
    const { db } = this.#deps
    const task = await db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: {
        workspaceId: true,
        siteId: true,
        chatSession: {
          select: { id: true, channel: true, externalChatId: true, telegramTopicId: true },
        },
      },
    })
    const session = task.chatSession
    if (session?.channel === 'telegram') {
      if (
        session.externalChatId === where.chatId &&
        (where.threadId === undefined || session.telegramTopicId === where.threadId)
      )
        return
      await db.chatSession.update({
        where: { id: session.id },
        data: {
          externalChatId: where.chatId,
          ...(where.threadId === undefined ? {} : { telegramTopicId: where.threadId }),
        },
      })
      return
    }
    const created = await db.chatSession.create({
      data: {
        workspaceId: task.workspaceId,
        siteId: task.siteId,
        channel: 'telegram',
        externalChatId: where.chatId,
        telegramTopicId: where.threadId ?? null,
      },
      select: { id: true },
    })
    await db.task.update({ where: { id: taskId }, data: { chatSessionId: created.id } })
  }

  async #newChat(where: Where, userId: string, identityId: string): Promise<void> {
    const { db } = this.#deps
    await db.channelIdentity.update({
      where: { id: identityId },
      data: { newChat: true, newChatSiteId: null },
    })
    const sites = await db.site.findMany({
      where: { deletedAt: null, workspace: { members: { some: { userId } } } },
      orderBy: { createdAt: 'desc' },
      take: TELEGRAM_PROJECTS_LISTED,
      select: { id: true, name: true },
    })
    const buttons: TelegramButton[][] = [
      [{ text: telegramText.noProject, data: pressData.project(null) }],
      ...sites.map((site) => [{ text: buttonText(site.name), data: pressData.project(site.id) }]),
    ]
    await this.#reply(where, sites.length > 0 ? telegramText.newChatAsk : telegramText.newChat, {
      ...(sites.length > 0 ? { buttons } : {}),
    })
  }

  /**
   * `/delete`: the chat of this topic, or the current chat, is deleted in the cabinet too, as
   * «Удалить» there does it; its topic in Telegram goes with it (owner's request of 15.11.2026).
   */
  async #delete(
    where: Where,
    identity: { userId: string; currentTaskId: string | null; newChat: boolean },
  ) {
    const target = await this.#targetOf(where, { ...identity, newChat: false })
    if (!('taskId' in target)) {
      await this.#reply(where, telegramText.nothingToDelete)
      return
    }
    try {
      await removeDialog(this.#deps.db, {
        userId: identity.userId,
        taskId: target.taskId,
        now: this.#now,
      })
    } catch (error) {
      if (!isDomainError(error)) throw error
      await this.#reply(where, toTRPCError(error).message)
      return
    }
    // A topic disappears with its messages; a chat without one is told.
    if (where.threadId === undefined) await this.#reply(where, telegramText.deleted)
  }

  async #chats(where: Where, userId: string): Promise<void> {
    const tasks = await this.#deps.db.task.findMany({
      where: { createdById: userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: TELEGRAM_CHATS_LISTED,
      select: { id: true, title: true },
    })
    if (tasks.length === 0) {
      await this.#reply(where, telegramText.noChats)
      return
    }
    await this.#reply(where, telegramText.chooseChat, {
      buttons: tasks.map((task) => [
        { text: buttonText(task.title ?? telegramText.untitled), data: pressData.chat(task.id) },
      ]),
    })
  }

  async press(press: TelegramPress): Promise<void> {
    const { db } = this.#deps
    const chatId = String(press.message?.chat.id ?? press.from.id)
    const where: Where = { chatId, threadId: press.message?.message_thread_id }
    const reply = (text: string, extra: { buttons?: TelegramButton[][]; taskId?: string } = {}) =>
      this.#reply(where, text, { ...extra, pressId: press.id })
    const identity = await this.#userOf(String(press.from.id))
    if (!identity) {
      await reply(telegramText.notLinked(this.#deps.appUrl))
      return
    }
    const action = readPressData(press.data)
    if (action === null) {
      await reply(telegramText.pressStale)
      return
    }
    const refusal = await this.#refusalOf(identity.userId)
    if (refusal !== null) {
      await reply(refusal)
      return
    }
    const now = this.#now
    // A press carries no time of its own: the id is the same for every delivery of the update.
    const requestId = updateUuid(`press:${this.#updateId}`, PRESS_EPOCH)
    try {
      switch (action.kind) {
        case 'stop':
          await cancelDialog(db, { taskId: action.taskId, requestId, userId: identity.userId, now })
          await reply(telegramText.stopped, { taskId: action.taskId })
          return
        case 'go':
          await continueDialog(db, {
            taskId: action.taskId,
            requestId,
            userId: identity.userId,
            now,
          })
          await enqueueTelegramProgress(db, action.taskId, `u:${this.#updateId}`, press.id)
          return
        case 'chat': {
          const task = await db.task.findFirst({
            where: { id: action.taskId, deletedAt: null, createdById: identity.userId },
            select: { id: true, title: true },
          })
          if (!task) {
            await reply(telegramText.pressStale)
            return
          }
          await db.channelIdentity.update({
            where: { id: identity.id },
            data: { currentTaskId: task.id, newChat: false, newChatSiteId: null },
          })
          await this.#bind(task.id, where)
          await reply(telegramText.chatChosen(task.title ?? telegramText.untitled), {
            buttons: [[{ text: telegramText.openButton, url: this.#chatLink(task.id) }]],
          })
          return
        }
        case 'project': {
          let name: string | null = null
          if (action.siteId !== null) {
            const site = await db.site.findFirst({
              where: {
                id: action.siteId,
                deletedAt: null,
                workspace: { members: { some: { userId: identity.userId } } },
              },
              select: { name: true },
            })
            if (!site) {
              await reply(telegramText.pressStale)
              return
            }
            name = site.name
          }
          await db.channelIdentity.update({
            where: { id: identity.id },
            data: { newChat: true, newChatSiteId: action.siteId },
          })
          await reply(telegramText.projectChosen(name))
          return
        }
      }
    } catch (error) {
      if (!isDomainError(error)) throw error
      await reply(toTRPCError(error).message)
    }
  }
}

const buttonText = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line === '' ? telegramText.untitled : line)
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('')
}

/**
 * Core found the topic of a chat gone — the client deleted it in Telegram, which tells a bot
 * nothing else: the chat is deleted in the cabinet too (owner's request of 15.11.2026).
 */
export async function handleTelegramTopicGone(
  deps: Pick<TelegramIntakeDeps, 'db' | 'now'>,
  place: { chatId: string; threadId: number },
): Promise<'deleted' | 'skipped'> {
  const { db } = deps
  const identity = await db.channelIdentity.findUnique({
    where: { channel_externalId: { channel: 'telegram', externalId: place.chatId } },
    select: { userId: true },
  })
  if (!identity) return 'skipped'
  const sessions = await db.chatSession.findMany({
    where: { channel: 'telegram', externalChatId: place.chatId, telegramTopicId: place.threadId },
    select: { tasks: { where: { deletedAt: null }, select: { id: true } } },
  })
  const tasks = sessions.flatMap((session) => session.tasks)
  for (const task of tasks) {
    try {
      await removeDialog(db, {
        userId: identity.userId,
        taskId: task.id,
        now: deps.now?.() ?? new Date(),
      })
    } catch (error) {
      // A release in progress keeps the chat; it goes on in the cabinet.
      if (!isDomainError(error)) throw error
    }
  }
  return tasks.length > 0 ? 'deleted' : 'skipped'
}
