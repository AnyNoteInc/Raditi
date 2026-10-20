import { Logger, Module, type DynamicModule } from '@nestjs/common'
import { MCP_HTTP_HANDLER, MCP_STRATEGY } from '@rekog/mcp-nest'
import { createPlaywrightBrowserFactory } from '@repo/browser-providers'
import type { PrismaClient } from '@repo/db'
import { isProduction, type PageBrowserFactory, type SecretStore } from '@repo/domain'
import {
  databaseCheck,
  s3Check,
  throttledLogger,
  vaultCheck,
  type HealthChecks,
} from '@repo/observability'
import { fetchSiteTransport, getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { createVaultSecretStore } from '@repo/vault'
import {
  HealthController,
  PrismaLifecycle,
  createAppPrisma,
  HEALTH_CHECKS,
  PRISMA,
  SECRET_STORE,
} from '@repo/service-runtime'

import type { McpConfig } from './config.ts'
import {
  MCP_ACCESS,
  MCP_ACCESS_PROBE_TOKEN,
  PostgresMcpAccess,
  type McpAccessStore,
} from './mcp-access.ts'
import { McpAuthGuard } from './mcp-auth.guard.ts'
import { mcpErrorSummary } from './mcp-http-error.ts'
import { McpHttpController } from './mcp-http.controller.ts'
import { MCP_SECURITY, type McpSecurity } from './mcp-policy.ts'
import { createMcpRuntime } from './mcp-server.ts'
import { MCP_PREVIEW_ADDRESS, McpToolsController } from './mcp-tools.controller.ts'
import { ContentSnapshotStorage } from './content-snapshots.ts'
import { ContentPrivacy } from './content-privacy.ts'
import {
  createContentStorage,
  MCP_CONTENT_STORAGE,
  type ContentStorage,
} from './content-storage.ts'
import { MCP_CONTENT, McpContentService, type ContentGatewayResolver } from './mcp-content.ts'
import { McpContentController } from './mcp-content.controller.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'
import { MCP_CONTENT_MAINTENANCE, McpContentMaintenance } from './mcp-content-maintenance.ts'
import {
  createSiteContentResolver,
  MCP_CONTENT_RESOLVER,
  PreviewDbValueStorage,
} from '@repo/site-content'
import {
  createPreviewContentResolver,
  MCP_PREVIEW_RESOLVER,
  type PreviewGatewayResolver,
} from './preview-content.ts'
import { MCP_BROWSER, McpBrowserService } from './mcp-browser.ts'
import { McpBrowserController } from './mcp-browser.controller.ts'
import { PostgresMcpBrowserStore } from './mcp-browser-store.ts'

/**
 * A seam for the stands, never for the regular role: wraps the gateway resolvers of the content
 * profile to inject faults (a lost acknowledgement, a refused write) and stands a browser in for
 * the browser profile. It turns nothing on: the profiles, their S3 and where a site's or a
 * preview's access comes from are the configuration's.
 */
export interface McpContentTesting {
  wrapResolver?: (regular: ContentGatewayResolver) => ContentGatewayResolver
  wrapPreviewResolver?: (regular: PreviewGatewayResolver) => PreviewGatewayResolver
  browserFactory?: PageBrowserFactory
}

/**
 * The mcp role on its own port: the only orchestrator port sandboxes reach (through
 * sandbox-gw), so nothing of core — /metrics, queues, workers — is mounted here.
 * In production it has its own Vault AppRole; PostgreSQL uses the shared user raditi.
 *
 * Published content (wp_rest, restore) is the content profile of the configuration
 * (MCP_CONTENT_PROFILE): snapshots in the artifacts bucket, the gateway from the adapter of the
 * site's stack. With `local` a dialog writes into its preview alone (docs/plan/53-chat-preview-
 * release.md, Р3, Р24): the access the build created in Vault `kv/previews/<previewId>/<kind>`,
 * each write an operation of the dialog's database plan. Only `local-site` — the local stands,
 * refused beside previews — lets a dialog write the site itself: the P6 path, with the access of
 * the site from Vault through the reference in credential_refs.
 *
 * The agent's browser on the preview (browser_*) is the browser profile (MCP_BROWSER_PROFILE,
 * Р21): a context of the preview's browser per turn, screenshots in the artifacts bucket.
 */
@Module({})
export class McpAppModule {
  static forRoot(config: McpConfig, testing?: McpContentTesting): DynamicModule {
    const content = config.contentProfile !== 'off'
    // The P6 path is a profile of its own, never what an empty PREVIEW_BASE_DOMAIN implies (Р3).
    const siteContent = config.contentProfile === 'local-site'
    // A configuration written before the browser profile has none: off.
    const browser = (config.browserProfile ?? 'off') !== 'off'
    const previews = config.preview ?? null
    // Customer onboarding and the gate for real data are not in place (spec §20). loadConfig
    // refuses the settings in production; this refuses a composition that got past it.
    if ((content || testing) && isProduction(config.appEnv))
      throw new Error('Local MCP content profile cannot run in production')
    if (browser && isProduction(config.appEnv))
      throw new Error('Local MCP browser profile cannot run in production')
    if ((testing?.wrapResolver || testing?.wrapPreviewResolver) && !content)
      throw new Error('MCP content test seams need the content profile')
    if (testing?.browserFactory && !browser)
      throw new Error('MCP browser test seams need the browser profile')
    // The browser goes to the preview of a dialog: without previews there is nowhere to go.
    if (browser && !previews)
      throw new Error('MCP browser profile needs previews (PREVIEW_BASE_DOMAIN)')
    // loadConfig refuses both; this refuses a composition that got past it.
    if (config.contentProfile === 'local' && !previews)
      throw new Error('MCP content profile local writes into previews (PREVIEW_BASE_DOMAIN)')
    if (siteContent && previews)
      throw new Error('MCP content profile local-site is refused beside previews')
    const storageConfig = config.storage
    if (content && !storageConfig) throw new Error('MCP content profile needs its S3 settings')
    if (browser && !storageConfig) throw new Error('MCP browser profile needs its S3 settings')
    const security: McpSecurity = {
      allowedHosts: config.allowedHosts,
      allowLocalOrigin: config.appEnv !== 'production',
      ...(content ? { contentTools: true, siteContent } : {}),
      ...(browser ? { browserTools: true } : {}),
    }
    const runtime = createMcpRuntime(security)
    return {
      module: McpAppModule,
      controllers: [
        HealthController,
        McpHttpController,
        McpToolsController,
        ...(content ? [McpContentController] : []),
        ...(browser ? [McpBrowserController] : []),
      ],
      providers: [
        { provide: MCP_STRATEGY, useValue: runtime.strategy },
        { provide: MCP_HTTP_HANDLER, useValue: runtime.handlers },
        { provide: MCP_SECURITY, useValue: security },
        { provide: MCP_PREVIEW_ADDRESS, useValue: previews },
        {
          provide: MCP_ACCESS,
          useFactory: (prisma: PrismaClient) => new PostgresMcpAccess(prisma),
          inject: [PRISMA],
        },
        McpAuthGuard,
        ...((content || browser) && storageConfig
          ? [
              {
                provide: MCP_CONTENT_STORAGE,
                useFactory: (): ContentStorage => createContentStorage(storageConfig),
              },
            ]
          : []),
        ...(browser && previews
          ? [
              {
                provide: MCP_BROWSER,
                inject: [PRISMA, MCP_CONTENT_STORAGE, SECRET_STORE],
                useFactory: (prisma: PrismaClient, storage: ContentStorage, secrets: SecretStore) =>
                  new McpBrowserService({
                    store: new PostgresMcpBrowserStore(prisma),
                    factory: testing?.browserFactory ?? createPlaywrightBrowserFactory(),
                    secrets,
                    privacy: new ContentPrivacy(secrets),
                    storage,
                    // The stack of the site picks where its pages may go; this module names no CMS.
                    adapters: getSiteAdapter,
                    address: previews,
                  }),
              },
            ]
          : []),
        ...(content
          ? [
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
                  return testing?.wrapResolver ? testing.wrapResolver(regular) : regular
                },
              },
              {
                provide: MCP_PREVIEW_RESOLVER,
                inject: [SECRET_STORE],
                useFactory: (secrets: SecretStore): PreviewGatewayResolver => {
                  const logger = new Logger('McpPreviewContent')
                  const warn = throttledLogger((line) => logger.warn(line))
                  const regular = createPreviewContentResolver({
                    secrets,
                    adapters: getSiteContentAdapter,
                    address: previews,
                    upstreamHost: config.previewUpstreamHost,
                    onRefusal: (reason) => warn(`preview content access (${reason})`, 'refused'),
                  })
                  return testing?.wrapPreviewResolver
                    ? testing.wrapPreviewResolver(regular)
                    : regular
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
                  PRISMA,
                  MCP_CONTENT_STORAGE,
                  SECRET_STORE,
                  MCP_CONTENT_RESOLVER,
                  MCP_PREVIEW_RESOLVER,
                ],
                useFactory: (
                  prisma: PrismaClient,
                  storage: ContentStorage,
                  secrets: SecretStore,
                  resolve: ContentGatewayResolver,
                  preview: PreviewGatewayResolver,
                ) =>
                  new McpContentService(
                    new PostgresMcpJournal(prisma),
                    new ContentSnapshotStorage(storage, secrets),
                    new ContentPrivacy(secrets),
                    resolve,
                    {
                      // The P6 path: the stands' profile `local-site` alone.
                      siteContent,
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
            ]
          : []),
        { provide: PRISMA, useFactory: () => createAppPrisma(config.db) },
        { provide: SECRET_STORE, useFactory: () => createVaultSecretStore(config.vault) },
        {
          provide: HEALTH_CHECKS,
          useFactory: (
            prisma: PrismaClient,
            secrets: SecretStore,
            access: McpAccessStore,
            storage?: ContentStorage,
          ): HealthChecks => ({
            database: databaseCheck(() => prisma),
            vault: vaultCheck(() => secrets),
            // The one bucket of the role: without it no snapshot, so no content change.
            ...(storage ? { s3: s3Check(() => storage, ['artifacts']) } : {}),
            // The admission query itself: a schema it no longer matches (a migration not
            // applied) turns every agent request into 503 while SELECT 1 still passes.
            access: async () => {
              try {
                return (await access.authenticate(MCP_ACCESS_PROBE_TOKEN)) === null
              } catch (error) {
                // Health logs the message only; the cause stays in memory.
                throw new Error(mcpErrorSummary(error), { cause: error })
              }
            },
          }),
          inject: [
            PRISMA,
            SECRET_STORE,
            MCP_ACCESS,
            ...(content || browser ? [MCP_CONTENT_STORAGE] : []),
          ],
        },
        PrismaLifecycle,
      ],
    }
  }
}
