import { createHash } from 'node:crypto'

import {
  assertCandidateTransition,
  assertTransition,
  badRequest,
  candidateCheckKinds,
  candidateFactsSchema,
  candidateFilesSchema,
  candidateMediaSchema,
  dbPlanSchema,
  dbPlanViewSchema,
  feedRowSchema,
  modelClassSchema,
  taskWaitingReasons,
  terminalTaskStatuses,
  versionBumps,
  versionTagSchema,
  type CandidateCheckKind,
  type CandidateFacts,
  type CandidateFiles,
  type CandidateMedia,
  type DbPlan,
  type DbPlanView,
  type FeedRow,
  type ModelClass,
  type TaskStatus,
  type TaskWaitingReason,
  type VersionBump,
} from '@repo/domain'
import { z } from 'zod'

import { enqueuePreviewSync } from './chat-outbox.ts'
import { insertFeedEvent } from './feed-events.ts'
import { Prisma } from './generated/prisma/client.ts'

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
 * saw, under its attempt, and never while a release of it has not ended — the sweeper of
 * reserves skips those, and so does this statement. The `feed.cancelled` row is written with
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
      AND NOT EXISTS (
        SELECT 1 FROM site_releases r
        WHERE r.task_id = t.id AND r.status NOT IN ('installed', 'rolled_back', 'failed'))
    RETURNING (SELECT tt.id FROM task_turns tt
      WHERE tt.task_id = t.id AND tt.turn_no = t.turn_no) AS turn_id`
  const row = moved[0]
  if (!row) return { moved: false, eventIds: [], turnId: null }
  const eventIds: bigint[] = []
  for (const entry of feed)
    eventIds.push(await insertFeedEvent(tx, { taskId, turnId: row.turn_id, row: entry }))
  return { moved: true, eventIds, turnId: row.turn_id }
}

const finishEmptiedSchema = z.strictObject({
  taskId: id,
  attempt: attemptSchema,
  turnNo: turnNoSchema,
})

/**
 * «Обновить» found the whole change of the dialog on `main` already (docs/plan/53-chat-preview-
 * release.md, R3): nothing is left to release, so the dialog ends `done`, as a pass without
 * changes ends a dialog without a candidate (Р7). From `awaiting_approval` under the attempt and
 * the turn number the caller saw, never with a release in work; `chargeTask` joins the same
 * transaction after it. false — the dialog was elsewhere, and nothing is written.
 */
export async function finishEmptiedDialog(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; attempt: number; turnNo: number },
): Promise<boolean> {
  const parsed = finishEmptiedSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid end of an emptied dialog')
  const { taskId, attempt, turnNo } = parsed.data
  assertTransition('awaiting_approval', 'done')
  const moved = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE tasks t SET status = 'done', waiting = NULL, finished_at = now(), updated_at = now()
    WHERE t.id = ${taskId}::uuid AND t.status = 'awaiting_approval' AND t.attempt = ${attempt}
      AND t.turn_no = ${turnNo}
      AND NOT EXISTS (
        SELECT 1 FROM site_releases r
        WHERE r.task_id = t.id AND r.status NOT IN ('installed', 'rolled_back', 'failed'))
    RETURNING t.id`
  return moved.length === 1
}

// ---------------------------------------------------------------------------------------------
// The candidate of a pass that changed something
// ---------------------------------------------------------------------------------------------

const sha1 = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

const candidateSchema = z.strictObject({
  taskId: id,
  /**
   * The next revision of the dialog, read by the caller before it wrote the artifacts of the
   * revision: one more than the highest. Another writer of the same revision fails on the
   * UNIQUE (task_id, revision) and rolls its transaction back.
   */
  revision: z.number().int().min(1).max(999_999),
  /** The turn whose head the candidate is; after «Обновить» the turn it was moved at. */
  turnNo: z.number().int().min(1).max(999_999),
  baseSha: sha1,
  baseTree: sha1,
  /** The installed version the base stands on; null — none is known. */
  baseVersion: versionTagSchema.nullable(),
  headSha: sha1,
  files: candidateFilesSchema,
  media: candidateMediaSchema,
  dbPlan: dbPlanSchema,
  dbPlanSha256: sha256,
  /**
   * What the client reads of the plan (docs/plan/53, «Операции БД и миграции»), built by core with
   * the revision: it describes this very plan. Absent or null — an empty plan, or a caller of
   * before descriptions; a release refuses a plan without one.
   */
  dbView: dbPlanViewSchema.nullable().optional(),
  /**
   * The variables of the site, each with the version its row named, when the builder read the
   * values the description is checked against (Р13). A row added or changed since may hold a
   * value the description was not checked for: it is recorded without the description. Absent —
   * none were read.
   */
  dbViewVariables: z
    .array(z.strictObject({ name: z.string().min(1).max(64), keyVersion: z.number().int() }))
    .max(1000)
    .optional(),
  proposedBump: z.enum(versionBumps),
  proposedVersion: versionTagSchema,
  facts: candidateFactsSchema,
  /** Checks the new revision starts with, `pending`. */
  checks: z
    .array(z.enum(candidateCheckKinds))
    .max(candidateCheckKinds.length)
    .refine((kinds) => new Set(kinds).size === kinds.length),
  /**
   * What the site had installed when the candidate was built — `sites.installed_sha` and the
   * tree of that commit —, null when nothing was. The candidate stands on the installed version
   * only if its base has that tree (Р15, Р27).
   */
  installed: z.strictObject({ sha: sha1, tree: sha1 }).nullable(),
})

export interface CandidateRecordInput {
  taskId: string
  revision: number
  turnNo: number
  baseSha: string
  baseTree: string
  baseVersion: string | null
  headSha: string
  files: CandidateFiles
  media: CandidateMedia
  dbPlan: DbPlan
  dbPlanSha256: string
  dbView?: DbPlanView | null
  /** The variables of the site with their versions when the description was checked. */
  dbViewVariables?: readonly { name: string; keyVersion: number }[]
  proposedBump: VersionBump
  proposedVersion: string
  facts: CandidateFacts
  checks: readonly CandidateCheckKind[]
  /** `sites.installed_sha` as the builder saw it and its tree; null — nothing was installed. */
  installed: { sha: string; tree: string } | null
}

export interface RecordedCandidate {
  id: string
  revision: number
  /** The candidate it replaced, or null for the first one of the dialog. */
  supersededId: string | null
  /**
   * `stale` — the candidate does not stand on what the site has installed: a release of another
   * dialog installed after its base was taken (Р15). Its dialog needs «Обновить» to release it.
   */
  status: 'current' | 'stale'
}

/**
 * The dialog's standing candidate — `current`, or `stale` after a release elsewhere — becomes
 * `superseded`: a newer revision replaces it, or the pass undid every change of the dialog.
 * Returns its id, or null when none stood.
 */
export async function supersedeStandingCandidate(
  tx: Pick<Tx, '$queryRaw' | 'taskCandidate'>,
  taskId: string,
): Promise<string | null> {
  const standing = await tx.$queryRaw<Array<{ id: string; status: 'current' | 'stale' }>>`
    SELECT id, status::text AS status FROM task_candidates
    WHERE task_id = ${id.parse(taskId)}::uuid AND status IN ('current', 'stale')
    ORDER BY revision DESC FOR UPDATE`
  for (const row of standing) assertCandidateTransition(row.status, 'superseded')
  if (standing.length > 0)
    await tx.taskCandidate.updateMany({
      where: { id: { in: standing.map((row) => row.id) } },
      // Nobody shows or releases a superseded revision: the values of its plan go with it.
      data: {
        status: 'superseded',
        supersededAt: new Date(),
        dbView: Prisma.DbNull,
        dbViewSha256: null,
      },
    })
  return standing[0]?.id ?? null
}

/** The revision the next candidate of a task gets: one more than the highest it has had. */
export async function nextCandidateRevision(
  db: Pick<Tx, 'taskCandidate'>,
  taskId: string,
): Promise<number> {
  const { _max: max } = await db.taskCandidate.aggregate({
    where: { taskId: id.parse(taskId) },
    _max: { revision: true },
  })
  return (max.revision ?? 0) + 1
}

/**
 * The next revision of the dialog's candidate (Р5, Р22): the one that stood — `current`, or
 * `stale` after a release elsewhere — becomes `superseded`, the new one is `current` when it
 * stands on what the site has installed and `stale` when it does not (Р15), its preview revision
 * is its own revision and its checks start `pending`. Call it in the transaction of the move
 * that shows it; the partial UNIQUE «one current per task» guards the rest.
 *
 * Staleness is decided here, not left to the release that installs: a pass that records after
 * the install, on a base taken before it, would never be marked (markSiteCandidatesStale ran
 * already, markStaleCandidates leaves candidates younger than the install). The site's row is
 * read FOR SHARE first: an install (`installRelease` writes it before it marks the candidates of
 * the site) either committed and is seen here, or waits for this transaction and then sees the
 * new row.
 */
export async function recordCandidate(
  tx: Pick<Tx, '$queryRaw' | 'taskCandidate' | 'candidateCheck'>,
  input: CandidateRecordInput,
): Promise<RecordedCandidate> {
  const parsed = candidateSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid candidate')
  const candidate = parsed.data
  let view = candidate.dbView ?? null
  if (
    view !== null &&
    (view.planSha256 !== candidate.dbPlanSha256 || candidate.dbPlan.length === 0)
  )
    throw badRequest('Invalid candidate')
  // The lock a change of a variable takes too (`takeBackDescriptions` of @repo/trpc): either it
  // committed and its row is seen below, or it waits and then finds this description.
  const site = await tx.$queryRaw<Array<{ id: string; installed_sha: string | null }>>`
    SELECT s.id, s.installed_sha FROM sites s JOIN tasks t ON t.site_id = s.id
    WHERE t.id = ${candidate.taskId}::uuid
    FOR SHARE OF s`
  if (view !== null && site[0]) {
    const checked = new Set(
      (candidate.dbViewVariables ?? []).map((row) => `${row.name}\u0000${row.keyVersion}`),
    )
    const rows = await tx.$queryRaw<Array<{ name: string; key_version: number }>>`
      SELECT name, key_version FROM site_env_vars WHERE site_id = ${site[0].id}::uuid`
    // A value set after the builder read them: the description was not checked for it (Р13).
    if (rows.some((row) => !checked.has(`${row.name}\u0000${row.key_version}`))) view = null
  }
  // The text the confirmation of a release is bound to: JSONB keeps no order of keys.
  const viewText = view === null ? null : JSON.stringify(view)
  const installedNow = site[0]?.installed_sha ?? null
  const status: RecordedCandidate['status'] =
    installedNow === null ||
    (candidate.installed !== null &&
      candidate.installed.sha === installedNow &&
      candidate.installed.tree === candidate.baseTree)
      ? 'current'
      : 'stale'
  const supersededId = await supersedeStandingCandidate(tx, candidate.taskId)
  const revision = candidate.revision
  const created = await tx.taskCandidate.create({
    data: {
      taskId: candidate.taskId,
      revision,
      turnNo: candidate.turnNo,
      status,
      baseSha: candidate.baseSha,
      baseTree: candidate.baseTree,
      baseVersion: candidate.baseVersion,
      headSha: candidate.headSha,
      files: candidate.files as Prisma.InputJsonValue,
      media: candidate.media as Prisma.InputJsonValue,
      dbPlan: candidate.dbPlan as Prisma.InputJsonValue,
      dbPlanSha256: candidate.dbPlanSha256,
      proposedBump: candidate.proposedBump,
      proposedVersion: candidate.proposedVersion,
      facts: candidate.facts as Prisma.InputJsonValue,
      previewRevision: revision,
      ...(viewText === null
        ? {}
        : {
            dbView: JSON.parse(viewText) as Prisma.InputJsonValue,
            dbViewSha256: createHash('sha256').update(viewText).digest('hex'),
          }),
    },
    select: { id: true },
  })
  if (candidate.checks.length > 0)
    await tx.candidateCheck.createMany({
      data: candidate.checks.map((kind) => ({
        candidateId: created.id,
        revision,
        kind,
        status: 'pending' as const,
      })),
    })
  return { id: created.id, revision, supersededId, status }
}

// ---------------------------------------------------------------------------------------------
// The preview follows the dialog (Р22)
// ---------------------------------------------------------------------------------------------

const turnOfTask = z.strictObject({ taskId: id, turnNo: z.number().int().min(1).max(999_999) })

/**
 * The database writes of a failed or cancelled turn leave the plan (Р22): its rows of
 * `preview_db_operations` are marked `excluded`, so the compacted plan and the rebuilt preview
 * no longer hold them. Returns how many rows were marked now.
 */
export async function excludeTurnDbOperations(
  tx: Pick<Tx, 'previewDbOperation'>,
  input: { taskId: string; turnNo: number },
): Promise<number> {
  const { taskId, turnNo } = turnOfTask.parse(input)
  const { count } = await tx.previewDbOperation.updateMany({
    where: { taskId, turnNo, excluded: false },
    data: { excluded: true },
  })
  return count
}

const syncSchema = z.strictObject({ taskId: id, revision: z.number().int().min(0).max(999_999) })

/**
 * Asks the manager of previews to bring the dialog's preview to `revision` (0 — the base): the
 * enqueue counter of the row is raised and `preview.sync` goes to the outbox with it, in the
 * caller's transaction. false — the dialog has no preview, or it is destroyed.
 */
export async function requestPreviewSync(
  tx: Pick<Tx, '$queryRaw' | 'outboxEvent'>,
  input: { taskId: string; revision: number },
): Promise<boolean> {
  const { taskId, revision } = syncSchema.parse(input)
  const rows = await tx.$queryRaw<Array<{ id: string; enqueues: number }>>`
    UPDATE preview_environments SET enqueues = enqueues + 1, updated_at = now()
    WHERE task_id = ${taskId}::uuid AND status <> 'destroyed'
    RETURNING id, enqueues`
  const row = rows[0]
  if (!row) return false
  await enqueuePreviewSync(tx, { previewId: row.id, revision, seq: row.enqueues })
  return true
}
