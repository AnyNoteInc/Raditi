import {
  appEnvSchema,
  BROWSER_STREAM_PATH,
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
  /**
   * BROWSER_STREAM_PUBLIC_URL (docs/plan/57-browser-tasks.md, Б12): where the cabinet opens the
   * stream of a task's browser — the gateway of the `preview` role, `ws(s)://host[:port]/path`.
   * null — the platform has no browser here: no site offers tasks in it. `wss://` in production.
   */
  browserStreamUrl: string | null
}

// The address of the stream gateway: a WebSocket URL with nothing a browser would send elsewhere —
// no credentials, no query, no fragment — and the one path the gateway opens a stream on.
const browserStreamUrl = z
  .url({ protocol: /^wss?$/, error: 'must be a ws:// or wss:// URL' })
  // Checks after a failed one still run: what is not a URL is refused above.
  .refine((value) => {
    const url = URL.parse(value)
    return (
      url === null ||
      (url.username === '' && url.password === '' && url.search === '' && url.hash === '')
    )
  }, 'must not carry credentials, a query or a fragment')
  .refine((value) => {
    const url = URL.parse(value)
    return url === null || url.pathname === BROWSER_STREAM_PATH
  }, `must have the path ${BROWSER_STREAM_PATH} of the stream gateway`)

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
    // The bounds and the default of the core role (apps/core/src/config/config.ts).
    BILLING_PAST_DUE_DAYS: envVar(z.coerce.number().int().min(1).max(90).default(7)),
    ...previewAddressEnvShape,
    BROWSER_STREAM_PUBLIC_URL: envVar(browserStreamUrl.optional()),
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
    if (
      isProduction(env.APP_ENV) &&
      env.BROWSER_STREAM_PUBLIC_URL !== undefined &&
      !env.BROWSER_STREAM_PUBLIC_URL.startsWith('wss://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BROWSER_STREAM_PUBLIC_URL'],
        message: 'must use wss in production',
      })
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
    browserStreamUrl: e.BROWSER_STREAM_PUBLIC_URL ?? null,
  }
}
