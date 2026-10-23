import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { isDomainError } from '@repo/domain'
import type { Mailer } from '@repo/mail'
import { deliverNotification, NOTIFICATIONS_QUEUE } from '@repo/notifications'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import { MAILER } from './notifications.tokens.ts'

/**
 * Delivers the notifications queue: job name = notification type, job data = payload.
 * Invalid jobs (BAD_REQUEST) fail at once; delivery errors are retried with the queue's
 * backoff. Logs carry the job name and id only: payloads hold addresses and one-time links.
 */
@Processor(NOTIFICATIONS_QUEUE, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
  readonly #logger = new Logger(NotificationsProcessor.name)
  readonly #mailer: Mailer
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(MAILER) mailer: Mailer) {
    super()
    this.#mailer = mailer
  }

  async process(job: Job): Promise<void> {
    try {
      await deliverNotification({ type: job.name, payload: job.data }, { mailer: this.#mailer })
    } catch (err) {
      if (isDomainError(err) && err.code === 'BAD_REQUEST') {
        throw new UnrecoverableError(err.message)
      }
      throw err
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#logger.warn(
      `Notification ${job?.name ?? '?'} (job ${job?.id ?? '?'}, attempt ${job?.attemptsMade ?? '?'}) ` +
        `failed: ${errorMessage(err)}`,
    )
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${NOTIFICATIONS_QUEUE}`, err)
  }
}
