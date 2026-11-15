import {
  applyScheduleChange,
  enqueueTelegramDeliver,
  insertFeedEvent,
  pendingScheduleChanges,
  refuseScheduleChanges,
  scheduleTriggersOf,
  staleScheduleReservations,
  type PrismaClient,
  type ScheduledTask,
} from '@repo/db'
import {
  isDomainError,
  type ReasoningEffort,
  type ScheduleChangeAction,
  type ScheduleLeftAction,
  type ScheduleLeftReason,
} from '@repo/domain'

// What a turn asked of the scheduled tasks of its author (docs/plan/82-scheduled-tasks.md,
// Зп31–Зп35): `schedule_create`, `schedule_update` and `schedule_delete` reserved it during the
// turn, checked then; at its end core applies each in the order asked — only core knows the
// values of the client and the keys of the turn, and the words of a task go to the agent of every
// run. Everything is checked again by `applyScheduleChange`. What was done is told by
// `feed.schedule_change`, what was not by `feed.schedule_left`; a turn that failed or was
// cancelled refuses its changes at once, and the sweep closes those no end of a turn reached. A
// chat bound to Telegram gets each of these rows there too, on its own: they come after the rows
// of the pass were sent (docs/plan/80-telegram.md), and the client there must learn that the task
// the agent promised was not saved.

type Refuses = (text: string) => 'turn_key' | 'client_value' | null

/** A reservation whose turn is over is closed this long after it was made, at the earliest. */
export const SCHEDULE_SWEEP_AFTER_MS = 5 * 60_000
/** A chat that changed this recently may be at the end of its turn: its changes wait. */
export const SCHEDULE_SWEEP_GRACE_MS = 5 * 60_000
/**
 * A reservation open this long is closed whatever its turn: a turn has no limit of time (docs/
 * plan/70), so not an hour, as the plan said, but a day, as the publications of pages.
 */
export const SCHEDULE_SWEEP_ANY_AFTER_MS = 24 * 60 * 60_000
const BATCH = 50

export interface ScheduleChangesDependencies {
  db: Pick<
    PrismaClient,
    | '$transaction'
    | '$queryRaw'
    | 'outboxEvent'
    | 'scheduleReservation'
    | 'task'
    | 'taskEvent'
    | 'taskTurn'
  >
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** The refusals of `applyScheduleChange` as the card tells them (§4.1, feed.schedule_left). */
export function scheduleLeftReasonOf(code: string): ScheduleLeftReason {
  if (code === 'SCHEDULE_FORBIDDEN') return 'forbidden'
  if (code === 'SCHEDULE_LIMIT') return 'limit'
  if (code === 'SCHEDULE_NOT_FOUND' || code === 'NOT_FOUND') return 'not_found'
  if (code.startsWith('TASK_TEXT_')) return 'text_refused'
  if (
    code === 'SCHEDULE_TOO_OFTEN' ||
    code === 'SCHEDULE_IN_PAST' ||
    code === 'SCHEDULE_TEMPLATE_PLACEHOLDER' ||
    code === 'BAD_REQUEST'
  )
    return 'invalid'
  return 'failed'
}

type Pending = Awaited<ReturnType<typeof pendingScheduleChanges>>[number]

/** The words a reservation sets: of a creation its own, of an update only what it changes. */
function wordsOf(change: Pending): { name: string | null; instructions: string | null } {
  const payload = (change.payload ?? {}) as {
    name?: unknown
    instructions?: unknown
    patch?: { name?: unknown; instructions?: unknown }
  }
  const words = change.kind === 'create' ? payload : (payload.patch ?? {})
  return {
    name: typeof words.name === 'string' ? words.name : null,
    instructions: typeof words.instructions === 'string' ? words.instructions : null,
  }
}

/**
 * The name the card of a change not done may tell: a creation's is the agent's and no check of
 * the turn read it, so it goes only with `told`; an update's and a deletion's is the task's own.
 */
function leftName(kind: ScheduleLeftAction, name: string | null, told: boolean): string | null {
  return kind === 'create' && !told ? null : name
}

export class ScheduleChanges {
  readonly #now: () => Date

  constructor(private readonly deps: ScheduleChangesDependencies) {
    this.#now = deps.now ?? (() => new Date())
  }

  /** At the end of a completed turn. Never throws: a change not applied is told, or swept. */
  async apply(taskId: string, turn: number, refusesText: Refuses): Promise<void> {
    const { db, logger } = this.deps
    try {
      const changes = await pendingScheduleChanges(db, taskId, turn)
      if (changes.length === 0) return
      const task = await db.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { workspaceId: true },
      })
      const turnId = await this.#turnId(taskId, turn)
      for (const change of changes)
        await this.#one(
          change,
          { taskId, turn, turnId, workspaceId: task.workspaceId },
          refusesText,
        )
    } catch (error) {
      logger?.warn(
        `schedule_changes_failed task=${taskId} turn=${turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }

  /** A turn that failed or was cancelled: its changes are refused and told at once. Never throws. */
  async failTurn(taskId: string, turn: number): Promise<void> {
    try {
      const closed = await refuseScheduleChanges(this.deps.db, {
        taskId,
        turnNo: turn,
        outcome: 'failed',
        now: this.#now(),
      })
      if (closed.length === 0) return
      const turnId = await this.#turnId(taskId, turn)
      for (const change of closed)
        await this.#left(
          taskId,
          { no: turn, id: turnId },
          change.kind,
          leftName(change.kind, change.name, false),
          'failed',
        )
    } catch {
      this.deps.logger?.warn(`schedule_turn_failed task=${taskId} turn=${turn}`)
    }
  }

  /**
   * Changes no end of a turn reached (Зп33): closed `failed` and told once their turn is over — not
   * while the chat is at the end of it here or changed a moment ago — or after a day whatever the
   * turn. Returns how many.
   */
  async sweep(isLive: (taskId: string) => boolean = () => false): Promise<number> {
    const { db, logger } = this.deps
    const now = this.#now()
    const stale = await staleScheduleReservations(db, {
      before: new Date(now.getTime() - SCHEDULE_SWEEP_AFTER_MS),
      anyBefore: new Date(now.getTime() - SCHEDULE_SWEEP_ANY_AFTER_MS),
      limit: BATCH,
    })
    let closed = 0
    for (const reservation of stale) {
      try {
        if (isLive(reservation.taskId) || (await this.#settling(reservation, now))) continue
        const [change] = await refuseScheduleChanges(db, {
          taskId: reservation.taskId,
          reservationIds: [reservation.id],
          outcome: 'failed',
          now,
        })
        if (!change) continue
        closed++
        await this.#left(
          reservation.taskId,
          {
            no: reservation.turnNo,
            id: await this.#turnId(reservation.taskId, reservation.turnNo),
          },
          change.kind,
          leftName(change.kind, change.name, false),
          'failed',
        )
      } catch {
        logger?.warn(`schedule_sweep_failed task=${reservation.taskId}`)
      }
    }
    if (closed > 0) logger?.log(`schedule_changes_swept count=${closed}`)
    return closed
  }

  /**
   * A chat that changed a moment ago — its turn settled, its changes not applied yet by the core
   * that runs it — is left to that end of the turn, unless its change waited a day.
   */
  async #settling(reservation: { id: string; taskId: string }, now: Date): Promise<boolean> {
    const { db } = this.deps
    const [chat, open] = await Promise.all([
      db.task.findUnique({ where: { id: reservation.taskId }, select: { updatedAt: true } }),
      db.scheduleReservation.findUnique({
        where: { id: reservation.id },
        select: { createdAt: true },
      }),
    ])
    if (!chat || !open) return false
    const recent = chat.updatedAt.getTime() > now.getTime() - SCHEDULE_SWEEP_GRACE_MS
    const day = open.createdAt.getTime() <= now.getTime() - SCHEDULE_SWEEP_ANY_AFTER_MS
    return recent && !day
  }

  async #one(
    change: Pending,
    where: { taskId: string; turn: number; turnId: string | null; workspaceId: string },
    refusesText: Refuses,
  ): Promise<void> {
    const { db, logger } = this.deps
    const words = wordsOf(change)
    // The words of a task go to the agent of every run and to the card: a key of the turn or a
    // value of the client in them is never kept (Ст19).
    const nameRefused = words.name !== null && refusesText(words.name) !== null
    if (nameRefused || (words.instructions !== null && refusesText(words.instructions) !== null)) {
      logger?.warn(`schedule_change_refused task=${where.taskId} turn=${where.turn} reason=text`)
      return this.#refuse(
        change,
        where,
        nameRefused ? 'name_refused' : 'text_refused',
        !nameRefused,
      )
    }
    try {
      const done = await applyScheduleChange(db, {
        reservationId: change.id,
        workspaceId: where.workspaceId,
        taskId: where.taskId,
        now: this.#now(),
      })
      const eventId = await insertFeedEvent(db, {
        taskId: where.taskId,
        turnId: where.turnId,
        row: { type: 'feed.schedule_change', payload: changePayloadOf(done.action, done.schedule) },
      })
      await this.#tell(where.taskId, where.turn, eventId)
      logger?.log(
        `schedule_changed task=${where.taskId} turn=${where.turn} action=${done.action} schedule=${done.schedule.id}`,
      )
    } catch (error) {
      // A fault of the platform — the database — leaves the change to the sweep, which tells it.
      if (!isDomainError(error)) {
        logger?.warn(`schedule_change_failed task=${where.taskId} turn=${where.turn}`)
        return
      }
      logger?.warn(
        `schedule_change_refused task=${where.taskId} turn=${where.turn} reason=${error.code}`,
      )
      await this.#refuse(change, where, scheduleLeftReasonOf(error.code), true)
    }
  }

  async #refuse(
    change: Pending,
    where: { taskId: string; turn: number; turnId: string | null },
    reason: ScheduleLeftReason,
    nameTold: boolean,
  ): Promise<void> {
    try {
      const [closed] = await refuseScheduleChanges(this.deps.db, {
        taskId: where.taskId,
        reservationIds: [change.id],
        outcome: 'refused',
        now: this.#now(),
      })
      if (!closed) return
      await this.#left(
        where.taskId,
        { no: where.turn, id: where.turnId },
        closed.kind,
        leftName(closed.kind, closed.name, nameTold),
        reason,
      )
    } catch {
      this.deps.logger?.warn(`schedule_change_left_failed task=${where.taskId}`)
    }
  }

  async #left(
    taskId: string,
    turn: { no: number; id: string | null },
    action: ScheduleLeftAction,
    name: string | null,
    reason: ScheduleLeftReason,
  ): Promise<void> {
    const eventId = await insertFeedEvent(this.deps.db, {
      taskId,
      turnId: turn.id,
      row: { type: 'feed.schedule_left', payload: { v: 1, action, name, reason } },
    })
    await this.#tell(taskId, turn.no, eventId)
  }

  /**
   * A row of this end of a turn, to the chat bound in Telegram (`enqueueTelegramDeliver` writes
   * nothing for one that is not): on its own and once — the job is keyed by the row. Never throws:
   * the row is in the cabinet whatever Telegram gets.
   */
  async #tell(taskId: string, turn: number, eventId: bigint): Promise<void> {
    const { db, logger } = this.deps
    try {
      const chat = await db.task.findUnique({ where: { id: taskId }, select: { attempt: true } })
      if (!chat) return
      await enqueueTelegramDeliver(db, {
        taskId,
        kind: 'answered',
        attempt: Math.max(1, chat.attempt),
        turnNo: turn,
        eventId: String(eventId),
      })
    } catch {
      logger?.warn(`schedule_change_telegram_failed task=${taskId} turn=${turn}`)
    }
  }

  async #turnId(taskId: string, turn: number): Promise<string | null> {
    const row = await this.deps.db.taskTurn
      .findFirst({ where: { taskId, turnNo: turn }, select: { id: true } })
      .catch(() => null)
    return row?.id ?? null
  }
}

/** What `feed.schedule_change` keeps of a task as the change left it. */
export function changePayloadOf(action: ScheduleChangeAction, schedule: ScheduledTask) {
  return {
    v: 1 as const,
    action,
    scheduleId: schedule.id,
    name: schedule.name,
    instructions: schedule.instructions,
    triggers: scheduleTriggersOf(schedule),
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    effort: schedule.effort as ReasoningEffort,
    notify: schedule.notify,
  }
}
