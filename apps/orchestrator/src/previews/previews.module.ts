import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import {
  isProduction,
  type ObjectStorage,
  type PreviewRuntime,
  type SecretStore,
  type TurnCredentialSource,
  type TurnExecutor,
} from '@repo/domain'
import { createDockerPreviewRuntime, type DockerPreviewConfig } from '@repo/sandbox-providers'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import {
  createMysqlDatabaseCatalog,
  createMysqlDatabaseCopier,
} from '@repo/site-connections/database-copy'
import { createHostLookup, createPinnedSiteTransport } from '@repo/site-connections/hosting'

import type { CoreConfig, PreviewsConfig } from '../config/config.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import {
  BACKGROUND_JOBS,
  CORE_CONFIG,
  OBJECT_STORAGE,
  PRISMA,
  SECRET_STORE,
  TURN_CREDENTIALS,
  TURN_EXECUTOR,
} from '../infra/tokens.ts'
import { LlmModule } from '../llm/llm.module.ts'
import { PreviewDbValueStorage } from '../mcp/preview-db-values.ts'
import { createSiteContentResolver } from '../mcp/site-content-resolver.ts'
import { previewDbPlanValues } from './db-plan-values.ts'
import { PreviewLoops } from './preview-loops.ts'
import { PreviewManager } from './preview-manager.ts'
import { PreviewsProcessor } from './previews.processor.ts'

/** PreviewRuntime of core's own Docker, or null when previews run elsewhere or not at all. */
export const PREVIEW_RUNTIME = Symbol('PREVIEW_RUNTIME')

/**
 * The runtime of core's own Docker for PREVIEW_EXECUTOR=local; null with runner VMs (M10). Its
 * egress proxy refuses the platform's subnets the sandbox gateway refuses (R10).
 */
export function previewRuntimeConfig(previews: PreviewsConfig | null): DockerPreviewConfig | null {
  if (!previews?.docker) return null
  return {
    runtime: previews.runtime,
    socketPath: previews.docker.socketPath,
    gatewayPort: previews.gatewayPort,
    egressRefusedSubnets: [...previews.egressRefusedSubnets],
    ...(previews.docker.firewallImage ? { firewallImage: previews.docker.firewallImage } : {}),
  }
}

/**
 * Previews of dialogs in the core role (docs/plan/53-chat-preview-release.md, R5c): the
 * processor of the `previews` queue, the loop of request rows of the mcp role, the sweep. Without
 * previews here (PREVIEW_BASE_DOMAIN unset) nothing of it runs; with PREVIEW_EXECUTOR=runner
 * (M10) builds end `failed` with `not_configured` until the runner executor exists.
 */
@Module({
  imports: [GitWorkspaceModule, LlmModule],
  providers: [
    {
      provide: PREVIEW_RUNTIME,
      useFactory: (config: CoreConfig): PreviewRuntime | null => {
        const runtime = previewRuntimeConfig(config.previews)
        return runtime ? createDockerPreviewRuntime(runtime) : null
      },
      inject: [CORE_CONFIG],
    },
    {
      provide: PreviewManager,
      useFactory: (
        config: CoreConfig,
        prisma: PrismaClient,
        runtime: PreviewRuntime | null,
        git: GitWorkspaceService | null,
        executor: TurnExecutor,
        storage: ObjectStorage,
        secrets: SecretStore,
        credentials: TurnCredentialSource,
      ): PreviewManager | null => {
        const previews = config.previews
        if (!previews) return null
        const connections = { lookup: createHostLookup(), appEnv: config.appEnv }
        return new PreviewManager({
          db: prisma,
          config: previews,
          runtime,
          copier: createMysqlDatabaseCopier(connections),
          catalog: createMysqlDatabaseCatalog(connections),
          git,
          executor,
          credentials,
          storage,
          secrets,
          // The stack of the site picks its adapters; this module names no CMS.
          adapters: getSiteAdapter,
          contentAdapters: getSiteContentAdapter,
          production: createSiteContentResolver({
            prisma,
            secrets,
            adapters: getSiteContentAdapter,
            // The address rule of a site (spec §12): never an address of the platform.
            transport: createPinnedSiteTransport(connections),
            // A disposable local site of a stand: plain http on loopback, never in production.
            allowLoopbackHttp: !isProduction(config.appEnv),
          }),
          values: previewDbPlanValues({
            prisma,
            values: new PreviewDbValueStorage(storage, secrets),
          }),
        })
      },
      inject: [
        CORE_CONFIG,
        PRISMA,
        PREVIEW_RUNTIME,
        GitWorkspaceService,
        TURN_EXECUTOR,
        OBJECT_STORAGE,
        SECRET_STORE,
        TURN_CREDENTIALS,
      ],
    },
    {
      provide: PreviewLoops,
      useFactory: (manager: PreviewManager | null, background: boolean) =>
        new PreviewLoops(manager, background),
      inject: [PreviewManager, BACKGROUND_JOBS],
    },
    PreviewsProcessor,
  ],
  exports: [PreviewManager],
})
export class PreviewsModule {}
