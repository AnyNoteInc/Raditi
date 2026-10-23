import { Module } from '@nestjs/common'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { MCP_PREVIEW_ADDRESS, McpToolsController } from './mcp-tools.controller.ts'

/** site_info, the one tool of every profile: the site of the turn and where its preview answers. */
@Module({
  controllers: [McpToolsController],
  providers: [
    {
      provide: MCP_PREVIEW_ADDRESS,
      inject: [MCP_CONFIG],
      useFactory: (config: McpConfig) => mcpProfilesOf(config).previews,
    },
  ],
})
export class SiteInfoModule {}
