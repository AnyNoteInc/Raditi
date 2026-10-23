import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { McpConfig } from './config.ts'

/** The configuration of the role (loadMcpConfig, or one a stand builds by hand). */
export const MCP_CONFIG = Symbol('MCP_CONFIG')

/**
 * The configuration for every module of the role: parsed before Nest exists, so a refusal is
 * printed before the app is built. Called once, by AppModule.forRoot.
 */
@Global()
@Module({})
export class McpConfigModule {
  static forRoot(config: McpConfig): DynamicModule {
    return {
      module: McpConfigModule,
      providers: [{ provide: MCP_CONFIG, useValue: config }],
      exports: [MCP_CONFIG],
    }
  }
}
