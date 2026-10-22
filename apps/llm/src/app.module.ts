import { Module, type DynamicModule } from '@nestjs/common'

import type { LlmRoleConfig } from './config/config.ts'
import { LlmConfigModule } from './config/config.module.ts'
import { GatewayModule } from './gateway/gateway.module.ts'
import { InfraModule } from './infra/infra.module.ts'

/**
 * The subscription gateway: its configuration and clients (global) and the gateway with the
 * store, egress, pool and maintenance it is built on. LlmRuntime starts and stops it.
 */
@Module({})
export class AppModule {
  static forRoot(config: LlmRoleConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [LlmConfigModule.forRoot(config), InfraModule, GatewayModule],
    }
  }
}
