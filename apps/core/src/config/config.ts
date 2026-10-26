import { isAbsolute } from 'node:path'

import { agentDriverConfigFromEnv, type AgentDriverConfig } from '@repo/agent-drivers'
import { ConfigError } from '@repo/app-bootstrap'
import { browserWorkerOrigin } from '@repo/browser-link'
import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  browserWorkerTokenSchema,
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
  browserSessionTimings,
  browserSettingBounds,
  previewRuntimes,
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
import { ipLiteral, isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'

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
/** The release API of core: deploy jobs reach only this port (plan 53, Р32). */
export const DEFAULT_RELEASE_API_PORT = previewDefaults.releaseApiPort
/** The gateway of previews (apps/preview): core builds the relay of the agent's browser to its port. */
export const DEFAULT_PREVIEW_GATEWAY_PORT = previewDefaults.gatewayPort
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
   * SANDBOX_INTERNET: the open internet of the agent of a repository turn (owner's decision of
   * 26.10.2026) — every public host through the egress proxy of sandbox-gw, and the site's
   * skills; false (`off`) — only the hosts of the client's variables, no skills.
   */
  sandboxInternet: boolean
  /**
   * SANDBOX_WARM_MINUTES with the local executor: how long the container of a completed turn
   * waits for the next turn of its task (owner's decision of 26.10.2026; spec §8, «Тёплая
   * песочница»). 0 — every turn gets a new container, as always with runner VMs.
   */
  sandboxWarmMs: number
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
  /**
   * The browser worker of tasks in the cloud browser (docs/plan/57-browser-tasks.md, Б10, Б18);
   * null — BROWSER_WORKER_URL is unset: such tasks are refused `unavailable`, the rest runs.
   */
  browser: BrowserWorkerConfig | null
}

/** Where core reaches the browser worker's internal API. Holds its token: never log it. */
export interface BrowserWorkerConfig {
  /** The worker's origin, `http://127.0.0.1:8086`. */
  url: string
  /** `Authorization: Bearer` of every call. */
  token: string
  /**
   * BROWSER_SESSION_MAX_HOURS, the worker's own setting: the hard deadline core writes on the
   * session it opens — the worker closes it then, and so does core's collector.
   */
  sessionMaxHours: number
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
  // The open internet of the agent (owner's decision of 26.10.2026); `off` — as before it.
  SANDBOX_INTERNET: envVar(z.enum(['open', 'off']).default('open')),
  // A container never outlives the deadline of its first turn, and waits only while it leaves
  // the next turn half of one (WARM_MIN_LEFT_MS): more than 10 minutes would never be waited.
  SANDBOX_WARM_MINUTES: envVar(z.coerce.number().int().min(0).max(10).default(10)),
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
  // The browser worker (docs/plan/57-browser-tasks.md, Б10): its internal origin and the bearer
  // token of its API, one visible ASCII word.
  BROWSER_WORKER_URL: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  // The rule every app reads the worker's token by (32 to 4096 visible ASCII characters): one
  // token opens every session of the worker.
  BROWSER_WORKER_TOKEN: envVar(browserWorkerTokenSchema.optional()),
  BROWSER_SESSION_MAX_HOURS: envVar(
    z.coerce
      .number()
      .int()
      .min(browserSettingBounds.maxHours.min)
      .max(browserSettingBounds.maxHours.max)
      .default(browserSessionTimings.maxHours),
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
        'SANDBOX_INTERNET',
        'SANDBOX_WARM_MINUTES',
        'RELEASE_API_PORT',
        'RELEASE_API_HOST',
        'RELEASE_API_PUBLIC_URL',
        'RELEASE_START_TIMEOUT_MINUTES',
        'BROWSER_WORKER_URL',
      ],
    ],
    // The token only with the worker it opens: the shared .env holds it for the worker too.
    [
      Boolean(env.BROWSER_WORKER_URL?.trim()),
      ['BROWSER_WORKER_TOKEN', 'BROWSER_SESSION_MAX_HOURS'],
    ],
    // The address of a preview: core builds hostnames, the gateway routes by them.
    [true, ['PREVIEW_BASE_DOMAIN', 'PREVIEW_SCHEME', 'PREVIEW_PUBLIC_PORT']],
    [true, ['PREVIEW_UPSTREAM_HOST']],
    // core serves /metrics and calls the pool probe of llm with it.
    [true, ['METRICS_TOKEN']],
    [
      (env.TURN_EXECUTOR?.trim() || (production ? 'runner' : 'local')) === 'runner',
      ['RUNNER_API_PORT', 'RUNNER_TOKENS'],
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
  let git: GitConfig | null = null
  {
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
    !isPrivateAddress(own.PREVIEW_UPSTREAM_HOST) &&
    !isLoopbackAddress(own.PREVIEW_UPSTREAM_HOST)
  )
    problems.push(
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    )
  const previewAddress = previewAddressFromEnv(own, appEnv)
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
  {
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
      const otherPorts = [own.CORE_PORT, ...(runnerApi ? [runnerApi.port] : [])]
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
    else if (origin)
      browser = {
        url: origin,
        token: own.BROWSER_WORKER_TOKEN,
        sessionMaxHours: own.BROWSER_SESSION_MAX_HOURS,
      }
  }

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
    sandbox: coreSandbox ? present(sandbox) : null,
    agentDrivers: present(agentDrivers),
    mailer: present(mailer),
    turnExecutor,
    sandboxInternet: own.SANDBOX_INTERNET === 'open',
    sandboxWarmMs: turnExecutor === 'local' ? own.SANDBOX_WARM_MINUTES * 60_000 : 0,
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
    browser,
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
