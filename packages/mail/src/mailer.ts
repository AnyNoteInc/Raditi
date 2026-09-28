import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
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

const SENDER: MailSender = { email: 'noreply@raditi.ru', name: 'Радити' }

export interface MailerConfig {
  /** Empty: letters are logged instead of sent (local development). */
  sendsayApiKey?: string
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
  const transport =
    config.transport ??
    (config.sendsayApiKey
      ? createSendsayTransport({ apiKey: config.sendsayApiKey })
      : createLogTransport(config.logger))

  return {
    async sendMail(message) {
      const to = recipientSchema.parse(message.to)
      const rendered = renderTemplate(message.kind, message.data)
      await transport.send({ from: SENDER, to, ...rendered })
    },
  }
}

const mailerEnvSchema = z
  .object({
    APP_ENV: envVar(appEnvSchema),
    SENDSAY_API_KEY: envVar(z.string().trim().optional()),
  })
  .superRefine((env, ctx) => {
    // Otherwise verification links would silently go to the logs instead of the users.
    if (isProduction(env.APP_ENV) && !env.SENDSAY_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SENDSAY_API_KEY'],
        message: 'is required when APP_ENV=production',
      })
    }
  })

/** Mailer settings from the environment; names the variables, never their values. */
export function mailerConfigFromEnv(env: Env): MailerConfig {
  return { sendsayApiKey: parseEnv('mail', mailerEnvSchema, env).SENDSAY_API_KEY }
}
