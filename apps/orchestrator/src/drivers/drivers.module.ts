import { Module } from '@nestjs/common'
import { createAgentDriverRegistry, createAgentDrivers } from '@repo/agent-drivers'
import type { AgentDriverId } from '@repo/domain'

import type { CoreConfig } from '../config/config.ts'
import { AGENT_DRIVERS, CORE_CONFIG } from '../infra/tokens.ts'

/**
 * Product drivers (spec §8); qwen stays registered but disabled. OpenCode stands next to Codex
 * and Kimi until they are removed: it runs only once the operator enables its row in
 * agent_drivers and an account of its provider.
 */
export const ENABLED_AGENT_DRIVERS: readonly AgentDriverId[] = ['codex', 'kimi', 'opencode']

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
