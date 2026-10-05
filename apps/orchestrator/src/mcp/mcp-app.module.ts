import { Logger, Module, type DynamicModule } from '@nestjs/common'
import { MCP_HTTP_HANDLER, MCP_STRATEGY } from '@rekog/mcp-nest'
import type { PrismaClient } from '@repo/db'
import { isProduction, type SecretStore } from '@repo/domain'
import {
  databaseCheck,
  s3Check,
  throttledLogger,
  vaultCheck,
  type HealthChecks,
} from '@repo/observability'
import { fetchSiteTransport, getSiteContentAdapter } from '@repo/site-adapters'
import { createVaultSecretStore } from '@repo/vault'

import type { McpConfig } from '../config/config.ts'
import { HealthController } from '../health/health.controller.ts'
import { PrismaLifecycle } from '../infra/lifecycle.ts'
import { createOrchestratorPrisma } from '../infra/prisma.ts'
import { HEALTH_CHECKS, PRISMA, SECRET_STORE } from '../infra/tokens.ts'
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
import { McpToolsController } from './mcp-tools.controller.ts'
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
import { createSiteContentResolver, MCP_CONTENT_RESOLVER } from './site-content-resolver.ts'

/**
 * A seam for the stands, never for the regular role: wraps the gateway resolver of the content
 * profile to inject faults (a lost acknowledgement, a refused write). It turns nothing on: the
 * profile, its S3 and where a site's access comes from are the configuration's.
 */
export interface McpContentTesting {
  wrapResolver: (regular: ContentGatewayResolver) => ContentGatewayResolver
}

/**
 * The mcp role on its own port: the only orchestrator port sandboxes reach (through
 * sandbox-gw), so nothing of core — /metrics, queues, workers — is mounted here.
 * In production it has its own Vault AppRole; PostgreSQL uses the shared user raditi.
 *
 * Published content (wp_rest, restore) is the content profile of the configuration
 * (MCP_CONTENT_PROFILE): snapshots in the artifacts bucket, the access of a site from Vault
 * through the reference in credential_refs, the gateway from the adapter of the site's stack.
 */
@Module({})
export class McpAppModule {
  static forRoot(config: McpConfig, testing?: McpContentTesting): DynamicModule {
    const content = config.contentProfile !== 'off'
    // Customer onboarding and the gate for real data are not in place (spec §20). loadConfig
    // refuses the setting in production; this refuses a composition that got past it.
    if ((content || testing) && isProduction(config.appEnv))
      throw new Error('Local MCP content profile cannot run in production')
    if (testing && !content) throw new Error('MCP content test seams need the content profile')
    const storageConfig = config.storage
    if (content && !storageConfig) throw new Error('MCP content profile needs its S3 settings')
    const security: McpSecurity = {
      allowedHosts: config.allowedHosts,
      allowLocalOrigin: config.appEnv !== 'production',
      ...(content ? { contentTools: true } : {}),
    }
    const runtime = createMcpRuntime(security)
    return {
      module: McpAppModule,
      controllers: [
        HealthController,
        McpHttpController,
        McpToolsController,
        ...(content ? [McpContentController] : []),
      ],
      providers: [
        { provide: MCP_STRATEGY, useValue: runtime.strategy },
        { provide: MCP_HTTP_HANDLER, useValue: runtime.handlers },
        { provide: MCP_SECURITY, useValue: security },
        {
          provide: MCP_ACCESS,
          useFactory: (prisma: PrismaClient) => new PostgresMcpAccess(prisma),
          inject: [PRISMA],
        },
        McpAuthGuard,
        ...(content && storageConfig
          ? [
              {
                provide: MCP_CONTENT_STORAGE,
                useFactory: (): ContentStorage => createContentStorage(storageConfig),
              },
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
                    // The local profile serves sites of this machine: plain http on loopback.
                    allowLoopbackHttp: config.contentProfile === 'local',
                    onRefusal: (reason) => warn(`site content access (${reason})`, 'refused'),
                  })
                  return testing ? testing.wrapResolver(regular) : regular
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
                inject: [PRISMA, MCP_CONTENT_STORAGE, SECRET_STORE, MCP_CONTENT_RESOLVER],
                useFactory: (
                  prisma: PrismaClient,
                  storage: ContentStorage,
                  secrets: SecretStore,
                  resolve: ContentGatewayResolver,
                ) =>
                  new McpContentService(
                    new PostgresMcpJournal(prisma),
                    new ContentSnapshotStorage(storage, secrets),
                    new ContentPrivacy(secrets),
                    resolve,
                  ),
              },
            ]
          : []),
        { provide: PRISMA, useFactory: () => createOrchestratorPrisma(config.db) },
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
          inject: [PRISMA, SECRET_STORE, MCP_ACCESS, ...(content ? [MCP_CONTENT_STORAGE] : [])],
        },
        PrismaLifecycle,
      ],
    }
  }
}
