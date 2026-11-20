import { Logger, Module } from '@nestjs/common'
import { createBrowserWorkerClient } from '@repo/browser-link'
import type { ObjectStorage } from '@repo/domain'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { ArtifactExports } from './artifact-exports.ts'
import { ArtifactThumbs } from './artifact-thumbs.ts'
import { ArtifactExportsProcessor } from './artifact-exports.processor.ts'
import { ARTIFACT_EXPORTS, ARTIFACT_THUMBS } from './artifact-exports.tokens.ts'

/**
 * The workbooks of tables of artifacts (docs/plan/88-artifacts.md, §7.13, question 26) and the
 * thumbnails of canvases (§7.7, slice 88.15): the worker of the queue `artifacts`.
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
    {
      provide: ARTIFACT_THUMBS,
      useFactory: (prisma: PrismaClient, storage: ObjectStorage, config: CoreConfig) => {
        const logger = new Logger('ArtifactThumbs')
        // The renderer of frames is the browser worker's (§7.12): without it no thumbnail is drawn.
        const client = config.browser
          ? createBrowserWorkerClient({ baseUrl: config.browser.url, token: config.browser.token })
          : null
        return new ArtifactThumbs({
          db: prisma,
          storage,
          render: client ? (request) => client.render(request) : null,
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
      inject: [PRISMA, OBJECT_STORAGE, CORE_CONFIG],
    },
    ArtifactExportsProcessor,
  ],
})
export class ArtifactExportsModule {}
