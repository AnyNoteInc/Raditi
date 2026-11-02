import type { Prisma } from '@repo/db'
import {
  answersFailure,
  CANDIDATE_REWIND_EVENT,
  readFeedRow,
  retryVerdict,
  type CandidateStatus,
  type FeedCeilingReason,
  type FeedCreditsState,
  type OpenFailure,
  type RetryVerdict,
  type TaskStatus,
} from '@repo/domain'

type Reader = Pick<Prisma.TransactionClient, 'taskEvent' | 'taskCandidate'>

/** A `feed.request` already written for this press of the browser: its id, or null. */
export async function requestOf(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
  requestId: string,
): Promise<bigint | null> {
  const row = await db.taskEvent.findFirst({
    where: {
      taskId,
      type: 'feed.request',
      payload: { path: ['requestId'], equals: requestId.toLowerCase() },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  return row?.id ?? null
}

/** A press of `/undo` or `/redo` core has not answered yet. */
export interface PendingTurnPress {
  id: bigint
  redo: boolean
}

/**
 * The `/undo` or `/redo` press of a chat with the repository that core has not answered yet
 * (docs/plan/61-chats-first.md, §5.14): its branch and its candidate are moving, and nothing else
 * starts until they stand. null — none. The press of a chat without the repository gets no answer
 * row — it is done with its own transaction —, so its caller does not ask.
 */
export async function turnRewinding(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<PendingTurnPress | null> {
  const press = await db.taskEvent.findFirst({
    where: {
      taskId,
      type: 'feed.request',
      AND: [
        { payload: { path: ['kind'], equals: 'command' } },
        {
          OR: [
            { payload: { path: ['command'], equals: 'turn_undo' } },
            { payload: { path: ['command'], equals: 'turn_redo' } },
          ],
        },
      ],
    },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true },
  })
  if (press === null) return null
  const answered = await db.taskEvent.count({
    where: {
      taskId,
      type: CANDIDATE_REWIND_EVENT,
      payload: { path: ['requestEventId'], equals: String(press.id) },
    },
  })
  if (answered > 0) return null
  const row = readFeedRow('feed.request', press.payload)
  return {
    id: press.id,
    redo: row.type === 'feed.request' && row.kind === 'command' && row.command === 'turn_redo',
  }
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
    where: { taskId, type: 'feed.request' },
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
    where: { taskId, type: 'feed.redo' },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  return { type: 'feed.rewind', ...(redo === null ? {} : { id: { gt: redo.id } }) }
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
    where: { taskId, type: 'feed.question' },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true },
  })
  if (row === null) return null
  const question = readFeedRow('feed.question', row.payload)
  if (question.type !== 'feed.question') return null
  // What closes a question: a row that moves the dialog on, or `/undo` of the turn that asked.
  const closes = { OR: [movingRequest, await standingRewinds(db, taskId)] }
  const answered = await db.taskEvent.count({
    where: { taskId, AND: [closes, { id: { gt: row.id } }] },
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
      type: 'feed.request',
      createdAt: { lte: until, ...(since === null ? {} : { gt: since }) },
    },
    orderBy: { id: 'asc' },
    select: { payload: true },
  })
  const words = rows.flatMap((row) => {
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
    where: { taskId, type: 'feed.rewind', id: { gt: pressId } },
    orderBy: { id: 'asc' },
    select: { id: true, payload: true },
  })
  if (row === null)
    return (await turnRewinding(db, taskId))?.id === pressId
      ? wordsOfTurn(db, taskId, task.turnNo)
      : null
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

/** The rows that may answer a failure (`answersFailure`): the client's presses and releases. */
const ANSWER_TYPES = ['feed.request', 'feed.decision', 'feed.release']
/** More rows after a failure than this, and it is surely answered. */
const ANSWERS_READ = 50

/**
 * The newest `feed.failure` of a dialog and whether the client answered it since — words, a
 * press other than `/reset`, a release (docs/plan/53, «Попробовать ещё (18.10)»). null — the
 * dialog has none.
 */
export async function openFailure(
  db: Pick<Prisma.TransactionClient, 'taskEvent'>,
  taskId: string,
): Promise<OpenFailure | null> {
  const row = await db.taskEvent.findFirst({
    where: { taskId, type: 'feed.failure' },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true },
  })
  if (row === null) return null
  const failure = readFeedRow('feed.failure', row.payload)
  if (failure.type !== 'feed.failure') return null
  const after = await db.taskEvent.findMany({
    where: { taskId, type: { in: ANSWER_TYPES }, id: { gt: row.id } },
    orderBy: { id: 'asc' },
    take: ANSWERS_READ,
    select: { type: true, payload: true },
  })
  return {
    id: String(row.id),
    code: failure.code,
    site: failure.site,
    answered:
      after.length >= ANSWERS_READ ||
      after.some((answer) => answersFailure(readFeedRow(answer.type, answer.payload))),
  }
}

/** Whether «Попробовать ещё» is offered in a dialog now, by `retryVerdict`. */
export async function dialogRetry(
  db: Pick<Prisma.TransactionClient, 'taskEvent' | 'task'>,
  task: { id: string; status: TaskStatus },
): Promise<RetryVerdict> {
  const row = await db.task.findUnique({ where: { id: task.id }, select: { billable: true } })
  return retryVerdict({
    status: task.status,
    billable: row?.billable ?? false,
    failure: task.status === 'awaiting_approval' ? await openFailure(db, task.id) : null,
  })
}

/** The candidate a dialog waits with: its latest one that is current or stale. */
export interface LiveCandidate {
  id: string
  revision: number
  status: Extract<CandidateStatus, 'current' | 'stale'>
}

export async function liveCandidate(
  db: Pick<Reader, 'taskCandidate'>,
  taskId: string,
): Promise<LiveCandidate | null> {
  const row = await db.taskCandidate.findFirst({
    where: { taskId, status: { in: ['current', 'stale'] } },
    orderBy: { revision: 'desc' },
    select: { id: true, revision: true, status: true },
  })
  if (row === null) return null
  return { id: row.id, revision: row.revision, status: row.status as LiveCandidate['status'] }
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
