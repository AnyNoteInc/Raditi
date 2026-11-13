import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { McpDocsService } from './docs-service.ts'
import { McpDocsController } from './mcp-docs.controller.ts'
import { postgresDocsStore } from './docs-store.ts'
import { MCP_DOCS } from './pages.tokens.ts'

/**
 * The documents of a workspace (docs/plan/69-pages.md, Ст7, Ст21): no profile and no domain — a
 * document lives in the cabinet until the client publishes it — so every composition has it.
 */
@Module({
  controllers: [McpDocsController],
  providers: [
    {
      provide: MCP_DOCS,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) =>
        new McpDocsService({ store: postgresDocsStore(prisma) }),
    },
  ],
})
export class DocsModule {}
