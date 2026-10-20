import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { ObjectStorage, SecretStore } from '@repo/domain'
import { databaseCheck, s3Check, vaultCheck, type HealthChecks } from '@repo/observability'
import {
  HEALTH_DETAILS_TOKEN,
  HealthController,
  HEALTH_CHECKS,
  OBJECT_STORAGE,
  PRISMA,
  SECRET_STORE,
} from '@repo/service-runtime'
import type { Redis } from 'ioredis'
import { redisCheck } from '../infra/redis.ts'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, REDIS } from '../infra/tokens.ts'
import { CORE_BUCKETS } from './health-checks.ts'

/** GET /health of the core role: database, Redis, its own S3 buckets and Vault. */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_DETAILS_TOKEN,
      useFactory: (config: CoreConfig): string => config.metricsToken,
      inject: [CORE_CONFIG],
    },
    {
      provide: HEALTH_CHECKS,
      useFactory: (
        prisma: PrismaClient,
        redis: Redis,
        storage: ObjectStorage,
        secrets: SecretStore,
      ): HealthChecks => ({
        database: databaseCheck(() => prisma),
        redis: redisCheck(redis),
        s3: s3Check(() => storage, CORE_BUCKETS),
        vault: vaultCheck(() => secrets),
      }),
      inject: [PRISMA, REDIS, OBJECT_STORAGE, SECRET_STORE],
    },
  ],
})
export class HealthModule {}
