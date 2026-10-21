import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { ObjectStorage, SecretStore } from '@repo/domain'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { CORE_CONFIG, OBJECT_STORAGE } from '../infra/tokens.ts'
import { ReleaseApiServer } from './release-api.server.ts'
import { ReleaseApi } from './release-api.service.ts'

/**
 * The release API of the core role (docs/plan/53-chat-preview-release.md, Р32, R8b). startCore
 * opens its listener on RELEASE_API_HOST:RELEASE_API_PORT when CoreConfig.releaseApi is set;
 * without it only the health answers.
 */
@Module({
  imports: [GitWorkspaceModule],
  providers: [
    {
      provide: ReleaseApi,
      useFactory: (
        prisma: PrismaClient,
        workspace: GitWorkspaceService | null,
        secrets: SecretStore,
        storage: ObjectStorage,
        config: CoreConfig,
      ): ReleaseApi | null =>
        config.releaseApi
          ? new ReleaseApi({
              db: prisma,
              git: workspace,
              secrets,
              storage,
              adapter: getSiteAdapter,
              contentAdapter: getSiteContentAdapter,
              publicUrl: config.releaseApi.publicUrl,
            })
          : null,
      inject: [PRISMA, GitWorkspaceService, SECRET_STORE, OBJECT_STORAGE, CORE_CONFIG],
    },
    {
      provide: ReleaseApiServer,
      useFactory: (api: ReleaseApi | null) => new ReleaseApiServer(api),
      inject: [ReleaseApi],
    },
  ],
  exports: [ReleaseApiServer],
})
export class ReleaseApiModule {}
