import { Logger, Module, type DynamicModule } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { fetchSiteTransport, getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { createSiteContentResolver, PreviewDbValueStorage } from '@repo/site-content'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import { PrivacyModule } from '../privacy/privacy.module.ts'
import { CONTENT_PRIVACY } from '../privacy/privacy.tokens.ts'
import { MCP_CONTENT_STORAGE, type ContentStorage } from '../storage/content-storage.ts'
import { MCP_CONTENT_RESOLVER } from './content.tokens.ts'
import { ContentSnapshotStorage } from './content-snapshots.ts'
import { MCP_CONTENT, McpContentService, type ContentGatewayResolver } from './mcp-content.ts'
import { McpContentController } from './mcp-content.controller.ts'
import { MCP_CONTENT_MAINTENANCE, McpContentMaintenance } from './mcp-content-maintenance.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'
import {
  createPreviewContentResolver,
  MCP_PREVIEW_RESOLVER,
  type PreviewGatewayResolver,
} from './preview-content.ts'

/** The seams of the content profile a stand may use: they wrap the regular resolvers. */
export interface ContentTesting {
  wrapResolver?: (regular: ContentGatewayResolver) => ContentGatewayResolver
  wrapPreviewResolver?: (regular: PreviewGatewayResolver) => PreviewGatewayResolver
}

/**
 * Published content (wp_rest, db_schema, restore) — the content profile of the configuration
 * (MCP_CONTENT_PROFILE): snapshots in the artifacts bucket, the gateway from the adapter of the
 * site's stack. With `local` a dialog writes into its preview alone (docs/plan/53-chat-preview-
 * release.md, Р3, Р24): the access the build created in Vault `kv/previews/<previewId>/<kind>`,
 * each write an operation of the dialog's database plan. Only `local-site` — the local stands,
 * refused beside previews — lets a dialog write the site itself: the P6 path, with the access of
 * the site from Vault through the reference in credential_refs.
 *
 * The trusted side (McpContentService.undoTurn, McpContentMaintenance) lives here as well; no
 * network channel from core reaches it yet (N8), and no scheduler runs the maintenance.
 */
@Module({})
export class ContentModule {
  static forRoot(testing: ContentTesting = {}): DynamicModule {
    return {
      module: ContentModule,
      imports: [PrivacyModule],
      controllers: [McpContentController],
      providers: [
        {
          provide: MCP_CONTENT_RESOLVER,
          inject: [PRISMA, SECRET_STORE],
          useFactory: (prisma: PrismaClient, secrets: SecretStore) => {
            const logger = new Logger('McpContent')
            const warn = throttledLogger((line) => logger.warn(line))
            const regular = createSiteContentResolver({
              prisma,
              secrets,
              // The stack of the site picks its adapter; this module names no CMS.
              adapters: getSiteContentAdapter,
              transport: fetchSiteTransport,
              // The local profiles serve sites of this machine: plain http on loopback (the
              // P6 path, and the trusted undo of what it wrote).
              allowLoopbackHttp: true,
              onRefusal: (reason) => warn(`site content access (${reason})`, 'refused'),
            })
            return testing.wrapResolver ? testing.wrapResolver(regular) : regular
          },
        },
        {
          provide: MCP_PREVIEW_RESOLVER,
          inject: [MCP_CONFIG, SECRET_STORE],
          useFactory: (config: McpConfig, secrets: SecretStore): PreviewGatewayResolver => {
            const logger = new Logger('McpPreviewContent')
            const warn = throttledLogger((line) => logger.warn(line))
            const regular = createPreviewContentResolver({
              secrets,
              adapters: getSiteContentAdapter,
              address: mcpProfilesOf(config).previews,
              upstreamHost: config.previewUpstreamHost,
              onRefusal: (reason) => warn(`preview content access (${reason})`, 'refused'),
            })
            return testing.wrapPreviewResolver ? testing.wrapPreviewResolver(regular) : regular
          },
        },
        {
          provide: MCP_CONTENT_MAINTENANCE,
          inject: [PRISMA, MCP_CONTENT_STORAGE, SECRET_STORE, MCP_CONTENT_RESOLVER],
          useFactory: (
            prisma: PrismaClient,
            storage: ContentStorage,
            secrets: SecretStore,
            resolve: ContentGatewayResolver,
          ) => new McpContentMaintenance(prisma, storage, secrets, resolve),
        },
        {
          provide: MCP_CONTENT,
          inject: [
            MCP_CONFIG,
            PRISMA,
            MCP_CONTENT_STORAGE,
            SECRET_STORE,
            CONTENT_PRIVACY,
            MCP_CONTENT_RESOLVER,
            MCP_PREVIEW_RESOLVER,
          ],
          useFactory: (
            config: McpConfig,
            prisma: PrismaClient,
            storage: ContentStorage,
            secrets: SecretStore,
            privacy: ContentPrivacy,
            resolve: ContentGatewayResolver,
            preview: PreviewGatewayResolver,
          ) =>
            new McpContentService(
              new PostgresMcpJournal(prisma),
              new ContentSnapshotStorage(storage, secrets),
              privacy,
              resolve,
              {
                // The P6 path: the stands' profile `local-site` alone.
                siteContent: mcpProfilesOf(config).siteContent,
                dbSettings: (site) =>
                  getSiteAdapter(site.stack).dbSettings({
                    stack: site.stack,
                    url: site.url,
                    docroot: '/',
                    extras: {},
                  }),
                previews: {
                  resolve: preview,
                  values: new PreviewDbValueStorage(storage, secrets),
                },
              },
            ),
        },
      ],
    }
  }
}
