import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import {
  isProduction,
  type GitProvider,
  type ObjectStorage,
  type SecretStore,
  type SiteContentGateway,
  type SiteLeaseStore,
} from '@repo/domain'
import { giteaOrgOwnerToken } from '@repo/git-providers'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { createHostLookup, createPinnedSiteTransport } from '@repo/site-connections/hosting'
import { BACKGROUND_JOBS, OBJECT_STORAGE, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { configuredGitProvider } from '../git-workspace/git-config.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { CORE_CONFIG, SITE_LEASES } from '../infra/tokens.ts'
import {
  PreviewDbValueStorage,
  createSiteContentResolver,
  previewDbPlanValues,
} from '@repo/site-content'
import { ReleaseSkill, type ProductionContent } from './release-skill.ts'
import { ReleaseSweep, ReleaseSweepRuntime } from './release-sweep.ts'
import { ReleasesProcessor } from './releases.processor.ts'
import { UndoPlanner } from './undo-planner.ts'

/**
 * The provider of site repositories acting as the release account — the owner of the
 * organization `sites`, whose token Vault keeps (plan 53, Р26, Р35; R8a): tags, their protection
 * and the secrets of a repository. null while git is not configured.
 */
export const RELEASE_GIT_PROVIDER = Symbol('RELEASE_GIT_PROVIDER')

/**
 * Production's plugin by the site's own access, at an address the site rule allows (spec §12):
 * what the readiness of a release and the plan of an undo read of a site's database.
 */
function productionContent(
  prisma: PrismaClient,
  secrets: SecretStore,
  config: CoreConfig,
): ProductionContent {
  const resolve = createSiteContentResolver({
    prisma,
    secrets,
    adapters: getSiteContentAdapter,
    transport: createPinnedSiteTransport({
      lookup: createHostLookup(),
      appEnv: config.appEnv,
    }),
    // A disposable local site of a stand: plain http on loopback, never in production.
    allowLoopbackHttp: !isProduction(config.appEnv),
  })
  // The resolver builds the stack's gateway: it carries the plugin's database part.
  return (scope) => resolve(scope) as Promise<SiteContentGateway>
}

/** The values the agent wrote into a preview, as the mcp role sealed them (R5c, R7). */
const planValues = (prisma: PrismaClient, storage: ObjectStorage, secrets: SecretStore) =>
  previewDbPlanValues({ prisma, values: new PreviewDbValueStorage(storage, secrets) })

/**
 * Releases in the core role (docs/plan/53-chat-preview-release.md, R8b): the release skill, the
 * processor of `release.advance` on the `deploys` queue and its sweeper. The revert commit and
 * the end of a release are the skill's; `releases:resolve` is a command of the operator
 * (scripts/releases-resolve.mjs) that only hands an `unknown` release back to it.
 */
@Module({
  imports: [GitWorkspaceModule],
  providers: [
    {
      provide: RELEASE_GIT_PROVIDER,
      useFactory: (config: CoreConfig, secrets: SecretStore): GitProvider | null =>
        config.git
          ? configuredGitProvider(config.git, { ownerToken: giteaOrgOwnerToken(secrets) })
          : null,
      inject: [CORE_CONFIG, SECRET_STORE],
    },
    {
      provide: ReleaseSkill,
      useFactory: (
        prisma: PrismaClient,
        leases: SiteLeaseStore,
        workspace: GitWorkspaceService | null,
        provider: GitProvider | null,
        secrets: SecretStore,
        storage: ObjectStorage,
        config: CoreConfig,
      ) => {
        return new ReleaseSkill({
          db: prisma,
          leases,
          git: workspace,
          provider,
          secrets,
          storage,
          adapter: getSiteAdapter,
          contentAccessKind: (stack) => getSiteContentAdapter(stack).accessKind,
          api: config.releaseApi
            ? { startTimeoutMs: config.releaseApi.startTimeoutMinutes * 60_000 }
            : null,
          values: planValues(prisma, storage, secrets),
          previewBaseDomain: config.previews?.address.baseDomain ?? null,
          production: productionContent(prisma, secrets, config),
        })
      },
      inject: [
        PRISMA,
        SITE_LEASES,
        GitWorkspaceService,
        RELEASE_GIT_PROVIDER,
        SECRET_STORE,
        OBJECT_STORAGE,
        CORE_CONFIG,
      ],
    },
    {
      provide: UndoPlanner,
      useFactory: (
        prisma: PrismaClient,
        workspace: GitWorkspaceService | null,
        secrets: SecretStore,
        storage: ObjectStorage,
        config: CoreConfig,
      ) =>
        new UndoPlanner({
          db: prisma,
          git: workspace,
          production: productionContent(prisma, secrets, config),
          values: planValues(prisma, storage, secrets),
          adapter: getSiteAdapter,
          previewBaseDomain: config.previews?.address.baseDomain ?? null,
        }),
      inject: [PRISMA, GitWorkspaceService, SECRET_STORE, OBJECT_STORAGE, CORE_CONFIG],
    },
    ReleasesProcessor,
    {
      provide: ReleaseSweep,
      useFactory: (prisma: PrismaClient) => new ReleaseSweep(prisma),
      inject: [PRISMA],
    },
    {
      provide: ReleaseSweepRuntime,
      useFactory: (sweep: ReleaseSweep, background: boolean) =>
        new ReleaseSweepRuntime(sweep, background),
      inject: [ReleaseSweep, BACKGROUND_JOBS],
    },
  ],
  exports: [ReleaseSkill],
})
export class ReleasesModule {}
