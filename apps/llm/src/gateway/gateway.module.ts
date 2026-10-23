import { Module, type Logger } from '@nestjs/common'
import type { LlmBackend } from '@repo/domain'

import { AccountingModule } from '../accounting/accounting.module.ts'
import { GATEWAY_STORE } from '../accounting/accounting.tokens.ts'
import type { GatewayStore } from '../accounting/gateway-types.ts'
import type { LlmRoleConfig } from '../config/config.ts'
import { LLM_CONFIG } from '../config/config.module.ts'
import type { StreamingEgress } from '../egress/egress.ts'
import { EgressModule } from '../egress/egress.module.ts'
import { GENERATION_EGRESS } from '../egress/egress.tokens.ts'
import { LLM_BACKENDS, LLM_LOGGER } from '../infra/infra.tokens.ts'
import { MaintenanceModule } from '../maintenance/maintenance.module.ts'
import type { CredentialSource } from '../pool/credentials.ts'
import { SubscriptionPoolHealth } from '../pool/pool-health.ts'
import { PoolModule } from '../pool/pool.module.ts'
import { CREDENTIAL_SOURCE } from '../pool/pool.tokens.ts'
import { LLM_GATEWAY } from './gateway.tokens.ts'
import { LlmRuntime } from './llm-runtime.ts'
import { GatewayReadiness } from './readiness.ts'
import { createLlmGateway } from './server.ts'

/**
 * The HTTP server of the role over the store, the pool and the gate of generations, and the
 * runtime (LlmRuntime) that starts and stops it. No module injects the runtime, so the module
 * exports nothing (plan 56, §3, item 4): startLlm and the stand's worker take it with app.get,
 * which looks in every module.
 */
@Module({
  imports: [AccountingModule, EgressModule, PoolModule, MaintenanceModule],
  providers: [
    GatewayReadiness,
    {
      provide: LLM_GATEWAY,
      useFactory: (
        config: LlmRoleConfig,
        backends: readonly LlmBackend[],
        store: GatewayStore,
        credentials: CredentialSource,
        egress: StreamingEgress,
        pool: SubscriptionPoolHealth,
        readiness: GatewayReadiness,
        logger: Logger,
      ) =>
        createLlmGateway({
          config,
          backends,
          store,
          credentials,
          egress,
          lifecycle: {
            pause: (key) => pool.pause(key.accountId),
            observe: (call, finish) => pool.observe(call, finish),
            // Both callers ask because the windows are unknown: admission and core's issue.
            probeAccounts: async (accountIds, unknownWindows = {}) => {
              await Promise.all(
                accountIds.map((accountId) => pool.probeAccount(accountId, unknownWindows)),
              )
            },
            // The snapshot has only grown old: one probe of the account in five minutes is enough.
            refreshAccount: async (accountId) => {
              await pool.refreshAccount(accountId)
            },
          },
          metricsToken: config.metricsToken,
          ready: () => readiness.ready(),
          health: () => readiness.health(),
          logger,
        }),
      inject: [
        LLM_CONFIG,
        LLM_BACKENDS,
        GATEWAY_STORE,
        CREDENTIAL_SOURCE,
        GENERATION_EGRESS,
        SubscriptionPoolHealth,
        GatewayReadiness,
        LLM_LOGGER,
      ],
    },
    LlmRuntime,
  ],
})
export class GatewayModule {}
