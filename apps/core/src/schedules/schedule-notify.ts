import { Logger } from '@nestjs/common'
import type { PrismaClient, RecordedRunOutcome } from '@repo/db'
import {
  isClientRefusalReason,
  scheduledNoticeTitle,
  scheduledRunReasonText,
  scheduleLimits,
  type ScheduledRunReason,
  type SchedulePausedReason,
} from '@repo/domain'

import type {
  DeliveryAnswer,
  Notice,
  NotificationDelivery,
} from '../tasks/notification-delivery.ts'

// The notices of a scheduled task itself (docs/plan/82-scheduled-tasks.md, Зп22, Зп38, Зп39): a
// run that did not start, a task that paused, a run the platform missed. They open the page of
// the task, not a chat; the push says the kind, the cabinet the name and the reason. A run of
// «Запустить сейчас» is told in the cabinet by its own words and never here (Зп24); a project the
// client deleted pauses its tasks without a notice (Зп22). A refusal for the reason told last is
// told once until the task starts again, or once a day; a missed run once a day; a notice of one
// kind is sent once per run whoever asks again.

/** A refusal for the same reason, a missed run: told again after this long at the earliest. */
export const SCHEDULE_REPEAT_NOTICE_MS = 24 * 60 * 60_000

/** What a notice of a task came to; `none` — nothing to tell. */
export type ScheduleNotifyAnswer = DeliveryAnswer | 'none'

/** Why a task paused, told after «Запланированная задача приостановлена». */
const pauseReasonText: Readonly<Record<Exclude<SchedulePausedReason, 'completed'>, string>> = {
  project_gone: scheduledRunReasonText.project_gone,
  member_gone: scheduledRunReasonText.member_gone,
  not_accepted: 'задачи пока не принимаются',
  refused: 'три отказа подряд',
}

export interface ScheduleNotifyDependencies {
  db: Pick<PrismaClient, 'chatNotification' | 'scheduledRun' | 'scheduledTask'>
  delivery: Pick<NotificationDelivery, 'deliver'>
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

export class ScheduleNotify {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ScheduleNotifyDependencies) {
    this.#logger = deps.logger ?? new Logger('ScheduleNotify')
    this.#now = deps.now ?? (() => new Date())
  }

  /**
   * After the outcome of a run was written — by web, or by core with `recorded`: a refusal is «не
   * запустилась», or «приостановлена» when it stopped the task; a missed run «пропустила запуск».
   * Never throws: a notice is not a reason to fail the start of a run.
   */
  async afterRun(
    runId: string,
    recorded?: Pick<RecordedRunOutcome, 'paused'>,
  ): Promise<ScheduleNotifyAnswer> {
    try {
      return await this.#afterRun(runId, recorded)
    } catch (error) {
      this.#logger.warn(
        `schedule_notify_failed run=${runId} reason=${error instanceof Error ? error.name : 'unknown'}`,
      )
      return 'none'
    }
  }

  /**
   * A task stopped by itself for its runs (Зп22): three refusals in a row, a right lost, the gate
   * of a chat (`not_accepted`). One notice per run. Never throws.
   */
  async paused(input: {
    scheduleId: string
    runId: string
    reason: Exclude<SchedulePausedReason, 'completed'>
    /** The refusal that made the third of a row, for «приостановлена: <причина>». */
    because?: ScheduledRunReason | null
  }): Promise<ScheduleNotifyAnswer> {
    try {
      const task = await this.deps.db.scheduledTask.findUnique({
        where: { id: input.scheduleId },
        select: { id: true, name: true, createdById: true, deletedAt: true },
      })
      if (!task || task.deletedAt !== null) return this.#log(input.runId, 'paused', 'none')
      // A project the client deleted stops its tasks without a word (Зп22).
      if (input.reason === 'project_gone') return this.#log(input.runId, 'paused', 'none')
      const reason =
        input.reason === 'refused' && input.because
          ? scheduledRunReasonText[input.because]
          : pauseReasonText[input.reason]
      return await this.#send(task, input.runId, 'paused', reason)
    } catch (error) {
      this.#logger.warn(
        `schedule_notify_failed run=${input.runId} reason=${error instanceof Error ? error.name : 'unknown'}`,
      )
      return 'none'
    }
  }

  async #afterRun(
    runId: string,
    recorded?: Pick<RecordedRunOutcome, 'paused'>,
  ): Promise<ScheduleNotifyAnswer> {
    const { db } = this.deps
    const run = await db.scheduledRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        reason: true,
        trigger: true,
        scheduledTask: {
          select: {
            id: true,
            name: true,
            createdById: true,
            deletedAt: true,
            enabled: true,
            pausedReason: true,
            refusalStreak: true,
            lastRefusalReason: true,
          },
        },
      },
    })
    if (!run || run.reason === null) return 'none'
    const task = run.scheduledTask
    // «Запустить сейчас» shows its refusal in the cabinet, without a notice (Зп24).
    if (run.trigger !== 'schedule' || task.deletedAt !== null) return 'none'
    const reason = run.reason as ScheduledRunReason
    if (run.status === 'skipped')
      return reason === 'missed' ? this.#missed(task, runId) : this.#log(runId, 'missed', 'none')
    if (run.status !== 'refused') return 'none'
    const paused = recorded ? recorded.paused : pausedBy(task, reason)
    if (paused !== null && paused !== 'completed')
      return this.paused({ scheduleId: task.id, runId, reason: paused, because: reason })
    if (await this.#toldBefore(task.id, reason)) return this.#log(runId, 'not_started', 'repeated')
    return this.#send(task, runId, 'not_started', scheduledRunReasonText[reason])
  }

  /** «Пропустила запуск» at most once a day per task (Зп38). */
  async #missed(task: TaskOfNotice, runId: string): Promise<ScheduleNotifyAnswer> {
    const recent = await this.deps.db.chatNotification.count({
      where: {
        scheduledTaskId: task.id,
        kind: 'missed',
        createdAt: { gt: new Date(this.#now().getTime() - SCHEDULE_REPEAT_NOTICE_MS) },
      },
    })
    if (recent > 0) return this.#log(runId, 'missed', 'repeated')
    return this.#send(task, runId, 'missed', null)
  }

  /**
   * A refusal for the reason told last, with no start of the task since, and less than a day ago
   * (Зп39): told once.
   */
  async #toldBefore(scheduleId: string, reason: ScheduledRunReason): Promise<boolean> {
    const { db } = this.deps
    const last = await db.chatNotification.findFirst({
      where: { scheduledTaskId: scheduleId, kind: 'not_started' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, scheduledRun: { select: { reason: true } } },
    })
    if (!last || last.scheduledRun?.reason !== reason) return false
    if (this.#now().getTime() - last.createdAt.getTime() >= SCHEDULE_REPEAT_NOTICE_MS) return false
    const started = await db.scheduledRun.count({
      where: { scheduledTaskId: scheduleId, status: 'started', startedAt: { gt: last.createdAt } },
    })
    return started === 0
  }

  async #send(
    task: TaskOfNotice,
    runId: string,
    kind: 'not_started' | 'paused' | 'missed',
    reason: string | null,
  ): Promise<ScheduleNotifyAnswer> {
    const title = scheduledNoticeTitle(kind)
    const notice: Notice = {
      userId: task.createdById,
      kind,
      chat: null,
      schedule: { id: task.id, runId },
      path: `/scheduled/${task.id}`,
      // Letters of a task: of a refusal and a pause, never of a missed run (Зп39).
      letter: kind !== 'missed',
      // The bot names the task (Т1); the push and the letter do not (rule 1, ВВ9).
      telegram: {
        text: `${title} — «${task.name}»${reason ? `: ${reason}` : ''}.`,
        button: 'Открыть задачу',
      },
    }
    const answer = await this.deps.delivery.deliver(notice)
    if (answer === 'sent')
      await this.deps.db.scheduledTask.updateMany({
        where: { id: task.id },
        data: { lastNotifiedAt: this.#now() },
      })
    return this.#log(runId, kind, answer)
  }

  #log(runId: string, kind: string, answer: ScheduleNotifyAnswer): ScheduleNotifyAnswer {
    this.#logger.log(`schedule_notify run=${runId} kind=${kind} answer=${answer}`)
    return answer
  }
}

type TaskOfNotice = { id: string; name: string; createdById: string }

/**
 * Whether the refusal of a run stopped its task, read from the task when web wrote the outcome
 * (recordRunOutcome's rules, Зп21, Зп22): a project gone or a right lost at once, the third
 * refusal in a row for a reason of the client.
 */
export function pausedBy(
  task: {
    enabled: boolean
    pausedReason: string | null
    refusalStreak: number
    lastRefusalReason: string | null
  },
  reason: ScheduledRunReason,
): SchedulePausedReason | null {
  if (task.enabled || task.pausedReason === null) return null
  if ((reason === 'project_gone' || reason === 'member_gone') && task.pausedReason === reason)
    return reason
  if (
    task.pausedReason === 'refused' &&
    isClientRefusalReason(reason) &&
    task.lastRefusalReason === reason &&
    task.refusalStreak >= scheduleLimits.refusalsToPause
  )
    return 'refused'
  return null
}
