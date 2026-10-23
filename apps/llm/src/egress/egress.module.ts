import { Module, type Logger } from '@nestjs/common'
import type { LlmBackend } from '@repo/domain'

import type { LlmRoleConfig } from '../config/config.ts'
import { LLM_CONFIG } from '../config/config.module.ts'
import { LLM_BACKENDS, LLM_LOGGER } from '../infra/infra.tokens.ts'
import {
  createControlEgress,
  createEgressTransport,
  gatedEgress,
  type StreamingEgress,
} from './egress.ts'
import { createEgressProbe, EgressHealth } from './egress-probe.ts'
import { CONTROL_HTTP, EGRESS_TRANSPORT, GENERATION_EGRESS, REGION_HTTP } from './egress.tokens.ts'

/**
 * The one way of the role to the providers, with a proxy and without one, and the health of
 * that way (EgressHealth): its gates are what the gateway and the pool send through.
 */
@Module({
  providers: [
    {
      provide: EgressHealth,
      useFactory: (config: LlmRoleConfig, logger: Logger) =>
        new EgressHealth(createEgressProbe(config.egress), logger),
      inject: [LLM_CONFIG, LLM_LOGGER],
    },
    {
      provide: EGRESS_TRANSPORT,
      useFactory: (config: LlmRoleConfig, backends: readonly LlmBackend[], channel: EgressHealth) =>
        createEgressTransport(config.egress, backends, {
          onDirectConnection: (established) => channel.observeDirect(established),
        }),
      inject: [LLM_CONFIG, LLM_BACKENDS, EgressHealth],
    },
    {
      provide: GENERATION_EGRESS,
      useFactory: (transport: StreamingEgress, channel: EgressHealth) =>
        gatedEgress(transport, () => channel.healthy()),
      inject: [EGRESS_TRANSPORT, EgressHealth],
    },
    {
      provide: CONTROL_HTTP,
      useFactory: (generation: StreamingEgress) => createControlEgress(generation),
      inject: [GENERATION_EGRESS],
    },
    {
      provide: REGION_HTTP,
      useFactory: (transport: StreamingEgress, channel: EgressHealth) =>
        createControlEgress(gatedEgress(transport, () => channel.reachable())),
      inject: [EGRESS_TRANSPORT, EgressHealth],
    },
  ],
  exports: [EgressHealth, GENERATION_EGRESS, CONTROL_HTTP, REGION_HTTP],
})
export class EgressModule {}
