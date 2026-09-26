import { Module, type DynamicModule } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { createVaultSecretStore } from '@repo/vault'

import type { McpConfig } from '../config/config.ts'
import { databaseCheck, vaultCheck, type HealthChecks } from '../health/health-checks.ts'
import { HealthController } from '../health/health.controller.ts'
import { PrismaLifecycle } from '../infra/lifecycle.ts'
import { createOrchestratorPrisma } from '../infra/prisma.ts'
import { HEALTH_CHECKS, PRISMA, SECRET_STORE } from '../infra/tokens.ts'

/**
 * The mcp role on its own port: the only orchestrator port sandboxes reach (through
 * sandbox-gw), so nothing of core — /metrics, queues, workers — is mounted here.
 * In production it has its own Vault AppRole and PostgreSQL role without billing (P6).
 */
@Module({})
export class McpAppModule {
  static forRoot(config: McpConfig): DynamicModule {
    return {
      module: McpAppModule,
      controllers: [HealthController],
      providers: [
        { provide: PRISMA, useFactory: () => createOrchestratorPrisma(config.db) },
        { provide: SECRET_STORE, useFactory: () => createVaultSecretStore(config.vault) },
        {
          provide: HEALTH_CHECKS,
          useFactory: (prisma: PrismaClient, secrets: SecretStore): HealthChecks => ({
            database: databaseCheck(prisma),
            vault: vaultCheck(secrets),
          }),
          inject: [PRISMA, SECRET_STORE],
        },
        PrismaLifecycle,
      ],
    }
  }
}
