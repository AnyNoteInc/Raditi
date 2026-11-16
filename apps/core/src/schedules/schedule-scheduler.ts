import { InjectQueue } from '@nestjs/bullmq'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { SCHEDULE_QUEUE, SCHEDULE_TICK_JOB } from '@repo/domain'
import { errorMessage } from '@repo/observability'
import type { Queue } from 'bullmq'

import { BACKGROUND_JOBS } from '../config/config.tokens.ts'

/** The id of the job scheduler of the tick: one for all core processes. */
export const SCHEDULE_TICK_SCHEDULER_ID = 'schedule.tick'
/** How often the due scheduled tasks are claimed (Зп19): a run starts at most this late. */
export const SCHEDULE_TICK_EVERY_MS = 60_000
/** After a failed registration the scheduler is tried again this much later. */
export const SCHEDULE_SCHEDULER_RETRY_MS = 30_000

/**
 * Registers the tick of the scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп19) as a BullMQ
 * job scheduler, as LeadsScheduler does its poll: every core process upserts the same one, each
 * tick makes one job for one worker. A tick has one attempt and leaves Redis at once: the next
 * tick claims the same rows. SchedulesModule is imported only with the intake of web configured.
 */
@Injectable()
export class ScheduleScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(ScheduleScheduler.name)
  readonly #queue: Pick<Queue, 'upsertJobScheduler'>
  readonly #background: boolean
  #retry: NodeJS.Timeout | undefined
  #stopping = false

  constructor(
    @InjectQueue(SCHEDULE_QUEUE) queue: Pick<Queue, 'upsertJobScheduler'>,
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
        SCHEDULE_TICK_SCHEDULER_ID,
        { every: SCHEDULE_TICK_EVERY_MS },
        {
          name: SCHEDULE_TICK_JOB,
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 60 * 60 } },
        },
      )
    } catch (error) {
      if (this.#stopping) return false
      this.#logger.warn(
        `The tick of scheduled tasks is not registered, next try in ${SCHEDULE_SCHEDULER_RETRY_MS / 1_000} s: ` +
          errorMessage(error),
      )
      this.#retry = setTimeout(() => void this.register(), SCHEDULE_SCHEDULER_RETRY_MS)
      this.#retry.unref()
      return false
    }
    this.#logger.log(`Scheduled tasks are claimed every ${SCHEDULE_TICK_EVERY_MS / 1_000} s`)
    return true
  }

  onModuleDestroy(): void {
    this.#stopping = true
    clearTimeout(this.#retry)
  }
}
