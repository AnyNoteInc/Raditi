import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'

import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SiteFiles } from './site-files.ts'
import { SiteFilesProcessor } from './site-files.processor.ts'

/**
 * The files of a project for web (06.11.2026): the worker of the `site-files` queue and what it
 * reads. Without git core starts all the same; the section «Терминал» then waits.
 */
@Module({
  imports: [GitWorkspaceModule],
  providers: [
    {
      provide: SiteFiles,
      useFactory: (db: PrismaClient, git: GitWorkspaceService | null, storage: ObjectStorage) =>
        new SiteFiles({ db, git, storage }),
      inject: [PRISMA, GitWorkspaceService, OBJECT_STORAGE],
    },
    SiteFilesProcessor,
  ],
})
export class SiteFilesModule {}
