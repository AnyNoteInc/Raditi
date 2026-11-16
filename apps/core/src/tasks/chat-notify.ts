import { Logger } from '@nestjs/common'
import { passUnattended, pauseSchedule, type PrismaClient } from '@repo/db'
import {
  notificationTitle,
  readFeedRow,
  scheduleNotifySwitchKinds,
  type ChatNotifyJob,
  type ChatNotifyKind,
  type NoticeLimitCause,
  type TaskStatus,
} from '@repo/domain'

import type { ScheduleNotify, ScheduleNotifyAnswer } from '../schedules/schedule-notify.ts'
import type { DeliveryAnswer, NotificationDelivery } from './notification-delivery.ts'

// A chat waits for its client after a pass (docs/plan/75-chat-input-output.md, ВВ6–ВВ11): the
// agent answered, asked, brought changes, failed or ran out of credits. When the job is due core
// tells the author of the chat — unless the chat went on meanwhile (the queue started the next
// pass) or the client looks at it now. The channels are NotificationDelivery's.
//
// A pass of a run of a scheduled task before the first words of its client (docs/plan/82-
// scheduled-tasks.md, Зп27, Зп38, Зп39, Зп62) is told in the words of a scheduled task: «выполнена»
// only while the switch of the task is on, a letter only of a question or a
// failure, at most one in 30 minutes per task. Its pass refused by the gate of the chat
// (`not_accepted`) pauses the task, and that is the one notice (Зп22). From the client's first
// words on the chat is an ordinary one.

/** The client looked at the chat this recently: no notification. */
export const PRESENCE_FRESH_MS = 60_000
export { LETTER_PAUSE_MS } from './notification-delivery.ts'

export type NotifyAnswer = 'sent' | 'seen' | 'moved_on' | 'skipped' | 'repeated'

export interface ChatNotifyDependencies {
  db: PrismaClient
  /** The channels: Web Push, letters and the bot. */
  delivery: Pick<NotificationDelivery, 'deliver'>
  /** The notice of a task its run paused; absent — a pause is not told. */
  schedules?: Pick<ScheduleNotify, 'paused'> | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** What the bot says of a chat of the cabinet (Т8). */
export const CHAT_NOTIFY_TELEGRAM_TEXT: Readonly<Record<ChatNotifyKind, string>> = Object.freeze({
  answered: 'Агент ответил',
  question: 'Агент задал вопрос',
  ready: 'Изменения готовы: посмотрите их и выпустите на сайт',
  failed: 'В работе агента произошла ошибка',
  limit: 'Кредиты закончились, агент остановился',
})

const WAITING: readonly TaskStatus[] = ['awaiting_user', 'awaiting_approval']

/** «Уведомлять, когда задача выполнится» turns these off (Зп39). */
const SWITCHED: ReadonlySet<ChatNotifyKind> = new Set(scheduleNotifySwitchKinds)
/** A letter of a pass of a scheduled run: only of a question or a failure (Зп39). */
const SCHEDULED_LETTERS: ReadonlySet<ChatNotifyKind> = new Set(['question', 'failed'])

/** The scheduled task a pass of a run's chat goes without its client for (Зп27). */
interface ScheduledPass {
  scheduleId: string
  runId: string
  name: string
  notify: boolean
}

export class ChatNotify {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ChatNotifyDependencies) {
    this.#logger = deps.logger ?? new Logger('ChatNotify')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: ChatNotifyJob): Promise<NotifyAnswer> {
    const { db } = this.deps
    const now = this.#now()
    const task = await db.task.findUnique({
      where: { id: job.taskId },
      select: {
        status: true,
        createdById: true,
        deletedAt: true,
        attempt: true,
        turnNo: true,
        title: true,
      },
    })
    if (!task || task.deletedAt !== null || task.createdById === null)
      return this.#log(job, 'skipped')
    const scheduled = await this.#scheduledPass(job)
    // The gate refused the pass of a run (Зп22): the task pauses, and that is what is told.
    if (scheduled && job.kind === 'failed') {
      const paused = await this.#pausedByGate(job.taskId, scheduled)
      if (paused !== null) return this.#log(job, answerOf(paused))
    }
    // The chat went on — its queue, words from another tab — or ended: there is nothing to wait for.
    if (
      !WAITING.includes(task.status) ||
      task.attempt !== job.attempt ||
      task.turnNo !== job.turnNo
    )
      return this.#log(job, 'moved_on')
    const userId = task.createdById
    const presence = await db.taskPresence.findUnique({
      where: { userId_taskId: { userId, taskId: job.taskId } },
      select: { seenAt: true },
    })
    if (presence && now.getTime() - presence.seenAt.getTime() < PRESENCE_FRESH_MS)
      return this.#log(job, 'seen')
    if (scheduled && !scheduled.notify && SWITCHED.has(job.kind)) return this.#log(job, 'skipped')

    const text = scheduled
      ? `${notificationTitle(job.kind, {
          scheduled: true,
          ...(job.kind === 'limit' ? { cause: await this.#limitCause(job.taskId) } : {}),
        })} — «${scheduled.name}».`
      : `${CHAT_NOTIFY_TELEGRAM_TEXT[job.kind]} — чат «${task.title?.trim() || 'Чат'}».`
    const answer = await this.deps.delivery.deliver({
      userId,
      kind: job.kind,
      chat: { taskId: job.taskId, attempt: job.attempt, turnNo: job.turnNo },
      schedule: scheduled ? { id: scheduled.scheduleId, runId: scheduled.runId } : null,
      path: `/chats/${job.taskId}`,
      letter: scheduled ? SCHEDULED_LETTERS.has(job.kind) : true,
      telegram: { text, button: 'Открыть чат' },
    })
    return this.#log(job, answerOf(answer))
  }

  /**
   * The run of the chat while its pass goes without the client (Зп27); null — an ordinary chat.
   * Decided by the request the pass answered: what the client wrote while it ran is not its own.
   */
  async #scheduledPass(job: ChatNotifyJob): Promise<ScheduledPass | null> {
    const { db } = this.deps
    const taskId = job.taskId
    const run = await db.scheduledRun.findUnique({
      where: { taskId },
      select: {
        id: true,
        name: true,
        scheduledTask: { select: { id: true, name: true, notify: true, deletedAt: true } },
      },
    })
    const answers =
      job.requestEventId === undefined ? undefined : { requestEventId: job.requestEventId }
    if (!run || !(await passUnattended(db, taskId, answers))) return null
    const schedule = run.scheduledTask
    return {
      scheduleId: schedule.id,
      runId: run.id,
      // A task deleted since keeps the name its run had.
      name: schedule.deletedAt === null ? schedule.name : run.name,
      notify: schedule.notify,
    }
  }

  /**
   * The failure of a pass of a run that the gate of the chat refused (`not_accepted`: class
   * `client` without its clearance, Зп22): its task pauses once and the client is told so. null —
   * another failure, or a task that stopped for another reason before (a single run completed):
   * the failure is told as always.
   */
  async #pausedByGate(
    taskId: string,
    scheduled: ScheduledPass,
  ): Promise<ScheduleNotifyAnswer | null> {
    const { db } = this.deps
    const failure = await db.taskEvent.findFirst({
      where: { taskId, type: 'feed.failure' },
      orderBy: { id: 'desc' },
      select: { payload: true },
    })
    const row = failure ? readFeedRow('feed.failure', failure.payload) : null
    if (row?.type !== 'feed.failure' || row.code !== 'not_accepted') return null
    const paused = await db.$transaction((tx) =>
      pauseSchedule(tx, scheduled.scheduleId, 'not_accepted'),
    )
    if (!paused) {
      const state = await db.scheduledTask.findUnique({
        where: { id: scheduled.scheduleId },
        select: { pausedReason: true },
      })
      if (state?.pausedReason !== 'not_accepted') return null
    }
    if (paused)
      this.#logger.log(`schedule_paused schedule=${scheduled.scheduleId} reason=not_accepted`)
    // A repeat of the job finds the notice of the run and sends nothing.
    return (
      (await this.deps.schedules?.paused({
        scheduleId: scheduled.scheduleId,
        runId: scheduled.runId,
        reason: 'not_accepted',
      })) ?? 'none'
    )
  }

  /** What stopped a pass at its limit, by the row that ended it: credits or the weekly limit. */
  async #limitCause(taskId: string): Promise<NoticeLimitCause> {
    const ending = await this.deps.db.taskEvent.findFirst({
      where: { taskId, type: { in: ['feed.failure', 'feed.question'] } },
      orderBy: { id: 'desc' },
      select: { type: true, payload: true },
    })
    const row = ending ? readFeedRow(ending.type, ending.payload) : null
    return row?.type === 'feed.failure' && row.code === 'usage_limit' ? 'weekly_limit' : 'credits'
  }

  #log(job: ChatNotifyJob, answer: NotifyAnswer): NotifyAnswer {
    this.#logger.log(`chat_notify task=${job.taskId} kind=${job.kind} answer=${answer}`)
    return answer
  }
}

const answerOf = (answer: DeliveryAnswer | ScheduleNotifyAnswer): NotifyAnswer =>
  answer === 'none' ? 'skipped' : answer
