import { Inject, Injectable } from '@nestjs/common'
import type { HealthProbe } from '@repo/observability'

import { LostCallCollector } from '../accounting/lost-call-collector.ts'
import { EgressHealth } from '../egress/egress-probe.ts'
import { HEALTH_PROBE } from '../infra/infra.tokens.ts'

/** What the gateway answers admission and GET /health with. */
@Injectable()
export class GatewayReadiness {
  readonly #collector: Pick<LostCallCollector, 'healthy'>
  readonly #channel: EgressHealth
  readonly #probe: HealthProbe
  #closing = false

  constructor(
    @Inject(LostCallCollector) collector: Pick<LostCallCollector, 'healthy'>,
    @Inject(EgressHealth) channel: EgressHealth,
    @Inject(HEALTH_PROBE) probe: HealthProbe,
  ) {
    this.#collector = collector
    this.#channel = channel
    this.#probe = probe
  }

  /** Admission closes for good when the role starts to stop. */
  close(): void {
    this.#closing = true
  }

  ready(): boolean {
    return !this.#closing && this.#collector.healthy() && this.#channel.healthy()
  }

  // Without a proxy the last line is all that tells of a provider out of reach; it closes
  // nothing, because only a request that is let through can find the provider again.
  async health(): Promise<boolean> {
    return (
      (await this.#probe()).status === 'ok' &&
      this.#collector.healthy() &&
      this.#channel.healthy() &&
      this.#channel.directReachable()
    )
  }
}
