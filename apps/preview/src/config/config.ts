import {
  appEnvSchema,
  pagesBaseDomainSchema,
  browserWorkerTokenSchema,
  envProblems,
  envVar,
  isProduction,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  previewDefaults,
  previewSessionSecretProblem,
  type Env,
} from '@repo/domain'
import { browserWorkerOrigin } from '@repo/browser-link'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import { ipLiteral, isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'
import { ConfigError } from '@repo/app-bootstrap'
import { getDomain } from 'tldts'
import { z } from 'zod'

import { parsePreviewRelays } from './browser-relays.ts'
import type {
  BrowserStreamConfig,
  PagesListenerConfig,
  PreviewGatewayConfig,
} from './config.tokens.ts'

export { ConfigError }
export type { BrowserStreamConfig, PagesListenerConfig, PreviewGatewayConfig }

export const DEFAULT_PREVIEW_GATEWAY_PORT = previewDefaults.gatewayPort
/** The listener of the stream of a task's browser (docs/plan/57-browser-tasks.md, Б12). */
export const DEFAULT_BROWSER_STREAM_PORT = 8091
/**
 * PREVIEW_SESSION_SECRET outside production when it is unset: the gateway signs its cookie with
 * it. Production refuses to start the role without a secret of its own.
 */
export const DEV_PREVIEW_SESSION_SECRET = 'raditi-dev-preview-session-secret-not-for-production'

/** The listener of published pages (docs/plan/69-pages.md, Ст4). */
export const DEFAULT_PAGES_PORT = 8092
/**
 * PAGES_COOKIE_SECRET outside production when it is unset; production refuses to start the
 * pages without one of its own.
 */
export const DEV_PAGES_COOKIE_SECRET = 'raditi-dev-pages-cookie-secret-not-for-production'

/** An IP literal to listen on. */
const listenHost = () =>
  envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .optional(),
  )

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  APP_URL: envVar(
    z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
  ),
  GITEA_URL: envVar(z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional()),
  ...previewAddressEnvShape,
  PREVIEW_GATEWAY_PORT: envVar(
    z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PREVIEW_GATEWAY_PORT),
  ),
  PREVIEW_SESSION_SECRET: envVar(z.string().optional()),
  PREVIEW_BROWSER_RELAYS: envVar(z.string().optional()),
  PREVIEW_GATEWAY_HOST: listenHost(),
  BROWSER_STREAM_PORT: envVar(
    z.coerce.number().int().min(1).max(65_535).default(DEFAULT_BROWSER_STREAM_PORT),
  ),
  BROWSER_STREAM_HOST: listenHost(),
  // The worker's address is an internal one: its problems are said, never the value itself.
  BROWSER_WORKER_URL: envVar(
    z
      .string()
      .refine((url) => {
        try {
          browserWorkerOrigin(url)
          return true
        } catch {
          return false
        }
      }, 'must be an http(s) origin without credentials or a path')
      .optional(),
  ),
  // The rule every app reads the worker's token by (32 to 4096 visible ASCII characters).
  BROWSER_WORKER_TOKEN: envVar(browserWorkerTokenSchema.optional()),
  // Published pages (docs/plan/69-pages.md): unset — no listener.
  PAGES_BASE_DOMAIN: envVar(pagesBaseDomainSchema.optional()),
  PAGES_PORT: envVar(z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PAGES_PORT)),
  PAGES_HOST: listenHost(),
  PAGES_PUBLIC_PORT: envVar(z.coerce.number().int().min(1).max(65_535).optional()),
  PAGES_COOKIE_SECRET: envVar(z.string().optional()),
  PAGES_ABUSE_EMAIL: envVar(z.email().optional()),
})

/** The registrable domain of a host by the Public Suffix List; null for an address or a local name. */
const registrableDomain = (host: string): string | null =>
  getDomain(host, { allowPrivateDomains: true })

/**
 * The settings of the preview gateway and nothing else: the database, the address of previews,
 * the cabinet it frames, its cookie secret, the sources of the agent's browser and the stream
 * of a task's browser. Lists every problem at once.
 */
export function loadPreviewConfig(env: Env): PreviewGatewayConfig {
  const parsed = ownEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(envProblems(parsed.error), 'preview')
  const own = parsed.data
  const appEnv = own.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []
  let db: DbConfig | undefined
  try {
    db = dbConfigFromEnv(env)
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err))
  }
  const address = previewAddressFromEnv(own, appEnv)
  problems.push(
    ...previewAddressProblems(
      { appEnv, address, appUrl: own.APP_URL ?? env.APP_URL ?? '', giteaUrl: own.GITEA_URL },
      registrableDomain,
    ),
  )
  if (address === null) problems.push('PREVIEW_BASE_DOMAIN: required for the preview role')
  if (own.APP_URL === undefined)
    problems.push('APP_URL: required for the preview role (the cabinet that frames a preview)')
  const secretProblem = previewSessionSecretProblem(own.PREVIEW_SESSION_SECRET, appEnv)
  if (secretProblem) problems.push(`PREVIEW_SESSION_SECRET: ${secretProblem}`)
  const relays = parsePreviewRelays(own.PREVIEW_BROWSER_RELAYS, production)
  problems.push(...relays.problems)
  // The worker's address needs its token (Б10); the token alone is the worker's own in the one
  // .env of the platform and opens no listener here — the same rule as core's and mcp's.
  if (own.BROWSER_WORKER_URL !== undefined) {
    if (own.BROWSER_WORKER_TOKEN === undefined)
      problems.push('BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL')
    // The token goes with every stream: plain http only inside the perimeter (spec §19).
    const worker = new URL(browserWorkerOrigin(own.BROWSER_WORKER_URL))
    if (
      production &&
      worker.protocol === 'http:' &&
      !isPrivateAddress(worker.hostname) &&
      !isLoopbackAddress(worker.hostname)
    )
      problems.push(
        'BROWSER_WORKER_URL: plain http only to a private or loopback IP address in production (spec §19)',
      )
  }
  const browserStream =
    own.BROWSER_WORKER_URL === undefined || own.BROWSER_WORKER_TOKEN === undefined
      ? null
      : {
          port: own.BROWSER_STREAM_PORT,
          host: own.BROWSER_STREAM_HOST ?? (production ? undefined : '127.0.0.1'),
          workerUrl: browserWorkerOrigin(own.BROWSER_WORKER_URL),
          workerToken: own.BROWSER_WORKER_TOKEN,
        }
  if (browserStream !== null && browserStream.port === own.PREVIEW_GATEWAY_PORT)
    problems.push('BROWSER_STREAM_PORT: must differ from PREVIEW_GATEWAY_PORT')
  const pages = pagesListenerOf(own, production, problems)
  if (pages !== null) {
    if (pages.port === own.PREVIEW_GATEWAY_PORT)
      problems.push('PAGES_PORT: must differ from PREVIEW_GATEWAY_PORT')
    if (browserStream !== null && pages.port === browserStream.port)
      problems.push('PAGES_PORT: must differ from BROWSER_STREAM_PORT')
    const base = pages.baseDomain
    const under = (host: string, parent: string) => host === parent || host.endsWith(`.${parent}`)
    // A page host must never be the cabinet's or a preview's, nor hold them (Ст3).
    if (own.APP_URL !== undefined && under(new URL(own.APP_URL).hostname, base))
      problems.push('PAGES_BASE_DOMAIN: must not be the host of APP_URL or above it')
    // A preview host is one `site-…-chat-…` label under its base, never `<slug>.<pages base>`: the
    // pages may sit under the previews' base (dev: pages.localhost under localhost), not the reverse.
    if (address !== null && under(address.baseDomain, base))
      problems.push('PAGES_BASE_DOMAIN: must not be PREVIEW_BASE_DOMAIN or above it')
  }
  if (problems.length > 0 || address === null || own.APP_URL === undefined || db === undefined)
    throw new ConfigError(problems, 'preview')

  return {
    appEnv,
    port: own.PREVIEW_GATEWAY_PORT,
    address,
    sessionSecret: own.PREVIEW_SESSION_SECRET ?? DEV_PREVIEW_SESSION_SECRET,
    appUrl: own.APP_URL,
    db,
    browserRelays: relays.ranges,
    host: own.PREVIEW_GATEWAY_HOST ?? (production ? undefined : '127.0.0.1'),
    browserStream,
    pages,
  }
}

/** The pages' listener, or null without PAGES_BASE_DOMAIN; its problems go to `problems`. */
function pagesListenerOf(
  own: z.infer<typeof ownEnvSchema>,
  production: boolean,
  problems: string[],
): PagesListenerConfig | null {
  if (own.PAGES_BASE_DOMAIN === undefined) {
    for (const name of [
      'PAGES_HOST',
      'PAGES_PUBLIC_PORT',
      'PAGES_COOKIE_SECRET',
      'PAGES_ABUSE_EMAIL',
    ] as const)
      if (own[name] !== undefined) problems.push(`${name}: needs PAGES_BASE_DOMAIN`)
    return null
  }
  const secret = own.PAGES_COOKIE_SECRET
  if (production && (secret === undefined || secret.length < 32))
    problems.push('PAGES_COOKIE_SECRET: at least 32 characters in production')
  if (production && (secret === DEV_PAGES_COOKIE_SECRET || secret === own.PREVIEW_SESSION_SECRET))
    problems.push(
      'PAGES_COOKIE_SECRET: a secret of its own in production, not the dev value or the preview one',
    )
  if (secret !== undefined && !/^[\x21-\x7e]+$/.test(secret))
    problems.push('PAGES_COOKIE_SECRET: visible ASCII characters only')
  if (production && own.PAGES_PUBLIC_PORT !== undefined)
    problems.push('PAGES_PUBLIC_PORT: not in production (a page host carries no port there)')
  return {
    baseDomain: own.PAGES_BASE_DOMAIN,
    ...(own.PAGES_PUBLIC_PORT === undefined ? {} : { publicPort: own.PAGES_PUBLIC_PORT }),
    cookieSecret: secret ?? DEV_PAGES_COOKIE_SECRET,
    abuseEmail: own.PAGES_ABUSE_EMAIL ?? null,
    port: own.PAGES_PORT,
    host: own.PAGES_HOST ?? (production ? undefined : '127.0.0.1'),
  }
}
