import {
  appEnvSchema,
  envVar,
  isProduction,
  parseEnv,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  type AppEnv,
  type Env,
  type PreviewAddress,
} from '@repo/domain'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { getDomain } from 'tldts'
import { z } from 'zod'

export interface WebEnv {
  appEnv: AppEnv
  /** Public origin of the app, no trailing slash. */
  appUrl: string
  metricsToken: string
  /** undefined: Redis is not configured (the health check reports it). */
  redisUrl: string | undefined
  /**
   * BILLING_PAST_DUE_DAYS: how long an overdue tariff waits for a payment. The scheduler of the
   * core role ends the tariff by it; web only tells the customer the day, so both must be given
   * the same value. 7 unless set, as in core.
   */
  pastDueDays: number
  /**
   * Where previews of dialogs are served (docs/plan/53-chat-preview-release.md, Р17, Р19): web
   * builds the ticket URL of the iframe and of `/preview/open` from it. null — previews are off.
   * The same variables as core and the `preview` role read.
   */
  preview: PreviewAddress | null
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
    METRICS_TOKEN: envVar(
      z
        .string()
        .regex(/^\S+$/, 'must not contain whitespace (it is sent as a Bearer token)')
        .optional(),
    ),
    REDIS_URL: envVar(z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).optional()),
    // The bounds and the default of the core role (apps/orchestrator/src/config/config.ts).
    BILLING_PAST_DUE_DAYS: envVar(z.coerce.number().int().min(1).max(90).default(7)),
    ...previewAddressEnvShape,
    // Read for the check of the preview domain only.
    GITEA_URL: envVar(z.string().optional()),
  })
  .superRefine((env, ctx) => {
    const tokenProblem = metricsTokenProblem(env.METRICS_TOKEN, env.APP_ENV)
    if (tokenProblem)
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: tokenProblem })
    if (isProduction(env.APP_ENV) && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must use https in production' })
    }
    // Production refuses http previews and a base under the domain of the cabinet or Gitea (Р19).
    const problems = previewAddressProblems(
      {
        appEnv: env.APP_ENV,
        address: previewAddressFromEnv(env, env.APP_ENV),
        appUrl: env.APP_URL,
        giteaUrl: env.GITEA_URL,
      },
      (host) => getDomain(host, { allowPrivateDomains: true }),
    )
    for (const problem of problems) {
      const [name, ...message] = problem.split(': ')
      ctx.addIssue({ code: 'custom', path: [name ?? ''], message: message.join(': ') })
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
    pastDueDays: e.BILLING_PAST_DUE_DAYS,
    preview: previewAddressFromEnv(e, e.APP_ENV),
  }
}
