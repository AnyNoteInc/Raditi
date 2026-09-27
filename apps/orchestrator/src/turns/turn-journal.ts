import { Buffer } from 'node:buffer'

import type { PrismaClient } from '@repo/db'
import {
  badRequest,
  conflict,
  leaseLost,
  turnEvidenceSchema,
  type AgentEvent,
  type ExecCursor,
  type TurnEvidence,
  type TurnJournal,
  type TurnPhase,
} from '@repo/domain'
import { z } from 'zod'

/** Evidence as the journal holds it: parsed, with the fence reduced to its four fields. */
export type JournaledEvidence = z.output<typeof turnEvidenceSchema>

/** One turn's journal across the lease epochs of its assignment (TurnAssignment). */
export interface TurnJournalRange {
  siteId: string
  taskId: string
  sessionId: string
  turn: number
  /** firstEpoch…fence.epoch of the assignment, both included. */
  fromEpoch: number
  toEpoch: number
}

const REPLAY_PAGE = 500
const rangeSchema = z.object({
  siteId: z.uuid(),
  taskId: z.uuid(),
  sessionId: z.string().min(1).max(200),
  turn: z.number().int().positive().max(999_999),
  fromEpoch: z.number().int().positive(),
  toEpoch: z.number().int().positive(),
})

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

  /**
   * The turn's evidence over an epoch range, in the order it was written (task_events.id), for
   * recovery. An entry that no longer passes its schema is a journal mismatch: CONFLICT, and
   * the turn waits for an operator.
   */
  async replay(input: TurnJournalRange): Promise<JournaledEvidence[]> {
    const range = rangeSchema.parse(input)
    if (range.toEpoch < range.fromEpoch) throw badRequest('Invalid turn journal range')
    const entries: JournaledEvidence[] = []
    let after = 0n
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: bigint; payload: unknown }>>`
        SELECT id, payload FROM task_events
        WHERE task_id = ${range.taskId}::uuid AND type IN ('turn.lifecycle', 'turn.output')
          AND id > ${after}
          AND payload->'fence'->>'siteId' = ${range.siteId}
          AND payload->>'sessionId' = ${range.sessionId}
          AND payload->>'turn' = ${String(range.turn)}
          AND (payload->'fence'->>'epoch')::int BETWEEN ${range.fromEpoch} AND ${range.toEpoch}
        ORDER BY id
        LIMIT ${REPLAY_PAGE}`
      for (const row of rows) {
        const parsed = turnEvidenceSchema.safeParse(row.payload)
        if (!parsed.success) throw conflict('Turn journal entry does not match its schema')
        entries.push(parsed.data)
      }
      if (rows.length < REPLAY_PAGE) return entries
      after = rows.at(-1)!.id
    }
  }
}

/** What recovery needs from a replayed journal: the last step and where the agent's output ended. */
export interface ReplayedTurn {
  lastPhase: TurnPhase | undefined
  containerId: string | undefined
  execId: string | undefined
  /** The durable output cursor: only whole lines, acknowledged with their events. */
  cursor: ExecCursor
  /** Every journaled agent event, across the epochs; its length is the attach eventCount. */
  events: AgentEvent[]
  candidateHeadSha: string | undefined
}

export function replayedTurn(entries: readonly JournaledEvidence[]): ReplayedTurn {
  const state: ReplayedTurn = {
    lastPhase: undefined,
    containerId: undefined,
    execId: undefined,
    cursor: { stdout: 0, stderr: 0 },
    events: [],
    candidateHeadSha: undefined,
  }
  for (const entry of entries) {
    state.lastPhase = entry.phase
    state.containerId = entry.containerId ?? state.containerId
    state.execId = entry.execId ?? state.execId
    state.candidateHeadSha = entry.candidateHeadSha ?? state.candidateHeadSha
    if (entry.phase === 'output' && entry.cursor) {
      state.cursor = { ...entry.cursor }
      state.events.push(...(entry.events ?? []))
    }
  }
  return state
}
