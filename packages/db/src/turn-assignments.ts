import { randomBytes } from 'node:crypto'

import {
  badRequest,
  MAX_SANDBOX_TURN_MS,
  runnerIdSchema,
  runnerLimits,
  turnAssignmentOutcomes,
  turnExecutorKinds,
  turnPlanSchema,
  type OpenTurnAssignment,
  type SiteLeaseFence,
  type SiteLeaseGrant,
  type TurnAssignment,
  type TurnAssignmentOutcome,
  type TurnAssignmentStore,
} from '@repo/domain'
import { z } from 'zod'

import { Prisma } from './generated/prisma/client.ts'

type AssignmentDatabase = Pick<Prisma.TransactionClient, '$queryRaw'>

const id = z.uuid()
const epoch = z.number().int().positive().max(2_147_483_647)
const fenceSchema = z.object({
  siteId: id,
  taskId: id,
  operation: z.literal('turn'),
  epoch,
})
const sessionIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const containerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const openSchema = z.object({
  fence: fenceSchema,
  sessionId: sessionIdSchema,
  turn: z.number().int().positive().max(999_999),
  executor: z.enum(turnExecutorKinds),
  plan: turnPlanSchema,
  remainingMs: z.number().int().positive().max(MAX_SANDBOX_TURN_MS),
})
const idsSchema = z.array(id).max(runnerLimits.claimIds)
const runnerSchema = z.object({ runnerId: runnerIdSchema, runnerSession: id })
const takenSchema = z.array(z.object({ lease_expires_at: z.coerce.date() })).length(1)

const rowsSchema = z.array(
  z.object({
    id,
    task_id: id,
    site_id: id,
    session_id: z.string(),
    turn_no: z.number().int(),
    executor: z.enum(turnExecutorKinds),
    plan: z.unknown(),
    first_epoch: z.number().int(),
    lease_epoch: z.number().int(),
    deadline_at: z.coerce.date(),
    runner_id: z.string().nullable(),
    runner_session: id.nullable(),
    container_id: z.string().nullable(),
    recovery_attempts: z.number().int(),
    outcome: z.enum(turnAssignmentOutcomes).nullable(),
    server_now: z.coerce.date(),
  }),
)

/** Every statement returns whole rows with the database clock of that statement. */
const columns = (alias: string) =>
  Prisma.raw(
    [
      'id',
      'task_id',
      'site_id',
      'session_id',
      'turn_no',
      'executor',
      'plan',
      'first_epoch',
      'lease_epoch',
      'deadline_at',
      'runner_id',
      'runner_session',
      'container_id',
      'recovery_attempts',
      'outcome',
    ]
      .map((column) => `${alias}.${column}`)
      .concat('clock_timestamp() AS server_now')
      .join(', '),
  )

function assignments(raw: unknown): TurnAssignment[] {
  return rowsSchema.parse(raw).map((row) => {
    const plan = turnPlanSchema.safeParse(row.plan)
    if (!plan.success) throw badRequest('Invalid turn assignment returned by the database')
    return {
      id: row.id,
      fence: {
        siteId: row.site_id,
        taskId: row.task_id,
        operation: 'turn',
        epoch: row.lease_epoch,
      },
      firstEpoch: row.first_epoch,
      sessionId: row.session_id,
      turn: row.turn_no,
      executor: row.executor,
      plan: plan.data,
      deadlineAt: row.deadline_at,
      serverNow: row.server_now,
      runner:
        row.runner_id !== null && row.runner_session !== null
          ? { id: row.runner_id, session: row.runner_session }
          : null,
      containerId: row.container_id,
      recoveryAttempts: row.recovery_attempts,
      outcome: row.outcome,
    }
  })
}

/** RFC 9562 version 7: the ids of this schema are time-ordered, as Prisma's uuid(7). */
function uuidv7(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Turn assignments in PostgreSQL. Opening and a takeover are fenced by the site lease in the same
 * statement, claims skip rows another claimant holds, and later writes are conditional on the
 * epoch.
 */
export class PostgresTurnAssignmentStore implements TurnAssignmentStore {
  private readonly db: AssignmentDatabase

  constructor(db: AssignmentDatabase) {
    this.db = db
  }

  async open(input: OpenTurnAssignment): Promise<TurnAssignment | null> {
    const parsed = openSchema.parse(input)
    const { fence } = parsed
    const rows = assignments(
      await this.db.$queryRaw`
      WITH owned AS MATERIALIZED (
        SELECT lease.site_id, clock_timestamp() AS instant FROM site_leases lease
        JOIN tasks task ON task.id = lease.holder_task_id AND task.site_id = lease.site_id
        WHERE lease.site_id = ${fence.siteId}::uuid AND lease.holder_task_id = ${fence.taskId}::uuid
          AND lease.epoch = ${fence.epoch} AND lease.operation = 'turn'::"LeaseOperation"
          AND NOT lease.held_for_operator AND lease.expires_at > clock_timestamp()
        FOR UPDATE OF lease
      )
      INSERT INTO turn_assignments AS a (id, task_id, site_id, session_id, turn_no, executor, plan,
        first_epoch, lease_epoch, deadline_at, created_at, updated_at)
      SELECT ${uuidv7()}::uuid, ${fence.taskId}::uuid, owned.site_id, ${parsed.sessionId},
        ${parsed.turn}, ${parsed.executor}::"TurnExecutorKind", ${JSON.stringify(parsed.plan)}::jsonb,
        ${fence.epoch}, ${fence.epoch},
        owned.instant + ${parsed.remainingMs}::int * interval '1 millisecond',
        owned.instant, owned.instant
      FROM owned
      ON CONFLICT (task_id, turn_no) WHERE finished_at IS NULL DO NOTHING
      RETURNING ${columns('a')}`,
    )
    return rows[0] ?? null
  }

  async get(assignmentId: string): Promise<TurnAssignment | null> {
    const checked = id.parse(assignmentId)
    const rows = assignments(
      await this.db.$queryRaw`
      SELECT ${columns('a')} FROM turn_assignments a WHERE a.id = ${checked}::uuid`,
    )
    return rows[0] ?? null
  }

  async claim(input: {
    ids: readonly string[]
    runnerId: string
    runnerSession: string
    limit: number
  }): Promise<TurnAssignment[]> {
    const ids = idsSchema.parse(input.ids)
    const { runnerId, runnerSession } = runnerSchema.parse(input)
    const limit = z.number().int().nonnegative().max(64).parse(input.limit)
    if (ids.length === 0 || limit === 0) return []
    return assignments(
      await this.db.$queryRaw`
      WITH picked AS MATERIALIZED (
        SELECT id FROM turn_assignments
        WHERE id = ANY(${ids}::uuid[]) AND executor = 'runner'::"TurnExecutorKind"
          AND runner_id IS NULL AND finished_at IS NULL AND deadline_at > clock_timestamp()
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE turn_assignments a SET runner_id = ${runnerId}, runner_session = ${runnerSession}::uuid,
        claimed_at = clock_timestamp(), runner_seen_at = clock_timestamp(),
        updated_at = clock_timestamp()
      FROM picked WHERE a.id = picked.id
      RETURNING ${columns('a')}`,
    )
  }

  async abandon(assignmentId: string, outcome?: TurnAssignmentOutcome): Promise<boolean> {
    const checked = id.parse(assignmentId)
    const closed = z.enum(turnAssignmentOutcomes).default('failed').parse(outcome)
    // Waits for a claim that holds the row, then sees its runner and changes nothing.
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE turn_assignments SET finished_at = clock_timestamp(),
        outcome = ${closed}::"TurnAssignmentOutcome", updated_at = clock_timestamp()
      WHERE id = ${checked}::uuid AND executor = 'runner'::"TurnExecutorKind"
        AND runner_id IS NULL AND finished_at IS NULL
      RETURNING id`
    return rows.length === 1
  }

  async recordContainer(input: {
    id: string
    epoch: number
    containerId: string
  }): Promise<boolean> {
    const checked = z
      .object({ id, epoch, containerId: containerIdSchema })
      .parse({ id: input.id, epoch: input.epoch, containerId: input.containerId })
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE turn_assignments SET container_id = ${checked.containerId},
        updated_at = clock_timestamp()
      WHERE id = ${checked.id}::uuid AND lease_epoch = ${checked.epoch} AND finished_at IS NULL
        AND (container_id IS NULL OR container_id = ${checked.containerId})
      RETURNING id`
    return rows.length === 1
  }

  async seen(input: {
    runnerId: string
    runnerSession: string
    ids: readonly string[]
  }): Promise<void> {
    const ids = idsSchema.parse(input.ids)
    const { runnerId, runnerSession } = runnerSchema.parse(input)
    if (ids.length === 0) return
    await this.db.$queryRaw`
      UPDATE turn_assignments SET runner_seen_at = clock_timestamp()
      WHERE id = ANY(${ids}::uuid[]) AND runner_id = ${runnerId}
        AND runner_session = ${runnerSession}::uuid AND finished_at IS NULL
      RETURNING id`
  }

  async takeOver(input: {
    id: string
    fence: SiteLeaseFence
    ttlMs: number
    runnerSession?: string
    countAttempt?: boolean
  }): Promise<{ assignment: TurnAssignment; grant: SiteLeaseGrant } | null> {
    const checked = z
      .object({
        id,
        fence: fenceSchema,
        ttlMs: z
          .number()
          .int()
          .min(1_000)
          .max(30 * 60_000),
        runnerSession: id.nullable(),
        countAttempt: z.boolean(),
      })
      .parse({
        id: input.id,
        fence: input.fence,
        ttlMs: input.ttlMs,
        runnerSession: input.runnerSession ?? null,
        countAttempt: input.countAttempt ?? true,
      })
    const { fence } = checked
    const attempts = checked.countAttempt ? 1 : 0
    // One statement: the lease moves to the next epoch only together with the assignment.
    const raw = await this.db.$queryRaw`
      WITH a AS MATERIALIZED (
        SELECT id, site_id, task_id FROM turn_assignments
        WHERE id = ${checked.id}::uuid AND site_id = ${fence.siteId}::uuid
          AND task_id = ${fence.taskId}::uuid AND lease_epoch = ${fence.epoch}
          AND finished_at IS NULL
          AND (${checked.runnerSession}::uuid IS NULL OR runner_id IS NOT NULL)
        FOR UPDATE
      ), held AS MATERIALIZED (
        SELECT lease.site_id FROM site_leases lease JOIN a ON a.site_id = lease.site_id
        WHERE lease.holder_task_id = a.task_id AND lease.epoch = ${fence.epoch}
          AND lease.operation = 'turn'::"LeaseOperation" AND lease.held_for_operator
          AND lease.epoch < 2147483647
        FOR UPDATE OF lease
      ), lease AS (
        UPDATE site_leases l SET epoch = l.epoch + 1, held_for_operator = false,
          acquired_at = clock_timestamp(), updated_at = clock_timestamp(),
          expires_at = clock_timestamp() + ${checked.ttlMs}::int * interval '1 millisecond'
        FROM held WHERE l.site_id = held.site_id
        RETURNING l.site_id, l.epoch, l.expires_at
      )
      UPDATE turn_assignments t SET lease_epoch = lease.epoch,
        recovery_attempts = t.recovery_attempts + ${attempts}::int,
        runner_session = COALESCE(${checked.runnerSession}::uuid, t.runner_session),
        updated_at = clock_timestamp()
      FROM a, lease WHERE t.id = a.id AND lease.site_id = a.site_id
      RETURNING ${columns('t')}, lease.expires_at AS lease_expires_at`
    const assignment = assignments(raw)[0]
    if (!assignment) return null
    const { lease_expires_at: expiresAt } = takenSchema.parse(raw)[0]!
    return {
      assignment,
      grant: { ...assignment.fence, expiresAt, serverNow: assignment.serverNow },
    }
  }

  async countAttempt(input: { id: string; epoch: number }): Promise<boolean> {
    const checked = z.object({ id, epoch }).parse({ id: input.id, epoch: input.epoch })
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE turn_assignments SET recovery_attempts = recovery_attempts + 1,
        updated_at = clock_timestamp()
      WHERE id = ${checked.id}::uuid AND lease_epoch = ${checked.epoch} AND finished_at IS NULL
      RETURNING id`
    return rows.length === 1
  }

  async finish(input: {
    id: string
    epoch: number
    outcome: TurnAssignmentOutcome
  }): Promise<boolean> {
    const checked = z
      .object({ id, epoch, outcome: z.enum(turnAssignmentOutcomes) })
      .parse({ id: input.id, epoch: input.epoch, outcome: input.outcome })
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE turn_assignments SET finished_at = clock_timestamp(),
        outcome = ${checked.outcome}::"TurnAssignmentOutcome", updated_at = clock_timestamp()
      WHERE id = ${checked.id}::uuid AND lease_epoch = ${checked.epoch} AND finished_at IS NULL
      RETURNING id`
    return rows.length === 1
  }

  async freeOrphanedHolds(): Promise<number> {
    // A finished assignment never becomes unfinished, and no turn opens on a held site: the
    // subqueries cannot change their answer for a lease this statement locks.
    const rows = await this.db.$queryRaw<Array<{ site_id: string }>>`
      UPDATE site_leases lease SET holder_task_id = NULL, operation = NULL, acquired_at = NULL,
        expires_at = NULL, held_for_operator = false, updated_at = clock_timestamp()
      WHERE lease.held_for_operator AND lease.operation = 'turn'::"LeaseOperation"
        AND EXISTS (SELECT 1 FROM turn_assignments a
          WHERE a.site_id = lease.site_id AND a.task_id = lease.holder_task_id
            AND a.lease_epoch = lease.epoch AND a.finished_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM turn_assignments a
          WHERE a.site_id = lease.site_id AND a.task_id = lease.holder_task_id
            AND a.finished_at IS NULL)
      RETURNING lease.site_id`
    return rows.length
  }

  async unfinished(filter: { runnerId?: string } = {}): Promise<TurnAssignment[]> {
    const runnerId = runnerIdSchema.nullable().parse(filter.runnerId ?? null)
    return assignments(
      await this.db.$queryRaw`
      SELECT ${columns('a')} FROM turn_assignments a
      WHERE a.finished_at IS NULL AND (${runnerId}::text IS NULL OR a.runner_id = ${runnerId})
      ORDER BY a.created_at, a.id
      LIMIT 1000`,
    )
  }
}
