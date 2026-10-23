import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { ObjectStorage, SecretStore } from '@repo/domain'
import { databaseCheck, s3Check, vaultCheck, type HealthChecks } from '@repo/observability'
import { HealthModule, PRISMA, SECRET_STORE } from '@repo/service-runtime'
import type { Redis } from 'ioredis'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { OBJECT_STORAGE, REDIS } from '../infra/infra.tokens.ts'
import { redisCheck } from '../infra/redis.ts'
import { CORE_BUCKETS } from './health-checks.ts'

/** What GET /health of the core role checks: database, Redis, its own S3 buckets and Vault. */
export function coreHealthChecks(
  prisma: PrismaClient,
  redis: Redis,
  storage: ObjectStorage,
  secrets: SecretStore,
): HealthChecks {
  return {
    database: databaseCheck(() => prisma),
    redis: redisCheck(redis),
    s3: s3Check(() => storage, CORE_BUCKETS),
    vault: vaultCheck(() => secrets),
  }
}

/** GET /health of the core role; its details behind METRICS_TOKEN, as GET /metrics. */
@Module({
  imports: [
    HealthModule.forRootAsync({
      inject: [PRISMA, REDIS, OBJECT_STORAGE, SECRET_STORE],
      useFactory: coreHealthChecks,
      details: {
        inject: [CORE_CONFIG],
        useFactory: (config: CoreConfig): string => config.metricsToken,
      },
    }),
  ],
})
export class CoreHealthModule {}
