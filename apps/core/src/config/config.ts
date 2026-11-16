import { agentDriverConfigFromEnv, type AgentDriverConfig } from '@repo/agent-drivers'
import { ConfigError } from '@repo/app-bootstrap'
import { browserWorkerOrigin } from '@repo/browser-link'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  coreGitAppsFromEnv,
  type GitAppsConfig,
  type GithubAppCoreCredentials,
} from '@repo/git-providers'
import {
  appEnvSchema,
  browserWorkerTokenSchema,
  envProblems,
  envVar,
  parseEnv,
  isProduction,
  runnerIdSchema,
  sandboxRuntimes,
  turnExecutorKinds,
  type AppEnv,
  type Env,
  type SandboxRuntime,
  type TurnExecutorKind,
} from '@repo/domain'
import { mailerConfigFromEnv, type MailerConfig } from '@repo/mail'
import {
  leadsTelegramConfigFromEnv,
  telegramConfigFromEnv,
  type LeadsTelegramConfig,
  type TelegramConfig,
} from '@repo/telegram'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { sandboxConfigFromEnv, type SandboxConfig } from '@repo/sandbox-providers'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { yookassaConfigFromEnv, type YookassaConfig } from '@repo/yookassa'
import { z } from 'zod'
import {
  isLoopbackAddress,
  isPrivateAddress,
  parseRefusedSubnets,
  type RefusedSubnet,
} from '@repo/ip-address'

import { gitEnvConfig, type GitEnvConfig } from '../git-worker/config.ts'
import { poolControlOrigin } from '../llm/pool-probe-client.ts'
import {
  parseRunnerTokens,
  runnerCredentialAddress,
  type RunnerTokenHashes,
} from './runner-tokens.ts'

export { ConfigError }

export const DEFAULT_CORE_PORT = 8081
/** Runner VMs reach only this port of core, on the private network (spec §19). */
export const DEFAULT_RUNNER_API_PORT = 8083
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
  /**
   * The bot of the leads of the landing (docs/plan/65-landing-platforms-leads.md, Л9); null:
   * leads wait in their queue until it is set.
   */
  leads: LeadsTelegramConfig | null
  /**
   * The bot of the chat in Telegram (docs/plan/80-telegram.md): core reads its updates and hands
   * each to web at `intakeUrl`, and sends what it says. null — TELEGRAM_BOT_TOKEN is empty.
   */
  telegram: CoreTelegramConfig | null
  /**
   * Web Push of the chats that wait for their client (docs/plan/75-chat-input-output.md, ВВ8):
   * the VAPID keys, both or neither; null — browsers are not told, letters still go.
   */
  webPush: { publicKey: string; privateKey: string } | null
  /** Where turns run: core's own Docker (local, not in production) or runner VMs. */
  turnExecutor: TurnExecutorKind
  /**
   * SANDBOX_WARM_MINUTES with the local executor: how long the container of a completed turn
   * waits for the next turn of its task (owner's decision of 26.10.2026; spec §8, «Тёплая
   * песочница»). 0 — every turn gets a new container, as always with runner VMs.
   */
  sandboxWarmMs: number
  /** WORKSPACE_TURN_LIMIT: the passes of one workspace that run at once (plan 70, ВР13). */
  workspaceTurnLimit: number
  /**
   * With runner VMs: the runtime they run turns under (SANDBOX_RUNTIME, one set of variables
   * with the runners at MVP; only runsc in production). A runner refuses a turn spec of another
   * runtime. Absent with the local executor, whose `sandbox` names it.
   */
  runnerRuntime?: SandboxRuntime
  /** The runner API listener; null with the local executor. */
  runnerApi: RunnerApiConfig | null
  /**
   * The ЮKassa shop for renewal charges. null — payments are off (both credentials empty):
   * nothing is charged, the rest of core runs. Holds the shop key: never log it.
   */
  yookassa: YookassaConfig | null
  billing: BillingConfig
  /**
   * The browser worker of tasks in the cloud browser (docs/plan/57-browser-tasks.md, Б10, Б18);
   * null — BROWSER_WORKER_URL is unset: such tasks are refused `unavailable`, the rest runs.
   */
  browser: BrowserWorkerConfig | null
  /**
   * Trusted git of the repositories of projects (docs/plan/84-projects.md, ПР12, ПР33): the volume
   * core shares with its git worker; GIT_CA_FILE and GIT_ALLOW_LOOPBACK only outside production.
   */
  git: GitEnvConfig
  /**
   * The apps of the repositories of projects (docs/plan/84-projects.md, §4.2, §4.5): the OAuth app
   * on gitlab.com (renewal of tokens), the GitHub App's installation tokens (Э10), the secret of
   * the cards core checks again (ПР15) and, outside production, the fakes of a stand.
   */
  gitApps: GitAppsConfig<GithubAppCoreCredentials>
  /**
   * SANDBOX_EGRESS_REFUSED_SUBNETS: the address of a git host in them is refused, as the git
   * worker refuses it (docs/plan/84-projects.md, §4.6); blank — only the public check.
   */
  gitRefusedSubnets: RefusedSubnet[]
}

/** Where core reaches the browser worker's internal API. Holds its token: never log it. */
export interface BrowserWorkerConfig {
  /** The worker's origin, `http://127.0.0.1:8086`. */
  url: string
  /** `Authorization: Bearer` of every call. */
  token: string
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

export interface RunnerApiConfig {
  port: number
  /** SHA-256 of runner tokens by runner id; the tokens themselves stay on the VMs. */
  tokens: RunnerTokenHashes
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
  // VAPID of Web Push (docs/plan/75, ВВ8): URL-safe base64 of the P-256 keys, as `web-push`
  // generates them. The private one is a secret: rendered from OpenBao on the host, never logged.
  WEB_PUSH_VAPID_PUBLIC: envVar(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{80,100}$/)
      .optional(),
  ),
  WEB_PUSH_PRIVATE_KEY: envVar(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{40,50}$/)
      .optional(),
  ),
  CORE_PORT: port(DEFAULT_CORE_PORT),
  RUNNER_API_PORT: port(DEFAULT_RUNNER_API_PORT),
  TURN_EXECUTOR: envVar(z.enum(turnExecutorKinds).optional()),
  RUNNER_TOKENS: envVar(z.string().optional()),
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
  // A waiting container is leased for its wait (docs/plan/70-turn-without-time-limit.md, ВР10).
  SANDBOX_WARM_MINUTES: envVar(z.coerce.number().int().min(0).max(10).default(10)),
  // How many passes of one workspace run at once (owner's requests of 06.11 and 12.11.2026,
  // plan 70, ВР13): the next one waits for the agents.
  WORKSPACE_TURN_LIMIT: envVar(z.coerce.number().int().min(1).max(64).default(8)),
  // The deployment label of core's own turn containers with TURN_EXECUTOR=local: core lists and
  // collects only those, so two trees or a stand on one Docker daemon never remove each other's
  // turns. It is the provider's runner label, so it takes the form of a runner id.
  SANDBOX_DEPLOYMENT: envVar(runnerIdSchema.default('local')),
  // The browser worker (docs/plan/57-browser-tasks.md, Б10): its internal origin and the bearer
  // token of its API, one visible ASCII word.
  BROWSER_WORKER_URL: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  // The rule every app reads the worker's token by (32 to 4096 visible ASCII characters): one
  // token opens every session of the worker.
  BROWSER_WORKER_TOKEN: envVar(browserWorkerTokenSchema.optional()),
})

/** Builds the configuration once at startup; throws ConfigError listing every problem. */
export function loadConfig(env: Env): CoreConfig {
  const shared = ownEnvSchema.pick({ APP_ENV: true }).safeParse(env)
  if (!shared.success) throw new ConfigError(envProblems(shared.error), 'core')
  const appEnv = shared.data.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []

  // A shared local .env may contain settings for other processes. Validate only what this
  // process uses.
  const selected: Record<string, string | undefined> = { APP_ENV: shared.data.APP_ENV }
  const fields: [boolean, readonly string[]][] = [
    [
      true,
      [
        'CORE_PORT',
        'TURN_EXECUTOR',
        'REDIS_URL',
        'LLM_CONTROL_URL',
        'LLM_POOL_MIN_TURN_HEADROOM_PCT',
        'APP_URL',
        'BILLING_RENEWAL_NOTICE_DAYS',
        'BILLING_PAST_DUE_DAYS',
        'BILLING_TICK_SECONDS',
        'WEB_PUSH_VAPID_PUBLIC',
        'WEB_PUSH_PRIVATE_KEY',
        'SANDBOX_WARM_MINUTES',
        'WORKSPACE_TURN_LIMIT',
        'BROWSER_WORKER_URL',
      ],
    ],
    // The token only with the worker it opens: the shared .env holds it for the worker too.
    [Boolean(env.BROWSER_WORKER_URL?.trim()), ['BROWSER_WORKER_TOKEN']],
    // core serves /metrics and calls the pool probe of llm with it.
    [true, ['METRICS_TOKEN']],
    [
      (env.TURN_EXECUTOR?.trim() || (production ? 'runner' : 'local')) === 'runner',
      ['RUNNER_API_PORT', 'RUNNER_TOKENS'],
    ],
    // The label of core's own turn containers; on runner VMs the runner's token gives it.
    [
      (env.TURN_EXECUTOR?.trim() || (production ? 'runner' : 'local')) === 'local',
      ['SANDBOX_DEPLOYMENT'],
    ],
  ]
  for (const [enabled, names] of fields)
    if (enabled) for (const name of names) selected[name] = env[name]
  const parsed = ownEnvSchema.safeParse(selected)
  if (!parsed.success) throw new ConfigError([...problems, ...envProblems(parsed.error)], 'core')
  const own = parsed.data
  const turnExecutor = own.TURN_EXECUTOR ?? (production ? 'runner' : 'local')
  let runnerApi: RunnerApiConfig | null = null
  let runnerRuntime: SandboxRuntime | undefined
  {
    if (own.REDIS_URL === undefined) problems.push('REDIS_URL: required for the core role')
    if ((own.WEB_PUSH_VAPID_PUBLIC === undefined) !== (own.WEB_PUSH_PRIVATE_KEY === undefined))
      problems.push('WEB_PUSH_VAPID_PUBLIC and WEB_PUSH_PRIVATE_KEY: set both or neither')
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
      if (own.CORE_PORT === own.RUNNER_API_PORT)
        problems.push('RUNNER_API_PORT: must differ from CORE_PORT')
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

  const section = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }
  const db = section(() => dbConfigFromEnv(env))
  const vault = section(() => vaultConfigFromEnv(env))
  const storage = section(() => storageConfigFromEnv(env))
  // A presigned URL is a bearer capability a runner VM follows over the cloud's network.
  if (production && storage) {
    const [name, origin] = storage.presignEndpoint
      ? ['S3_RUNNER_ENDPOINT', storage.presignEndpoint]
      : ['S3_ENDPOINT', storage.endpoint]
    if (new URL(origin).protocol !== 'https:')
      problems.push(`${name}: must use https in production (runners follow presigned URLs)`)
  }
  // Docker is driven by the runner, or by core itself only with the local executor.
  const coreSandbox = turnExecutor === 'local'
  const sandbox = coreSandbox ? section(() => sandboxConfigFromEnv(env)) : undefined
  const mailer = section(() => mailerConfigFromEnv(env))
  const leads = section(() => leadsTelegramConfigFromEnv(env))
  const telegram = section(() => coreTelegramConfigFromEnv(env))
  // Only core charges renewals; the other roles neither need nor read the shop settings.
  const yookassa = section(() => yookassaConfigFromEnv(env))
  const agentDrivers = section(() =>
    agentDriverConfigFromEnv(
      production || env.SANDBOX_IMAGE?.trim()
        ? env
        : { ...env, SANDBOX_IMAGE: SANDBOX_IMAGE_PLACEHOLDER },
    ),
  )

  let llmControlUrl: string | undefined
  {
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
  let browser: BrowserWorkerConfig | null = null
  if (own.BROWSER_WORKER_URL !== undefined) {
    let origin: string | null = null
    try {
      origin = browserWorkerOrigin(own.BROWSER_WORKER_URL)
    } catch {
      problems.push(
        'BROWSER_WORKER_URL: expected an http(s) origin (no path, credentials or query)',
      )
    }
    // Inside the perimeter plain http goes to a private address only (spec §19).
    const url = origin ? new URL(origin) : null
    if (
      url &&
      production &&
      url.protocol === 'http:' &&
      !isPrivateAddress(url.hostname) &&
      !isLoopbackAddress(url.hostname)
    )
      problems.push(
        'BROWSER_WORKER_URL: plain http only to a private or loopback IP address in production (spec §19)',
      )
    if (own.BROWSER_WORKER_TOKEN === undefined)
      problems.push('BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL')
    else if (origin) browser = { url: origin, token: own.BROWSER_WORKER_TOKEN }
  }

  const git = gitEnvConfig(env)
  problems.push(...git.problems)
  const gitRefusedSubnets = parseRefusedSubnets(env.SANDBOX_EGRESS_REFUSED_SUBNETS?.trim() ?? '')
  if (gitRefusedSubnets === null)
    problems.push('SANDBOX_EGRESS_REFUSED_SUBNETS: expected subnets such as 10.10.0.0/16')
  const gitApps = section(() => coreGitAppsFromEnv(env))

  if (problems.length > 0) throw new ConfigError(problems, 'core')

  return {
    appEnv,
    port: own.CORE_PORT,
    redisUrl: present(own.REDIS_URL),
    metricsToken: own.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
    ...(llmControlUrl === undefined ? {} : { llmControlUrl }),
    minTurnHeadroomPct: own.LLM_POOL_MIN_TURN_HEADROOM_PCT,
    db: present(db),
    storage: present(storage),
    vault: present(vault),
    sandbox: coreSandbox ? { ...present(sandbox), runnerId: own.SANDBOX_DEPLOYMENT } : null,
    agentDrivers: present(agentDrivers),
    mailer: present(mailer),
    leads: leads ?? null,
    telegram: telegram ?? null,
    webPush:
      own.WEB_PUSH_VAPID_PUBLIC && own.WEB_PUSH_PRIVATE_KEY
        ? { publicKey: own.WEB_PUSH_VAPID_PUBLIC, privateKey: own.WEB_PUSH_PRIVATE_KEY }
        : null,
    turnExecutor,
    sandboxWarmMs: turnExecutor === 'local' ? own.SANDBOX_WARM_MINUTES * 60_000 : 0,
    workspaceTurnLimit: own.WORKSPACE_TURN_LIMIT,
    ...(runnerRuntime ? { runnerRuntime } : {}),
    runnerApi,
    yookassa: present(yookassa),
    billing: {
      appUrl: present(own.APP_URL),
      renewalNoticeDays: own.BILLING_RENEWAL_NOTICE_DAYS,
      pastDueDays: own.BILLING_PAST_DUE_DAYS,
      tickSeconds: own.BILLING_TICK_SECONDS,
    },
    browser,
    git: git.config,
    gitApps: present(gitApps),
    gitRefusedSubnets: gitRefusedSubnets ?? [],
  }
}

/** Every missing section was reported above, so this only narrows the type. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Configuration section is missing')
  return value
}

export interface CoreTelegramConfig {
  bot: TelegramConfig
  /** TELEGRAM_INTAKE_URL: where core posts the updates, the route `/api/webhooks/telegram` of web. */
  intakeUrl: string
}

const telegramIntakeSchema = z.object({
  TELEGRAM_INTAKE_URL: envVar(
    z
      .url({ protocol: /^https?$/ })
      .refine((url) => new URL(url).pathname === '/api/webhooks/telegram', {
        message: 'must be the route /api/webhooks/telegram of web',
      })
      .optional(),
  ),
})

/** The bot and where its updates go; null — the bot is off. */
export function coreTelegramConfigFromEnv(env: Env): CoreTelegramConfig | null {
  const bot = telegramConfigFromEnv(env)
  const { TELEGRAM_INTAKE_URL } = parseEnv('telegram', telegramIntakeSchema, env)
  if (bot === null) return null
  if (TELEGRAM_INTAKE_URL === undefined)
    throw new Error(
      'Invalid telegram configuration: TELEGRAM_INTAKE_URL is required when the bot is on',
    )
  return { bot, intakeUrl: TELEGRAM_INTAKE_URL }
}
