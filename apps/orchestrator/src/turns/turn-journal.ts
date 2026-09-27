import { Buffer } from 'node:buffer'

import type { PrismaClient } from '@repo/db'
import {
  badRequest,
  leaseLost,
  turnEvidenceSchema,
  type TurnEvidence,
  type TurnJournal,
} from '@repo/domain'

/** Operational evidence only. It does not transition tasks, bill customers or dispatch jobs. */
export class TaskEventTurnJournal implements TurnJournal {
  constructor(private readonly db: Pick<PrismaClient, '$queryRaw'>) {}

  async record(input: TurnEvidence): Promise<void> {
    const evidence = turnEvidenceSchema.parse(input)
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
    // Fence lost, not an outage: a failed statement rejects with its own database error.
    if (rows.length !== 1) throw leaseLost('Turn evidence no longer owns its site lease')
  }
}
