import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common'
import {
  provisioningLimits,
  SITE_IMPORT_QUEUE,
  SITE_PROVISION_JOB,
  siteProvisionJobSchema,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import { SiteImportRunner } from './site-import.runner.ts'

/**
 * Works the import queue: every job says «look at the code_import of this site», and the row of
 * the stage decides what happens (SiteImportRunner). Two imports per process at most. A job is
 * never retried by BullMQ: a failure of the infrastructure leaves the stage to its own requeue,
 * to the sweep and to the next event of its outbox.
 */
@Processor(SITE_IMPORT_QUEUE, { concurrency: provisioningLimits.importConcurrency })
export class SiteImportProcessor extends WorkerHost implements OnModuleDestroy {
  readonly #logger = new Logger(SiteImportProcessor.name)
  readonly #runner: Pick<SiteImportRunner, 'run'>
  readonly #shutdown = new AbortController()
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(SiteImportRunner) runner: Pick<SiteImportRunner, 'run'>) {
    super()
    this.#runner = runner
  }

  async process(job: Job): Promise<void> {
    // A job this build does not know (left by another version) cannot succeed later.
    if (job.name !== SITE_PROVISION_JOB)
      throw new UnrecoverableError(`Unknown site import job "${job.name}"`)
    const parsed = siteProvisionJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('Invalid site import job')
    const { siteId, stage } = parsed.data
    // The schema of a database is another stage, of another queue and not of this slice.
    if (stage !== 'code_import') {
      this.#logger.warn(`site_import_ignored site=${siteId.toLowerCase()} stage=${stage}`)
      return
    }
    await this.#runner.run(siteId.toLowerCase(), this.#shutdown.signal)
  }

  /**
   * Shutdown of core: the running imports stop and give their stages back to the queue
   * (releaseDelayMs) while the database is still there, within the hard stop of the process
   * (30 s). As early as the modules are destroyed, not only when BullMQ closes the worker after
   * them: the other modules may take their time. A job the worker still takes meanwhile is
   * skipped; its stage stays queued until the sweep wakes it.
   */
  onModuleDestroy(): void {
    this.#shutdown.abort()
  }

  /** The worker is closing and waits for its jobs (also outside a Nest shutdown). */
  @OnWorkerEvent('closing')
  onClosing(): void {
    this.#shutdown.abort()
  }

  /** Without the error: a driver's message may quote what it was sent. */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    this.#logger.warn(`site_import_job_failed job=${job?.id ?? '?'}`)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${SITE_IMPORT_QUEUE}`, err)
  }
}
