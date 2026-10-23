import { Global, Module } from '@nestjs/common'
import { HEALTH_CHECK_TIMEOUT_MS } from '@repo/observability'
import { createS3ObjectStorage } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'
import { SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { OBJECT_STORAGE, REDIS } from './infra.tokens.ts'
import { RedisLifecycle, createRedisClient } from './redis.ts'

/**
 * Connections of the core role: S3, Vault and Redis. The database is DatabaseModule of
 * @repo/service-runtime, which AppModule imports with the role's settings beside this one.
 * Nothing connects here: S3 and Vault connect on first use.
 */
@Global()
@Module({
  providers: [
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
    RedisLifecycle,
  ],
  exports: [OBJECT_STORAGE, SECRET_STORE, REDIS],
})
export class InfraModule {}
