import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { McpArtifactsService } from './artifacts-service.ts'
import { postgresArtifactsStore } from './artifacts-store.ts'
import { MCP_ARTIFACTS } from './artifacts.tokens.ts'
import {
  McpArtifactSynonymsController,
  McpArtifactsController,
} from './mcp-artifacts.controller.ts'

/**
 * The artifacts of a workspace (docs/plan/88-artifacts.md, Ар22): no profile and no configuration —
 * every composition has them, as it had the documents of plan 69 they replace.
 */
@Module({
  controllers: [McpArtifactsController, McpArtifactSynonymsController],
  providers: [
    {
      provide: MCP_ARTIFACTS,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) =>
        new McpArtifactsService({ store: postgresArtifactsStore(prisma) }),
    },
  ],
})
export class ArtifactsModule {}
