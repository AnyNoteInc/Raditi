import { Logger } from '@nestjs/common'
import {
  claimDueSchedule,
  dueScheduleIds,
  recordRunOutcome,
  stalePendingRuns,
  type PrismaClient,
} from '@repo/db'
import { isDomainError, scheduleLimits } from '@repo/domain'

import type { ScheduleNotify } from './schedule-notify.ts'

// The tick of the scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп14, Зп19–Зп21): once a minute
// every core process may run it. The tasks due by now are claimed one by one, each in a
// transaction of its own under its row FOR UPDATE SKIP LOCKED — two ticks never claim one task,
// and a task another holds is the next tick's. A claim writes the run with its outbox event
// `schedule.start`, or «Пропущено»; then runs web never answered for 75 minutes are closed,
// «Не запустилась: сбой платформы». Logs carry ids only.

/** Tasks one read of the due ones takes. */
export const SCHEDULE_TICK_BATCH = 100
/** Reads of the due tasks one tick makes at most: a tick never runs into the next one. */
export const SCHEDULE_TICK_ROUNDS = 20

export interface ScheduleTickDependencies {
  db: Pick<PrismaClient, '$transaction' | 'scheduledTask' | 'scheduledRun'>
  notify: Pick<ScheduleNotify, 'afterRun'>
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

export interface ScheduleTickResult {
  /** Tasks this tick claimed: a run, a missed row, or both. */
  claimed: number
  /** Runs handed to web by `schedule.start`. */
  started: number
  /** Runs web never answered, closed now. */
  stale: number
}

export class ScheduleTick {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ScheduleTickDependencies) {
    this.#logger = deps.logger ?? new Logger('ScheduleTick')
    this.#now = deps.now ?? (() => new Date())
  }

  /** One tick. A task that throws is logged and the tick goes on; `signal` stops it between rows. */
  async run(signal?: AbortSignal): Promise<ScheduleTickResult> {
    const now = this.#now()
    const result: ScheduleTickResult = { claimed: 0, started: 0, stale: 0 }
    const seen = new Set<string>()
    for (let round = 0; round < SCHEDULE_TICK_ROUNDS && !signal?.aborted; round++) {
      const ids = await dueScheduleIds(this.deps.db, now, SCHEDULE_TICK_BATCH)
      // A task another tick holds, or one that throws, comes back in the next read: once a tick.
      const fresh = ids.filter((id) => !seen.has(id))
      for (const id of fresh) {
        if (signal?.aborted) break
        seen.add(id)
        await this.#claim(id, now, result)
      }
      if (ids.length < SCHEDULE_TICK_BATCH || fresh.length === 0) break
    }
    if (!signal?.aborted) await this.#closeStale(now, result, signal)
    if (result.claimed > 0 || result.stale > 0)
      this.#logger.log(
        `schedule_tick claimed=${result.claimed} started=${result.started} stale=${result.stale}`,
      )
    return result
  }

  async #claim(id: string, now: Date, result: ScheduleTickResult): Promise<void> {
    try {
      const claim = await this.deps.db.$transaction((tx) => claimDueSchedule(tx, id, now))
      if (!claim) return
      result.claimed++
      if (claim.startRunId !== null) result.started++
      if (claim.completed) this.#logger.log(`schedule_completed schedule=${id}`)
      // «Пропущено» while the platform stood (Зп14); one still going is said in the list alone.
      if (claim.missedRunId !== null) await this.deps.notify.afterRun(claim.missedRunId)
    } catch (error) {
      this.#logger.warn(
        `schedule_claim_failed schedule=${id} reason=${isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown'}`,
      )
    }
  }

  /** Runs `pending` longer than 75 minutes: «Не запустилась: сбой платформы» (Зп21). */
  async #closeStale(now: Date, result: ScheduleTickResult, signal?: AbortSignal): Promise<void> {
    const olderThan = new Date(now.getTime() - scheduleLimits.pendingSweepMinutes * 60_000)
    const stale = await stalePendingRuns(this.deps.db, olderThan, SCHEDULE_TICK_BATCH)
    for (const run of stale) {
      if (signal?.aborted) return
      try {
        const recorded = await recordRunOutcome(
          this.deps.db,
          run.id,
          { status: 'refused', reason: 'platform' },
          now,
        )
        if (!recorded.recorded) continue
        result.stale++
        this.#logger.warn(`schedule_run_stale run=${run.id} attempts=${run.attempts}`)
        await this.deps.notify.afterRun(run.id, recorded)
      } catch (error) {
        this.#logger.warn(
          `schedule_stale_failed run=${run.id} reason=${error instanceof Error ? error.name : 'unknown'}`,
        )
      }
    }
  }
}
