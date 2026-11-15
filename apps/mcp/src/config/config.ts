import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  browserSessionTimings,
  browserSettingBounds,
  browserWorkerTokenSchema,
  envProblems,
  envVar,
  isProduction,
  pagesAddressFromEnv,
  type PagesAddress,
  type AppEnv,
  type Env,
} from '@repo/domain'
import { ConfigError } from '@repo/app-bootstrap'
import { browserWorkerOrigin } from '@repo/browser-link'
import { isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { z } from 'zod'

import { parseMcpHosts } from './allowed-hosts.ts'

export { ConfigError }

export const DEFAULT_MCP_PORT = 8082

/**
 * The browser worker (`apps/browser`, docs/plan/57-browser-tasks.md, Б10, Б20): where the `web`
 * tools of a browser task go. A product path, not a local profile: allowed in production. Holds
 * the worker's token: never log it.
 */
export interface McpBrowserWorkerConfig {
  /** The worker's internal origin, `http://127.0.0.1:8086`. */
  url: string
  token: string
  /** BROWSER_SESSION_MAX_HOURS, the worker's own setting: the deadline of a session opened here. */
  sessionMaxHours: number
}

/**
 * The agent's web search (`raditi_search_web`, Yandex Search API; spec §20, «Веб-поиск агента —
 * 08.11.2026» and «… — Yandex Search API, 11.11.2026»). Its key is no setting: it is read from Vault
 * (`WEB_SEARCH_KEY_PATH`), where the operator command puts it, and the tool is there while it is.
 */
export interface McpWebSearchConfig {
  /** How long one request may take, in milliseconds. */
  timeoutMs: number
  /**
   * Calls a turn and the whole service in a calendar month (Moscow) may make. A workspace has no
   * limit of its own: its credits are (a turn runs only on a reserve of them).
   */
  limits: { turn: number; serviceMonth: number }
}

/** Pilot values (spec §20): 3 a turn, 5 000 a month for the whole service. */
export const webSearchDefaults = {
  timeoutSeconds: 10,
  turn: 3,
  serviceMonth: 5000,
} as const

/** The MCP gateway: its own port, database and Vault (its own AppRole in production). */
export interface McpConfig {
  appEnv: AppEnv
  port: number
  /** Exact upstream Host values after sandbox-gw rewriting (without ports). */
  allowedHosts: string[]
  db: DbConfig
  vault: VaultConfig
  /** A configuration a stand builds by hand may leave it out: the defaults then. */
  webSearch?: McpWebSearchConfig
  /** null — the worker is not configured: browser tasks get no `web` tools here. */
  browserWorker?: McpBrowserWorkerConfig | null
  /**
   * Where published pages answer (docs/plan/69-pages.md, Ст3): the address `page_publish` gives
   * the agent. null — no pages: the family `pages` is not offered.
   */
  pages: PagesAddress | null
}

/**
 * What a configuration turns on. A configuration a stand builds by hand may leave out the
 * browser worker: it is then off.
 */
export function mcpProfilesOf(config: McpConfig) {
  return {
    // The worker is no profile — a product path, production too (Б20) — but it turns the `web`
    // tools on the same way; a configuration written before it has none: no web tools.
    worker: config.browserWorker ?? null,
    // A product path, like the worker: the tool is offered while its key is in Vault.
    webSearch: config.webSearch ?? {
      timeoutMs: webSearchDefaults.timeoutSeconds * 1000,
      limits: { turn: webSearchDefaults.turn, serviceMonth: webSearchDefaults.serviceMonth },
    },
  }
}

const port = (fallback: number) =>
  envVar(z.coerce.number().int().min(1).max(65_535).default(fallback))

const count = (fallback: number, max: number) =>
  envVar(z.coerce.number().int().min(0).max(max).default(fallback))

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  MCP_PORT: port(DEFAULT_MCP_PORT),
  MCP_ALLOWED_HOSTS: envVar(z.string().optional()),
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
  WEB_SEARCH_TIMEOUT_SECONDS: envVar(
    z.coerce.number().int().min(1).max(30).default(webSearchDefaults.timeoutSeconds),
  ),
  WEB_SEARCH_TURN_LIMIT: count(webSearchDefaults.turn, 100),
  WEB_SEARCH_SERVICE_MONTH_LIMIT: count(webSearchDefaults.serviceMonth, 10_000_000),
  // Published pages (docs/plan/69-pages.md): the address the agent is given.
  PAGES_BASE_DOMAIN: envVar(z.string().optional()),
  PAGES_PUBLIC_PORT: envVar(z.coerce.number().int().min(1).max(65_535).optional()),
  BROWSER_SESSION_MAX_HOURS: envVar(
    z.coerce
      .number()
      .int()
      .min(browserSettingBounds.maxHours.min)
      .max(browserSettingBounds.maxHours.max)
      .default(browserSessionTimings.maxHours),
  ),
})

/**
 * The settings of the MCP gateway (spec §5, §8) and nothing else: the database, Vault, its own
 * port, the browser worker, the limits of the web search and the address of pages. It reads none
 * of the git, billing, Redis, S3 or runner settings.
 * Lists every problem at once.
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
  const pages = pagesAddressFromEnv(own, production, problems)
  // The worker's address needs its token (Б10); the token alone is the worker's own in the one
  // .env of the platform and is not read here — the same rule as core's.
  if (own.BROWSER_WORKER_URL !== undefined) {
    if (own.BROWSER_WORKER_TOKEN === undefined)
      problems.push('BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL')
    // The token goes in every request: plain http only inside the perimeter (spec §19).
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
  if (problems.length > 0 || db === undefined || vault === undefined || allowedHosts === undefined)
    throw new ConfigError(problems, 'mcp')

  return {
    appEnv,
    port: own.MCP_PORT,
    allowedHosts,
    db,
    vault,
    browserWorker:
      own.BROWSER_WORKER_URL !== undefined && own.BROWSER_WORKER_TOKEN !== undefined
        ? {
            url: browserWorkerOrigin(own.BROWSER_WORKER_URL),
            token: own.BROWSER_WORKER_TOKEN,
            sessionMaxHours: own.BROWSER_SESSION_MAX_HOURS,
          }
        : null,
    webSearch: {
      timeoutMs: own.WEB_SEARCH_TIMEOUT_SECONDS * 1000,
      limits: { turn: own.WEB_SEARCH_TURN_LIMIT, serviceMonth: own.WEB_SEARCH_SERVICE_MONTH_LIMIT },
    },
    pages,
  }
}
