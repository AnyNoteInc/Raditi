import {
  assertTransition,
  badRequest,
  conflict,
  feedRowSchema,
  modelClassSchema,
  taskWaitingReasons,
  terminalTaskStatuses,
  type FeedRow,
  type ModelClass,
  type TaskStatus,
  type TaskWaitingReason,
} from '@repo/domain'
import { z } from 'zod'

import { insertFeedEvent } from './feed-events.ts'
import type { Prisma } from './generated/prisma/client.ts'

// The moves of a pass of the agent (docs/plan/53-chat-preview-release.md, R3; spec §7 «Очередь
// и сериализация»; docs/research/2026-10-client-feed/feed-design.md, «Обработчик хода»). Each is
// one conditional statement in the caller's transaction: the status is the truth, and a move
// that found the task elsewhere writes nothing, so the live handler and the sweep can race
// without a second outcome. Money is not written here — @repo/billing joins the same
// transaction after the move (`chargeTask` after `done`, `releaseTask` after `failed` and
// `cancelled`), and its refusal rolls the move back with it.

type Tx = Prisma.TransactionClient

const id = z.uuid()
const attemptSchema = z.number().int().min(1).max(2_147_483_647)
const turnNoSchema = z.number().int().min(0).max(999_999)

// ---------------------------------------------------------------------------------------------
// queued → preparing
// ---------------------------------------------------------------------------------------------

const claimSchema = z.strictObject({ taskId: id, attempt: attemptSchema })
export type TaskClaimInput = z.infer<typeof claimSchema>

export interface ClaimedTask {
  /** `tasks.turn_no` when the pass was claimed: its turn opens at the next number. */
  turnNo: number
  modelClass: ModelClass | null
  billable: boolean
}

/**
 * The handler of `agent-turns` takes the pass: `queued → preparing` for the attempt the job was
 * put for, and `waiting` is cleared (it means something only in `queued`). null — the task is
 * not queued under that attempt: another job took it, it was cancelled, or a later attempt
 * replaced the one of the job. Nothing is written then.
 */
export async function claimQueuedTask(
  db: Pick<Tx, '$queryRaw'>,
  input: TaskClaimInput,
): Promise<ClaimedTask | null> {
  const parsed = claimSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid task claim')
  const { taskId, attempt } = parsed.data
  assertTransition('queued', 'preparing')
  const rows = await db.$queryRaw<
    Array<{ turn_no: number; model_class: string | null; billable: boolean }>
  >`
    UPDATE tasks SET status = 'preparing', waiting = NULL, updated_at = now()
    WHERE id = ${taskId}::uuid AND status = 'queued' AND attempt = ${attempt}
    RETURNING turn_no, model_class::text AS model_class, billable`
  const row = rows[0]
  if (!row) return null
  const modelClass = row.model_class === null ? null : modelClassSchema.parse(row.model_class)
  return { turnNo: row.turn_no, modelClass, billable: row.billable }
}

const passClaimSchema = claimSchema.extend({
  /** At most this many passes of one workspace at once (WORKSPACE_TURN_LIMIT). */
  workspaceLimit: z.number().int().min(1).max(64),
})

/**
 * As claimQueuedTask, while the workspace of the task runs fewer than `workspaceLimit` passes
 * (docs/plan/70-turn-without-time-limit.md, ВР13): the count and the claim run under one lock
 * of the workspace, so of nine passes that claim at once exactly eight go and none gives way for
 * nothing. `full` — the task stays `queued` for the attempt, waiting for the agents; nothing is
 * written then. null — as claimQueuedTask.
 */
export async function claimQueuedPass(
  db: Pick<Prisma.TransactionClient, '$queryRaw'> & {
    $transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>
  },
  input: TaskClaimInput & { workspaceLimit: number },
): Promise<ClaimedTask | 'full' | null> {
  const parsed = passClaimSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid task claim')
  const { taskId, attempt, workspaceLimit } = parsed.data
  return db.$transaction(async (tx) => {
    const [task] = await tx.$queryRaw<Array<{ workspace_id: string }>>`
      SELECT workspace_id FROM tasks
      WHERE id = ${taskId}::uuid AND status = 'queued' AND attempt = ${attempt}`
    if (!task) return null
    // Held to the commit: a claim after this one counts it, never both the other's old state.
    await tx.$queryRaw`
      SELECT 1 AS locked FROM pg_advisory_xact_lock(
        hashtextextended(${`raditi:workspace-passes:${task.workspace_id}`}, 0))`
    const [busy] = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM tasks
      WHERE workspace_id = ${task.workspace_id}::uuid AND id <> ${taskId}::uuid
        AND status IN ('preparing', 'running')`
    if ((busy?.n ?? 0) >= workspaceLimit) return 'full' as const
    return claimQueuedTask(tx, { taskId, attempt })
  })
}

// ---------------------------------------------------------------------------------------------
// The end of a pass: preparing / running → its outcome
// ---------------------------------------------------------------------------------------------

/** What a pass may end in; `queued` is the way back when the site or the pool is busy. */
export const settledTaskStatuses = [
  'queued',
  'awaiting_user',
  'awaiting_approval',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly TaskStatus[]
export type SettledTaskStatus = (typeof settledTaskStatuses)[number]

const passStatuses = ['preparing', 'running'] as const
const changeTypes = ['code', 'content', 'mixed', 'none'] as const

const settleSchema = z
  .strictObject({
    taskId: id,
    attempt: attemptSchema,
    /** `tasks.turn_no` the caller saw: a pass that opened another turn meanwhile is not this one. */
    expectedTurnNo: turnNoSchema,
    from: z
      .array(z.enum(passStatuses))
      .min(1)
      .max(passStatuses.length)
      .refine((statuses) => new Set(statuses).size === statuses.length),
    to: z.enum(settledTaskStatuses),
    /** Why the task waits again; only with `queued`, where the CHECK allows it. */
    waiting: z.enum(taskWaitingReasons).nullable().default(null),
    /** The turn the feed rows belong to; null — no turn was opened by this pass. */
    turn: z.number().int().min(1).max(999_999).nullable(),
    feed: z.array(z.unknown()).max(4),
    /** The agent's summary for the platform (`tasks.summary`), never shown to the client. */
    summary: z.string().min(1).max(500).optional(),
    changeType: z.enum(changeTypes).optional(),
  })
  .refine((input) => input.waiting === null || input.to === 'queued', {
    message: 'only a queued task waits',
    path: ['waiting'],
  })
  .refine((input) => input.to !== 'queued' || input.feed.length === 0, {
    message: 'the way back to the queue writes no feed row',
    path: ['feed'],
  })

export interface SettleTurnInput {
  taskId: string
  attempt: number
  expectedTurnNo: number
  from: readonly (typeof passStatuses)[number][]
  to: SettledTaskStatus
  waiting?: TaskWaitingReason | null
  turn: number | null
  /** Written in this order, after the move and only with it. */
  feed: readonly FeedRow[]
  summary?: string
  changeType?: (typeof changeTypes)[number]
}

export interface SettledTurn {
  /** false — the task was not where the caller expected, or a turn of it is still assigned. */
  moved: boolean
  /** `task_events.id` of the feed rows, in the order of `feed`. */
  eventIds: bigint[]
  /**
   * `task_turns.id` of the turn the rows belong to, or null: a row the caller writes after the
   * money of the move (`insertFeedEvent`) belongs to it as well.
   */
  turnId: string | null
}

/**
 * Moves the task out of its pass in one conditional statement: from one of `from`, under the
 * attempt and the turn number the caller saw, and only while no turn assignment of the task is
 * open — an assignment that recovery may still finish decides the outcome itself (spec §7,
 * «переходы в done, failed, awaiting_* и cancelled — только когда назначение хода закрыто»).
 * The feed rows pass their strict write schema and are inserted after the move; a move that
 * matched nothing writes none of them.
 */
export async function settleTurn(
  tx: Pick<Tx, '$queryRaw' | 'taskEvent'>,
  input: SettleTurnInput,
): Promise<SettledTurn> {
  const parsed = settleSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid turn settlement')
  const { taskId, attempt, expectedTurnNo, from, to, waiting, turn } = parsed.data
  for (const status of from) assertTransition(status, to)
  const feed = input.feed.map((row) => feedRowSchema.parse(row))
  const terminal = (terminalTaskStatuses as readonly string[]).includes(to)
  const moved = await tx.$queryRaw<Array<{ turn_id: string | null }>>`
    UPDATE tasks t SET
      status = ${to}::"TaskStatus",
      waiting = ${waiting}::"TaskWaiting",
      summary = COALESCE(${parsed.data.summary ?? null}::text, t.summary),
      change_type = COALESCE(${parsed.data.changeType ?? null}::"ChangeType", t.change_type),
      finished_at = CASE WHEN ${terminal} THEN now() ELSE t.finished_at END,
      updated_at = now()
    WHERE t.id = ${taskId}::uuid AND t.status::text = ANY(${[...from]}::text[])
      AND t.attempt = ${attempt} AND t.turn_no = ${expectedTurnNo}
      AND NOT EXISTS (
        SELECT 1 FROM turn_assignments a WHERE a.task_id = t.id AND a.finished_at IS NULL)
    RETURNING (SELECT tt.id FROM task_turns tt
      WHERE tt.task_id = t.id AND tt.turn_no = ${turn ?? 0}) AS turn_id`
  const row = moved[0]
  if (!row) return { moved: false, eventIds: [], turnId: null }
  const eventIds: bigint[] = []
  for (const entry of feed)
    eventIds.push(await insertFeedEvent(tx, { taskId, turnId: row.turn_id, row: entry }))
  return { moved: true, eventIds, turnId: row.turn_id }
}

const rejectSchema = z.strictObject({ taskId: id, turnNo: z.number().int().min(1).max(999_999) })

/**
 * Marks the turn of a pass that ended in a `feed.failure` (docs/plan/53, «Попробовать ещё
 * (18.10)»): in the transaction of the failure, after its move. The mark is the trusted fact that
 * the platform refused what the turn left — whether the turn failed or completed with a result
 * that could not be taken — so the planner replaces it instead of continuing from it, «Обновить»
 * does not carry its head, and @repo/billing does not charge its model calls (`taskRawCredits`).
 * The first moment stays: a repeated call changes nothing. false — no such turn.
 */
export async function rejectTurn(
  tx: Pick<Tx, '$executeRaw'>,
  input: { taskId: string; turnNo: number },
): Promise<boolean> {
  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid rejected turn')
  const { taskId, turnNo } = parsed.data
  const marked = await tx.$executeRaw`
    UPDATE task_turns SET rejected_at = COALESCE(rejected_at, now())
    WHERE task_id = ${taskId}::uuid AND turn_no = ${turnNo}`
  return marked === 1
}

/**
 * `/undo` of a chat (docs/plan/61-chats-first.md, §5.14): the client took a completed turn back, so
 * the planner does not go on from it and its words do not reach the agent again. Not a rejection:
 * @repo/billing keeps charging the turn, and nothing is given back (К29). Only once, and only a
 * turn whose result was taken. Its id, or null — no such turn, and nothing is written.
 */
export async function undoTurn(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turnNo: number },
): Promise<string | null> {
  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid undone turn')
  const { taskId, turnNo } = parsed.data
  const undone = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE task_turns SET undone_at = now()
    WHERE task_id = ${taskId}::uuid AND turn_no = ${turnNo} AND status = 'completed'
      AND rejected_at IS NULL AND undone_at IS NULL
    RETURNING id`
  return undone[0]?.id ?? null
}

/**
 * `/redo` of a chat (docs/plan/61-chats-first.md, §5.14): the turn `/undo` took counts again, so
 * the next pass goes on from it and its words stand as read. No money moved either way. Its id, or
 * null — no such turn, and nothing is written.
 */
export async function redoTurn(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turnNo: number },
): Promise<string | null> {
  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid redone turn')
  const { taskId, turnNo } = parsed.data
  const redone = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE task_turns SET undone_at = NULL
    WHERE task_id = ${taskId}::uuid AND turn_no = ${turnNo} AND status = 'completed'
      AND rejected_at IS NULL AND undone_at IS NOT NULL
    RETURNING id`
  return redone[0]?.id ?? null
}

/** Where a chat with the repository may stand when `/undo` takes its last turn back. */
const rewindableStatuses = ['awaiting_user', 'awaiting_approval'] as const
type RewindableStatus = (typeof rewindableStatuses)[number]

/** Where `/undo` and `/redo` leave a chat with the repository. */
const rewindSchema = z.strictObject({
  taskId: id,
  turnNo: turnNoSchema,
  to: z.enum(rewindableStatuses),
})

/**
 * The status of a chat that waits at `turnNo`, with no turn assigned: the one move of `/undo` and
 * `/redo`. false — the chat is elsewhere, and nothing is written.
 */
async function moveWaitingChat(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turnNo: number; to: RewindableStatus },
): Promise<boolean> {
  const parsed = rewindSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid rewind of a chat')
  const { taskId, turnNo, to } = parsed.data
  for (const from of rewindableStatuses) if (from !== to) assertTransition(from, to)
  const moved = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE tasks t SET status = ${to}::"TaskStatus", waiting = NULL, updated_at = now()
    WHERE t.id = ${taskId}::uuid AND t.status::text = ANY(${[...rewindableStatuses]}::text[])
      AND t.turn_no = ${turnNo}
      AND NOT EXISTS (
        SELECT 1 FROM turn_assignments a WHERE a.task_id = t.id AND a.finished_at IS NULL)
    RETURNING t.id`
  return moved.length === 1
}

/**
 * The move of `/undo` in a chat with the repository (docs/plan/61-chats-first.md, §5.14), after its
 * branch went back: the chat waits with the candidate that stands now (`to: awaiting_approval`) or
 * for the next words (`awaiting_user`, nothing stands), and the turn is undone (`undoTurn`). Under
 * the turn number the caller saw, while the chat waits, with no turn assigned and no release in
 * work. Its id, or null — the chat is elsewhere, and nothing is written.
 */
export async function rewindDialog(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turnNo: number; to: RewindableStatus },
): Promise<string | null> {
  if (!(await moveWaitingChat(tx, input))) return null
  const turnId = await undoTurn(tx, { taskId: input.taskId, turnNo: input.turnNo })
  if (turnId === null) throw conflict('The last turn of the chat is no longer there to undo')
  return turnId
}

/**
 * The move of `/redo` in a chat with the repository, after its branch came forward: as `rewindDialog`,
 * the chat waits as it did before `/undo` and the turn counts again (`redoTurn`). Its id, or null.
 */
export async function redoDialog(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turnNo: number; to: RewindableStatus },
): Promise<string | null> {
  if (!(await moveWaitingChat(tx, input))) return null
  const turnId = await redoTurn(tx, { taskId: input.taskId, turnNo: input.turnNo })
  if (turnId === null) throw conflict('The undone turn of the chat is no longer there to redo')
  return turnId
}

/** Where a dialog waits without a turn: what the sweeper of reserves may close. */
export const waitingTaskStatuses = [
  'queued',
  'awaiting_user',
  'awaiting_approval',
] as const satisfies readonly TaskStatus[]

const cancelWaitingSchema = z.strictObject({
  taskId: id,
  from: z.enum(waitingTaskStatuses),
  attempt: attemptSchema,
  feed: z.array(z.unknown()).max(1),
})

/**
 * A dialog whose reserve ran out while it waited is cancelled (Р8): from the status the caller
 * saw, under its attempt. The `feed.cancelled` row is written with
 * the move; `expireTaskHolds` joins the same transaction after it.
 */
export async function cancelWaitingTask(
  tx: Pick<Tx, '$queryRaw' | 'taskEvent'>,
  input: {
    taskId: string
    from: (typeof waitingTaskStatuses)[number]
    attempt: number
    feed: readonly FeedRow[]
  },
): Promise<SettledTurn> {
  const parsed = cancelWaitingSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid cancellation of a waiting task')
  const { taskId, from, attempt } = parsed.data
  assertTransition(from, 'cancelled')
  const feed = input.feed.map((row) => feedRowSchema.parse(row))
  const moved = await tx.$queryRaw<Array<{ turn_id: string | null }>>`
    UPDATE tasks t SET status = 'cancelled', waiting = NULL, finished_at = now(),
      updated_at = now()
    WHERE t.id = ${taskId}::uuid AND t.status = ${from}::"TaskStatus" AND t.attempt = ${attempt}
    RETURNING (SELECT tt.id FROM task_turns tt
      WHERE tt.task_id = t.id AND tt.turn_no = t.turn_no) AS turn_id`
  const row = moved[0]
  if (!row) return { moved: false, eventIds: [], turnId: null }
  const eventIds: bigint[] = []
  for (const entry of feed)
    eventIds.push(await insertFeedEvent(tx, { taskId, turnId: row.turn_id, row: entry }))
  return { moved: true, eventIds, turnId: row.turn_id }
}
