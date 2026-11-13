import { Logger, Module } from '@nestjs/common'
import { Counter, type Registry } from '@prometheus-io/client'
import type { PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialSource } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'
import { backendCapacities, backendFallbacks } from './backends.ts'
import { CoreCredentialRuntime } from './credential-runtime.ts'
import { CredentialSweeper, type CredentialSweepKind } from './credential-sweeper.ts'
import { TURN_CREDENTIALS } from './llm.tokens.ts'
import { createPoolProbeClient, type PoolProbeClient } from './pool-probe-client.ts'
import { TurnCostRuntime } from './turn-costs.ts'
import { GatewayTurnCredentials } from './turn-credentials.ts'

const sweepKinds: readonly CredentialSweepKind[] = [
  'requested',
  'expired',
  'finished',
  'vault',
  'usage_closed',
  'retirement',
  'lost',
]

/**
 * A refused probe leaves the windows stale and every turn waiting for agents; the issuer reselects
 * from what is stored and says nothing, so the refusal is logged here (09.11.2026: an llm that did
 * not admit core's address held every chat of the server in «queued» without a word).
 */
export function loggedProbe(
  probe: PoolProbeClient,
  logger: { warn(message: string): void },
): PoolProbeClient {
  return (accountIds, options) =>
    probe(accountIds, options).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'unknown'
      logger.warn(
        `pool_probe_failed accounts=${accountIds.length} stale=${options?.stale === true} reason=${reason}`,
      )
      throw error
    })
}

/** Core's turn-key lifecycle. Subscription credentials remain exclusive to the llm role. */
@Module({
  providers: [
    {
      provide: TURN_CREDENTIALS,
      useFactory: (prisma: PrismaClient, secrets: SecretStore, config: CoreConfig) =>
        new GatewayTurnCredentials({
          prisma,
          secrets,
          requireAssignment: true,
          minTurnHeadroomPct: config.minTurnHeadroomPct ?? 5,
          // The adapters' own word; core never sends a request with them.
          capacityOf: backendCapacities(llmBackends),
          // The API after the plan (docs/plan/70-turn-without-time-limit.md, ВР25).
          fallbackOf: backendFallbacks(llmBackends),
          ...(config.llmControlUrl === undefined
            ? {}
            : {
                probeAccounts: loggedProbe(
                  createPoolProbeClient(config.llmControlUrl, config.metricsToken),
                  new Logger('CoreCredentials'),
                ),
              }),
        }),
      inject: [PRISMA, SECRET_STORE, CORE_CONFIG],
    },
    { provide: GatewayTurnCredentials, useExisting: TURN_CREDENTIALS },
    {
      provide: TurnCostRuntime,
      useFactory: (prisma: PrismaClient, background: boolean) =>
        new TurnCostRuntime(prisma, background),
      inject: [PRISMA, BACKGROUND_JOBS],
    },
    {
      provide: CredentialSweeper,
      useFactory: (
        prisma: PrismaClient,
        secrets: SecretStore,
        credentials: TurnCredentialSource,
        registry: Registry,
      ) => {
        const swept = new Counter({
          name: 'raditi_llm_credentials_swept_total',
          help: 'Aggregate core subscription credential cleanup',
          labelNames: ['kind'],
          registers: [registry],
        })
        for (const kind of sweepKinds) swept.inc({ kind }, 0)
        return new CredentialSweeper({
          prisma,
          secrets,
          credentials,
          logger: new Logger('CoreCredentials'),
          onSwept: (kind) => swept.inc({ kind }),
        })
      },
      inject: [PRISMA, SECRET_STORE, TURN_CREDENTIALS, METRICS_REGISTRY],
    },
    {
      provide: CoreCredentialRuntime,
      useFactory: (sweeper: CredentialSweeper, background: boolean) =>
        new CoreCredentialRuntime(sweeper, background),
      inject: [CredentialSweeper, BACKGROUND_JOBS],
    },
  ],
  exports: [TURN_CREDENTIALS],
})
export class LlmModule {}
