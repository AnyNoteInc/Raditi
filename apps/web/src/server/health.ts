import type { BucketKind, ObjectStorage, SecretStore } from '@repo/domain'

import { bearerTokenMatches } from './bearer-token'
import { describeError } from './errors'

export const healthCheckNames = ['database', 'redis', 's3', 'vault'] as const
export type HealthCheckName = (typeof healthCheckNames)[number]

/** Resolves true when the dependency is usable; false, a rejection or a throw mean 'fail'. */
export type HealthCheck = () => Promise<boolean>
export type HealthChecks = Record<HealthCheckName, HealthCheck>
export type CheckResult = 'ok' | 'fail'

export interface HealthReport {
  status: 'ok' | 'degraded'
  checks: Record<HealthCheckName, CheckResult>
}

/** Per check: the endpoint answers in time even when a dependency hangs. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000

export type HealthFailureLogger = (name: HealthCheckName, error: unknown) => void

class HealthTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`${name} health check timed out after ${ms} ms`)
    this.name = 'HealthTimeoutError'
  }
}

/** Settles with the check or fails after `ms`; a late rejection is already handled. */
function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthTimeoutError(name, ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Runs the checks in parallel; never throws. */
export async function runHealthChecks(
  checks: HealthChecks,
  options: { timeoutMs?: number; onFailure?: HealthFailureLogger } = {},
): Promise<HealthReport> {
  const { timeoutMs = HEALTH_CHECK_TIMEOUT_MS, onFailure } = options
  const results = await Promise.all(
    healthCheckNames.map(async (name): Promise<[HealthCheckName, CheckResult]> => {
      try {
        const ok = await withTimeout(Promise.resolve().then(checks[name]), timeoutMs, name)
        if (ok === true) return [name, 'ok']
        onFailure?.(name, new Error(`${name} health check returned false`))
      } catch (error) {
        onFailure?.(name, error)
      }
      return [name, 'fail']
    }),
  )
  const checkResults = Object.fromEntries(results) as Record<HealthCheckName, CheckResult>
  return {
    status: results.every(([, result]) => result === 'ok') ? 'ok' : 'degraded',
    checks: checkResults,
  }
}

/** How long one report is reused, so frequent or anonymous probes cannot hammer the dependencies. */
export const HEALTH_CACHE_TTL_MS = 5_000

export type HealthProbe = () => Promise<HealthReport>

/** Runs the checks at most once per `ttlMs`; callers during a run share its result. */
export function cachedHealthProbe(
  checks: HealthChecks,
  options: Parameters<typeof runHealthChecks>[1] & { ttlMs?: number; now?: () => number } = {},
): HealthProbe {
  const { ttlMs = HEALTH_CACHE_TTL_MS, now = Date.now, ...runOptions } = options
  let cached: { report: HealthReport; at: number } | undefined
  let running: Promise<HealthReport> | undefined
  return () => {
    if (cached !== undefined && now() - cached.at < ttlMs) return Promise.resolve(cached.report)
    running ??= runHealthChecks(checks, runOptions)
      .then((report) => {
        cached = { report, at: now() }
        return report
      })
      .finally(() => {
        running = undefined
      })
    return running
  }
}

/**
 * 200 when everything is ok, 503 otherwise, so load balancers and probes can act on it.
 * Anonymous callers get only `{ status }`; the per-dependency checks need
 * `Authorization: Bearer $METRICS_TOKEN`.
 */
export async function healthResponse(
  request: Request,
  options: { probe: HealthProbe; token: string | undefined },
): Promise<Response> {
  const report = await options.probe()
  const detailed =
    options.token !== undefined &&
    bearerTokenMatches(request.headers.get('authorization'), options.token)
  return Response.json(detailed ? report : { status: report.status }, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}

export interface SqlClient {
  $queryRaw(query: TemplateStringsArray): PromiseLike<unknown>
}

export const databaseCheck =
  (getDb: () => SqlClient): HealthCheck =>
  async () => {
    await getDb().$queryRaw`SELECT 1`
    return true
  }

/** The part of an ioredis client the check needs. */
export interface RedisProbe {
  connect(): Promise<unknown>
  ping(): Promise<string>
  disconnect(): void
}

/** Opens its own short-lived connection and always closes it, whatever happens. */
export const redisCheck =
  (getUrl: () => string | undefined, connect: (url: string) => RedisProbe): HealthCheck =>
  async () => {
    const url = getUrl()
    if (!url) throw new Error('REDIS_URL is not set')
    const client = connect(url)
    try {
      await client.connect()
      return (await client.ping()) === 'PONG'
    } finally {
      client.disconnect()
    }
  }

/** The buckets web's own S3 key may access (spec §14): the health check looks at no others. */
export const WEB_BUCKETS = ['inbox', 'artifacts', 'logs'] as const satisfies readonly BucketKind[]

/** ok only when every bucket in `kinds` is reachable. */
export const s3Check =
  (
    getStorage: () => Pick<ObjectStorage, 'checkBuckets'>,
    kinds: readonly BucketKind[],
  ): HealthCheck =>
  async () => {
    const buckets = await getStorage().checkBuckets(kinds)
    return kinds.every((kind) => buckets[kind] === true)
  }

/** ok when Vault is initialized and unsealed (a standby node counts). */
export const vaultCheck =
  (getSecrets: () => Pick<SecretStore, 'health'>): HealthCheck =>
  async () => {
    const health = await getSecrets().health()
    return health.initialized && !health.sealed
  }

const LOG_INTERVAL_MS = 60_000

/** Logs a failing check at most once a minute per dependency: probes run every few seconds. */
export function throttledHealthLogger(
  log: (message: string) => void = console.warn,
  now: () => number = Date.now,
): HealthFailureLogger {
  const lastLogged = new Map<HealthCheckName, number>()
  return (name, error) => {
    const at = now()
    const previous = lastLogged.get(name)
    if (previous !== undefined && at - previous < LOG_INTERVAL_MS) return
    lastLogged.set(name, at)
    log(`[health] ${name} is unavailable: ${describeError(error)}`)
  }
}
