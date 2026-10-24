import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { getSiteAdapter } from '@repo/site-adapters'
import { PRISMA } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { mcpBrowserTasksOf } from './browser-tasks.ts'
import { MCP_PREVIEW_ADDRESS, McpToolsController } from './mcp-tools.controller.ts'
import { MCP_BROWSER_TASKS } from './site-info.tokens.ts'

/**
 * site_info, the one tool of every profile: the site of the turn, where its preview answers and,
 * for a browser task, where its browser starts and who drives it (docs/plan/57-browser-tasks.md,
 * Б20) — with or without the browser worker.
 */
@Module({
  controllers: [McpToolsController],
  providers: [
    {
      provide: MCP_PREVIEW_ADDRESS,
      inject: [MCP_CONFIG],
      useFactory: (config: McpConfig) => mcpProfilesOf(config).previews,
    },
    {
      provide: MCP_BROWSER_TASKS,
      inject: [PRISMA],
      // The stack of the site picks where its browser starts; this module names no CMS.
      useFactory: (prisma: PrismaClient) =>
        mcpBrowserTasksOf({ db: prisma, adapters: getSiteAdapter }),
    },
  ],
})
export class SiteInfoModule {}
