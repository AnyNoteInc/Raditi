import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  envProblems,
  envVar,
  isProduction,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewDefaults,
  type AppEnv,
  type Env,
  type PreviewAddress,
} from '@repo/domain'
import { ConfigError } from '@repo/app-bootstrap'
import { isLoopbackAddress, isPrivateAddress, ipLiteral } from '@repo/ip-address'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { z } from 'zod'

import { parseMcpHosts } from './allowed-hosts.ts'

export { ConfigError }

export const DEFAULT_MCP_PORT = 8082

/**
 * Published-content tools of the mcp role. `off` — only site_info; `local` — wp_rest and
 * restore into the preview of the dialog, on this machine (needs PREVIEW_BASE_DOMAIN; plan 53,
 * Р3, Р24); `local-site` — the P6 path of the local stands: a dialog without a preview writes
 * the site connected on this machine itself, refused where previews are configured. Production
 * allows only `off`: the gate that opens content there is the owner's decision (spec §20).
 */
export const mcpContentProfiles = ['off', 'local', 'local-site'] as const
export type McpContentProfile = (typeof mcpContentProfiles)[number]

/**
 * The agent's browser tools on the preview of its dialog (MCP_BROWSER_PROFILE, plan 53, Р21).
 * `off` — none; `local` — browser_* against previews of this machine. Production allows only
 * `off`, like the content profile: the gate that opens it there is the owner's decision.
 */
export const mcpBrowserProfiles = ['off', 'local'] as const
export type McpBrowserProfile = (typeof mcpBrowserProfiles)[number]

/** S3 of content snapshots: the connection and the artifacts bucket alone (spec §14). */
export type McpStorageConfig = Omit<StorageConfig, 'buckets' | 'presignEndpoint'> & {
  buckets: Pick<StorageConfig['buckets'], 'artifacts'>
}

/**
 * The MCP gateway: its own port, database and Vault (its own AppRole in production); with a
 * content profile also S3 for the snapshots it takes before a change.
 */
export interface McpConfig {
  appEnv: AppEnv
  port: number
  /** Exact upstream Host values after sandbox-gw rewriting (without ports). */
  allowedHosts: string[]
  db: DbConfig
  vault: VaultConfig
  contentProfile: McpContentProfile
  browserProfile: McpBrowserProfile
  /** null while both profiles are off. Holds the S3 key: never log it. */
  storage: McpStorageConfig | null
  /**
   * PREVIEW_UPSTREAM_HOST: the content of a preview is written over plain http to this address
   * in any environment (plan 53, Р24); the upstream itself comes from preview_environments.
   */
  previewUpstreamHost: string
  /**
   * Where previews answer (PREVIEW_BASE_DOMAIN and the rest): the origin of the dialog's preview
   * the agent is shown and must not write into content. null — previews are not configured, and
   * the content profile keeps the P6 path of a dialog without a preview (the local stands).
   */
  preview: PreviewAddress | null
}

/**
 * What the profiles of a configuration turn on. A configuration a stand builds by hand may
 * leave out the browser profile and previews: both are then off.
 */
export function mcpProfilesOf(config: McpConfig) {
  return {
    content: config.contentProfile !== 'off',
    // The P6 path is a profile of its own, never what an empty PREVIEW_BASE_DOMAIN implies (Р3).
    siteContent: config.contentProfile === 'local-site',
    // A configuration written before the browser profile has none: off.
    browser: (config.browserProfile ?? 'off') !== 'off',
    previews: config.preview ?? null,
  }
}

const port = (fallback: number) =>
  envVar(z.coerce.number().int().min(1).max(65_535).default(fallback))

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  MCP_PORT: port(DEFAULT_MCP_PORT),
  MCP_ALLOWED_HOSTS: envVar(z.string().optional()),
  MCP_CONTENT_PROFILE: envVar(
    z
      .enum(mcpContentProfiles, { error: `must be one of ${mcpContentProfiles.join(', ')}` })
      .default('off'),
  ),
  MCP_BROWSER_PROFILE: envVar(
    z
      .enum(mcpBrowserProfiles, { error: `must be one of ${mcpBrowserProfiles.join(', ')}` })
      .default('off'),
  ),
  ...previewAddressEnvShape,
  PREVIEW_UPSTREAM_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .default(previewDefaults.upstreamHost),
  ),
})

/** What the mcp role reads of the S3 settings: the connection and its one bucket. */
const MCP_STORAGE_VARIABLES = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_BUCKET_ARTIFACTS',
] as const

/**
 * The settings of the MCP gateway (spec §5, §8) and nothing else: the database, Vault, its own
 * port and profiles, the address of previews and, with a content profile, the one S3 bucket of
 * snapshots. It reads none of the git, billing, Redis or runner settings. Lists every problem
 * at once.
 */
export function loadMcpConfig(env: Env): McpConfig {
  const parsed = ownEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(envProblems(parsed.error), 'mcp')
  const own = parsed.data
  const appEnv = own.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []
  const section = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  const db = section(() => dbConfigFromEnv(env))
  const allowedHosts = section(() => parseMcpHosts(own.MCP_ALLOWED_HOSTS, production))
  const vault = section(() => vaultConfigFromEnv(env))
  // The mcp role keeps content snapshots in the artifacts bucket; its S3 key reaches no other
  // (spec §14), so the names of the other buckets and the runners' address are not its settings.
  let storage: McpStorageConfig | null = null
  if (production && own.MCP_BROWSER_PROFILE !== 'off')
    problems.push(
      'MCP_BROWSER_PROFILE: only off is allowed in production (the agent browser is not open there)',
    )
  if (own.MCP_CONTENT_PROFILE !== 'off' || own.MCP_BROWSER_PROFILE !== 'off') {
    if (production) {
      if (own.MCP_CONTENT_PROFILE !== 'off')
        problems.push(
          'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
        )
    } else {
      const read = section(() =>
        storageConfigFromEnv(
          Object.fromEntries(MCP_STORAGE_VARIABLES.map((name) => [name, env[name]])),
        ),
      )
      if (read)
        storage = {
          endpoint: read.endpoint,
          region: read.region,
          accessKeyId: read.accessKeyId,
          secretAccessKey: read.secretAccessKey,
          forcePathStyle: read.forcePathStyle,
          buckets: { artifacts: read.buckets.artifacts },
        }
    }
  }
  // The content of a preview goes to its upstream over plain http with an application password
  // (Р24): in production only inside the host or the private network, never to a public address.
  if (
    production &&
    !isPrivateAddress(own.PREVIEW_UPSTREAM_HOST) &&
    !isLoopbackAddress(own.PREVIEW_UPSTREAM_HOST)
  )
    problems.push(
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    )
  const preview = previewAddressFromEnv(own, appEnv)
  // Where the agent's content goes is said, never inferred (Р3): `local` — the preview of the
  // dialog; `local-site` — the site itself, the P6 path of the stands, never beside previews.
  if (!production && own.MCP_CONTENT_PROFILE === 'local' && preview === null)
    problems.push('MCP_CONTENT_PROFILE: local writes into previews and needs PREVIEW_BASE_DOMAIN')
  if (!production && own.MCP_CONTENT_PROFILE === 'local-site' && preview !== null)
    problems.push(
      'MCP_CONTENT_PROFILE: local-site writes the connected site itself and is refused where previews are configured (PREVIEW_BASE_DOMAIN)',
    )
  if (problems.length > 0 || db === undefined || vault === undefined || allowedHosts === undefined)
    throw new ConfigError(problems, 'mcp')

  return {
    appEnv,
    port: own.MCP_PORT,
    allowedHosts,
    db,
    vault,
    contentProfile: own.MCP_CONTENT_PROFILE,
    browserProfile: own.MCP_BROWSER_PROFILE,
    storage,
    previewUpstreamHost: own.PREVIEW_UPSTREAM_HOST,
    preview,
  }
}
