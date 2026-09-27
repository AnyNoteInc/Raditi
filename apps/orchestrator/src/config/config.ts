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
  type TurnExecutorKind,
} from '@repo/domain'
import { mailerConfigFromEnv, type MailerConfig } from '@repo/mail'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { sandboxConfigFromEnv, type SandboxConfig } from '@repo/sandbox-providers'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { z } from 'zod'

import type { RunnerConfig } from '../runner/runner-config.ts'
import { isPrivateAddress } from './private-address.ts'
import { parseRunnerTokens, type RunnerTokenHashes } from './runner-tokens.ts'

export type { RunnerConfig }

/** Process roles (spec §5, §6): one image, the role is picked by ORCHESTRATOR_ROLES. */
export const orchestratorRoles = ['core', 'mcp', 'runner'] as const
export type OrchestratorRole = (typeof orchestratorRoles)[number]

export const DEFAULT_CORE_PORT = 8081
export const DEFAULT_MCP_PORT = 8082
/** Runner VMs reach only this port of core, on the private network (spec §19). */
export const DEFAULT_RUNNER_API_PORT = 8083
/** Locally both HTTP roles share one process (spec §6). */
const DEFAULT_DEV_ROLES: OrchestratorRole[] = ['core', 'mcp']

/** Everything the core role needs. Holds credentials: never log it. */
export interface CoreConfig {
  appEnv: AppEnv
  port: number
  redisUrl: string
  metricsToken: string
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
}

export interface RunnerApiConfig {
  port: number
  /** SHA-256 of runner tokens by runner id; the tokens themselves stay on the VMs. */
  tokens: RunnerTokenHashes
}

/** The MCP gateway: its own port; database and Vault only (its own AppRole in production). */
export interface McpConfig {
  appEnv: AppEnv
  port: number
  db: DbConfig
  vault: VaultConfig
}

export interface OrchestratorConfig {
  appEnv: AppEnv
  roles: OrchestratorRole[]
  /** null when the role is not selected for this process. */
  core: CoreConfig | null
  mcp: McpConfig | null
  runner: RunnerConfig | null
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
  METRICS_TOKEN: envVar(z.string().optional()),
})

/** Platform credentials a sandbox VM must never hold (spec §8, §19). */
function isPlatformVariable(name: string): boolean {
  return (
    name === 'DATABASE_URL' ||
    name === 'REDIS_URL' ||
    name.startsWith('VAULT_') ||
    name.startsWith('S3_')
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
  const parsed = ownEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(envProblems(parsed.error))
  const own = parsed.data
  const appEnv = own.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []

  const roles = parseRoles(own.ORCHESTRATOR_ROLES, production, problems)
  const hasCore = roles.includes('core')
  const hasMcp = roles.includes('mcp')
  const hasRunner = roles.includes('runner')
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
      if (!isOrigin(s3))
        problems.push('RUNNER_S3_ORIGIN: expected an origin (no path, credentials or query)')
      // The cloud's S3 is outside the private network: presigned URLs go there over TLS only.
      else if (production && s3.protocol !== 'https:')
        problems.push('RUNNER_S3_ORIGIN: must use https in production')
      s3Origin = s3.origin
    }
    if (own.RUNNER_TOKEN_FILE === undefined)
      problems.push(
        'RUNNER_TOKEN_FILE: required for the runner role (the token is never an env value)',
      )
    else if (!isAbsolute(own.RUNNER_TOKEN_FILE))
      problems.push('RUNNER_TOKEN_FILE: must be an absolute path')
    if (own.RUNNER_CORE_CA_FILE !== undefined && !isAbsolute(own.RUNNER_CORE_CA_FILE))
      problems.push('RUNNER_CORE_CA_FILE: must be an absolute path')
    // Names only: the values are exactly what must not be on a sandbox VM.
    if (production)
      for (const name of Object.keys(env).filter(isPlatformVariable).sort())
        if (env[name]?.trim())
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
  const db = hasCore || hasMcp ? section(() => dbConfigFromEnv(env)) : undefined
  const vault = hasCore || hasMcp ? section(() => vaultConfigFromEnv(env)) : undefined
  const storage = hasCore ? section(() => storageConfigFromEnv(env)) : undefined
  // Docker is driven by the runner, or by core itself only with the local executor.
  const coreSandbox = hasCore && turnExecutor === 'local'
  const sandbox = coreSandbox || hasRunner ? section(() => sandboxConfigFromEnv(env)) : undefined
  const mailer = hasCore ? section(() => mailerConfigFromEnv(env)) : undefined
  const agentDrivers = hasCore ? section(() => agentDriverConfigFromEnv(env)) : undefined

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
          db: present(db),
          storage: present(storage),
          vault: present(vault),
          sandbox: coreSandbox ? present(sandbox) : null,
          agentDrivers: present(agentDrivers),
          mailer: present(mailer),
          turnExecutor,
          runnerApi,
        }
      : null,
    mcp: hasMcp ? { appEnv, port: own.MCP_PORT, db: present(db), vault: present(vault) } : null,
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

const isOrigin = (url: URL) =>
  !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash

/** Every missing section was reported above, so this only narrows the type. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Configuration section is missing')
  return value
}
