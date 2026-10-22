import { Global, Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { cachedHealthProbe, databaseCheck, vaultCheck } from '@repo/observability'
import { createAppPrisma, PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { createVaultSecretStore } from '@repo/vault'

import type { LlmRoleConfig } from '../config/config.ts'
import { LLM_CONFIG } from '../config/config.module.ts'
import { databaseShutdown } from './database-shutdown.ts'
import { DATABASE_SHUTDOWN, HEALTH_PROBE, LLM_BACKENDS, LLM_LOGGER } from './infra.tokens.ts'

/**
 * The clients of the role and what every module of it shares: global, so no module imports it.
 * Nothing here has a shutdown hook: the role stops in one ordered sequence (gateway/llm-runtime.ts),
 * and the database pool is its last step.
 */
@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      useFactory: (config: LlmRoleConfig) => createAppPrisma(config.db),
      inject: [LLM_CONFIG],
    },
    {
      provide: SECRET_STORE,
      useFactory: (config: LlmRoleConfig) => createVaultSecretStore(config.vault),
      inject: [LLM_CONFIG],
    },
    // The set the role's configuration read its provider origins and stand overrides from.
    { provide: LLM_BACKENDS, useValue: llmBackends },
    { provide: LLM_LOGGER, useFactory: () => new Logger('LlmGateway') },
    {
      provide: HEALTH_PROBE,
      useFactory: (prisma: PrismaClient, secrets: SecretStore) =>
        cachedHealthProbe({
          database: databaseCheck(() => prisma),
          vault: vaultCheck(() => secrets),
        }),
      inject: [PRISMA, SECRET_STORE],
    },
    {
      provide: DATABASE_SHUTDOWN,
      useFactory: (prisma: PrismaClient, logger: Logger) => databaseShutdown(prisma, logger),
      inject: [PRISMA, LLM_LOGGER],
    },
  ],
  exports: [PRISMA, SECRET_STORE, LLM_BACKENDS, LLM_LOGGER, HEALTH_PROBE, DATABASE_SHUTDOWN],
})
export class InfraModule {}
