import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import { BILLING_QUEUE, BillingJobs, isRenewalJob } from './billing-jobs.ts'

/**
 * Works the billing queue: every job is one renewal pass, named by the job (the schedulers of
 * BillingScheduler produce them). One pass at a time in this process; another core process
 * may run the same pass meanwhile, and the passes are written for that. A pass that fails —
 * the database is away — is not retried by BullMQ: the next tick does the same work.
 */
@Processor(BILLING_QUEUE, { concurrency: 1 })
export class BillingProcessor extends WorkerHost {
  readonly #logger = new Logger(BillingProcessor.name)
  readonly #jobs: Pick<BillingJobs, 'run'>
  readonly #shutdown = new AbortController()
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(BillingJobs) jobs: Pick<BillingJobs, 'run'>) {
    super()
    this.#jobs = jobs
  }

  async process(job: Job): Promise<void> {
    // A job of a pass this build does not know (left by another version) cannot succeed later.
    if (!isRenewalJob(job.name)) throw new UnrecoverableError(`Unknown billing job "${job.name}"`)
    await this.#jobs.run(job.name, this.#shutdown.signal)
  }

  /**
   * The worker is closing and waits for the running job: the pass ends after the row it is
   * at instead of holding the shutdown for all its batches.
   */
  @OnWorkerEvent('closing')
  onClosing(): void {
    this.#shutdown.abort()
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`billing ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${BILLING_QUEUE}`, err)
  }
}
