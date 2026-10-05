import { Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { Counter, type Registry } from '@prometheus-io/client'
import type { PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialSource } from '@repo/domain'

import type { CoreConfig } from '../config/config.ts'
import {
  BACKGROUND_JOBS,
  CORE_CONFIG,
  METRICS_REGISTRY,
  PRISMA,
  SECRET_STORE,
  TURN_CREDENTIALS,
} from '../infra/tokens.ts'
import { MetricsModule } from '../metrics/metrics.module.ts'
import { CredentialSweeper, type CredentialSweepKind } from './credential-sweeper.ts'
import { createPoolProbeClient } from './pool-probe-client.ts'
import { GatewayTurnCredentials } from './turn-credentials.ts'

export const TURN_CREDENTIAL_SWEEP_INTERVAL_MS = 60_000
const sweepKinds: readonly CredentialSweepKind[] = [
  'requested',
  'expired',
  'finished',
  'vault',
  'usage_closed',
  'retirement',
  'lost',
]

/** The core timer only starts in running applications; durable rows make every pass repeatable. */
export class CoreCredentialRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #closing = false

  constructor(
    private readonly sweeper: Pick<CredentialSweeper, 'tick' | 'close'>,
    private readonly background: boolean,
    private readonly logger: { warn(message: string): void } = new Logger('CoreCredentials'),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || this.#timer || this.#closing) return
    this.#timer = setInterval(() => void this.tick(), TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    this.#timer.unref()
    void this.tick()
  }

  tick(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = Promise.resolve()
      .then(() => this.sweeper.tick())
      .catch(() => {
        if (!this.#closing) this.logger.warn('llm_credentials_sweep_failed kind=runtime')
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.sweeper.close()
  }
}

/** Core's turn-key lifecycle. Subscription credentials remain exclusive to the llm role. */
@Module({
  imports: [MetricsModule],
  providers: [
    {
      provide: TURN_CREDENTIALS,
      useFactory: (prisma: PrismaClient, secrets: SecretStore, config: CoreConfig) =>
        new GatewayTurnCredentials({
          prisma,
          secrets,
          requireAssignment: true,
          minTurnHeadroomPct: config.minTurnHeadroomPct ?? 5,
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
  exports: [TURN_CREDENTIALS, GatewayTurnCredentials],
})
export class LlmModule {}
