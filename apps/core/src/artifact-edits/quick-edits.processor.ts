import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { QUICK_EDIT_JOB, quickEditJobSchema } from '@repo/domain/artifacts'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { QuickEditRunner } from './quick-edit-runner.ts'
import { QUICK_EDIT_RUNNER } from './quick-edits.tokens.ts'

/**
 * Works the queue `artifact-edits` (docs/plan/98-quick-edits.md): one quick edit per job, one try —
 * a lost one is ended by the sweeper. Many at a time: each mostly waits for the model. Logs carry
 * the job id, never the content.
 */
@Processor('artifact-edits', { concurrency: 32, lockDuration: 60_000, maxStalledCount: 0 })
export class QuickEditsProcessor extends WorkerHost {
  readonly #logger = new Logger(QuickEditsProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(QUICK_EDIT_RUNNER) private readonly runner: Pick<QuickEditRunner, 'run'>) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name !== QUICK_EDIT_JOB) throw new UnrecoverableError(`Unknown job "${job.name}"`)
    const data = quickEditJobSchema.safeParse(job.data)
    if (!data.success) throw new UnrecoverableError('Invalid artifact.quick_edit job')
    await this.runner.run(data.data.quickEditId)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#logger.warn(`Quick edit job ${job?.id ?? '?'} failed: ${errorMessage(err)}`)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn('worker artifact-edits', err)
  }
}
