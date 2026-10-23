import { Logger, Module } from '@nestjs/common'
import { Counter, type Registry } from '@prometheus-io/client'
import type { PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialSource } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'
import { backendCapacities } from './backends.ts'
import { CoreCredentialRuntime } from './credential-runtime.ts'
import { CredentialSweeper, type CredentialSweepKind } from './credential-sweeper.ts'
import { TURN_CREDENTIALS } from './llm.tokens.ts'
import { createPoolProbeClient } from './pool-probe-client.ts'
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
          ...(config.llmControlUrl === undefined
            ? {}
            : {
                probeAccounts: createPoolProbeClient(config.llmControlUrl, config.metricsToken),
              }),
        }),
      inject: [PRISMA, SECRET_STORE, CORE_CONFIG],
    },
    { provide: GatewayTurnCredentials, useExisting: TURN_CREDENTIALS },
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
