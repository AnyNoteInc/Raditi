import { isDeepStrictEqual } from 'node:util'

import {
  badRequest,
  conflict,
  terminalTaskStatuses,
  turnEvidenceSchema,
  turnAssignmentOutcomes,
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
    if (plan.replacesTurn === undefined && plan.workspace.expectedBranchSha !== undefined)
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
        task.siteId !== fence.siteId ||
        task.workspaceId !== labels.workspaceId ||
        terminalTaskStatuses.includes(task.status)
      )
        throw conflict('Product task is not available for a turn')
      if (turn !== task.turnNo + 1) return null
      if (await tx.turnAssignment.count({ where: { taskId: task.id, finishedAt: null } }))
        return null
      if (turn > 1) {
        const prior = await tx.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: task.id, turnNo: turn - 1 } },
        })
        const branch = await taskBranch(tx, task.id, prior)
        if (plan.replacesTurn === undefined) {
          if (prior.status !== 'completed') throw conflict('An unsuccessful turn must be replaced')
          // After «Обновить» (plan 53, Р27) the turn is a new session on the moved candidate;
          // a continuation would restore a session of the old `main` and publish over the move.
          if (plan.rebased) {
            if (
              branch.movedAfterLastTurn === null ||
              plan.previous ||
              plan.workspace.expectedBaseSha !== branch.movedAfterLastTurn
            )
              throw conflict('A rebased turn does not start on the candidate «Обновить» moved')
          } else {
            if (
              plan.previous?.turn !== turn - 1 ||
              plan.workspace.expectedBaseSha !== prior.headSha
            )
              throw conflict('Continuation does not restore the completed product turn')
            if (branch.movedAfterLastTurn !== null)
              throw conflict('«Обновить» moved the task branch after the completed product turn')
          }
        } else {
          if (plan.workspace.expectedBranchSha !== branch.written)
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
            // «Обновить» moved the candidate after the replaced turn (plan 53, Р27): its input
            // stands on the old `main`, so the replacement is a new session on the moved head.
            if (
              !plan.rebased ||
              plan.previous ||
              plan.workspace.expectedBaseSha !== branch.movedAfterLastTurn
            )
              throw conflict('Replacement does not start on the candidate «Обновить» moved')
          } else if (
            (plan.rebased === true) !== (replaced.rebased === true) ||
            !isDeepStrictEqual(plan.previous, replaced.previous) ||
            plan.workspace.expectedBaseSha !== replaced.workspace.expectedBaseSha
          )
            throw conflict('Replacement does not restore the replaced turn input')
        }
      } else if (plan.previous || plan.replacesTurn !== undefined || plan.rebased) {
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
          baseSha: plan.workspace.expectedBaseSha,
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
 * publication. `movedAfterLastTurn` — the candidate's head when «Обновить» moved it after the
 * turn before this one (it records the candidate under the task's turn number, with a head that
 * turn did not write); null otherwise.
 */
async function taskBranch(
  tx: Tx,
  taskId: string,
  prior: { turnNo: number; headSha: string | null },
): Promise<{ written: string | null; movedAfterLastTurn: string | null }> {
  const published = await tx.taskTurn.findFirst({
    where: { taskId, status: 'completed' },
    orderBy: { turnNo: 'desc' },
    select: { turnNo: true, headSha: true },
  })
  if (published && !published.headSha)
    throw conflict('Completed product turn has no publication evidence')
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
  const written =
    moved && moved.turnNo >= (published?.turnNo ?? 0) ? moved.headSha : (published?.headSha ?? null)
  return {
    written,
    movedAfterLastTurn: moved && moved.turnNo === prior.turnNo ? moved.headSha : null,
  }
}

/** A client's cancel and the turn's deadline are their own TaskTurn statuses, not failures. */
function turnStatus(outcome: TurnAssignmentOutcome, reason: ClosureReason | undefined) {
  if (outcome !== 'failed') return outcome
  return reason === 'timeout' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'failed'
}
