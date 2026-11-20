import { Logger, Module } from '@nestjs/common'
import type { ObjectStorage } from '@repo/domain'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { ArtifactExports } from './artifact-exports.ts'
import { ArtifactExportsProcessor } from './artifact-exports.processor.ts'
import { ARTIFACT_EXPORTS } from './artifact-exports.tokens.ts'

/**
 * The workbooks of tables of artifacts (docs/plan/88-artifacts.md, §7.13, question 26): the worker
 * of the queue `artifacts`.
 */
@Module({
  providers: [
    {
      provide: ARTIFACT_EXPORTS,
      useFactory: (prisma: PrismaClient, storage: ObjectStorage) => {
        const logger = new Logger('ArtifactExports')
        return new ArtifactExports({
          db: prisma,
          storage,
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
      inject: [PRISMA, OBJECT_STORAGE],
    },
    ArtifactExportsProcessor,
  ],
})
export class ArtifactExportsModule {}
