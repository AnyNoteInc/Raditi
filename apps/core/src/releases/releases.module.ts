import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { GitProvider, ObjectStorage, SecretStore, SiteLeaseStore } from '@repo/domain'
import { giteaOrgOwnerToken } from '@repo/git-providers'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { configuredGitProvider } from '../git-workspace/git-config.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { LeasesModule } from '../leases/leases.module.ts'
import { SITE_LEASES } from '../leases/leases.tokens.ts'
import type { DbPlanValueReader } from '../site-content/db-plan-values.ts'
import {
  productionContent,
  type SiteContentResolvers,
} from '../site-content/site-content-access.ts'
import { SiteContentModule } from '../site-content/site-content.module.ts'
import { PLAN_VALUES, SITE_CONTENT_RESOLVERS } from '../site-content/site-content.tokens.ts'
import { ReleaseSkill } from './release-skill.ts'
import { ReleaseSweep, ReleaseSweepRuntime } from './release-sweep.ts'
import { RELEASE_GIT_PROVIDER } from './releases.tokens.ts'
import { ReleasesProcessor } from './releases.processor.ts'
import { UndoPlanner } from './undo-planner.ts'

/**
 * Releases in the core role (docs/plan/53-chat-preview-release.md, R8b): the release skill, the
 * processor of `release.advance` on the `deploys` queue and its sweeper. The revert commit and
 * the end of a release are the skill's; `releases:resolve` is a command of the operator
 * (scripts/releases-resolve.mjs) that only hands an `unknown` release back to it. What the
 * readiness of a release and the plan of an undo read of a site's database is production's
 * plugin (SiteContentModule), each with a resolver of its own.
 */
@Module({
  imports: [GitWorkspaceModule, LeasesModule, SiteContentModule],
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
        values: DbPlanValueReader,
        production: SiteContentResolvers,
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
          values,
          previewBaseDomain: config.previews?.address.baseDomain ?? null,
          production: productionContent(production()),
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
        PLAN_VALUES,
        SITE_CONTENT_RESOLVERS,
      ],
    },
    {
      provide: UndoPlanner,
      useFactory: (
        prisma: PrismaClient,
        workspace: GitWorkspaceService | null,
        config: CoreConfig,
        values: DbPlanValueReader,
        production: SiteContentResolvers,
      ) =>
        new UndoPlanner({
          db: prisma,
          git: workspace,
          production: productionContent(production()),
          values,
          adapter: getSiteAdapter,
          previewBaseDomain: config.previews?.address.baseDomain ?? null,
        }),
      inject: [PRISMA, GitWorkspaceService, CORE_CONFIG, PLAN_VALUES, SITE_CONTENT_RESOLVERS],
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
})
export class ReleasesModule {}
