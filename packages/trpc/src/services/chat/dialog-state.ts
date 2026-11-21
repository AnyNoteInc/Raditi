import type { Prisma } from '@repo/db'
import {
  readFeedRow,
  type FeedCeilingReason,
  type FeedCreditsState,
  type TaskStatus,
} from '@repo/domain'

/**
 * Rows of the feed (`feed.*`) are exactly the rows `client_visible` marks
 * (`task_events_feed_visible_check`): a lookup of one says so, and PostgreSQL reads the partial index
 * of the feed (`task_events_feed_idx`) — a few rows a turn — instead of every row of the task, its
 * journal included.
 */
export const visible = { clientVisible: true } as const satisfies Prisma.TaskEventWhereInput

/** A `feed.request` already written for this press of the browser: its id, or null. */
export async function requestOf(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
  requestId: string,
): Promise<bigint | null> {
  const row = await db.taskEvent.findFirst({
    where: {
      taskId,
      ...visible,
      type: 'feed.request',
      payload: { path: ['requestId'], equals: requestId.toLowerCase() },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  return row?.id ?? null
}

/** How far back a pending `/cancel` is looked for: as far as core's `pressedCancel` looks. */
const PRESSES_READ = 50

/**
 * A `/cancel` press core has not acted on yet: the newest request, skipping other commands, is
 * `cancel` — the same rows core's `pressedCancel` reads. Words or a press after it would hide it
 * from core, so a task in the browser takes none (docs/plan/57, Б24).
 */
export async function cancelPending(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<boolean> {
  const rows = await db.taskEvent.findMany({
    where: { taskId, ...visible, type: 'feed.request' },
    orderBy: { id: 'desc' },
    take: PRESSES_READ,
    select: { payload: true },
  })
  for (const row of rows) {
    const event = readFeedRow('feed.request', row.payload)
    if (event.type !== 'feed.request') continue
    if (event.kind !== 'command') return false
    if (event.command === 'cancel') return true
  }
  return false
}

/**
 * The `feed.request` rows that move a dialog on: the client's words, «Продолжить» and a command
 * the agent carries out (`agent_command`, `/init`). Any other command — `/cancel`, `/reset`,
 * `/update` — is a press: it answers no question and starts no work of the agent.
 */
export const movingRequest = {
  ...visible,
  type: 'feed.request',
  NOT: { payload: { path: ['kind'], equals: 'command' } },
} as const satisfies Prisma.TaskEventWhereInput

/**
 * The `feed.rewind` rows `/redo` has not cancelled: every one before its last `feed.redo`. `/redo`
 * follows its `/undo` with nothing moving in between, so an older row stands before a turn that
 * came later, and says nothing of what the chat waits for now (docs/plan/61-chats-first.md, §5.14).
 */
async function standingRewinds(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<Prisma.TaskEventWhereInput> {
  const redo = await db.taskEvent.findFirst({
    where: { taskId, ...visible, type: 'feed.redo' },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  return { ...visible, type: 'feed.rewind', ...(redo === null ? {} : { id: { gt: redo.id } }) }
}

/**
 * The last question of a dialog and whether words, «Продолжить» or «Продолжить работу агента»
 * came after it, or it was undone and not brought back. `browser` — a task in the browser waits
 * for the client to act there (docs/plan/57, Б23).
 */
export interface DialogQuestion {
  id: bigint
  kind: 'agent' | 'ceiling' | 'browser'
  /** Of a question of the platform. */
  reason: FeedCeilingReason | null
  answered: boolean
}

export async function lastQuestion(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<DialogQuestion | null> {
  const row = await db.taskEvent.findFirst({
    where: { taskId, ...visible, type: 'feed.question' },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true },
  })
  if (row === null) return null
  const question = readFeedRow('feed.question', row.payload)
  if (question.type !== 'feed.question') return null
  // What closes a question: a row that moves the dialog on, or `/undo` of the turn that asked.
  const closes = { OR: [movingRequest, await standingRewinds(db, taskId)] }
  const answered = await db.taskEvent.count({
    where: { taskId, ...visible, AND: [closes, { id: { gt: row.id } }] },
  })
  return {
    id: row.id,
    kind: question.kind,
    reason: question.kind === 'ceiling' ? question.reason : null,
    answered: answered > 0,
  }
}

/**
 * The ending a dialog waits after — a pass that changed nothing and asked nothing (`feed.result`,
 * owner's decision of 26.10.2026) or one that failed (`feed.failure`, owner's decision of
 * 28.10.2026: «никогда не завершай диалог, если произошла ошибка») leaves it open for the
 * client's next words (`next: 'awaiting_user'`) — while nothing the client wrote or pressed,
 * besides a command, came after it. `/undo` leaves it open just so (`feed.rewind`), and `/redo`
 * gives it back what it waited after, or stands for it when that can take no words: the candidate
 * it waited with did not come back (`feed.redo` with `open`). null — none.
 */
export async function openResult(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<bigint | null> {
  const row = await db.taskEvent.findFirst({
    where: {
      taskId,
      ...visible,
      OR: [
        { type: { in: ['feed.result', 'feed.failure'] } },
        await standingRewinds(db, taskId),
        { type: 'feed.redo', payload: { path: ['open'], equals: true } },
      ],
    },
    orderBy: { id: 'desc' },
    select: { id: true, type: true, payload: true },
  })
  if (row === null) return null
  const ending = readFeedRow(row.type, row.payload)
  const open =
    ending.type === 'feed.rewind' ||
    ending.type === 'feed.redo' ||
    ((ending.type === 'feed.result' || ending.type === 'feed.failure') &&
      ending.next === 'awaiting_user')
  if (!open) return null
  const answered = await db.taskEvent.count({
    where: { taskId, ...movingRequest, id: { gt: row.id } },
  })
  return answered > 0 ? null : row.id
}

/**
 * The words a turn answered, as the client wrote them, for the field after `/undo`: the rows from
 * the start of the turn before it to its own start, the ones the planner keeps from the agent
 * (`requestsNotUndone`). null — none: the turn answered a press.
 */
export async function wordsOfTurn(
  db: Pick<Prisma.TransactionClient, 'taskEvent' | 'taskTurn'>,
  taskId: string,
  turnNo: number,
): Promise<string | null> {
  const turns = await db.taskTurn.findMany({
    where: { taskId, turnNo: { in: [turnNo - 1, turnNo] } },
    select: { turnNo: true, startedAt: true },
  })
  const until = turns.find((turn) => turn.turnNo === turnNo)?.startedAt ?? null
  if (until === null) return null
  const since = turns.find((turn) => turn.turnNo === turnNo - 1)?.startedAt ?? null
  const rows = await db.taskEvent.findMany({
    where: {
      taskId,
      ...visible,
      type: 'feed.request',
      createdAt: { lte: until, ...(since === null ? {} : { gt: since }) },
    },
    orderBy: { id: 'asc' },
    select: { payload: true, artifactCommentHasWords: true },
  })
  const words = rows.flatMap((row) => {
    if (row.artifactCommentHasWords === false) return []
    const event = readFeedRow('feed.request', row.payload)
    return event.type === 'feed.request' && 'text' in event && typeof event.text === 'string'
      ? [event.text]
      : []
  })
  return words.length > 0 ? words.join('\n\n') : null
}

/**
 * What a repeat of the press `pressId` of `/undo` gives back: its answer may never have reached the
 * page. The words of the turn it took, while the chat still stands where that press left it, or of
 * the turn core is still taking (`turnNo`, the last one); null — it took none, or the chat moved on
 * and the words went their way.
 */
export async function wordsOfUndonePress(
  db: Pick<Prisma.TransactionClient, 'taskEvent' | 'taskTurn'>,
  task: { id: string; turnNo: number },
  pressId: bigint,
): Promise<string | null> {
  const taskId = task.id
  const row = await db.taskEvent.findFirst({
    where: { taskId, ...visible, type: 'feed.rewind', id: { gt: pressId } },
    orderBy: { id: 'asc' },
    select: { id: true, payload: true },
  })
  if (row === null) return null
  if ((await openResult(db, taskId)) !== row.id) return null
  const rewind = readFeedRow('feed.rewind', row.payload)
  return rewind.type === 'feed.rewind' ? wordsOfTurn(db, taskId, rewind.turn) : null
}

/** A question of the platform about credits that waits for «Продолжить». */
export async function openCeilingQuestion(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<DialogQuestion | null> {
  const question = await lastQuestion(db, taskId)
  return question !== null && question.kind === 'ceiling' && !question.answered ? question : null
}

/** Where the next message goes. The writer calls this again under the dialog lock. */
export async function dialogMessageTarget(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  task: { id: string; status: TaskStatus; needsBrowser: boolean },
) {
  if (task.needsBrowser && (await cancelPending(db, task.id)))
    return { kind: 'cancel_pending' } as const
  if (task.status !== 'awaiting_user' && task.status !== 'awaiting_approval')
    return { kind: 'not_waiting' } as const
  const question = await lastQuestion(db, task.id)
  const open = question !== null && !question.answered ? question : null
  if (open?.kind === 'ceiling') return { kind: 'ceiling', question: open } as const
  if (task.status === 'awaiting_approval') return { kind: 'not_waiting' } as const
  const id = open?.id ?? (await openResult(db, task.id))
  return id === null ? ({ kind: 'no_open_event' } as const) : ({ kind: 'answer', id } as const)
}

/**
 * What became of the held credits, for the feed (spec §17): returned, or burnt with an ended
 * period of the tariff; null — the task held none.
 */
export function creditsAfterReturn(returned: {
  applied: boolean
  expiries: readonly unknown[]
}): FeedCreditsState | null {
  if (!returned.applied) return null
  return returned.expiries.length > 0 ? 'expired' : 'returned'
}
