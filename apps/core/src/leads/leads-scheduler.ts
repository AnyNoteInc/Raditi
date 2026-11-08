import { InjectQueue } from '@nestjs/bullmq'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { errorMessage } from '@repo/observability'
import type { Queue } from 'bullmq'

import { BACKGROUND_JOBS } from '../config/config.tokens.ts'
import { LEAD_POLL_JOB, LEADS_QUEUE } from './leads-jobs.ts'

/** The id of the job scheduler of the poll: one for all core processes. */
export const LEADS_POLL_SCHEDULER_ID = 'leads.poll'
/** How often the presses of «Обработано» are read. */
export const LEADS_POLL_EVERY_MS = 5_000
/** After a failed registration the scheduler is tried again this much later. */
export const LEADS_SCHEDULER_RETRY_MS = 30_000

/**
 * Registers the poll of the bot of leads as a BullMQ job scheduler, as BillingScheduler does
 * its passes: every core process upserts the same one, each tick makes one job for one worker.
 * A poll has one attempt and leaves Redis at once: the next tick reads the same updates.
 */
@Injectable()
export class LeadsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(LeadsScheduler.name)
  readonly #queue: Pick<Queue, 'upsertJobScheduler'>
  readonly #background: boolean
  #retry: NodeJS.Timeout | undefined
  #stopping = false

  constructor(
    @InjectQueue(LEADS_QUEUE) queue: Pick<Queue, 'upsertJobScheduler'>,
    @Inject(BACKGROUND_JOBS) background: boolean,
  ) {
    this.#queue = queue
    this.#background = background
  }

  onApplicationBootstrap(): void {
    if (!this.#background) return
    void this.register()
  }

  /** Upserts the scheduler; resolves to whether it stands. Never rejects. */
  async register(): Promise<boolean> {
    if (this.#stopping) return false
    try {
      await this.#queue.upsertJobScheduler(
        LEADS_POLL_SCHEDULER_ID,
        { every: LEADS_POLL_EVERY_MS },
        {
          name: LEAD_POLL_JOB,
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 60 * 60 } },
        },
      )
    } catch (error) {
      if (this.#stopping) return false
      this.#logger.warn(
        `The poll of leads is not registered, next try in ${LEADS_SCHEDULER_RETRY_MS / 1_000} s: ` +
          errorMessage(error),
      )
      this.#retry = setTimeout(() => void this.register(), LEADS_SCHEDULER_RETRY_MS)
      this.#retry.unref()
      return false
    }
    this.#logger.log(`The bot of leads reads its buttons every ${LEADS_POLL_EVERY_MS / 1_000} s`)
    return true
  }

  onModuleDestroy(): void {
    this.#stopping = true
    clearTimeout(this.#retry)
  }
}
