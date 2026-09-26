import type { PrismaClient } from '@repo/db'
import type { BucketKind, ObjectStorage, SecretStore } from '@repo/domain'
import type { Redis } from 'ioredis'

import { withTimeout } from '../common/async.ts'

/** Resolves true when the dependency is usable; false or a rejection means 'fail'. */
export type HealthCheck = () => Promise<boolean>
export type HealthChecks = Record<string, HealthCheck>
export type CheckResult = 'ok' | 'fail'

export interface HealthReport {
  status: 'ok' | 'degraded'
  checks: Record<string, CheckResult>
}

/** Per check: the endpoint answers within this time even when a dependency hangs. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000

/** Runs the checks in parallel; never throws. */
export async function runHealthChecks(
  checks: HealthChecks,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthReport> {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
      const ok = await withTimeout(
        Promise.resolve().then(check),
        timeoutMs,
        `${name} health check timed out`,
      ).catch(() => false)
      return [name, ok === true ? 'ok' : 'fail']
    }),
  )
  return {
    status: results.every(([, result]) => result === 'ok') ? 'ok' : 'degraded',
    checks: Object.fromEntries(results),
  }
}

export const databaseCheck =
  (prisma: Pick<PrismaClient, '$queryRaw'>): HealthCheck =>
  async () => {
    await prisma.$queryRaw`SELECT 1`
    return true
  }

export const redisCheck =
  (redis: Pick<Redis, 'ping'>): HealthCheck =>
  async () =>
    (await redis.ping()) === 'PONG'

/** Buckets the core role's S3 key may access (spec §14); /health checks only these. */
export const CORE_BUCKETS: readonly BucketKind[] = ['inbox', 'sessions', 'logs', 'artifacts']

/** ok only when every given bucket is reachable. */
export const s3Check =
  (storage: Pick<ObjectStorage, 'checkBuckets'>, kinds: readonly BucketKind[]): HealthCheck =>
  async () => {
    const buckets = await storage.checkBuckets(kinds)
    return kinds.every((kind) => buckets[kind] === true)
  }

/** ok when Vault is initialized and unsealed (a standby node counts). */
export const vaultCheck =
  (secrets: Pick<SecretStore, 'health'>): HealthCheck =>
  async () => {
    const health = await secrets.health()
    return health.initialized && !health.sealed
  }
