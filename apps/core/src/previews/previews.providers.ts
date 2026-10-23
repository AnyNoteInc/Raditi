import type { Provider } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type {
  HostLookup,
  ObjectStorage,
  PreviewRuntime,
  SecretStore,
  TurnCredentialSource,
  TurnExecutor,
} from '@repo/domain'
import { createDockerPreviewRuntime, type DockerPreviewConfig } from '@repo/sandbox-providers'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { siteSource } from '@repo/site-connections'
import {
  createMysqlDatabaseCatalog,
  createMysqlDatabaseCopier,
} from '@repo/site-connections/database-copy'
import { databaseInspector } from '@repo/site-connections/databases'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig, PreviewsConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { TURN_CREDENTIALS } from '../llm/llm.tokens.ts'
import type { DbPlanValueReader } from '../site-content/db-plan-values.ts'
import type { SiteContentResolvers } from '../site-content/site-content-access.ts'
import {
  HOST_LOOKUP,
  PLAN_VALUES,
  SITE_CONTENT_RESOLVERS,
} from '../site-content/site-content.tokens.ts'
import { TURN_EXECUTOR } from '../turns/turns.tokens.ts'
import { PreviewLoops } from './preview-loops.ts'
import { PreviewManager } from './preview-manager.ts'
import { PREVIEW_RUNTIME } from './previews.tokens.ts'
import { createPreviewSiteSources } from './site-sources.ts'

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

/** The previews of dialogs: their runtime, their manager and its loops. */
export const previewProviders: Provider[] = [
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
      lookup: HostLookup,
      production: SiteContentResolvers,
      values: DbPlanValueReader,
    ): PreviewManager | null => {
      const previews = config.previews
      if (!previews) return null
      const connections = { lookup, appEnv: config.appEnv }
      return new PreviewManager({
        db: prisma,
        config: previews,
        runtime,
        copier: createMysqlDatabaseCopier(connections),
        catalog: createMysqlDatabaseCatalog(connections),
        // Where the site's files and database are, as the connection wizard recorded them.
        sources: createPreviewSiteSources({
          db: prisma,
          secrets,
          sources: siteSource,
          databases: databaseInspector,
          ...connections,
        }),
        git,
        executor,
        credentials,
        storage,
        secrets,
        // The stack of the site picks its adapters; this module names no CMS.
        adapters: getSiteAdapter,
        contentAdapters: getSiteContentAdapter,
        production: production(),
        values,
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
      HOST_LOOKUP,
      SITE_CONTENT_RESOLVERS,
      PLAN_VALUES,
    ],
  },
  {
    provide: PreviewLoops,
    useFactory: (manager: PreviewManager | null, background: boolean) =>
      new PreviewLoops(manager, background),
    inject: [PreviewManager, BACKGROUND_JOBS],
  },
]
