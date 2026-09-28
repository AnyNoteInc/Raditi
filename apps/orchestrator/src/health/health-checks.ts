import type { BucketKind } from '@repo/domain'
import type { HealthCheck } from '@repo/observability'
import type { Redis } from 'ioredis'

/** The shared client fails fast while Redis is away (enableOfflineQueue is off). */
export const redisCheck =
  (redis: Pick<Redis, 'ping'>): HealthCheck =>
  async () =>
    (await redis.ping()) === 'PONG'

/** Buckets the core role's S3 key may access (spec §14); /health checks only these. */
export const CORE_BUCKETS: readonly BucketKind[] = ['inbox', 'sessions', 'logs', 'artifacts']
