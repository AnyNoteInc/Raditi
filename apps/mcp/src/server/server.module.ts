import { Module } from '@nestjs/common'
import { MCP_HTTP_HANDLER, MCP_STRATEGY } from '@rekog/mcp-nest'

import { AccessModule } from '../access/access.module.ts'
import { McpAuthGuard } from '../access/mcp-auth.guard.ts'
import { MCP_SECURITY, type McpSecurity } from '../access/mcp-policy.ts'
import { McpHttpController } from './mcp-http.controller.ts'
import { createMcpRuntime } from './mcp-runtime.ts'
import { MCP_RUNTIME } from './server.tokens.ts'

type McpRuntime = ReturnType<typeof createMcpRuntime>

/**
 * The MCP endpoint: one runtime per app (a fresh transport and strategy, made when the app is
 * built), its handlers behind /mcp and McpAuthGuard. mountMcp connects the strategy to the
 * HTTP server before the app listens; the tools are the controllers of the other modules.
 */
@Module({
  imports: [AccessModule],
  controllers: [McpHttpController],
  providers: [
    {
      provide: MCP_RUNTIME,
      inject: [MCP_SECURITY],
      useFactory: (security: McpSecurity) => createMcpRuntime(security),
    },
    {
      provide: MCP_STRATEGY,
      inject: [MCP_RUNTIME],
      useFactory: (runtime: McpRuntime) => runtime.strategy,
    },
    {
      provide: MCP_HTTP_HANDLER,
      inject: [MCP_RUNTIME],
      useFactory: (runtime: McpRuntime) => runtime.handlers,
    },
    McpAuthGuard,
  ],
})
export class ServerModule {}
