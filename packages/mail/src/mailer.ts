import { appEnvSchema, isProduction } from '@repo/domain'
import { z } from 'zod'

import { createSendsayTransport } from './sendsay.ts'
import { renderTemplate } from './templates/index.ts'
import type { MailMessage } from './templates/schemas.ts'
import {
  createLogTransport,
  type MailLogger,
  type MailSender,
  type MailTransport,
} from './transport.ts'

export const DEFAULT_SENDER: MailSender = { email: 'noreply@raditi.ru', name: 'Радити' }

export interface MailerConfig {
  /** Empty: letters are logged instead of sent (local development). */
  sendsayApiKey?: string
  sendsayApiUrl?: string
  from?: Partial<MailSender>
  logger?: MailLogger
  /** Replaces SendSay and the log fallback, e.g. in tests. */
  transport?: MailTransport
}

export interface Mailer {
  /** Renders the template and sends it; throws on invalid data or a delivery failure. */
  sendMail(message: MailMessage): Promise<void>
}

const recipientSchema = z.email()

export function createMailer(config: MailerConfig = {}): Mailer {
  const from: MailSender = {
    email: config.from?.email ?? DEFAULT_SENDER.email,
    name: config.from?.name ?? DEFAULT_SENDER.name,
  }
  const transport =
    config.transport ??
    (config.sendsayApiKey
      ? createSendsayTransport({ apiKey: config.sendsayApiKey, apiUrl: config.sendsayApiUrl })
      : createLogTransport(config.logger))

  return {
    async sendMail(message) {
      const to = recipientSchema.parse(message.to)
      const rendered = renderTemplate(message.kind, message.data)
      await transport.send({ from, to, ...rendered })
    },
  }
}

const mailerEnvSchema = z
  .object({
    APP_ENV: appEnvSchema,
    SENDSAY_API_KEY: z
      .string()
      .optional()
      .transform((key) => key?.trim() || undefined),
  })
  .superRefine((env, ctx) => {
    // Otherwise verification links would silently go to the logs instead of the users.
    if (isProduction(env.APP_ENV) && !env.SENDSAY_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SENDSAY_API_KEY'],
        message: 'SENDSAY_API_KEY is required when APP_ENV=production',
      })
    }
  })

/** Mailer settings from the environment; names the variables, never their values. */
export function mailerConfigFromEnv(env: Record<string, string | undefined>): MailerConfig {
  const parsed = mailerEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`[@repo/mail] ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  return { sendsayApiKey: parsed.data.SENDSAY_API_KEY }
}
