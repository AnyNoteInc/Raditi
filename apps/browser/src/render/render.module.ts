import { Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common'
import { createPlaywrightFrameRenderer } from '@repo/browser-providers/render'
import type { PrismaClient } from '@repo/db'
import { isProduction, type BrowserSessionRuntime } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'

import { WORKER_TOKEN } from '../api/api.tokens.ts'
import { WorkerTokenGuard } from '../api/worker-auth.guard.ts'
import type { BrowserWorkerConfig } from '../config/config.ts'
import { errorName } from '../common/browser-codes.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { SESSION_RUNTIME } from '../sessions/sessions.tokens.ts'
import { createArtifactFiles } from './artifact-files.ts'
import { RenderPool } from './render-pool.ts'
import { RenderService, type ArtifactFilesReader } from './render-service.ts'
import { DiagramService } from './diagram-service.ts'
import { PrintService } from './print-service.ts'
import { DiagramController, PrintController, RenderController } from './render.controller.ts'
import {
  ARTIFACT_FILES,
  DIAGRAM_SERVICE,
  PRINT_SERVICE,
  RENDER_POOL,
  RENDER_SERVICE,
} from './render.tokens.ts'

/** Render containers at most: each draws two frames at a time (§7.12). */
const RENDER_CONTAINERS = 2

/**
 * The renderer of frames of artifacts (docs/plan/88-artifacts.md, Ар32, §7.12; slices 88.15,
 * 88.15б, 88.15в): `POST /v1/render`, its pool of containers without network and the files of
 * artifacts it reads. The pool is closed when the app stops.
 */
@Module({
  imports: [SessionsModule],
  controllers: [RenderController, DiagramController, PrintController],
  providers: [
    {
      provide: RENDER_POOL,
      useFactory: (config: BrowserWorkerConfig, runtime: BrowserSessionRuntime | null) => {
        const logger = new Logger('RenderPool')
        return new RenderPool({
          runtime,
          // Without the images of the runtime, outside production: a Chromium of this machine.
          local: runtime === null && !isProduction(config.appEnv),
          containers: RENDER_CONTAINERS,
          create: createPlaywrightFrameRenderer,
          warn: (event, error) => logger.warn(`${event}: ${errorName(error)}`),
        })
      },
      inject: [BROWSER_CONFIG, SESSION_RUNTIME],
    },
    {
      provide: ARTIFACT_FILES,
      useFactory: (config: BrowserWorkerConfig): ArtifactFilesReader =>
        createArtifactFiles(config.storage),
      inject: [BROWSER_CONFIG],
    },
    {
      provide: RENDER_SERVICE,
      useFactory: (prisma: PrismaClient, files: ArtifactFilesReader, pool: RenderPool) =>
        new RenderService({ db: prisma, files, pool }),
      inject: [PRISMA, ARTIFACT_FILES, RENDER_POOL],
    },
    {
      provide: DIAGRAM_SERVICE,
      useFactory: (pool: RenderPool) => new DiagramService(pool),
      inject: [RENDER_POOL],
    },
    {
      provide: PRINT_SERVICE,
      useFactory: (pool: RenderPool) => new PrintService(pool),
      inject: [RENDER_POOL],
    },
    {
      provide: WORKER_TOKEN,
      useFactory: (config: BrowserWorkerConfig): string => config.token,
      inject: [BROWSER_CONFIG],
    },
    WorkerTokenGuard,
  ],
})
export class RenderModule implements OnModuleDestroy {
  readonly #pool: RenderPool

  constructor(@Inject(RENDER_POOL) pool: RenderPool) {
    this.#pool = pool
  }

  async onModuleDestroy(): Promise<void> {
    await this.#pool.close()
  }
}
