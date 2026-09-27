import { appEnvSchema, envVar, isProduction, parseEnv, type AppEnv, type Env } from '@repo/domain'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { z } from 'zod'

export interface WebEnv {
  appEnv: AppEnv
  /** Public origin of the app, no trailing slash. */
  appUrl: string
  metricsToken: string
  /** undefined: Redis is not configured (the health check reports it). */
  redisUrl: string | undefined
}

const webEnvSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
    APP_ENV: envVar(appEnvSchema),
    APP_URL: envVar(
      z
        .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
        .transform((url) => url.replace(/\/+$/, '')),
    ),
    METRICS_TOKEN: envVar(z.string().optional()),
    REDIS_URL: envVar(z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).optional()),
  })
  .superRefine((env, ctx) => {
    const tokenProblem = metricsTokenProblem(env.METRICS_TOKEN, env.APP_ENV)
    if (tokenProblem)
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: tokenProblem })
    if (isProduction(env.APP_ENV) && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must use https in production' })
    }
  })

/** The app's own variables; the error names variables, never their values. */
export function webEnvFromEnv(env: Env): WebEnv {
  const e = parseEnv('web', webEnvSchema, env)
  return {
    appEnv: e.APP_ENV,
    appUrl: e.APP_URL,
    metricsToken: e.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
    redisUrl: e.REDIS_URL,
  }
}
