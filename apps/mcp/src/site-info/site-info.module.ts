import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { mcpBrowserTasksOf } from './browser-tasks.ts'
import { McpToolsController } from './mcp-tools.controller.ts'
import { MCP_BROWSER_TASKS } from './site-info.tokens.ts'

/** site_info, the one tool of every composition: what the chat has and who drives its browser. */
@Module({
  controllers: [McpToolsController],
  providers: [
    {
      provide: MCP_BROWSER_TASKS,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) => mcpBrowserTasksOf({ db: prisma }),
    },
  ],
})
export class SiteInfoModule {}
