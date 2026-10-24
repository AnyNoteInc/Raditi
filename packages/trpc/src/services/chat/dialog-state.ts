import type { Prisma } from '@repo/db'
import {
  answersFailure,
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
 * The `feed.request` rows that move a dialog on: the client's words and «Продолжить». A
 * command — `/cancel`, `/reset`, `/update` — is a press: it answers no question and starts no
 * work of the agent.
 */
export const movingRequest = {
  type: 'feed.request',
  NOT: { payload: { path: ['kind'], equals: 'command' } },
} as const satisfies Prisma.TaskEventWhereInput

/**
 * The last question of a dialog and whether words, «Продолжить» or «Продолжить работу агента»
 * came after it. `browser` — a task in the browser waits for the client to act there (docs/plan/57,
 * Б23).
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
  const answered = await db.taskEvent.count({
    where: { taskId, ...movingRequest, id: { gt: row.id } },
  })
  return {
    id: row.id,
    kind: question.kind,
    reason: question.kind === 'ceiling' ? question.reason : null,
    answered: answered > 0,
  }
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
