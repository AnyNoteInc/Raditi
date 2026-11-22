import { Module } from '@nestjs/common'
import { createBrowserWorkerClient } from '@repo/browser-link'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { McpArtifactsService } from './artifacts-service.ts'
import { postgresArtifactsStore } from './artifacts-store.ts'
import { MCP_ARTIFACTS } from './artifacts.tokens.ts'
import {
  McpArtifactFramesController,
  McpArtifactSynonymsController,
  McpArtifactsController,
} from './mcp-artifacts.controller.ts'

/**
 * The artifacts of a workspace (docs/plan/88-artifacts.md, Ар22): no profile — every composition
 * has them, as it had the documents of plan 69 they replace; their frames are drawn by the browser
 * worker where it is configured (Ар32).
 */
@Module({
  controllers: [McpArtifactsController, McpArtifactFramesController, McpArtifactSynonymsController],
  providers: [
    {
      provide: MCP_ARTIFACTS,
      inject: [PRISMA, MCP_CONFIG],
      useFactory: (prisma: PrismaClient, config: McpConfig) => {
        // The renderer of frames is the browser worker's (Ар32); without it no frame is drawn.
        const worker = mcpProfilesOf(config).worker
        const client = worker
          ? createBrowserWorkerClient({ baseUrl: worker.url, token: worker.token })
          : null
        return new McpArtifactsService({
          store: postgresArtifactsStore(prisma),
          render: client ? (request) => client.render(request) : null,
          // The diagrams of «Схема» are drawn by the same worker (88.24).
          diagram: client ? (request) => client.diagram(request) : null,
        })
      },
    },
  ],
})
export class ArtifactsModule {}
