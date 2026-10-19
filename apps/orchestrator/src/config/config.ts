import { isAbsolute } from 'node:path'

import { agentDriverConfigFromEnv, type AgentDriverConfig } from '@repo/agent-drivers'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  envProblems,
  envVar,
  isProduction,
  parsePreviewWebImages,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  previewDefaults,
  previewExecutorKinds,
  previewImageRoles,
  previewImageSchema,
  previewRuntimes,
  previewSessionSecretProblem,
  sandboxRuntimes,
  turnExecutorKinds,
  type AppEnv,
  type Env,
  type GitProviderKind,
  type PreviewAddress,
  type PreviewExecutorKind,
  type PreviewImageRole,
  type PreviewRuntimeKind,
  type SandboxRuntime,
  type TurnExecutorKind,
} from '@repo/domain'
import { mailerConfigFromEnv, type MailerConfig } from '@repo/mail'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import {
  egressRefusedSubnetsVar,
  sandboxConfigFromEnv,
  type SandboxConfig,
} from '@repo/sandbox-providers'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { yookassaConfigFromEnv, type YookassaConfig } from '@repo/yookassa'
import { getDomain } from 'tldts'
import { z } from 'zod'

import type { RunnerConfig } from '../runner/runner-config.ts'
import { poolControlOrigin } from '../llm/pool-probe-client.ts'
import { parseMcpHosts } from '../mcp/mcp-policy.ts'
import { llmConfigFromEnv, type LlmConfig } from './llm-config.ts'
import { parsePreviewRelays, type PreviewRelayRange } from './preview-relays.ts'
import { ipLiteral, isLoopbackAddress, isPrivateAddress } from './private-address.ts'
import {
  parseRunnerTokens,
  runnerCredentialAddress,
  type RunnerTokenHashes,
} from './runner-tokens.ts'

export type { RunnerConfig }
export type LlmRoleConfig = LlmConfig & { db: DbConfig; vault: VaultConfig; metricsToken: string }

/**
 * Process roles (spec §5, §6): one image, the role is picked by ORCHESTRATOR_ROLES. `preview` —
 * the gateway of previews (docs/plan/53-chat-preview-release.md, Р19).
 */
export const orchestratorRoles = ['core', 'mcp', 'runner', 'llm', 'preview'] as const
export type OrchestratorRole = (typeof orchestratorRoles)[number]

export const DEFAULT_CORE_PORT = 8081
export const DEFAULT_MCP_PORT = 8082
/** Runner VMs reach only this port of core, on the private network (spec §19). */
export const DEFAULT_RUNNER_API_PORT = 8083
/** The gateway of previews (role `preview`). */
export const DEFAULT_PREVIEW_GATEWAY_PORT = previewDefaults.gatewayPort
/** The release API of core: deploy jobs reach only this port (plan 53, Р32). */
export const DEFAULT_RELEASE_API_PORT = previewDefaults.releaseApiPort
/**
 * PREVIEW_SESSION_SECRET outside production when it is unset: the gateway signs its cookie with
 * it. Production refuses to start the role without a secret of its own.
 */
export const DEV_PREVIEW_SESSION_SECRET = 'raditi-dev-preview-session-secret-not-for-production'
/** Locally the HTTP roles share one process (spec §6). */
const DEFAULT_DEV_ROLES: OrchestratorRole[] = ['core', 'mcp', 'llm']
/**
 * SANDBOX_IMAGE of .env.example: no registry serves it, and agent drivers refuse it in
 * production. Core reads no stack image before the supervisor plans turns (P12), so outside
 * production a missing SANDBOX_IMAGE stands for it, as in a fresh copy of .env.example.
 */
const SANDBOX_IMAGE_PLACEHOLDER = `raditi/sbx-wordpress@sha256:${'0'.repeat(64)}`

/** Everything the core role needs. Holds credentials: never log it. */
export interface CoreConfig {
  appEnv: AppEnv
  port: number
  redisUrl: string
  metricsToken: string
  /** Private core → llm control channel; absence leaves unknown quota windows waiting. */
  llmControlUrl?: string
  minTurnHeadroomPct?: number
  db: DbConfig
  storage: StorageConfig
  vault: VaultConfig
  /** Core's own Docker: only with the local executor, never in production. */
  sandbox: SandboxConfig | null
  agentDrivers: AgentDriverConfig
  mailer: MailerConfig
  /** Where turns run: core's own Docker (local, not in production) or runner VMs. */
  turnExecutor: TurnExecutorKind
  /**
   * With runner VMs: the runtime they run turns under (SANDBOX_RUNTIME, one set of variables
   * with the runners at MVP; only runsc in production). A runner refuses a turn spec of another
   * runtime. Absent with the local executor, whose `sandbox` names it.
   */
  runnerRuntime?: SandboxRuntime
  /** The runner API listener; null with the local executor. */
  runnerApi: RunnerApiConfig | null
  /**
   * Where site repositories live (spec §10). null — git is not configured: no turn can run,
   * the rest of core does. Plain http is never a git transport (spec §19).
   */
  git: GitConfig | null
  /**
   * The token of the account that may create repositories in the `sites` organization, and
   * nothing more (docs/plan/39-site-connection-wizard.md). null — unset, or git is not
   * configured: the import of a connected site refuses, and the bot's token never stands in
   * for it. Never log it.
   */
  siteRepositoryProvisionerToken: string | null
  /**
   * The ЮKassa shop for renewal charges. null — payments are off (both credentials empty):
   * nothing is charged, the rest of core runs. Holds the shop key: never log it.
   */
  yookassa: YookassaConfig | null
  billing: BillingConfig
  /** Previews of dialogs; null — PREVIEW_BASE_DOMAIN is unset and no preview is built. */
  previews: PreviewsConfig | null
  /** The release API listener; null — RELEASE_API_HOST is unset and releases are off here. */
  releaseApi: ReleaseApiConfig | null
}

/** Where and how previews of dialogs run (docs/plan/53-chat-preview-release.md, Р17, Р18). */
export interface PreviewsConfig {
  address: PreviewAddress
  ttlHours: number
  /** core's own Docker (never in production until M10) or a runner VM. */
  executor: PreviewExecutorKind
  runtime: PreviewRuntimeKind
  /** A web image per runtime version (PREVIEW_WEB_IMAGES); empty — no preview can run. */
  webImages: Readonly<Record<string, string>>
  /** PREVIEW_*_IMAGE by role; null — not set, the part of a preview that needs it is off. */
  images: Readonly<Record<PreviewImageRole, string | null>>
  /** Where the entry forwarders publish their ports (PREVIEW_UPSTREAM_HOST). */
  upstreamHost: string
  /** PREVIEW_GATEWAY_PORT: where the relay of the agent's browser reaches the gateway (Р21). */
  gatewayPort: number
  /**
   * SANDBOX_EGRESS_REFUSED_SUBNETS: the platform's own subnets the egress proxy of a preview never
   * connects to (R10, Р13), as the sandbox gateway's; empty — only addresses that are not public.
   */
  egressRefusedSubnets: readonly string[]
  /**
   * core's own Docker for PREVIEW_EXECUTOR=local (R5c): its socket (SANDBOX_DOCKER_SOCKET) and,
   * under runsc, the host firewall image (SANDBOX_NETWORK_GUARD_IMAGE). null with runner VMs.
   */
  docker: { socketPath: string; firewallImage: string | null } | null
}

/** The API deploy jobs call (plan 53, Р32): manifest, access, step reports, backup. */
export interface ReleaseApiConfig {
  /** The address it listens on; the containers of deploy jobs reach it. */
  host: string
  port: number
  /** The origin deploy jobs are given, without a trailing slash. */
  publicUrl: string
  /** A job silent this long after the tag is revoked (Р31). */
  startTimeoutMinutes: number
}

/**
 * The gateway of previews (role `preview`, Р19): the exact Host to the upstream of its preview,
 * one-time tickets and its own session cookie. Holds the session secret: never log it.
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

/** Renewal of tariffs by the scheduler of core (docs/plan/37-billing-plan.md, M5.11). */
export interface BillingConfig {
  /** Public origin of the web app (APP_URL), no trailing slash: billing letters link to it. */
  appUrl: string
  /** How many days before the end of a period the notice of the charge goes out. */
  renewalNoticeDays: number
  /** How many days an overdue tariff waits for a payment before it ends. */
  pastDueDays: number
  /** How often each renewal pass runs. */
  tickSeconds: number
}

/** Our Gitea over HTTPS. Holds the bot token: never log it. */
export interface GitConfig {
  kind: GitProviderKind
  /** Web root without a trailing slash: the API and the only origin git clones from and pushes to. */
  baseUrl: string
  token: string
  /** PEM bundle of the server's CA for git; the API client takes NODE_EXTRA_CA_CERTS. */
  caFile: string | null
  /**
   * Where the bare mirrors of site repositories and the cache of base bundles live
   * (GIT_MIRROR_DIR, plan 53, Р10); absent — under the OS temp directory.
   */
  mirrorDir?: string
}

export interface RunnerApiConfig {
  port: number
  /** SHA-256 of runner tokens by runner id; the tokens themselves stay on the VMs. */
  tokens: RunnerTokenHashes
}

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

export interface OrchestratorConfig {
  appEnv: AppEnv
  roles: OrchestratorRole[]
  /** null when the role is not selected for this process. */
  core: CoreConfig | null
  mcp: McpConfig | null
  runner: RunnerConfig | null
  llm: LlmRoleConfig | null
  preview: PreviewGatewayConfig | null
}

/** Lists every problem at once; names variables, never their values. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid orchestrator configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const port = (fallback: number) =>
  envVar(z.coerce.number().int().min(1).max(65_535).default(fallback))

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  // The origin billing letters link to; web reads the same variable.
  APP_URL: envVar(
    z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
  ),
  // A notice goes out before every automatic charge; with a month of 28 days as the shortest
  // period, more days than that would announce the next charge right after the last one.
  BILLING_RENEWAL_NOTICE_DAYS: envVar(z.coerce.number().int().min(1).max(27).default(3)),
  BILLING_PAST_DUE_DAYS: envVar(z.coerce.number().int().min(1).max(90).default(7)),
  BILLING_TICK_SECONDS: envVar(z.coerce.number().int().min(1).max(3_600).default(300)),
  ORCHESTRATOR_ROLES: envVar(z.string().optional()),
  ORCHESTRATOR_PORT: port(DEFAULT_CORE_PORT),
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
  RUNNER_API_PORT: port(DEFAULT_RUNNER_API_PORT),
  TURN_EXECUTOR: envVar(z.enum(turnExecutorKinds).optional()),
  RUNNER_TOKENS: envVar(z.string().optional()),
  RUNNER_CORE_URL: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  RUNNER_TOKEN_FILE: envVar(z.string().optional()),
  RUNNER_CORE_CA_FILE: envVar(z.string().optional()),
  RUNNER_S3_ORIGIN: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  RUNNER_MAX_TURNS: envVar(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(1, 'one turn per runner until several runners are supported (stage 2)')
      .default(1),
  ),
  REDIS_URL: envVar(z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).optional()),
  // `Authorization: Bearer <token>` carries one word: a space or a trailing line break from a
  // secret template would leave /metrics, /health details and the pool probe closed for good.
  METRICS_TOKEN: envVar(
    z
      .string()
      .regex(/^\S+$/, 'must not contain whitespace (it is sent as a Bearer token)')
      .optional(),
  ),
  LLM_CONTROL_URL: envVar(z.string().optional()),
  LLM_POOL_MIN_TURN_HEADROOM_PCT: envVar(z.coerce.number().gt(0).max(100).default(5)),
  GITEA_URL: envVar(z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional()),
  // Sent in an Authorization header, as a token and as a Basic password.
  GITEA_TOKEN: envVar(
    z
      .string()
      .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without whitespace')
      .optional(),
  ),
  // The same header, another account: the one that creates site repositories.
  GITEA_PROVISIONER_TOKEN: envVar(
    z
      .string()
      .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without whitespace')
      .optional(),
  ),
  GIT_CA_FILE: envVar(z.string().optional()),
  GIT_MIRROR_DIR: envVar(z.string().optional()),
  // Previews and releases (docs/plan/53-chat-preview-release.md, «Переменные окружения»).
  ...previewAddressEnvShape,
  PREVIEW_GATEWAY_PORT: port(DEFAULT_PREVIEW_GATEWAY_PORT),
  PREVIEW_SESSION_SECRET: envVar(z.string().optional()),
  PREVIEW_BROWSER_RELAYS: envVar(z.string().optional()),
  PREVIEW_GATEWAY_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .optional(),
  ),
  PREVIEW_TTL_HOURS: envVar(
    z.coerce.number().int().min(1).max(720).default(previewDefaults.ttlHours),
  ),
  PREVIEW_EXECUTOR: envVar(z.enum(previewExecutorKinds).optional()),
  PREVIEW_RUNTIME: envVar(z.enum(previewRuntimes).optional()),
  PREVIEW_WEB_IMAGES: envVar(z.string().optional()),
  PREVIEW_DB_IMAGE: envVar(previewImageSchema.optional()),
  PREVIEW_CLI_IMAGE: envVar(previewImageSchema.optional()),
  PREVIEW_FORWARDER_IMAGE: envVar(previewImageSchema.optional()),
  PREVIEW_BROWSER_IMAGE: envVar(previewImageSchema.optional()),
  PREVIEW_EGRESS_IMAGE: envVar(previewImageSchema.optional()),
  PREVIEW_UPSTREAM_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .default(previewDefaults.upstreamHost),
  ),
  // The platform's own subnets the egress proxy of a preview never connects to (R10, Р13).
  SANDBOX_EGRESS_REFUSED_SUBNETS: egressRefusedSubnetsVar,
  RELEASE_API_PORT: port(DEFAULT_RELEASE_API_PORT),
  RELEASE_API_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .optional(),
  ),
  RELEASE_API_PUBLIC_URL: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  RELEASE_START_TIMEOUT_MINUTES: envVar(
    z.coerce.number().int().min(1).max(60).default(previewDefaults.releaseStartTimeoutMinutes),
  ),
})

/** The PREVIEW_*_IMAGE variable of each image role. */
const previewImageVariables = {
  db: 'PREVIEW_DB_IMAGE',
  cli: 'PREVIEW_CLI_IMAGE',
  forwarder: 'PREVIEW_FORWARDER_IMAGE',
  browser: 'PREVIEW_BROWSER_IMAGE',
  egress: 'PREVIEW_EGRESS_IMAGE',
} as const satisfies Record<PreviewImageRole, string>

/** The registrable domain of a host by the Public Suffix List; null for an address or a local name. */
const registrableDomain = (host: string): string | null =>
  getDomain(host, { allowPrivateDomains: true })

/** What the mcp role reads of the S3 settings: the connection and its one bucket. */
const MCP_STORAGE_VARIABLES = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_BUCKET_ARTIFACTS',
] as const

/** Set by the OS, Docker or the Node image: never a platform setting. */
const systemVariables = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'TZ',
  'TERM',
  'LANG',
  'LANGUAGE',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'NODE_VERSION',
  'YARN_VERSION',
  '_',
])

/**
 * All a production runner may be given (spec §8, §19): its own and the sandbox settings plus the
 * system's. Anything else may be a platform credential a sandbox VM must never hold.
 */
function isRunnerVariable(name: string): boolean {
  return (
    ['APP_ENV', 'NODE_ENV', 'ORCHESTRATOR_ROLES'].includes(name) ||
    name.startsWith('RUNNER_') ||
    name.startsWith('SANDBOX_') ||
    name.startsWith('LC_') ||
    systemVariables.has(name)
  )
}

function isRole(name: string): name is OrchestratorRole {
  return (orchestratorRoles as readonly string[]).includes(name)
}

function parseRoles(raw: string | undefined, production: boolean, problems: string[]) {
  if (raw === undefined) {
    if (production) problems.push('ORCHESTRATOR_ROLES: required in production (one role)')
    return production ? [] : DEFAULT_DEV_ROLES
  }
  const names = [...new Set(raw.split(',').map((name) => name.trim()))].filter(Boolean)
  const unknown = names.filter((name) => !isRole(name))
  if (unknown.length > 0) {
    problems.push(
      `ORCHESTRATOR_ROLES: unknown role ${unknown.map((n) => `"${n}"`).join(', ')}; ` +
        `expected ${orchestratorRoles.join(', ')}`,
    )
  }
  const roles = names.filter(isRole)
  if (names.length === 0) problems.push('ORCHESTRATOR_ROLES: at least one role is required')
  if (production && roles.length > 1) {
    problems.push('ORCHESTRATOR_ROLES: production runs exactly one role per process')
  }
  return roles
}

/** Builds the configuration once at startup; throws ConfigError listing every problem. */
export function loadConfig(env: Env): OrchestratorConfig {
  const shared = ownEnvSchema.pick({ APP_ENV: true, ORCHESTRATOR_ROLES: true }).safeParse(env)
  if (!shared.success) throw new ConfigError(envProblems(shared.error))
  const appEnv = shared.data.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []

  const roles = parseRoles(shared.data.ORCHESTRATOR_ROLES, production, problems)
  const hasCore = roles.includes('core')
  const hasMcp = roles.includes('mcp')
  const hasRunner = roles.includes('runner')
  const hasLlm = roles.includes('llm')
  const hasPreview = roles.includes('preview')
  // A shared local .env may contain settings for other processes. Validate only what this
  // process uses; keep the original env for the production runner's credential allowlist.
  const selected: Record<string, string | undefined> = { APP_ENV: shared.data.APP_ENV }
  const fields: [boolean, readonly string[]][] = [
    [
      hasCore,
      [
        'ORCHESTRATOR_PORT',
        'TURN_EXECUTOR',
        'REDIS_URL',
        'LLM_CONTROL_URL',
        'LLM_POOL_MIN_TURN_HEADROOM_PCT',
        'GITEA_URL',
        'GITEA_TOKEN',
        'GITEA_PROVISIONER_TOKEN',
        'GIT_CA_FILE',
        'GIT_MIRROR_DIR',
        'APP_URL',
        'BILLING_RENEWAL_NOTICE_DAYS',
        'BILLING_PAST_DUE_DAYS',
        'BILLING_TICK_SECONDS',
        'PREVIEW_TTL_HOURS',
        'PREVIEW_GATEWAY_PORT',
        'PREVIEW_EXECUTOR',
        'PREVIEW_RUNTIME',
        'PREVIEW_WEB_IMAGES',
        ...Object.values(previewImageVariables),
        'SANDBOX_EGRESS_REFUSED_SUBNETS',
        'RELEASE_API_PORT',
        'RELEASE_API_HOST',
        'RELEASE_API_PUBLIC_URL',
        'RELEASE_START_TIMEOUT_MINUTES',
      ],
    ],
    // The address of a preview: core builds hostnames, the gateway routes by them.
    [
      hasCore || hasPreview || hasMcp,
      ['PREVIEW_BASE_DOMAIN', 'PREVIEW_SCHEME', 'PREVIEW_PUBLIC_PORT'],
    ],
    [hasCore || hasMcp, ['PREVIEW_UPSTREAM_HOST']],
    [
      hasPreview,
      [
        'PREVIEW_GATEWAY_PORT',
        'PREVIEW_GATEWAY_HOST',
        'PREVIEW_SESSION_SECRET',
        'PREVIEW_BROWSER_RELAYS',
        'APP_URL',
        'GITEA_URL',
      ],
    ],
    // core serves /metrics and calls the pool probe of llm with it; llm checks it.
    [hasCore || hasLlm, ['METRICS_TOKEN']],
    [hasMcp, ['MCP_PORT', 'MCP_ALLOWED_HOSTS', 'MCP_CONTENT_PROFILE', 'MCP_BROWSER_PROFILE']],
    [
      hasCore && (env.TURN_EXECUTOR?.trim() || (production ? 'runner' : 'local')) === 'runner',
      ['RUNNER_API_PORT', 'RUNNER_TOKENS'],
    ],
    [
      hasRunner,
      [
        'RUNNER_CORE_URL',
        'RUNNER_TOKEN_FILE',
        'RUNNER_CORE_CA_FILE',
        'RUNNER_S3_ORIGIN',
        'RUNNER_MAX_TURNS',
      ],
    ],
  ]
  for (const [enabled, names] of fields)
    if (enabled) for (const name of names) selected[name] = env[name]
  const parsed = ownEnvSchema.safeParse(selected)
  if (!parsed.success) throw new ConfigError([...problems, ...envProblems(parsed.error)])
  const own = parsed.data
  if (hasCore && hasMcp && own.ORCHESTRATOR_PORT === own.MCP_PORT) {
    problems.push(
      'MCP_PORT: must differ from ORCHESTRATOR_PORT (sandboxes reach only the MCP port)',
    )
  }

  const turnExecutor = own.TURN_EXECUTOR ?? (production ? 'runner' : 'local')
  let runnerApi: RunnerApiConfig | null = null
  let runnerRuntime: SandboxRuntime | undefined
  if (hasCore) {
    if (own.REDIS_URL === undefined) problems.push('REDIS_URL: required for the core role')
    // Every billing letter carries a link to the app: a guessed origin would not open.
    if (own.APP_URL === undefined)
      problems.push('APP_URL: required for the core role (billing letters link to the app)')
    else if (production && !own.APP_URL.startsWith('https://'))
      problems.push('APP_URL: must use https in production')
    if (production && turnExecutor !== 'runner')
      problems.push('TURN_EXECUTOR: production runs turns only on runner VMs (runner)')
    if (turnExecutor === 'runner') {
      // The runners validate their own value and refuse to start on a wrong one; core only names
      // a valid one in its turn specs (turnRuntimeOf), and never runc in production.
      runnerRuntime = sandboxRuntimes.find((known) => known === env.SANDBOX_RUNTIME?.trim())
      if (production && runnerRuntime === 'runc')
        problems.push('SANDBOX_RUNTIME: production runner VMs run turns under gVisor (runsc)')
      if ([own.ORCHESTRATOR_PORT, ...(hasMcp ? [own.MCP_PORT] : [])].includes(own.RUNNER_API_PORT))
        problems.push('RUNNER_API_PORT: must differ from ORCHESTRATOR_PORT and MCP_PORT')
      const tokens = parseRunnerTokens(own.RUNNER_TOKENS ?? '', production)
      problems.push(...tokens.problems.map((problem) => `RUNNER_TOKENS: ${problem}`))
      // A turn key is bound to the address of its runner (runnerCredentialAddress): a runner
      // without exactly one would authenticate and claim, then fail every turn it takes.
      for (const runnerId of tokens.hashes.keys()) {
        try {
          runnerCredentialAddress(tokens.hashes, runnerId)
        } catch {
          problems.push(
            `RUNNER_TOKENS: runner ${runnerId} needs one @<IP address> on every hash (its turn keys are bound to it)`,
          )
        }
      }
      if (tokens.problems.length === 0 && tokens.hashes.size === 0)
        problems.push('RUNNER_TOKENS: at least one runner token hash is required (id:sha256@ip)')
      runnerApi = { port: own.RUNNER_API_PORT, tokens: tokens.hashes }
    }
    // /metrics lives on the core port only.
    const tokenProblem = metricsTokenProblem(own.METRICS_TOKEN, appEnv)
    if (tokenProblem) problems.push(`METRICS_TOKEN: ${tokenProblem}`)
  }

  let coreUrl: URL | undefined
  let s3Origin: string | null = null
  if (hasRunner) {
    if (own.RUNNER_CORE_URL === undefined)
      problems.push('RUNNER_CORE_URL: required for the runner role')
    else {
      coreUrl = new URL(own.RUNNER_CORE_URL)
      if (!isOrigin(coreUrl))
        problems.push('RUNNER_CORE_URL: expected an origin (no path, credentials or query)')
      // Inside the perimeter plain http goes to the app VM's private address only (spec §19).
      if (production && coreUrl.protocol === 'http:' && !isPrivateAddress(coreUrl.hostname))
        problems.push(
          'RUNNER_CORE_URL: plain http only to a private IP address in production (spec §19)',
        )
    }
    if (own.RUNNER_S3_ORIGIN === undefined) {
      if (production) problems.push('RUNNER_S3_ORIGIN: required for the runner role in production')
    } else {
      const s3 = new URL(own.RUNNER_S3_ORIGIN)
      // Path-style S3 shares one host between buckets: the pin names the sessions bucket too.
      if (!isOrigin(s3, { bucket: true }))
        problems.push(
          'RUNNER_S3_ORIGIN: expected an origin, with the sessions bucket for path-style S3 (no credentials or query)',
        )
      // The cloud's S3 is outside the private network: presigned URLs go there over TLS only.
      else if (production && s3.protocol !== 'https:')
        problems.push('RUNNER_S3_ORIGIN: must use https in production')
      s3Origin = s3.origin + s3.pathname.replace(/\/$/, '')
    }
    if (own.RUNNER_TOKEN_FILE === undefined)
      problems.push(
        'RUNNER_TOKEN_FILE: required for the runner role (the token is never an env value)',
      )
    else if (!isAbsolute(own.RUNNER_TOKEN_FILE))
      problems.push('RUNNER_TOKEN_FILE: must be an absolute path')
    if (own.RUNNER_CORE_CA_FILE !== undefined && !isAbsolute(own.RUNNER_CORE_CA_FILE))
      problems.push('RUNNER_CORE_CA_FILE: must be an absolute path')
    // Names only: the values may be exactly what must not be on a sandbox VM.
    if (production)
      for (const name of Object.keys(env).sort())
        if (!isRunnerVariable(name) && env[name]?.trim())
          problems.push(`${name}: must not be set for the runner role in production`)
  }

  const section = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }
  const db =
    hasCore || hasMcp || hasLlm || hasPreview ? section(() => dbConfigFromEnv(env)) : undefined
  const mcpHosts = hasMcp
    ? section(() => parseMcpHosts(own.MCP_ALLOWED_HOSTS, production))
    : undefined
  const vault = hasCore || hasMcp || hasLlm ? section(() => vaultConfigFromEnv(env)) : undefined
  const llm = hasLlm ? section(() => llmConfigFromEnv(env, appEnv)) : undefined
  if (hasLlm && !hasCore) {
    const tokenProblem = metricsTokenProblem(own.METRICS_TOKEN, appEnv)
    if (tokenProblem) problems.push(`METRICS_TOKEN: ${tokenProblem}`)
  }
  if (
    llm &&
    [
      ...(hasCore ? [own.ORCHESTRATOR_PORT] : []),
      ...(hasMcp ? [own.MCP_PORT] : []),
      ...(runnerApi ? [runnerApi.port] : []),
    ].includes(llm.port)
  )
    problems.push('LLM_GATEWAY_PORT: must differ from the other role ports')
  const storage = hasCore ? section(() => storageConfigFromEnv(env)) : undefined
  // The mcp role keeps content snapshots in the artifacts bucket; its S3 key reaches no other
  // (spec §14), so the names of the other buckets and the runners' address are not its settings.
  let mcpStorage: McpStorageConfig | null = null
  if (hasMcp && production && own.MCP_BROWSER_PROFILE !== 'off')
    problems.push(
      'MCP_BROWSER_PROFILE: only off is allowed in production (the agent browser is not open there)',
    )
  if (hasMcp && (own.MCP_CONTENT_PROFILE !== 'off' || own.MCP_BROWSER_PROFILE !== 'off')) {
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
        mcpStorage = {
          endpoint: read.endpoint,
          region: read.region,
          accessKeyId: read.accessKeyId,
          secretAccessKey: read.secretAccessKey,
          forcePathStyle: read.forcePathStyle,
          buckets: { artifacts: read.buckets.artifacts },
        }
    }
  }
  // A presigned URL is a bearer capability a runner VM follows over the cloud's network.
  if (production && storage) {
    const [name, origin] = storage.presignEndpoint
      ? ['S3_RUNNER_ENDPOINT', storage.presignEndpoint]
      : ['S3_ENDPOINT', storage.endpoint]
    if (new URL(origin).protocol !== 'https:')
      problems.push(`${name}: must use https in production (runners follow presigned URLs)`)
  }
  // Docker is driven by the runner, or by core itself only with the local executor.
  const coreSandbox = hasCore && turnExecutor === 'local'
  const sandbox = coreSandbox || hasRunner ? section(() => sandboxConfigFromEnv(env)) : undefined
  const mailer = hasCore ? section(() => mailerConfigFromEnv(env)) : undefined
  // Only core charges renewals; the other roles neither need nor read the shop settings.
  const yookassa = hasCore ? section(() => yookassaConfigFromEnv(env)) : undefined
  const agentDrivers = hasCore
    ? section(() =>
        agentDriverConfigFromEnv(
          production || env.SANDBOX_IMAGE?.trim()
            ? env
            : { ...env, SANDBOX_IMAGE: SANDBOX_IMAGE_PLACEHOLDER },
        ),
      )
    : undefined

  let llmControlUrl: string | undefined
  if (hasCore) {
    const origin = own.LLM_CONTROL_URL ?? (production ? undefined : 'http://127.0.0.1:8084')
    if (origin !== undefined) {
      try {
        llmControlUrl = poolControlOrigin(origin)
      } catch {
        problems.push(
          'LLM_CONTROL_URL: must be an http(s) origin at a private IP or loopback address',
        )
      }
    }
  }
  let git: GitConfig | null = null
  if (hasCore) {
    if (own.GIT_CA_FILE !== undefined && !isAbsolute(own.GIT_CA_FILE))
      problems.push('GIT_CA_FILE: must be an absolute path')
    if (own.GIT_MIRROR_DIR !== undefined && !isAbsolute(own.GIT_MIRROR_DIR))
      problems.push('GIT_MIRROR_DIR: must be an absolute path')
    if (own.GITEA_URL !== undefined) {
      const url = new URL(own.GITEA_URL)
      if (url.username || url.password || url.search || url.hash)
        problems.push('GITEA_URL: expected an address without credentials, query or fragment')
      else if (url.protocol !== 'https:') {
        // Outside production the dev Gitea speaks plain http: core starts, turns do not.
        if (production) problems.push('GITEA_URL: must use https in production (spec §19)')
      } else if (own.GITEA_TOKEN === undefined)
        problems.push('GITEA_TOKEN: required with an https GITEA_URL')
      else
        git = {
          kind: 'gitea',
          baseUrl: url.origin + url.pathname.replace(/\/+$/, ''),
          token: own.GITEA_TOKEN,
          caFile: own.GIT_CA_FILE ?? null,
          ...(own.GIT_MIRROR_DIR === undefined ? {} : { mirrorDir: own.GIT_MIRROR_DIR }),
        }
    }
  }
  // Repositories are created in the Gitea that git is configured for: without git the token
  // has nowhere to go.
  const siteRepositoryProvisionerToken = git === null ? null : (own.GITEA_PROVISIONER_TOKEN ?? null)

  // Previews and releases (docs/plan/53-chat-preview-release.md).
  // The content of a preview goes to its upstream over plain http with an application password
  // (Р24): in production only inside the host or the private network, never to a public address.
  if (
    production &&
    (hasCore || hasMcp) &&
    !isPrivateAddress(own.PREVIEW_UPSTREAM_HOST) &&
    !isLoopbackAddress(own.PREVIEW_UPSTREAM_HOST)
  )
    problems.push(
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    )
  const previewAddress = hasCore || hasPreview || hasMcp ? previewAddressFromEnv(own, appEnv) : null
  // Where the agent's content goes is said, never inferred (Р3): `local` — the preview of the
  // dialog; `local-site` — the site itself, the P6 path of the stands, never beside previews.
  if (hasMcp && !production && own.MCP_CONTENT_PROFILE === 'local' && previewAddress === null)
    problems.push('MCP_CONTENT_PROFILE: local writes into previews and needs PREVIEW_BASE_DOMAIN')
  if (hasMcp && !production && own.MCP_CONTENT_PROFILE === 'local-site' && previewAddress !== null)
    problems.push(
      'MCP_CONTENT_PROFILE: local-site writes the connected site itself and is refused where previews are configured (PREVIEW_BASE_DOMAIN)',
    )
  if (hasCore || hasPreview)
    problems.push(
      ...previewAddressProblems(
        {
          appEnv,
          address: previewAddress,
          appUrl: own.APP_URL ?? env.APP_URL ?? '',
          giteaUrl: own.GITEA_URL ?? env.GITEA_URL,
        },
        registrableDomain,
      ),
    )
  let previews: PreviewsConfig | null = null
  let releaseApi: ReleaseApiConfig | null = null
  if (hasCore) {
    const executor = own.PREVIEW_EXECUTOR ?? (production ? 'runner' : 'local')
    // Core's own Docker never runs a preview in production, as it never runs a turn there.
    if (production && executor === 'local')
      problems.push('PREVIEW_EXECUTOR: production runs previews only on runner VMs (runner)')
    const runtime = own.PREVIEW_RUNTIME ?? (production ? 'runsc' : 'runc')
    if (production && runtime !== 'runsc')
      problems.push('PREVIEW_RUNTIME: production previews run under gVisor (runsc)')
    const web = parsePreviewWebImages(own.PREVIEW_WEB_IMAGES)
    problems.push(...web.problems)
    if (previewAddress !== null)
      previews = {
        address: previewAddress,
        ttlHours: own.PREVIEW_TTL_HOURS,
        executor,
        runtime,
        webImages: web.images,
        images: Object.fromEntries(
          previewImageRoles.map((role) => [role, own[previewImageVariables[role]] ?? null]),
        ) as Record<PreviewImageRole, string | null>,
        upstreamHost: own.PREVIEW_UPSTREAM_HOST,
        gatewayPort: own.PREVIEW_GATEWAY_PORT,
        egressRefusedSubnets: own.SANDBOX_EGRESS_REFUSED_SUBNETS ?? [],
        docker:
          executor === 'local'
            ? {
                socketPath: env.SANDBOX_DOCKER_SOCKET?.trim() || '/var/run/docker.sock',
                firewallImage: env.SANDBOX_NETWORK_GUARD_IMAGE?.trim() || null,
              }
            : null,
      }

    // Listens only where it is told (Р32): on the private network in production, on loopback
    // or the runner's bridge in dev. Unset — no release API, and no port for stands to share.
    const host = own.RELEASE_API_HOST
    if (host !== undefined) {
      if (production && !isPrivateAddress(host))
        problems.push('RELEASE_API_HOST: must be a private IP address in production (spec §19)')
      const otherPorts = [
        own.ORCHESTRATOR_PORT,
        ...(hasMcp ? [own.MCP_PORT] : []),
        ...(runnerApi ? [runnerApi.port] : []),
        ...(llm ? [llm.port] : []),
        ...(hasPreview ? [own.PREVIEW_GATEWAY_PORT] : []),
      ]
      if (otherPorts.includes(own.RELEASE_API_PORT))
        problems.push('RELEASE_API_PORT: must differ from the other ports of this process')
      let publicUrl: string | undefined
      if (own.RELEASE_API_PUBLIC_URL === undefined) {
        if (production)
          problems.push('RELEASE_API_PUBLIC_URL: required with RELEASE_API_HOST in production')
        else publicUrl = `http://${host.includes(':') ? `[${host}]` : host}:${own.RELEASE_API_PORT}`
      } else {
        const url = new URL(own.RELEASE_API_PUBLIC_URL)
        if (!isOrigin(url))
          problems.push(
            'RELEASE_API_PUBLIC_URL: expected an origin (no path, credentials or query)',
          )
        // Inside the perimeter plain http goes to a private address only (spec §19).
        else if (production && url.protocol === 'http:' && !isPrivateAddress(url.hostname))
          problems.push(
            'RELEASE_API_PUBLIC_URL: plain http only to a private IP address in production (spec §19)',
          )
        publicUrl = url.origin
      }
      if (publicUrl !== undefined)
        releaseApi = {
          host,
          port: own.RELEASE_API_PORT,
          publicUrl,
          startTimeoutMinutes: own.RELEASE_START_TIMEOUT_MINUTES,
        }
    } else if (own.RELEASE_API_PUBLIC_URL !== undefined)
      problems.push('RELEASE_API_HOST: required with RELEASE_API_PUBLIC_URL')
  }

  let preview: PreviewGatewayConfig | null = null
  if (hasPreview) {
    if (previewAddress === null) problems.push('PREVIEW_BASE_DOMAIN: required for the preview role')
    if (own.APP_URL === undefined)
      problems.push('APP_URL: required for the preview role (the cabinet that frames a preview)')
    const secretProblem = previewSessionSecretProblem(own.PREVIEW_SESSION_SECRET, appEnv)
    if (secretProblem) problems.push(`PREVIEW_SESSION_SECRET: ${secretProblem}`)
    const ports = [
      ...(hasCore ? [own.ORCHESTRATOR_PORT] : []),
      ...(hasMcp ? [own.MCP_PORT] : []),
      ...(runnerApi ? [runnerApi.port] : []),
      ...(llm ? [llm.port] : []),
    ]
    if (ports.includes(own.PREVIEW_GATEWAY_PORT))
      problems.push('PREVIEW_GATEWAY_PORT: must differ from the other role ports')
    const relays = parsePreviewRelays(own.PREVIEW_BROWSER_RELAYS, production)
    problems.push(...relays.problems)
    if (previewAddress !== null && own.APP_URL !== undefined && db !== undefined)
      preview = {
        appEnv,
        port: own.PREVIEW_GATEWAY_PORT,
        address: previewAddress,
        sessionSecret: own.PREVIEW_SESSION_SECRET ?? DEV_PREVIEW_SESSION_SECRET,
        appUrl: own.APP_URL,
        db,
        browserRelays: relays.ranges,
        host: own.PREVIEW_GATEWAY_HOST ?? (production ? undefined : '127.0.0.1'),
      }
  }
  if (problems.length > 0) throw new ConfigError(problems)

  return {
    appEnv,
    roles,
    core: hasCore
      ? {
          appEnv,
          port: own.ORCHESTRATOR_PORT,
          redisUrl: present(own.REDIS_URL),
          metricsToken: own.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
          ...(llmControlUrl === undefined ? {} : { llmControlUrl }),
          minTurnHeadroomPct: own.LLM_POOL_MIN_TURN_HEADROOM_PCT,
          db: present(db),
          storage: present(storage),
          vault: present(vault),
          sandbox: coreSandbox ? present(sandbox) : null,
          agentDrivers: present(agentDrivers),
          mailer: present(mailer),
          turnExecutor,
          ...(runnerRuntime ? { runnerRuntime } : {}),
          runnerApi,
          git,
          siteRepositoryProvisionerToken,
          yookassa: present(yookassa),
          billing: {
            appUrl: present(own.APP_URL),
            renewalNoticeDays: own.BILLING_RENEWAL_NOTICE_DAYS,
            pastDueDays: own.BILLING_PAST_DUE_DAYS,
            tickSeconds: own.BILLING_TICK_SECONDS,
          },
          previews,
          releaseApi,
        }
      : null,
    mcp: hasMcp
      ? {
          appEnv,
          port: own.MCP_PORT,
          allowedHosts: present(mcpHosts),
          db: present(db),
          vault: present(vault),
          contentProfile: own.MCP_CONTENT_PROFILE,
          browserProfile: own.MCP_BROWSER_PROFILE,
          storage: mcpStorage,
          previewUpstreamHost: own.PREVIEW_UPSTREAM_HOST,
          preview: previewAddress,
        }
      : null,
    llm: hasLlm
      ? {
          ...present(llm),
          db: present(db),
          vault: present(vault),
          metricsToken: own.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
        }
      : null,
    runner: hasRunner
      ? {
          appEnv,
          coreUrl: present(coreUrl),
          tokenFile: present(own.RUNNER_TOKEN_FILE),
          caFile: own.RUNNER_CORE_CA_FILE ?? null,
          s3Origin,
          maxTurns: own.RUNNER_MAX_TURNS,
          sandbox: present(sandbox),
        }
      : null,
    preview,
  }
}

/** An origin; with `bucket`, optionally followed by one S3 bucket name as its path. */
const isOrigin = (url: URL, { bucket = false } = {}) =>
  !url.username &&
  !url.password &&
  (url.pathname === '/' ||
    (bucket && /^\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/?$/.test(url.pathname))) &&
  !url.search &&
  !url.hash

/** Every missing section was reported above, so this only narrows the type. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Configuration section is missing')
  return value
}
