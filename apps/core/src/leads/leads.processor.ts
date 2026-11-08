import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { LEAD_POLL_JOB, LEAD_SEND_JOB, LEADS_QUEUE, type LeadsJobs } from './leads-jobs.ts'
import { LEADS_JOBS } from './leads.tokens.ts'

const sendData = z.object({ leadId: z.uuid() })

/**
 * Works the queue of leads: `lead.send` posts one lead (retried by the queue's backoff),
 * `lead.poll` reads the presses of «Обработано» (one attempt: the next tick reads again). One job
 * at a time in this process. Logs carry the job name and id, never the lead.
 */
@Processor(LEADS_QUEUE, { concurrency: 1 })
export class LeadsProcessor extends WorkerHost {
  readonly #logger = new Logger(LeadsProcessor.name)
  readonly #jobs: Pick<LeadsJobs, 'send' | 'poll'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(LEADS_JOBS) jobs: Pick<LeadsJobs, 'send' | 'poll'>) {
    super()
    this.#jobs = jobs
  }

  async process(job: Job): Promise<void> {
    if (job.name === LEAD_POLL_JOB) {
      await this.#jobs.poll()
      return
    }
    if (job.name !== LEAD_SEND_JOB) throw new UnrecoverableError(`Unknown leads job "${job.name}"`)
    const data = sendData.safeParse(job.data)
    if (!data.success) throw new UnrecoverableError('Invalid lead.send job')
    await this.#jobs.send(data.data.leadId)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    // The poll fails every tick while Telegram is away: one line a minute, not one a tick.
    if (job?.name === LEAD_POLL_JOB) {
      this.#warn('Leads poll', err)
      return
    }
    this.#logger.warn(
      `Leads job ${job?.name ?? '?'} (job ${job?.id ?? '?'}, attempt ${job?.attemptsMade ?? '?'}) ` +
        `failed: ${errorMessage(err)}`,
    )
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${LEADS_QUEUE}`, err)
  }
}
