import { Module } from '@nestjs/common'
import {
  listWorkspacePages,
  readChatDocument,
  reservePagePublication,
  type PrismaClient,
} from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { McpPagesController } from './mcp-pages.controller.ts'
import { McpPagesService, type McpPagesStore } from './pages-service.ts'
import { MCP_PAGES } from './pages.tokens.ts'

/** The store of the agent's pages: the functions of @repo/db over the role's database. */
export function postgresPagesStore(db: PrismaClient): McpPagesStore {
  return {
    reserve: (input) => reservePagePublication(db, input),
    documentTitle: async (workspaceId, documentId) =>
      (await readChatDocument(db, { workspaceId, documentId, reader: 'agent' })).title,
    list: (workspaceId) => listWorkspacePages(db, workspaceId),
  }
}

/**
 * The pages of a workspace (docs/plan/69-pages.md, Ст20): no profile, a product path wherever
 * the pages are configured (PAGES_BASE_DOMAIN); AppModule imports it only then. The role keeps
 * no bytes of a page: they come with the outbox to core at the end of the turn (Ст6).
 */
@Module({
  controllers: [McpPagesController],
  providers: [
    {
      provide: MCP_PAGES,
      inject: [MCP_CONFIG, PRISMA],
      useFactory: (config: McpConfig, prisma: PrismaClient) => {
        if (!config.pages) throw new Error('The pages need PAGES_BASE_DOMAIN')
        return new McpPagesService({ store: postgresPagesStore(prisma), address: config.pages })
      },
    },
  ],
})
export class PagesModule {}
