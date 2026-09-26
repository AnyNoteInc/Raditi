import { Buffer } from 'node:buffer'

import type { PrismaClient } from '@repo/db'
import {
  agentEventSchema,
  badRequest,
  conflict,
  turnPhases,
  turnResultSchema,
  type TurnEvidence,
  type TurnJournal,
} from '@repo/domain'
import { z } from 'zod'

const id = z.uuid()
const textId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const evidenceSchema = z
  .object({
    fence: z.object({
      siteId: id,
      taskId: id,
      operation: z.enum(['turn', 'deploy', 'revert']),
      epoch: z.number().int().positive(),
    }),
    sessionId: textId,
    turn: z.number().int().positive().max(999_999),
    sequence: z.number().int().positive().max(1_000_000),
    phase: z.enum(turnPhases),
    containerId: textId.optional(),
    execId: textId.optional(),
    cursor: z
      .object({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() })
      .optional(),
    events: z.array(agentEventSchema).max(10_000).optional(),
    snapshotPrefix: z
      .string()
      .max(256)
      .regex(/^sessions\/[A-Za-z0-9_-]+\/turns\/[0-9]+\/$/)
      .optional(),
    candidateHeadSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
    baseSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
    committedAt: z.iso.datetime().optional(),
    recoveredFromEpoch: z.number().int().positive().optional(),
    result: turnResultSchema.optional(),
    reason: z
      .enum([
        'cancelled',
        'timeout',
        'lease_lost',
        'run_failed',
        'snapshot_ambiguous',
        'publication_ambiguous',
        'destroy_failed',
        'journal_failed',
      ])
      .optional(),
  })
  .strict()

/** Operational evidence only. It does not transition tasks, bill customers or dispatch jobs. */
export class TaskEventTurnJournal implements TurnJournal {
  constructor(private readonly db: Pick<PrismaClient, '$queryRaw'>) {}

  async record(input: TurnEvidence): Promise<void> {
    const evidence = evidenceSchema.parse(input)
    const payload = JSON.stringify(evidence)
    if (Buffer.byteLength(payload) > 1024 * 1024)
      throw badRequest('Turn evidence exceeds its limit')
    const { fence } = evidence
    const recovery = evidence.phase === 'recovery' || evidence.phase === 'failed'
    // A failed/held owner may append evidence for its own epoch, never for a newer owner.
    // The fence check and append are one statement, not a check-then-write race.
    const rows = await this.db.$queryRaw<Array<{ id: bigint }>>`
      WITH owned_lease AS MATERIALIZED (
        SELECT site_id, expires_at, held_for_operator FROM site_leases
        WHERE site_id = ${fence.siteId}::uuid AND holder_task_id = ${fence.taskId}::uuid
          AND epoch = ${fence.epoch} AND operation = ${fence.operation}::"LeaseOperation"
        FOR UPDATE
      )
      INSERT INTO task_events (task_id, turn_id, type, payload, client_visible)
      SELECT task.id, turn.id, ${evidence.phase === 'output' ? 'turn.output' : 'turn.lifecycle'},
        ${payload}::jsonb, false
      FROM tasks task
      JOIN owned_lease lease ON lease.site_id = task.site_id
      LEFT JOIN task_turns turn ON turn.task_id = task.id AND turn.turn_no = ${evidence.turn}
      WHERE task.id = ${fence.taskId}::uuid AND task.site_id = ${fence.siteId}::uuid
        AND (${recovery} OR (NOT lease.held_for_operator AND lease.expires_at > clock_timestamp()))
      RETURNING id`
    if (rows.length !== 1) throw conflict('Turn evidence no longer owns its site lease')
  }
}
