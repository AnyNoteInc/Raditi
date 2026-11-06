import { isDeepStrictEqual } from 'node:util'

import {
  badRequest,
  branchBeforeTurn,
  conflict,
  leaseScopeOf,
  requirementsOf,
  terminalTaskStatuses,
  turnEvidenceSchema,
  turnAssignmentOutcomes,
  turnLeaseOf,
  turnPlanSchema,
  type OpenTurnAssignment,
  type TurnAssignment,
  type TurnAssignmentOutcome,
  type TurnEvidence,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { PostgresTurnAssignmentStore, validateOpenTurnAssignment } from './turn-assignments.ts'

type Database = Pick<PrismaClient, '$queryRaw' | '$transaction'>
type Tx = Prisma.TransactionClient
/** One of the journal's fixed reasons, never free text. */
type ClosureReason = NonNullable<TurnEvidence['reason']>
const closureSchema = z.object({
  id: z.uuid(),
  epoch: z.number().int().positive().max(2_147_483_647).optional(),
  outcome: z.enum(turnAssignmentOutcomes),
  reason: turnEvidenceSchema.shape.reason,
})

/**
 * Product runs are numbered once. Their assignment and TaskTurn are admitted and closed in
 * one transaction; task status, billing and queue dispatch are still owned by P12.
 * The operational adapter remains available to the isolated executor PoCs.
 *
 * A turn meets the requirements of its task (docs/plan/57-browser-tasks.md, Б2, Б3), fixed when
 * the task was created. A turn without a repository has no branch, base or head: it continues the
 * completed turn before it by its snapshot, and after an unsuccessful one starts a new session —
 * nothing it did on the site is undone, so it is never replaced. After `/undo` of the turn before
 * it (docs/plan/61-chats-first.md, §5.14) it starts where that turn started, one step back.
 */
export class PostgresTaskTurnAssignmentStore extends PostgresTurnAssignmentStore {
  private readonly productDb: Database

  constructor(productDb: Database) {
    super(productDb)
    this.productDb = productDb
  }

  override async open(input: OpenTurnAssignment): Promise<TurnAssignment | null> {
    const parsed = validateOpenTurnAssignment(input)
    const { plan, fence, sessionId, turn } = parsed
    const requirements = requirementsOf(plan)
    const workspace = plan.workspace
    const labels = plan.sandbox.labels
    if (
      labels.taskId !== fence.taskId ||
      labels.siteId !== fence.siteId ||
      labels.sessionId !== sessionId ||
      labels.turn !== turn ||
      plan.context.taskId !== fence.taskId ||
      plan.context.sessionId !== sessionId ||
      plan.context.turn !== turn ||
      (plan.replacesTurn !== undefined && plan.replacesTurn !== turn - 1)
    )
      throw badRequest('Product turn identity differs from its assignment')
    if (plan.replacesTurn === undefined && workspace?.expectedBranchSha !== undefined)
      throw badRequest('Only a replacement may pin the previous task branch')
    return this.productDb.$transaction(async (tx) => {
      // Same lock as MCP admission: no product run opens around an unresolved writer.
      const owned = await tx.$queryRaw<Array<{ site_id: string }>>`
        SELECT site_id FROM site_leases
        WHERE site_id = ${fence.siteId}::uuid AND holder_task_id = ${fence.taskId}::uuid
          AND epoch = ${fence.epoch} AND operation = 'turn'
          AND NOT held_for_operator AND expires_at > clock_timestamp()
          AND inflight_mcp_call_id IS NULL FOR UPDATE`
      if (owned.length !== 1) return null
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${fence.taskId}::uuid FOR UPDATE`
      const task = await tx.task.findUniqueOrThrow({ where: { id: fence.taskId } })
      if (task.contentRetiredAt) throw conflict('Task content context has expired')
      if (
        // Its own row for a chat with the code (`turnLeaseOf`), its site's for a stand's turn.
        (fence.siteId !== turnLeaseOf(task) && fence.siteId !== leaseScopeOf(task)) ||
        task.workspaceId !== labels.workspaceId ||
        terminalTaskStatuses.includes(task.status)
      )
        throw conflict('Product task is not available for a turn')
      if (
        task.needsRepository !== requirements.repository ||
        task.needsBrowser !== requirements.browser
      )
        throw conflict('The turn plan does not meet the requirements of its task')
      if (turn !== task.turnNo + 1) return null
      if (await tx.turnAssignment.count({ where: { taskId: task.id, finishedAt: null } }))
        return null
      if (turn > 1 && workspace === undefined) {
        // Without a repository there is no branch to read: a completed turn is continued by its
        // snapshot, an unsuccessful one is followed by a new session (plan 57, Б3, Б4).
        const prior = await tx.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: task.id, turnNo: turn - 1 } },
        })
        if (prior.undoneAt !== null) {
          if (!plan.rewound) throw conflict('An undone turn is not continued')
          const undone = await tx.turnAssignment.findMany({
            where: { taskId: task.id, turnNo: turn - 1 },
          })
          const saved = turnPlanSchema.safeParse(undone[0]?.plan)
          if (undone.length !== 1 || !saved.success)
            throw conflict('The undone turn can no longer be restored')
          if (!isDeepStrictEqual(plan.previous, saved.data.previous))
            throw conflict('A rewound turn does not start where the undone one started')
        } else if (plan.rewound) {
          throw conflict('Only a turn after an undone one is rewound')
        } else if (prior.status === 'completed') {
          if (plan.previous?.turn !== turn - 1)
            throw conflict('Continuation does not restore the completed product turn')
        } else if (plan.previous) {
          throw conflict('A turn after an unsuccessful one starts a new session')
        }
      } else if (turn > 1 && workspace !== undefined) {
        const prior = await tx.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: task.id, turnNo: turn - 1 } },
        })
        const branch = await taskBranch(tx, task.id, prior)
        if (plan.replacesTurn === undefined) {
          if (prior.status !== 'completed') throw conflict('An unsuccessful turn must be replaced')
          if (prior.undoneAt !== null) throw conflict('An undone turn must be replaced')
          // After «Обновить» (plan 53, Р27) or the client's edit the turn starts on the moved
          // candidate, going on with the session of the completed turn or a new one; a plain
          // continuation would start on the old head and publish over the move.
          if (plan.rebased) {
            if (
              branch.movedAfterLastTurn === null ||
              (plan.previous !== undefined && plan.previous.turn !== turn - 1) ||
              workspace.expectedBaseSha !== branch.movedAfterLastTurn
            )
              throw conflict('A rebased turn does not start on the candidate «Обновить» moved')
          } else {
            if (plan.previous?.turn !== turn - 1 || workspace.expectedBaseSha !== prior.headSha)
              throw conflict('Continuation does not restore the completed product turn')
            if (branch.movedAfterLastTurn !== null)
              throw conflict('«Обновить» moved the task branch after the completed product turn')
          }
        } else {
          if (workspace.expectedBranchSha !== branch.written)
            throw conflict('Replacement does not pin the published task branch')
          const previous = await tx.turnAssignment.findMany({
            where: { taskId: task.id, turnNo: plan.replacesTurn },
          })
          if (previous.length !== 1 || previous[0]!.finishedAt === null)
            throw conflict('Replacement requires a closed product assignment')
          // A plan saved by a driver the platform no longer has is history, not an input.
          const saved = turnPlanSchema.safeParse(previous[0]!.plan)
          if (!saved.success) throw conflict('The replaced turn can no longer be restored')
          const replaced = saved.data
          if (previous[0]!.sessionId !== sessionId)
            throw conflict('Replacement does not restore the replaced turn input')
          if (branch.movedAfterLastTurn !== null) {
            // «Обновить» or the client's edit moved the candidate after the replaced turn: the
            // replacement starts on the moved head, with the session the replaced turn started
            // from or a new one.
            if (
              !plan.rebased ||
              (plan.previous !== undefined &&
                !isDeepStrictEqual(plan.previous, replaced.previous)) ||
              workspace.expectedBaseSha !== branch.movedAfterLastTurn
            )
              throw conflict('Replacement does not start on the candidate «Обновить» moved')
          } else if (
            (plan.rebased === true) !== (replaced.rebased === true) ||
            !isDeepStrictEqual(plan.previous, replaced.previous) ||
            workspace.expectedBaseSha !== replaced.workspace?.expectedBaseSha
          )
            throw conflict('Replacement does not restore the replaced turn input')
        }
      } else if (plan.previous || plan.replacesTurn !== undefined || plan.rebased || plan.rewound) {
        throw badRequest('The first product turn has no predecessor')
      }
      const assignment = await new PostgresTurnAssignmentStore(tx).open(parsed)
      if (!assignment) return null
      await tx.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo: turn,
          status: 'running',
          driverId: plan.driverId,
          driverVersion: plan.driverVersion,
          image: plan.sandbox.image,
          baseSha: workspace?.expectedBaseSha ?? null,
          startedAt: assignment.serverNow,
        },
      })
      await tx.task.update({ where: { id: task.id }, data: { turnNo: turn } })
      return assignment
    })
  }

  override async finish(input: {
    id: string
    epoch: number
    outcome: TurnAssignmentOutcome
  }): Promise<boolean> {
    return this.#close(input.id, input.epoch, input.outcome)
  }

  /**
   * Nobody journaled a `failed` entry yet when an unclaimed turn is abandoned: `reason` is why
   * its caller gave it up (`cancelled`, `timeout`), stored with the TaskTurn in the same
   * transaction. Without it the owner's later finish() brings the journaled reason.
   */
  override async abandon(
    id: string,
    outcome: TurnAssignmentOutcome = 'failed',
    reason?: ClosureReason,
  ): Promise<boolean> {
    return this.#close(id, undefined, outcome, reason)
  }

  async #close(
    id: string,
    epoch: number | undefined,
    outcome: TurnAssignmentOutcome,
    given?: ClosureReason,
  ) {
    closureSchema.parse({ id, epoch, outcome, reason: given })
    return this.productDb.$transaction(async (tx) => {
      const operational = new PostgresTurnAssignmentStore(tx)
      // get() validates the id before using it in SQL; re-read after taking the lock.
      if (!(await operational.get(id))) return false
      await tx.$queryRaw`SELECT id FROM turn_assignments WHERE id = ${id}::uuid FOR UPDATE`
      const before = (await operational.get(id))!
      if (before.outcome !== null) {
        if (epoch === before.fence.epoch && outcome === 'failed')
          await this.#explainAbandoned(tx, before)
        return false
      }
      if (epoch !== undefined && before.fence.epoch !== epoch) return false
      // Lock even a released lease: admission cannot install a writer around this check.
      await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${before.fence.siteId}::uuid FOR UPDATE`
      const lease = await tx.siteLease.findUnique({ where: { siteId: before.fence.siteId } })
      if (
        lease?.holderTaskId === before.fence.taskId &&
        lease.epoch === before.fence.epoch &&
        (lease.inflightMcpCallId || lease.heldForOperator)
      )
        return false
      const closed =
        epoch === undefined
          ? await operational.abandon(id, outcome)
          : await operational.finish({ id, epoch, outcome })
      if (!closed) return false
      await this.#projectClosure(tx, before, outcome, given)
      return true
    })
  }

  /** The reason of the turn's last `failed` journal entry at the assignment's epoch, if any. */
  async #journaledReason(tx: Tx, assignment: TurnAssignment): Promise<ClosureReason | undefined> {
    const rows = await tx.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM task_events WHERE task_id = ${assignment.fence.taskId}::uuid
        AND type = 'turn.lifecycle' AND payload->>'sessionId' = ${assignment.sessionId}
        AND payload->>'turn' = ${String(assignment.turn)} AND payload->>'phase' = 'failed'
        AND (payload->'fence'->>'epoch')::int = ${assignment.fence.epoch}
      ORDER BY id DESC LIMIT 1`
    const parsed = turnEvidenceSchema.safeParse(rows[0]?.payload)
    return parsed.success ? parsed.data.reason : undefined
  }

  async #projectClosure(
    tx: Tx,
    assignment: TurnAssignment,
    outcome: TurnAssignmentOutcome,
    given?: ClosureReason,
  ) {
    const reason = given ?? (await this.#journaledReason(tx, assignment))
    const terminal = await tx.turnAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    await tx.taskTurn.updateMany({
      where: { taskId: assignment.fence.taskId, turnNo: assignment.turn, status: 'running' },
      data: {
        status: turnStatus(outcome, reason),
        finishedAt: terminal.finishedAt,
        failureReason: outcome === 'completed' ? null : (reason ?? outcome),
      },
    })
  }

  /**
   * An unclaimed runner turn is abandoned before its owner journals why: a client's cancel or
   * the turn's deadline would stay a platform failure. The owner's finish() of the same epoch,
   * which closes nothing any more, brings that reason to the TaskTurn — once, and only to a
   * closure that recorded none.
   */
  async #explainAbandoned(tx: Tx, assignment: TurnAssignment) {
    // A local or claimed turn is closed by its owner's finish(), after its journal entry.
    if (assignment.executor !== 'runner' || assignment.runner !== null) return
    if (assignment.outcome !== 'failed') return
    const reason = await this.#journaledReason(tx, assignment)
    if (!reason) return
    await tx.taskTurn.updateMany({
      // failure_reason = 'failed' is the outcome itself: the closure knew no reason.
      where: {
        taskId: assignment.fence.taskId,
        turnNo: assignment.turn,
        status: 'failed',
        failureReason: 'failed',
      },
      data: { status: turnStatus('failed', reason), failureReason: reason },
    })
  }
}

/**
 * Where the platform last left `agent/<taskId>` (docs/plan/53-chat-preview-release.md, R3), the
 * rule the planner's facts follow too. `written` — the head of the last completed turn or, when
 * «Обновить» moved the standing candidate after it, the candidate's head; null before the first
 * publication. A turn the client undid no longer counts (docs/plan/61-chats-first.md, §5.14): while
 * it is the latest one the branch stands where its plan found it. `movedAfterLastTurn` — the
 * candidate's head when «Обновить» moved it after the turn before this one (it records the
 * candidate under the task's turn number, with a head that turn did not write); null otherwise.
 */
async function taskBranch(
  tx: Tx,
  taskId: string,
  prior: { turnNo: number; headSha: string | null },
): Promise<{ written: string | null; movedAfterLastTurn: string | null }> {
  const published = await tx.taskTurn.findFirst({
    where: { taskId, status: 'completed', undoneAt: null },
    orderBy: { turnNo: 'desc' },
    select: { turnNo: true, headSha: true },
  })
  if (published && !published.headSha)
    throw conflict('Completed product turn has no publication evidence')
  const undone = await tx.taskTurn.findFirst({
    where: { taskId, undoneAt: { not: null }, turnNo: { gt: published?.turnNo ?? 0 } },
    orderBy: { turnNo: 'desc' },
    select: { turnNo: true },
  })
  const last = undone
    ? await undoneTurnBranch(tx, taskId, undone.turnNo)
    : { turnNo: published?.turnNo ?? 0, head: published?.headSha ?? null }
  // The latest revision whatever its status: an «Обновить» that left nothing to release while a
  // pass was queued records the head it pushed as a revision superseded at once (plan 53, R3).
  const standing = await tx.taskCandidate.findFirst({
    where: { taskId },
    orderBy: { revision: 'desc' },
    select: { turnNo: true, headSha: true },
  })
  const own = standing
    ? standing.turnNo === prior.turnNo
      ? prior.headSha
      : ((
          await tx.taskTurn.findUnique({
            where: { taskId_turnNo: { taskId, turnNo: standing.turnNo } },
            select: { headSha: true },
          })
        )?.headSha ?? null)
    : null
  const moved = standing && standing.headSha !== own ? standing : null
  return {
    written: moved && moved.turnNo >= last.turnNo ? moved.headSha : last.head,
    movedAfterLastTurn: moved && moved.turnNo === prior.turnNo ? moved.headSha : null,
  }
}

/** Where `/undo` of a turn left the task branch: where the plan of that turn found it. */
async function undoneTurnBranch(
  tx: Tx,
  taskId: string,
  turnNo: number,
): Promise<{ turnNo: number; head: string | null }> {
  const assignments = await tx.turnAssignment.findMany({ where: { taskId, turnNo } })
  const saved = turnPlanSchema.safeParse(assignments[0]?.plan)
  if (assignments.length !== 1 || !saved.success)
    throw conflict('The undone turn can no longer be restored')
  return { turnNo, head: branchBeforeTurn(saved.data) }
}

/** A client's cancel and the turn's deadline are their own TaskTurn statuses, not failures. */
function turnStatus(outcome: TurnAssignmentOutcome, reason: ClosureReason | undefined) {
  if (outcome !== 'failed') return outcome
  return reason === 'timeout' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'failed'
}
