import { Logger } from '@nestjs/common'
import { recordRunOutcome, type PrismaClient } from '@repo/db'
import {
  SCHEDULE_INTAKE_SECRET_HEADER,
  scheduleIntakeRequestSchema,
  scheduleIntakeResponseSchema,
  type ScheduleIntakeResponse,
  type ScheduleStartJob,
} from '@repo/domain'

import type { ScheduleNotify } from './schedule-notify.ts'

// The start of a run (docs/plan/82-scheduled-tasks.md, §4.3, Зп19–Зп21): only web creates a chat
// (`createDialog`, and core never imports @repo/trpc), and web shares no network with core, so
// core posts the id of the run to web's intake through the edge, as it posts the updates of the
// bot of the chat, with the secret in `x-raditi-schedule-secret`. Web starts the chat and writes
// the outcome itself; its chat id comes from the run, so a repeat never makes a second chat.
// 400 and 413 are final; web away, a deploy, 401 while a secret is rotated, 404, 5xx and a
// timeout are tried again by BullMQ (eight tries from 30 s doubling); after the last one the run
// is «Не запустилась: сбой платформы». A refusal is told by ScheduleNotify. Logs carry ids and
// statuses, never the secret or the words of a task.

/** Web takes a run in one `createDialog`, Vault and a transaction: its slowest path, with room. */
export const SCHEDULE_INTAKE_TIMEOUT_MS = 60_000

export interface ScheduleStartDependencies {
  db: Pick<PrismaClient, '$transaction' | 'scheduledRun'>
  /** SCHEDULE_INTAKE_URL and SCHEDULE_INTAKE_SECRET. */
  intake: { url: string; secret: string }
  notify: Pick<ScheduleNotify, 'afterRun'>
  fetch?: typeof fetch
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** What a delivery came to; a delivery to try again throws instead. */
export type ScheduleStartAnswer =
  'gone' | 'answered' | ScheduleIntakeResponse['outcome'] | 'given_up'

/** The attempt of the job: `made` failed before this one, of `max` (BullMQ's attemptsMade, attempts). */
export interface StartAttempt {
  made: number
  max: number
}

/** A delivery web did not take: BullMQ tries it again. */
export class ScheduleStartRetry extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleStartRetry'
  }
}

type Delivery =
  | { kind: 'answer'; answer: ScheduleIntakeResponse }
  | { kind: 'final'; status: number }
  | { kind: 'later'; cause: string }

export class ScheduleStart {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ScheduleStartDependencies) {
    this.#logger = deps.logger ?? new Logger('ScheduleStart')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(
    job: ScheduleStartJob,
    attempt: StartAttempt,
    signal?: AbortSignal,
  ): Promise<ScheduleStartAnswer> {
    const { db } = this.deps
    const run = await db.scheduledRun.findUnique({
      where: { id: job.runId },
      select: { status: true },
    })
    if (!run) return this.#log(job, 'gone')
    // Web answered before — this delivery is a repeat, or the tick closed the run meanwhile.
    if (run.status !== 'pending') return this.#log(job, 'answered')
    await db.scheduledRun.updateMany({
      where: { id: job.runId, status: 'pending' },
      data: { attempts: { increment: 1 } },
    })
    const delivery = await this.#post(job, signal)
    if (delivery.kind === 'answer') {
      // Web wrote the outcome; a refusal or a missed run is told here (Зп22, Зп38, Зп39).
      if (delivery.answer.outcome !== 'started') await this.deps.notify.afterRun(job.runId)
      return this.#log(job, delivery.answer.outcome)
    }
    if (delivery.kind === 'final') {
      this.#logger.warn(`schedule_start_refused run=${job.runId} status=${delivery.status}`)
      return this.#giveUp(job)
    }
    // The worker closing: the run waits for the next delivery, which BullMQ makes.
    if (signal?.aborted || attempt.made + 1 < attempt.max) {
      this.#logger.warn(
        `schedule_start_later run=${job.runId} attempt=${attempt.made + 1}/${attempt.max} cause=${delivery.cause}`,
      )
      throw new ScheduleStartRetry(`Web did not take the run: ${delivery.cause}`)
    }
    this.#logger.warn(
      `schedule_start_given_up run=${job.runId} attempts=${attempt.max} cause=${delivery.cause}`,
    )
    return this.#giveUp(job)
  }

  /** «Не запустилась: сбой платформы» (Зп21), told as a refusal is. */
  async #giveUp(job: ScheduleStartJob): Promise<ScheduleStartAnswer> {
    const recorded = await recordRunOutcome(
      this.deps.db,
      job.runId,
      { status: 'refused', reason: 'platform' },
      this.#now(),
    )
    if (recorded.recorded) await this.deps.notify.afterRun(job.runId, recorded)
    return this.#log(job, 'given_up')
  }

  async #post(job: ScheduleStartJob, signal?: AbortSignal): Promise<Delivery> {
    const { intake } = this.deps
    const timeout = AbortSignal.timeout(SCHEDULE_INTAKE_TIMEOUT_MS)
    let response: Response
    try {
      response = await (this.deps.fetch ?? fetch)(intake.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SCHEDULE_INTAKE_SECRET_HEADER]: intake.secret,
        },
        body: JSON.stringify(scheduleIntakeRequestSchema.parse({ runId: job.runId })),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        redirect: 'error',
      })
    } catch (error) {
      return { kind: 'later', cause: error instanceof Error ? error.name : 'Error' }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 400 || response.status === 413)
        return { kind: 'final', status: response.status }
      return { kind: 'later', cause: `HTTP ${response.status}` }
    }
    try {
      const answer = scheduleIntakeResponseSchema.safeParse(await response.json())
      // A body web would never write: a proxy on the way, a web of another version. Again later.
      if (!answer.success) return { kind: 'later', cause: 'unreadable answer' }
      return { kind: 'answer', answer: answer.data }
    } catch (error) {
      return { kind: 'later', cause: error instanceof Error ? error.name : 'Error' }
    }
  }

  #log(job: ScheduleStartJob, answer: ScheduleStartAnswer): ScheduleStartAnswer {
    this.#logger.log(`schedule_start run=${job.runId} answer=${answer}`)
    return answer
  }
}
