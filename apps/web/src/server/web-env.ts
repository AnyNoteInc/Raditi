import { appEnvSchema, isProduction, type AppEnv } from '@repo/domain'
import { z } from 'zod'

/** METRICS_TOKEN from .env.example: fine locally, refused in production. */
export const DEV_METRICS_TOKEN = 'raditi-dev-metrics'

/** Production METRICS_TOKEN: long enough that guessing it is hopeless (openssl rand -hex 32). */
export const MIN_METRICS_TOKEN_LENGTH = 32

export interface WebEnv {
  appEnv: AppEnv
  /** Public origin of the app, no trailing slash. */
  appUrl: string
  metricsToken: string
  /** undefined: Redis is not configured (the health check reports it). */
  redisUrl: string | undefined
}

type Env = Record<string, string | undefined>

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const webEnvSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
    APP_ENV: z.preprocess(blankToUndefined, appEnvSchema),
    APP_URL: z.preprocess(
      blankToUndefined,
      z
        .url({ protocol: /^https?$/, error: 'APP_URL must be an http(s) URL' })
        .transform((url) => url.replace(/\/+$/, '')),
    ),
    METRICS_TOKEN: z.preprocess(blankToUndefined, z.string().optional()),
    REDIS_URL: z.preprocess(
      blankToUndefined,
      z.url({ protocol: /^rediss?$/, error: 'REDIS_URL must be a redis:// URL' }).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (!isProduction(env.APP_ENV)) return
    if (env.METRICS_TOKEN === undefined || env.METRICS_TOKEN === DEV_METRICS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_TOKEN'],
        message: 'set a unique token in production (the dev placeholder is refused)',
      })
    } else if (env.METRICS_TOKEN.length < MIN_METRICS_TOKEN_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_TOKEN'],
        message: `must be at least ${MIN_METRICS_TOKEN_LENGTH} characters in production`,
      })
    }
    if (!env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must use https in production' })
    }
  })

/** The app's own variables; the error names variables, never their values. */
export function webEnvFromEnv(env: Env): WebEnv {
  const parsed = webEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`[web] invalid configuration: ${problems.join('; ')}`)
  }
  const e = parsed.data
  return {
    appEnv: e.APP_ENV,
    appUrl: e.APP_URL,
    metricsToken: e.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
    redisUrl: e.REDIS_URL,
  }
}
