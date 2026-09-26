import { Global, Module } from '@nestjs/common'
import { createS3ObjectStorage } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'

import type { CoreConfig } from '../config/config.ts'
import { HEALTH_CHECK_TIMEOUT_MS } from '../health/health-checks.ts'
import { PrismaLifecycle, RedisLifecycle } from './lifecycle.ts'
import { createOrchestratorPrisma } from './prisma.ts'
import { createRedisClient } from './redis.ts'
import { CORE_CONFIG, OBJECT_STORAGE, PRISMA, REDIS, SECRET_STORE } from './tokens.ts'

/** Adapters of the core role. Nothing connects here: Prisma and S3 connect on first use. */
@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      useFactory: (config: CoreConfig) => createOrchestratorPrisma(config.db),
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
    PrismaLifecycle,
    RedisLifecycle,
  ],
  exports: [PRISMA, OBJECT_STORAGE, SECRET_STORE, REDIS],
})
export class InfraModule {}
