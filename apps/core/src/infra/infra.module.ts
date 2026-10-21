import { Global, Module } from '@nestjs/common'
import {
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  type PrismaClient,
} from '@repo/db'
import { HEALTH_CHECK_TIMEOUT_MS } from '@repo/observability'
import { createS3ObjectStorage } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'
import { createYookassaClient, type YookassaClient } from '@repo/yookassa'
import { PrismaLifecycle, createAppPrisma, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { RedisLifecycle, createRedisClient } from './redis.ts'
import {
  CORE_CONFIG,
  SITE_LEASES,
  TURN_ASSIGNMENTS,
  YOOKASSA,
  REDIS,
  OBJECT_STORAGE,
} from './tokens.ts'

/** Adapters of the core role. Nothing connects here: Prisma and S3 connect on first use. */
@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      useFactory: (config: CoreConfig) => createAppPrisma(config.db),
      inject: [CORE_CONFIG],
    },
    {
      provide: OBJECT_STORAGE,
      useFactory: (config: CoreConfig) =>
        createS3ObjectStorage(config.storage, undefined, {
          healthTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
        }),
      inject: [CORE_CONFIG],
    },
    {
      provide: SECRET_STORE,
      useFactory: (config: CoreConfig) => createVaultSecretStore(config.vault),
      inject: [CORE_CONFIG],
    },
    {
      provide: REDIS,
      useFactory: (config: CoreConfig) => createRedisClient(config.redisUrl),
      inject: [CORE_CONFIG],
    },
    {
      provide: SITE_LEASES,
      useFactory: (prisma: PrismaClient) => new PostgresSiteLeaseStore(prisma),
      inject: [PRISMA],
    },
    {
      provide: TURN_ASSIGNMENTS,
      useFactory: (prisma: PrismaClient) => new PostgresTaskTurnAssignmentStore(prisma),
      inject: [PRISMA],
    },
    {
      // null while payments are off: whoever charges must check before it starts.
      provide: YOOKASSA,
      useFactory: (config: CoreConfig): YookassaClient | null =>
        config.yookassa ? createYookassaClient(config.yookassa) : null,
      inject: [CORE_CONFIG],
    },
    PrismaLifecycle,
    RedisLifecycle,
  ],
  exports: [PRISMA, OBJECT_STORAGE, SECRET_STORE, REDIS, SITE_LEASES, TURN_ASSIGNMENTS, YOOKASSA],
})
export class InfraModule {}
