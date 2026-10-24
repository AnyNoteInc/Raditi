import { Module } from '@nestjs/common'
import { createBrowserWorkerClient } from '@repo/browser-link'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import { PrivacyModule } from '../privacy/privacy.module.ts'
import { CONTENT_PRIVACY } from '../privacy/privacy.tokens.ts'
import { McpWebService } from './mcp-web.ts'
import { McpWebController } from './mcp-web.controller.ts'
import { PostgresMcpWebStore } from './mcp-web-store.ts'
import { MCP_WEB } from './web.tokens.ts'

/**
 * The cloud browser of a browser task (web_*, docs/plan/57-browser-tasks.md, Б20). No profile:
 * a product path wherever the browser worker is configured (BROWSER_WORKER_URL), production too;
 * AppModule imports it only then. The role passes the agent's actions to the worker; the worker
 * holds the browser. What the page shows is masked with the task's contact map (PrivacyModule).
 */
@Module({
  imports: [PrivacyModule],
  controllers: [McpWebController],
  providers: [
    {
      provide: MCP_WEB,
      inject: [MCP_CONFIG, PRISMA, CONTENT_PRIVACY],
      useFactory: (config: McpConfig, prisma: PrismaClient, privacy: ContentPrivacy) => {
        const worker = mcpProfilesOf(config).worker
        // AppModule imports this module only with the worker; this narrows the type.
        if (!worker) throw new Error('MCP web tools need the browser worker (BROWSER_WORKER_URL)')
        return new McpWebService({
          store: new PostgresMcpWebStore(prisma),
          // The token stays in the client's closure; nothing here logs it.
          worker: createBrowserWorkerClient({ baseUrl: worker.url, token: worker.token }),
          privacy,
        })
      },
    },
  ],
})
export class WebModule {}
