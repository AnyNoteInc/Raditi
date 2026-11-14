import {
  appEnvSchema,
  BROWSER_STREAM_PATH,
  envVar,
  isProduction,
  pagesAddressFromEnv,
  pagesOriginOf,
  parseEnv,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  type AppEnv,
  type Env,
  type PagesAddress,
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
  /**
   * Where published pages answer (docs/plan/69-pages.md, Ст3): the cabinet names their address.
   * null — PAGES_BASE_DOMAIN is unset: no pages here. The same variables as mcp and preview read.
   */
  pages: PagesAddress | null
  /**
   * The root of the domain of pages, where the frame of the cabinet opens a page of a chat
   * (docs/plan/67-agent-documents.md, Д3): its origin, from PAGES_BASE_DOMAIN (`pagesOriginOf`),
   * and the secret its tokens are signed with (PAGES_SIGNING_SECRET; outside production an empty
   * one is a value for development). null — no pages here, or in production no secret: pages of a
   * chat are downloaded only.
   */
  pageViews: { origin: string; secret: string } | null
}

/** The secret of the pages outside production when none is set: never a secret of a server. */
export const DEV_PAGES_SECRET = 'raditi-development-pages-secret-not-for-production'

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
    PAGES_SIGNING_SECRET: envVar(z.string().optional()),
    // Read for the check of the preview domain only.
    GITEA_URL: envVar(z.string().optional()),
    PAGES_BASE_DOMAIN: envVar(z.string().optional()),
    PAGES_PUBLIC_PORT: envVar(z.coerce.number().int().min(1).max(65_535).optional()),
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
    pagesProblems(env, ctx)
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
    const pageProblems: string[] = []
    pagesAddressFromEnv(env, isProduction(env.APP_ENV), pageProblems)
    for (const problem of [...problems, ...pageProblems]) {
      const [name, ...message] = problem.split(': ')
      ctx.addIssue({ code: 'custom', path: [name ?? ''], message: message.join(': ') })
    }
  })

/**
 * The root of the domain of pages (`pagesOriginOf`) in production: never the cabinet's own host
 * and never under the previews' domain, and a secret given is at least 32 bytes. A subdomain of
 * the cabinet's domain is allowed — `pages.raditi.ru`, owner's answer of 13.11.2026: the page is an
 * opaque origin by its sandbox, and the cookies of the cabinet are of its own host.
 */
function pagesProblems(
  env: {
    APP_ENV: AppEnv
    APP_URL: string
    PAGES_BASE_DOMAIN?: string | undefined
    PAGES_SIGNING_SECRET?: string | undefined
    PREVIEW_BASE_DOMAIN?: string | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (!isProduction(env.APP_ENV)) return
  const origin = pagesOriginOf({
    APP_ENV: env.APP_ENV,
    APP_URL: env.APP_URL,
    PAGES_BASE_DOMAIN: env.PAGES_BASE_DOMAIN,
  })
  if (origin === null) return
  const domain = (host: string) => getDomain(host, { allowPrivateDomains: true }) ?? host
  const pages = new URL(origin).hostname
  const app = URL.parse(env.APP_URL)
  const preview = env.PREVIEW_BASE_DOMAIN?.trim()
  if (app !== null && app.hostname === pages)
    ctx.addIssue({
      code: 'custom',
      path: ['PAGES_BASE_DOMAIN'],
      message: 'must not be the host of the cabinet',
    })
  if (preview && domain(preview) === domain(pages))
    ctx.addIssue({
      code: 'custom',
      path: ['PAGES_BASE_DOMAIN'],
      message: 'must not share its registrable domain with the previews (a preview runs site code)',
    })
  // An empty secret leaves the pages of chats off (`pageViewsOf`); a short one is a mistake to tell.
  const secret = env.PAGES_SIGNING_SECRET?.trim() ?? ''
  if (secret !== '' && Buffer.byteLength(secret) < 32)
    ctx.addIssue({
      code: 'custom',
      path: ['PAGES_SIGNING_SECRET'],
      message: 'must be at least 32 bytes in production',
    })
}

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
    pages: pagesAddressFromEnv(e, isProduction(e.APP_ENV), []),
    pageViews: pageViewsOf(e),
  }
}

function pageViewsOf(e: {
  APP_ENV: AppEnv
  APP_URL: string
  PAGES_BASE_DOMAIN?: string | undefined
  PAGES_SIGNING_SECRET?: string | undefined
}): WebEnv['pageViews'] {
  const origin = pagesOriginOf({
    APP_ENV: e.APP_ENV,
    APP_URL: e.APP_URL,
    PAGES_BASE_DOMAIN: e.PAGES_BASE_DOMAIN,
  })
  if (origin === null) return null
  const production = isProduction(e.APP_ENV)
  const secret = e.PAGES_SIGNING_SECRET?.trim() || (production ? '' : DEV_PAGES_SECRET)
  // Without its secret the function is off, never open with a known key.
  if (secret === '') return null
  return { origin, secret }
}
