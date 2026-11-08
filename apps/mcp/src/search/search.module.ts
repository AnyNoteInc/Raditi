import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { AccessModule } from '../access/access.module.ts'
import { MCP_WEB_SEARCH_KEY, type WebSearchKey } from '../access/web-search-key.ts'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { McpSearchController } from './mcp-search.controller.ts'
import { MCP_WEB_SEARCH } from './search.tokens.ts'
import { McpWebSearchService } from './web-search.ts'
import { PostgresWebSearchStore } from './web-search-store.ts'

/**
 * The agent's web search (`search_web`, Parallel Search in its `fast` mode). No profile: a
 * product path of every composition, offered while its key is in Vault (`subs/search/parallel`,
 * read by AccessModule's WebSearchKey). The key stays in this role: the sandbox, the CLI and the
 * client never get it.
 */
@Module({
  imports: [AccessModule],
  controllers: [McpSearchController],
  providers: [
    {
      provide: MCP_WEB_SEARCH,
      inject: [MCP_CONFIG, PRISMA, MCP_WEB_SEARCH_KEY],
      useFactory: (config: McpConfig, prisma: PrismaClient, key: WebSearchKey) =>
        new McpWebSearchService({
          store: new PostgresWebSearchStore(prisma),
          config: mcpProfilesOf(config).webSearch,
          key,
        }),
    },
  ],
})
export class SearchModule {}
