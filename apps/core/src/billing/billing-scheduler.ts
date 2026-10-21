import { InjectQueue } from '@nestjs/bullmq'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { renewalJobs, type RenewalJob } from '@repo/billing'
import { errorMessage } from '@repo/observability'
import type { Queue } from 'bullmq'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, BACKGROUND_JOBS } from '../infra/tokens.ts'
import { BILLING_QUEUE } from './billing-jobs.ts'

/** The id of the job scheduler of a pass: one per pass for all core processes. */
export const billingSchedulerId = (job: RenewalJob) => `billing.${job}`

/** After a failed registration the schedulers are tried again this much later. */
export const BILLING_SCHEDULER_RETRY_MS = 30_000

/**
 * Registers the job schedulers of the renewal passes — the cron of billing (spec §7): one
 * BullMQ job scheduler per pass, every BILLING_TICK_SECONDS. A scheduler lives in Redis under
 * its id, so every core process upserts the same four and each tick still produces one job per
 * pass, taken by one worker. The first job of a new scheduler runs at once; an upsert of an
 * existing one keeps its rhythm and takes a changed interval.
 *
 * Only with background work on: tests and tools compile core without Redis. The upserts are
 * not awaited by the start of the application — while Redis is away BullMQ holds its commands
 * until the connection is back, and core must come up and answer /health meanwhile.
 */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(BillingScheduler.name)
  readonly #queue: Pick<Queue, 'upsertJobScheduler'>
  readonly #everyMs: number
  readonly #background: boolean
  #retry: NodeJS.Timeout | undefined
  #stopping = false

  constructor(
    @InjectQueue(BILLING_QUEUE) queue: Pick<Queue, 'upsertJobScheduler'>,
    @Inject(CORE_CONFIG) config: Pick<CoreConfig, 'billing'>,
    @Inject(BACKGROUND_JOBS) background: boolean,
  ) {
    this.#queue = queue
    this.#everyMs = config.billing.tickSeconds * 1_000
    this.#background = background
  }

  onApplicationBootstrap(): void {
    if (!this.#background) return
    void this.register()
  }

  /**
   * Upserts the four schedulers; resolves to whether all of them stand. A failure is logged
   * and tried again later, unless the application is stopping. Never rejects.
   */
  async register(): Promise<boolean> {
    if (this.#stopping) return false
    try {
      for (const job of renewalJobs) {
        await this.#queue.upsertJobScheduler(
          billingSchedulerId(job),
          { every: this.#everyMs },
          // The options of the job are the defaults of the queue (queues.ts).
          { name: job },
        )
      }
    } catch (error) {
      if (this.#stopping) return false
      this.#logger.warn(
        `Billing schedulers are not registered, next try in ${BILLING_SCHEDULER_RETRY_MS / 1_000} s: ` +
          errorMessage(error),
      )
      this.#retry = setTimeout(() => void this.register(), BILLING_SCHEDULER_RETRY_MS)
      this.#retry.unref()
      return false
    }
    this.#logger.log(
      `Renewal passes (${renewalJobs.join(', ')}) run every ${this.#everyMs / 1_000} s`,
    )
    return true
  }

  /**
   * Nothing to wait for: an upsert that is still held for a Redis that never came back is
   * dropped with the queue's connection (BullMqShutdownService). The schedulers stay in Redis
   * for the next start and for the other core processes.
   */
  onModuleDestroy(): void {
    this.#stopping = true
    clearTimeout(this.#retry)
  }
}
