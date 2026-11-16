import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  SCHEDULE_QUEUE,
  SCHEDULE_START_JOB,
  SCHEDULE_TICK_JOB,
  scheduleLimits,
  scheduleStartJobSchema,
} from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { ScheduleStart } from './schedule-start.ts'
import type { ScheduleTick } from './schedule-tick.ts'
import { SCHEDULE_START, SCHEDULE_TICK } from './schedules.tokens.ts'

/**
 * Works the queue `schedules` (docs/plan/82-scheduled-tasks.md, Зп19–Зп21): `schedule.tick` claims
 * the due tasks (one attempt: the next tick does the same work), `schedule.start` hands one run to
 * web (retried by the queue's backoff; the last attempt gives the run up). A few at a time: a start
 * waits up to a minute for web, and a tick must not wait behind them. Logs carry the job name and
 * id, never the words of a task.
 */
@Processor(SCHEDULE_QUEUE, { concurrency: 4 })
export class SchedulesProcessor extends WorkerHost {
  readonly #logger = new Logger(SchedulesProcessor.name)
  readonly #tick: Pick<ScheduleTick, 'run'>
  readonly #start: Pick<ScheduleStart, 'run'>
  readonly #shutdown = new AbortController()
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(SCHEDULE_TICK) tick: Pick<ScheduleTick, 'run'>,
    @Inject(SCHEDULE_START) start: Pick<ScheduleStart, 'run'>,
  ) {
    super()
    this.#tick = tick
    this.#start = start
  }

  async process(job: Job): Promise<void> {
    if (job.name === SCHEDULE_TICK_JOB) {
      await this.#tick.run(this.#shutdown.signal)
      return
    }
    if (job.name !== SCHEDULE_START_JOB)
      throw new UnrecoverableError(`Unknown schedules job "${job.name}"`)
    const data = scheduleStartJobSchema.safeParse(job.data)
    if (!data.success) throw new UnrecoverableError('Invalid schedule.start job')
    await this.#start.run(
      data.data,
      { made: job.attemptsMade, max: job.opts.attempts ?? scheduleLimits.startAttempts },
      this.#shutdown.signal,
    )
  }

  /**
   * The worker is closing and waits for its jobs: the tick ends after the task it is at, a start
   * gives its post up and is tried again by the next core.
   */
  @OnWorkerEvent('closing')
  onClosing(): void {
    this.#shutdown.abort()
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    // A tick fails every minute while the database is away: one line a minute, not one a tick.
    if (job?.name === SCHEDULE_TICK_JOB) {
      this.#warn('Schedule tick', err)
      return
    }
    this.#logger.warn(
      `Schedules job ${job?.name ?? '?'} (job ${job?.id ?? '?'}, attempt ${job?.attemptsMade ?? '?'}) ` +
        `failed: ${errorMessage(err)}`,
    )
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${SCHEDULE_QUEUE}`, err)
  }
}
