import { appEnvSchema, isProduction, type AppEnv } from '@repo/domain'
import { z } from 'zod'

export interface SmartCaptchaKeys {
  /** `ysc2_…`, server only. */
  serverKey: string
  /** `ysc1_…`, public: the web layout passes it to the widget as a prop. */
  clientKey: string
}

export interface AuthConfig {
  appEnv: AppEnv
  /** Public origin of the web app (APP_URL), no trailing slash. */
  appUrl: string
  /** Origin better-auth builds its links from (BETTER_AUTH_URL), no trailing slash. */
  baseUrl: string
  secret: string
  /** null: captcha is off (local development, e2e). */
  captcha: SmartCaptchaKeys | null
}

const SERVER_KEY_PREFIX = 'ysc2_'
const CLIENT_KEY_PREFIX = 'ysc1_'
/** Keys of one captcha share the 20 characters after the prefix. */
const pairId = (key: string): string => key.slice(5, 25)

const httpUrl = (name: string) =>
  z
    .url({ protocol: /^https?$/, error: `${name} must be an http(s) URL` })
    .transform((url) => url.replace(/\/+$/, ''))

const optionalKey = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)

const authEnvSchema = z
  .object({
    APP_ENV: appEnvSchema,
    APP_URL: httpUrl('APP_URL'),
    BETTER_AUTH_URL: httpUrl('BETTER_AUTH_URL'),
    BETTER_AUTH_SECRET: z
      .string({ error: 'BETTER_AUTH_SECRET is not set' })
      .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)'),
    SMARTCAPTCHA_SERVER_KEY: optionalKey,
    SMARTCAPTCHA_CLIENT_KEY: optionalKey,
  })
  .superRefine((env, ctx) => {
    const server = env.SMARTCAPTCHA_SERVER_KEY
    const client = env.SMARTCAPTCHA_CLIENT_KEY
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })

    if (isProduction(env.APP_ENV)) {
      if (!server || !client) {
        issue(
          'SMARTCAPTCHA_SERVER_KEY and SMARTCAPTCHA_CLIENT_KEY are required when APP_ENV=production',
        )
      }
      for (const [name, url] of [
        ['APP_URL', env.APP_URL],
        ['BETTER_AUTH_URL', env.BETTER_AUTH_URL],
      ] as const) {
        if (!url.startsWith('https://')) issue(`${name} must use https when APP_ENV=production`)
      }
    }
    // Only one key would reject every sign-in with "captcha required", or show a widget
    // whose token nobody checks.
    if (Boolean(server) !== Boolean(client)) {
      issue('Set both SMARTCAPTCHA_SERVER_KEY and SMARTCAPTCHA_CLIENT_KEY or neither')
      return
    }
    if (!server || !client) return
    if (!server.startsWith(SERVER_KEY_PREFIX)) {
      issue(`SMARTCAPTCHA_SERVER_KEY must start with ${SERVER_KEY_PREFIX}`)
    }
    if (!client.startsWith(CLIENT_KEY_PREFIX)) {
      issue(`SMARTCAPTCHA_CLIENT_KEY must start with ${CLIENT_KEY_PREFIX}`)
    }
    if (pairId(server) !== pairId(client)) {
      issue('SMARTCAPTCHA_SERVER_KEY and SMARTCAPTCHA_CLIENT_KEY belong to different captchas')
    }
  })

/** Auth settings from the environment; throws with every problem listed. */
export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const parsed = authEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`[@repo/auth] ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  const e = parsed.data
  return {
    appEnv: e.APP_ENV,
    appUrl: e.APP_URL,
    baseUrl: e.BETTER_AUTH_URL,
    secret: e.BETTER_AUTH_SECRET,
    captcha:
      e.SMARTCAPTCHA_SERVER_KEY && e.SMARTCAPTCHA_CLIENT_KEY
        ? { serverKey: e.SMARTCAPTCHA_SERVER_KEY, clientKey: e.SMARTCAPTCHA_CLIENT_KEY }
        : null,
  }
}
