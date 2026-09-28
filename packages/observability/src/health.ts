import { withTimeout, type BucketKind, type ObjectStorage, type SecretStore } from '@repo/domain'

/** Resolves true when the dependency is usable; false, a rejection or a throw mean 'fail'. */
export type HealthCheck = () => Promise<boolean>
export type HealthChecks<Name extends string = string> = Record<Name, HealthCheck>
export type CheckResult = 'ok' | 'fail'

export interface HealthReport<Name extends string = string> {
  status: 'ok' | 'degraded'
  checks: Record<Name, CheckResult>
}

export type HealthProbe<Name extends string = string> = () => Promise<HealthReport<Name>>
export type HealthFailureLogger = (name: string, error: unknown) => void

/** Per check: the endpoint answers in time even when a dependency hangs. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000

/** How long one report is reused, so frequent or anonymous probes cannot hammer the dependencies. */
export const HEALTH_CACHE_TTL_MS = 5_000

export interface HealthCheckOptions {
  timeoutMs?: number
  onFailure?: HealthFailureLogger
}

/** Runs the checks in parallel; never throws. */
export async function runHealthChecks<Name extends string>(
  checks: HealthChecks<Name>,
  { timeoutMs = HEALTH_CHECK_TIMEOUT_MS, onFailure }: HealthCheckOptions = {},
): Promise<HealthReport<Name>> {
  const entries = Object.entries(checks) as [Name, HealthCheck][]
  const results = await Promise.all(
    entries.map(async ([name, check]): Promise<[Name, CheckResult]> => {
      try {
        const message = `${name} health check timed out after ${timeoutMs} ms`
        const ok = await withTimeout(Promise.resolve().then(check), timeoutMs, message)
        if (ok === true) return [name, 'ok']
        onFailure?.(name, new Error(`${name} health check returned false`))
      } catch (error) {
        onFailure?.(name, error)
      }
      return [name, 'fail']
    }),
  )
  return {
    status: results.every(([, result]) => result === 'ok') ? 'ok' : 'degraded',
    checks: Object.fromEntries(results) as Record<Name, CheckResult>,
  }
}

/** Runs the checks at most once per `ttlMs`; callers during a run share its result. */
export function cachedHealthProbe<Name extends string>(
  checks: HealthChecks<Name>,
  options: HealthCheckOptions & { ttlMs?: number; now?: () => number } = {},
): HealthProbe<Name> {
  const { ttlMs = HEALTH_CACHE_TTL_MS, now = Date.now, ...runOptions } = options
  let cached: { report: HealthReport<Name>; at: number } | undefined
  let running: Promise<HealthReport<Name>> | undefined
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

export interface SqlClient {
  $queryRaw(query: TemplateStringsArray): PromiseLike<unknown>
}

export const databaseCheck =
  (getDb: () => SqlClient): HealthCheck =>
  async () => {
    await getDb().$queryRaw`SELECT 1`
    return true
  }

/** ok only when every bucket in `kinds` is reachable; the check looks at no others. */
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
