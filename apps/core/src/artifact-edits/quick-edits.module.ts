import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import type { SecretStore } from '@repo/domain'
import type { PrismaClient } from '@repo/db'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { ArtifactChecks } from '../artifacts/artifact-checks.ts'
import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { QuickEditRunner } from './quick-edit-runner.ts'
import { QuickEditsProcessor } from './quick-edits.processor.ts'
import { QUICK_EDIT_RUNNER } from './quick-edits.tokens.ts'

const SWEEP_EVERY_MS = 60_000

/** The sweep of lost quick edits, once a minute, one pass at a time (БПр15). */
@Injectable()
class QuickEditSweepRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<unknown> | undefined

  constructor(@Inject(QUICK_EDIT_RUNNER) private readonly runner: Pick<QuickEditRunner, 'sweep'>) {}

  onApplicationBootstrap(): void {
    this.#timer = setInterval(() => {
      this.#pending ??= this.runner.sweep().finally(() => (this.#pending = undefined))
    }, SWEEP_EVERY_MS)
    this.#timer.unref()
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.#timer)
    await this.#pending
  }
}

/**
 * Quick edits of artifact notes (docs/plan/98-quick-edits.md): one model call of core each, through
 * the gateway of the llm role on the API offer, without a sandbox. The worker of `artifact-edits`.
 */
@Module({
  providers: [
    {
      provide: QUICK_EDIT_RUNNER,
      useFactory: (prisma: PrismaClient, secrets: SecretStore, config: CoreConfig) => {
        const logger = new Logger('QuickEdits')
        return new QuickEditRunner({
          db: prisma,
          secrets,
          gatewayOrigin: config.llmControlUrl ?? null,
          artifacts: new ArtifactChecks({ db: prisma, logger: new Logger('ArtifactChecks') }),
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
      inject: [PRISMA, SECRET_STORE, CORE_CONFIG],
    },
    QuickEditsProcessor,
    QuickEditSweepRuntime,
  ],
})
export class QuickEditsModule {}
