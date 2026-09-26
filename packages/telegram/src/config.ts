import { z } from 'zod'

import { TELEGRAM_LIMITS } from './limits.ts'

export interface TelegramConfig {
  /** Credential: never log this object. */
  botToken: string
  webhookSecret: string
  proxyUrl: string | undefined
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.preprocess(
      blankToUndefined,
      z
        .string()
        .regex(/^\d+:[A-Za-z0-9_-]+$/, 'must look like 123456:ABC-DEF')
        .optional(),
    ),
    TELEGRAM_WEBHOOK_SECRET: z.preprocess(
      blankToUndefined,
      z
        .string()
        .regex(
          new RegExp(`^[A-Za-z0-9_-]{32,${TELEGRAM_LIMITS.webhookSecretMax}}$`),
          'must be 32–256 characters of A-Z, a-z, 0-9, _ and -',
        )
        .optional(),
    ),
    TELEGRAM_PROXY_URL: z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  })
  .superRefine((env, ctx) => {
    if (env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'is required when the bot is on',
      })
    }
  })

/**
 * Reads the bot settings. null when TELEGRAM_BOT_TOKEN is empty: the bot is off.
 * The error names variables and reasons only, never values (the proxy URL may hold a password).
 */
export function telegramConfigFromEnv(
  env: Record<string, string | undefined>,
): TelegramConfig | null {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`[@repo/telegram] invalid Telegram configuration: ${problems.join('; ')}`)
  }
  const e = parsed.data
  if (e.TELEGRAM_BOT_TOKEN === undefined || e.TELEGRAM_WEBHOOK_SECRET === undefined) return null
  return {
    botToken: e.TELEGRAM_BOT_TOKEN,
    webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
    proxyUrl: e.TELEGRAM_PROXY_URL,
  }
}
