import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import {
  appEnvSchema,
  browserSettingBounds,
  browserWorkerTokenSchema,
  browserSessionTimings,
  browserStreamDefaults,
  DIGEST_PINNED_IMAGE,
  envProblems,
  envVar,
  formatEgressHost,
  isProduction,
  parseEgressHost,
  previewImageSchema,
  previewRuntimes,
  type AppEnv,
  type BrowserLocalSite,
  type Env,
  type PreviewRuntimeKind,
} from '@repo/domain'
import { ConfigError } from '@repo/app-bootstrap'
import { ipLiteral } from '@repo/ip-address'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import {
  browserSessionRuntimeLimits,
  egressRefusedSubnetsVar,
  localSiteRoute,
  type DockerBrowserSessionConfig,
} from '@repo/sandbox-providers'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { z } from 'zod'

export { ConfigError }

export const DEFAULT_BROWSER_WORKER_PORT = 8086

/** Sessions one worker holds at most; each is a Chromium of its own. */
export const browserMaxSessionsBounds = Object.freeze({ min: 1, max: 64, default: 8 })
/** JPEG quality of the screencast. */
export const browserStreamQualityBounds = Object.freeze({ min: 10, max: 100 })

/** S3 of the worker: the connection and the inbox bucket alone (Б26, spec §14). */
export type BrowserInboxStorageConfig = Omit<StorageConfig, 'buckets' | 'presignEndpoint'> & {
  buckets: Pick<StorageConfig['buckets'], 'inbox'>
}

/**
 * The browser worker (docs/plan/57-browser-tasks.md, Б10–Б19): its port and token, the database,
 * the inbox of attachments, the Docker runtime of the sessions' containers and the numbers of a
 * session and its stream. Holds the token and the S3 key: never log it.
 */
export interface BrowserWorkerConfig {
  appEnv: AppEnv
  /**
   * BROWSER_WORKER_HOST: the address it listens on; undefined — every address (production, in its
   * container). Loopback elsewhere unless set.
   */
  host: string | undefined
  port: number
  /** BROWSER_WORKER_TOKEN: the bearer token of core, mcp and the stream gateway. */
  token: string
  /** METRICS_TOKEN: /metrics and the details of /health. */
  metricsToken: string
  db: DbConfig
  storage: BrowserInboxStorageConfig
  /**
   * The Docker runtime of the sessions; null — its images are not configured (outside production
   * only): the worker starts, and every session it is asked for is unavailable.
   */
  runtime: DockerBrowserSessionConfig | null
  /** BROWSER_EXTRA_HOSTS: `host:port` every session may reach besides its site's. */
  extraHosts: readonly string[]
  /** BROWSER_LOCAL_SITES (outside production): exact origins reached at fixed targets. */
  localSites: readonly BrowserLocalSite[]
  session: {
    idleMinutes: number
    maxHours: number
    maxSessions: number
  }
  stream: {
    maxFps: number
    quality: number
    window: number
  }
}

const bounded = (bounds: { min: number; max: number }, fallback: number) =>
  envVar(z.coerce.number().int().min(bounds.min).max(bounds.max).default(fallback))

const image = envVar(previewImageSchema.optional())

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  BROWSER_WORKER_HOST: envVar(
    z
      .string()
      .refine((host) => ipLiteral(host) === host, 'must be an IP address')
      .optional(),
  ),
  BROWSER_WORKER_PORT: envVar(
    z.coerce.number().int().min(1).max(65_535).default(DEFAULT_BROWSER_WORKER_PORT),
  ),
  // The rule every app reads the worker's token by (32 to 4096 visible ASCII characters).
  BROWSER_WORKER_TOKEN: envVar(
    z
      .string({ error: 'required (the bearer token of core, mcp and the stream gateway)' })
      .pipe(browserWorkerTokenSchema),
  ),
  METRICS_TOKEN: envVar(
    z
      .string()
      .regex(/^\S+$/, 'must not contain whitespace (it is sent as a Bearer token)')
      .optional(),
  ),
  BROWSER_RUNTIME: envVar(z.enum(previewRuntimes).optional()),
  // A local Unix socket only, never DOCKER_HOST or TCP.
  BROWSER_DOCKER_SOCKET: envVar(
    z
      .string()
      .regex(/^\/[^\0\r\n]*$/, 'must be an absolute Unix socket path')
      .optional(),
  ),
  BROWSER_IMAGE: image,
  BROWSER_FORWARDER_IMAGE: image,
  BROWSER_EGRESS_IMAGE: image,
  SANDBOX_NETWORK_GUARD_IMAGE: envVar(
    z.string().regex(DIGEST_PINNED_IMAGE, 'expected an image pinned by digest').optional(),
  ),
  SANDBOX_EGRESS_REFUSED_SUBNETS: egressRefusedSubnetsVar,
  BROWSER_EXTRA_HOSTS: envVar(z.string().optional()),
  BROWSER_LOCAL_SITES: envVar(z.string().optional()),
  BROWSER_SESSION_IDLE_MINUTES: bounded(
    browserSettingBounds.idleMinutes,
    browserSessionTimings.idleMinutes,
  ),
  BROWSER_SESSION_MAX_HOURS: bounded(browserSettingBounds.maxHours, browserSessionTimings.maxHours),
  BROWSER_MAX_SESSIONS: bounded(browserMaxSessionsBounds, browserMaxSessionsBounds.default),
  BROWSER_STREAM_MAX_FPS: bounded(browserSettingBounds.maxFps, browserStreamDefaults.maxFps),
  BROWSER_STREAM_QUALITY: bounded(browserStreamQualityBounds, browserStreamDefaults.quality),
  BROWSER_STREAM_WINDOW: bounded(browserSettingBounds.window, browserStreamDefaults.window),
})

/** What the worker reads of the S3 settings: the connection and its one bucket. */
const BROWSER_STORAGE_VARIABLES = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_BUCKET_INBOX',
] as const

/** BROWSER_EXTRA_HOSTS: comma-separated public `host[:port]`, each as the egress proxy spells it. */
function parseExtraHosts(text: string | undefined, problems: string[]): string[] {
  const hosts: string[] = []
  for (const part of (text ?? '').split(',').map((item) => item.trim())) {
    if (part === '') continue
    const parsed = parseEgressHost(part)
    if (parsed === null) {
      problems.push('BROWSER_EXTRA_HOSTS: expected public host names with an optional port')
      return []
    }
    hosts.push(formatEgressHost(parsed))
  }
  return [...new Set(hosts)]
}

/**
 * BROWSER_LOCAL_SITES: a JSON object `{"http://name[:port]": "host:port"}` — the exact origin of a
 * disposable local site and the fixed target its egress proxy forwards to, without DNS (Б11).
 * Never in production. Problems name the variable, never a value.
 */
function parseLocalSites(
  text: string | undefined,
  production: boolean,
  problems: string[],
): BrowserLocalSite[] {
  if (text === undefined) return []
  if (production) {
    problems.push('BROWSER_LOCAL_SITES: refused in production (local sites are for stands only)')
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('BROWSER_LOCAL_SITES: expected a JSON object of origins and host:port targets')
    return []
  }
  const sites: BrowserLocalSite[] = []
  for (const [origin, target] of Object.entries(parsed)) {
    const site = { origin, target: String(target) }
    if (typeof target !== 'string' || localSiteRoute(site) === null) {
      problems.push(
        'BROWSER_LOCAL_SITES: each key must be an http:// origin with a host name, each value a host:port',
      )
      return []
    }
    sites.push(site)
  }
  if (sites.length > browserSessionRuntimeLimits.localSites) {
    problems.push(
      `BROWSER_LOCAL_SITES: at most ${browserSessionRuntimeLimits.localSites} local sites`,
    )
    return []
  }
  return sites
}

/**
 * The settings of the browser worker and nothing else: its port and token, the database, the
 * inbox bucket, the Docker runtime of the sessions and their numbers. It reads none of the git,
 * billing, Vault, Redis or turn settings. Lists every problem at once.
 */
export function loadBrowserConfig(env: Env): BrowserWorkerConfig {
  const parsed = ownEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(envProblems(parsed.error), 'browser')
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

  const metricsProblem = metricsTokenProblem(own.METRICS_TOKEN, appEnv)
  if (metricsProblem) problems.push(`METRICS_TOKEN: ${metricsProblem}`)

  const db = section(() => dbConfigFromEnv(env))
  // The worker reads attachments of tasks from the inbox; its S3 key reaches no other bucket
  // (Б26, spec §14), so the names of the other buckets are not its settings.
  const read = section(() =>
    storageConfigFromEnv(
      Object.fromEntries(BROWSER_STORAGE_VARIABLES.map((name) => [name, env[name]])),
    ),
  )
  const storage: BrowserInboxStorageConfig | undefined = read && {
    endpoint: read.endpoint,
    region: read.region,
    accessKeyId: read.accessKeyId,
    secretAccessKey: read.secretAccessKey,
    forcePathStyle: read.forcePathStyle,
    buckets: { inbox: read.buckets.inbox },
  }

  const runtimeKind: PreviewRuntimeKind = own.BROWSER_RUNTIME ?? (production ? 'runsc' : 'runc')
  // Page scripts of the open internet run in this Chromium: gVisor is the boundary (rule 5).
  if (production && runtimeKind !== 'runsc')
    problems.push('BROWSER_RUNTIME: production browsers run under gVisor (runsc)')
  const refusedSubnets = own.SANDBOX_EGRESS_REFUSED_SUBNETS ?? []
  if (production && refusedSubnets.length === 0)
    problems.push(
      'SANDBOX_EGRESS_REFUSED_SUBNETS: required in production (the platform subnets the browser never reaches)',
    )
  const images = [own.BROWSER_IMAGE, own.BROWSER_FORWARDER_IMAGE, own.BROWSER_EGRESS_IMAGE]
  const imageCount = images.filter((value) => value !== undefined).length
  let runtime: DockerBrowserSessionConfig | null = null
  if (imageCount > 0 && imageCount < images.length)
    problems.push(
      'BROWSER_IMAGE, BROWSER_FORWARDER_IMAGE, BROWSER_EGRESS_IMAGE: set all three or none',
    )
  else if (imageCount === 0 && production)
    problems.push(
      'BROWSER_IMAGE, BROWSER_FORWARDER_IMAGE, BROWSER_EGRESS_IMAGE: required in production',
    )
  else if (own.BROWSER_IMAGE && own.BROWSER_FORWARDER_IMAGE && own.BROWSER_EGRESS_IMAGE) {
    if (runtimeKind === 'runsc' && own.SANDBOX_NETWORK_GUARD_IMAGE === undefined)
      problems.push(
        'SANDBOX_NETWORK_GUARD_IMAGE: required under runsc (the host firewall of a session network)',
      )
    runtime = {
      // The egress proxy of every session refuses local sites in production on its own too.
      appEnv,
      runtime: runtimeKind,
      ...(own.BROWSER_DOCKER_SOCKET ? { socketPath: own.BROWSER_DOCKER_SOCKET } : {}),
      images: {
        browser: own.BROWSER_IMAGE,
        forwarder: own.BROWSER_FORWARDER_IMAGE,
        egress: own.BROWSER_EGRESS_IMAGE,
      },
      ...(own.SANDBOX_NETWORK_GUARD_IMAGE
        ? { firewallImage: own.SANDBOX_NETWORK_GUARD_IMAGE }
        : {}),
      refusedSubnets,
    }
  }
  const extraHosts = parseExtraHosts(own.BROWSER_EXTRA_HOSTS, problems)
  const localSites = parseLocalSites(own.BROWSER_LOCAL_SITES, production, problems)
  if (runtime && localSites.length > 0) runtime.localSites = true

  if (problems.length > 0 || db === undefined || storage === undefined)
    throw new ConfigError(problems, 'browser')
  return {
    appEnv,
    host: own.BROWSER_WORKER_HOST ?? (production ? undefined : '127.0.0.1'),
    port: own.BROWSER_WORKER_PORT,
    token: own.BROWSER_WORKER_TOKEN,
    metricsToken: own.METRICS_TOKEN ?? DEV_METRICS_TOKEN,
    db,
    storage,
    runtime,
    extraHosts,
    localSites,
    session: {
      idleMinutes: own.BROWSER_SESSION_IDLE_MINUTES,
      maxHours: own.BROWSER_SESSION_MAX_HOURS,
      maxSessions: own.BROWSER_MAX_SESSIONS,
    },
    stream: {
      maxFps: own.BROWSER_STREAM_MAX_FPS,
      quality: own.BROWSER_STREAM_QUALITY,
      window: own.BROWSER_STREAM_WINDOW,
    },
  }
}
