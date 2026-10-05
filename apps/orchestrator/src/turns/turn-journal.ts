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

/** Entries an owner may append for its own epoch after its lease expired or was held. */
const endings: readonly TurnPhase[] = ['failed', 'recovery', 'vacating']

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

/** Operational evidence and TaskTurn metadata. No task transitions, billing or dispatch. */
export class TaskEventTurnJournal implements TurnJournal {
  constructor(private readonly db: Pick<PrismaClient, '$queryRaw'>) {}

  async record(input: TurnEvidence): Promise<void> {
    const evidence = turnEvidenceSchema.parse(input)
    const payload = JSON.stringify(evidence)
    if (Buffer.byteLength(payload) > 1024 * 1024)
      throw badRequest('Turn evidence exceeds its limit')
    const { fence } = evidence
    let nativeSessionId = evidence.nativeSessionId
    for (const event of evidence.events ?? [])
      if (event.type === 'started' && event.nativeSessionId) nativeSessionId = event.nativeSessionId
    const recovery = endings.includes(evidence.phase)
    // A failed, held or vacating owner may append evidence for its own epoch, never for a newer
    // owner.
    // The fence check and append are one statement, not a check-then-write race.
    const rows = await this.db.$queryRaw<Array<{ id: bigint }>>`
      WITH owned_lease AS MATERIALIZED (
        SELECT site_id, expires_at, held_for_operator FROM site_leases
        WHERE site_id = ${fence.siteId}::uuid AND holder_task_id = ${fence.taskId}::uuid
          AND epoch = ${fence.epoch} AND operation = ${fence.operation}::"LeaseOperation"
        FOR UPDATE
      ), inserted AS (
      INSERT INTO task_events (task_id, turn_id, type, payload, client_visible)
      SELECT task.id, turn.id, ${evidence.phase === 'output' ? 'turn.output' : 'turn.lifecycle'},
        ${payload}::jsonb, false
      FROM tasks task
      JOIN owned_lease lease ON lease.site_id = task.site_id
      LEFT JOIN task_turns turn ON turn.task_id = task.id AND turn.turn_no = ${evidence.turn}
      WHERE task.id = ${fence.taskId}::uuid AND task.site_id = ${fence.siteId}::uuid
        AND (${recovery} OR (NOT lease.held_for_operator AND lease.expires_at > clock_timestamp()))
      RETURNING id, turn_id
      ), projected AS (
        UPDATE task_turns tt SET
          native_session_id = COALESCE(${nativeSessionId ?? null}::text, tt.native_session_id),
          head_sha = COALESCE(${evidence.candidateHeadSha ?? null}::text, tt.head_sha),
          snapshot_prefix = COALESCE(${evidence.snapshotPrefix ?? null}::text, tt.snapshot_prefix),
          model_id = COALESCE(tt.model_id, (SELECT k.model_id FROM llm_keys k
            JOIN turn_assignments a ON a.task_id = k.task_id AND a.turn_no = k.turn_no
              AND a.session_id = k.session_id AND a.first_epoch = k.first_epoch
            WHERE a.task_id = ${fence.taskId}::uuid AND a.turn_no = ${evidence.turn}
              AND a.session_id = ${evidence.sessionId} AND a.lease_epoch = ${fence.epoch}
            LIMIT 1))
        FROM inserted WHERE tt.id = inserted.turn_id AND tt.status = 'running'
        RETURNING tt.id
      ) SELECT id FROM inserted`
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
  /**
   * The last entry: `failed`, `recovery` or `vacating` when an owner ended the turn, held its
   * site or gave it up without proof that its container is gone.
   */
  lastPhase: TurnPhase | undefined
  /** The last step the turn reached, not counting those three. */
  step: TurnPhase | undefined
  /** Why the last `failed`, `recovery` or `vacating` entry ended the turn. */
  reason: JournaledEvidence['reason']
  /** An owner gave the turn up while its prepare was out (vacating): it ends `failed`. */
  vacating: boolean
  /** The outcome the last `failed` entry closes the assignment with. */
  outcome: JournaledEvidence['outcome']
  /** The highest sequence journaled: a recovered owner continues after it. */
  sequence: number
  containerId: string | undefined
  execId: string | undefined
  /** The durable output cursor: only whole lines, acknowledged with their events. */
  cursor: ExecCursor
  /** Every journaled agent event, across the epochs; its length is the attach eventCount. */
  events: AgentEvent[]
  candidateHeadSha: string | undefined
  /** The driver session: the last `started` event's, else the one the turn resumed. */
  nativeSessionId: string | undefined
}

/**
 * Sums a turn's journal up. Entries that contradict each other — another container or exec, an
 * output cursor that moved back — are a journal mismatch: CONFLICT, and the turn waits for an
 * operator.
 */
export function replayedTurn(entries: readonly JournaledEvidence[]): ReplayedTurn {
  const state: ReplayedTurn = {
    lastPhase: undefined,
    step: undefined,
    reason: undefined,
    vacating: false,
    outcome: undefined,
    sequence: 0,
    containerId: undefined,
    execId: undefined,
    cursor: { stdout: 0, stderr: 0 },
    events: [],
    candidateHeadSha: undefined,
    nativeSessionId: undefined,
  }
  const mismatch = () => conflict('Turn journal entries contradict each other')
  for (const entry of entries) {
    if (
      (entry.containerId && state.containerId && entry.containerId !== state.containerId) ||
      (entry.execId && state.execId && entry.execId !== state.execId)
    )
      throw mismatch()
    state.lastPhase = entry.phase
    if (entry.phase === 'vacating') state.vacating = true
    if (endings.includes(entry.phase)) {
      state.reason = entry.reason
      state.outcome = entry.outcome
    } else {
      state.step = entry.phase
      state.reason = undefined
      state.outcome = undefined
    }
    state.sequence = Math.max(state.sequence, entry.sequence)
    state.containerId = entry.containerId ?? state.containerId
    state.execId = entry.execId ?? state.execId
    state.candidateHeadSha = entry.candidateHeadSha ?? state.candidateHeadSha
    state.nativeSessionId = entry.nativeSessionId ?? state.nativeSessionId
    if (entry.phase === 'output' && entry.cursor) {
      if (entry.cursor.stdout < state.cursor.stdout || entry.cursor.stderr < state.cursor.stderr)
        throw mismatch()
      state.cursor = { ...entry.cursor }
      for (const event of entry.events ?? []) {
        state.events.push(event)
        if (event.type === 'started' && event.nativeSessionId)
          state.nativeSessionId = event.nativeSessionId
      }
    }
  }
  return state
}
