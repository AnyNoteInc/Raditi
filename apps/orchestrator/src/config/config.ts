import { isAbsolute } from 'node:path'

import { agentDriverConfigFromEnv, type AgentDriverConfig } from '@repo/agent-drivers'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  envProblems,
  envVar,
  isProduction,
  turnExecutorKinds,
  type AppEnv,
  type Env,
  type GitProviderKind,
  type TurnExecutorKind,
} from '@repo/domain'
import { mailerConfigFromEnv, type MailerConfig } from '@repo/mail'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { sandboxConfigFromEnv, type SandboxConfig } from '@repo/sandbox-providers'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { yookassaConfigFromEnv, type YookassaConfig } from '@repo/yookassa'
import { z } from 'zod'

import type { RunnerConfig } from '../runner/runner-config.ts'
import { poolControlOrigin } from '../llm/pool-probe-client.ts'
import { parseMcpHosts } from '../mcp/mcp-policy.ts'
import { llmConfigFromEnv, type LlmConfig } from './llm-config.ts'
import { isPrivateAddress } from './private-address.ts'
import {
  parseRunnerTokens,
  runnerCredentialAddress,
  type RunnerTokenHashes,
} from './runner-tokens.ts'

export type { RunnerConfig }
export type LlmRoleConfig = LlmConfig & { db: DbConfig; vault: VaultConfig; metricsToken: string }

/** Process roles (spec §5, §6): one image, the role is picked by ORCHESTRATOR_ROLES. */
export const orchestratorRoles = ['core', 'mcp', 'runner', 'llm'] as const
export type OrchestratorRole = (typeof orchestratorRoles)[number]

export const DEFAULT_CORE_PORT = 8081
export const DEFAULT_MCP_PORT = 8082
/** Runner VMs reach only this port of core, on the private network (spec §19). */
export const DEFAULT_RUNNER_API_PORT = 8083
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
  /** The runner API listener; null with the local executor. */
  runnerApi: RunnerApiConfig | null
  /**
   * Where site repositories live (spec §10). null — git is not configured: no turn can run,
   * the rest of core does. Plain http is never a git transport (spec §19).
   */
  git: GitConfig | null
  /**
   * The ЮKassa shop for renewal charges. null — payments are off (both credentials empty):
   * nothing is charged, the rest of core runs. Holds the shop key: never log it.
   */
  yookassa: YookassaConfig | null
}

/** Our Gitea over HTTPS. Holds the bot token: never log it. */
export interface GitConfig {
  kind: GitProviderKind
  /** Web root without a trailing slash: the API and the only origin git clones from and pushes to. */
  baseUrl: string
  token: string
  /** PEM bundle of the server's CA for git; the API client takes NODE_EXTRA_CA_CERTS. */
  caFile: string | null
}

export interface RunnerApiConfig {
  port: number
  /** SHA-256 of runner tokens by runner id; the tokens themselves stay on the VMs. */
  tokens: RunnerTokenHashes
}

/**
 * Published-content tools of the mcp role. `off` — only site_info; `local` — wp_rest and
 * restore against sites connected on this machine. Production allows only `off`: the gate that
 * opens content there is the owner's decision (spec §20).
 */
export const mcpContentProfiles = ['off', 'local'] as const
export type McpContentProfile = (typeof mcpContentProfiles)[number]

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
  /** null while the content profile is off. Holds the S3 key: never log it. */
  storage: McpStorageConfig | null
}

export interface OrchestratorConfig {
  appEnv: AppEnv
  roles: OrchestratorRole[]
  /** null when the role is not selected for this process. */
  core: CoreConfig | null
  mcp: McpConfig | null
  runner: RunnerConfig | null
  llm: LlmRoleConfig | null
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
  ORCHESTRATOR_ROLES: envVar(z.string().optional()),
  ORCHESTRATOR_PORT: port(DEFAULT_CORE_PORT),
  MCP_PORT: port(DEFAULT_MCP_PORT),
  MCP_ALLOWED_HOSTS: envVar(z.string().optional()),
  MCP_CONTENT_PROFILE: envVar(
    z
      .enum(mcpContentProfiles, { error: `must be one of ${mcpContentProfiles.join(', ')}` })
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
  GIT_CA_FILE: envVar(z.string().optional()),
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
        'GIT_CA_FILE',
      ],
    ],
    // core serves /metrics and calls the pool probe of llm with it; llm checks it.
    [hasCore || hasLlm, ['METRICS_TOKEN']],
    [hasMcp, ['MCP_PORT', 'MCP_ALLOWED_HOSTS', 'MCP_CONTENT_PROFILE']],
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
  if (hasCore) {
    if (own.REDIS_URL === undefined) problems.push('REDIS_URL: required for the core role')
    if (production && turnExecutor !== 'runner')
      problems.push('TURN_EXECUTOR: production runs turns only on runner VMs (runner)')
    if (turnExecutor === 'runner') {
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
  const db = hasCore || hasMcp || hasLlm ? section(() => dbConfigFromEnv(env)) : undefined
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
  if (hasMcp && own.MCP_CONTENT_PROFILE !== 'off') {
    if (production)
      problems.push(
        'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
      )
    else {
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
        }
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
          runnerApi,
          git,
          yookassa: present(yookassa),
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
          storage: mcpStorage,
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
