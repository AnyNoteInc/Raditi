import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { createCaller, createContext } from '@repo/trpc'
import { z } from 'zod'

import { env } from '@/env'

import type { SpeechConfig, SpeechDependencies } from './speech'

/** SpeechKit's synchronous recognition (docs/plan/75-chat-input-output.md, ВВ17). */
const SPEECHKIT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'

const speechEnv = z.object({
  YANDEX_SPEECHKIT_API_KEY: z
    .string()
    .regex(/^\S{20,200}$/)
    .optional(),
  YANDEX_SPEECHKIT_FOLDER_ID: z
    .string()
    .regex(/^[a-z0-9]{10,40}$/)
    .optional(),
  YANDEX_SPEECHKIT_URL: z.url({ protocol: /^https?$/ }).optional(),
})

let read: SpeechConfig | null | undefined

/**
 * The settings of SpeechKit: its key — a secret, rendered from OpenBao into web's app.env — and
 * the folder of the account; the address of a fake only outside production. Absent or broken —
 * null: the field has no microphone, the route answers 503.
 */
export function speechConfig(): SpeechConfig | null {
  if (read !== undefined) return read
  const value = (name: string) => process.env[name]?.trim() || undefined
  const parsed = speechEnv.safeParse({
    YANDEX_SPEECHKIT_API_KEY: value('YANDEX_SPEECHKIT_API_KEY'),
    YANDEX_SPEECHKIT_FOLDER_ID: value('YANDEX_SPEECHKIT_FOLDER_ID'),
    YANDEX_SPEECHKIT_URL: value('YANDEX_SPEECHKIT_URL'),
  })
  const production = env.web().appEnv === 'production'
  read =
    parsed.success &&
    parsed.data.YANDEX_SPEECHKIT_API_KEY &&
    parsed.data.YANDEX_SPEECHKIT_FOLDER_ID &&
    !(production && parsed.data.YANDEX_SPEECHKIT_URL)
      ? {
          apiKey: parsed.data.YANDEX_SPEECHKIT_API_KEY,
          folderId: parsed.data.YANDEX_SPEECHKIT_FOLDER_ID,
          url: parsed.data.YANDEX_SPEECHKIT_URL ?? SPEECHKIT_URL,
        }
      : null
  return read
}

/** Whether the field of a chat offers dictation here: for the pages, without the key. */
export const speechAvailable = (): boolean => speechConfig() !== null

const log = throttledLogger((line) => console.error(`[speech] ${line}`))

export const speechDependencies: SpeechDependencies = {
  appOrigin: () => env.web().appUrl,
  config: speechConfig,
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  countLastHour: (userId) =>
    prisma.speechCall.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
    }),
  record: async (input) => {
    await prisma.speechCall.create({ data: input })
  },
  onFailure: (reason) => log(reason, undefined),
}
