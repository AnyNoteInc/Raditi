import { Module } from '@nestjs/common'
import { createAgentDriverRegistry, createAgentDrivers } from '@repo/agent-drivers'
import type { AgentDriverId } from '@repo/domain'

import type { CoreConfig } from '../config/config.ts'
import { AGENT_DRIVERS, CORE_CONFIG } from '../infra/tokens.ts'

/**
 * The product runs one shell (spec §8). A turn of OpenCode needs, beside this, what the
 * operator switches on in the database: the provider, a profile with an approved rate and an
 * account.
 */
export const ENABLED_AGENT_DRIVERS: readonly AgentDriverId[] = ['opencode']

@Module({
  providers: [
    {
      provide: AGENT_DRIVERS,
      useFactory: (config: CoreConfig) =>
        createAgentDriverRegistry(
          createAgentDrivers(config.agentDrivers),
          new Set(ENABLED_AGENT_DRIVERS),
        ),
      inject: [CORE_CONFIG],
    },
  ],
  exports: [AGENT_DRIVERS],
})
export class DriversModule {}
