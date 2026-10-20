import {
  appEnvSchema,
  envProblems,
  envVar,
  isProduction,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  previewDefaults,
  previewSessionSecretProblem,
  type AppEnv,
  type Env,
  type PreviewAddress,
} from '@repo/domain'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import { ipLiteral } from '@repo/ip-address'
import { parsePreviewRelays, type PreviewRelayRange } from '@repo/preview-gateway'
import { ConfigError } from '@repo/app-bootstrap'
import { getDomain } from 'tldts'
import { z } from 'zod'

export { ConfigError }

export const DEFAULT_PREVIEW_GATEWAY_PORT = previewDefaults.gatewayPort
/**
 * PREVIEW_SESSION_SECRET outside production when it is unset: the gateway signs its cookie with
 * it. Production refuses to start the role without a secret of its own.
 */
export const DEV_PREVIEW_SESSION_SECRET = 'raditi-dev-preview-session-secret-not-for-production'

/**
 * The gateway of previews (docs/plan/53-chat-preview-release.md, Р19): the exact Host to the
 * upstream of its preview, one-time tickets and its own session cookie. Holds the session
 * secret: never log it.
 */
export interface PreviewGatewayConfig {
  appEnv: AppEnv
  port: number
  address: PreviewAddress
  sessionSecret: string
  /** APP_URL: `frame-ancestors` and the way back to the cabinet. */
  appUrl: string
  db: DbConfig
  /**
   * PREVIEW_BROWSER_RELAYS: the sources that may use the gateway as a forward proxy (the relays
   * of the agent's browser, Р21); empty — the forward proxy is off.
   */
  browserRelays: readonly PreviewRelayRange[]
  /**
   * PREVIEW_GATEWAY_HOST: the address it listens on; undefined — every address (production, in
   * its container). Loopback elsewhere unless set: a Linux stand names the Docker bridge's
   * gateway, where the relay of the agent's browser reaches the host (host.docker.internal).
   */
  host: string | undefined
}

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
  PREVIEW_GATEWAY_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .optional(),
  ),
})

/** The registrable domain of a host by the Public Suffix List; null for an address or a local name. */
const registrableDomain = (host: string): string | null =>
  getDomain(host, { allowPrivateDomains: true })

/**
 * The settings of the preview gateway and nothing else: the database, the address of previews,
 * the cabinet it frames, its cookie secret and the sources of the agent's browser. Lists every
 * problem at once.
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
  }
}
