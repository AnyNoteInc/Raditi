import { agentEventSchema, type AgentTodoList, type TurnTodoFacts } from '@repo/domain'

import type { PrismaClient, TurnStatus } from './generated/prisma/client.ts'

// The agent's plan of its work beside the chat (docs/plan/89-agent-todos.md, ТД4, §5.3). The list
// has no state of its own: it is the last `todo_list` event the agent wrote in the journal of a
// turn. A turn undone by `/undo` is not counted, so `/undo` and `/redo` move the plan with no code
// of their own. What the card shows of these facts is the domain's (`chatTodoOf`).

/** The last two counted turns of a chat, newest first, with the last list each wrote. */
export interface ChatTodoTurns {
  latest: TurnTodoFacts | null
  previous: TurnTodoFacts | null
}

interface TurnRow {
  turn_no: number
  status: TurnStatus
  rejected: boolean
  /** The last `todo_list` event of the newest journal row of the turn that holds one. */
  list: unknown
}

/** An event that no longer reads is no list: the card does not show what it cannot check. */
function listOf(raw: unknown): AgentTodoList | null {
  if (raw === null) return null
  const parsed = agentEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type !== 'todo_list') return null
  const { items, omitted } = parsed.data
  return omitted === undefined ? { items } : { items, omitted }
}

// The predicate of the journal rows is the one of task_events_todo_list_idx word for word (its
// constants inline, never parameters), so the planner reads the newest row of a turn from that
// index; of that row only its last `todo_list` event leaves the database, never the whole batch.
/** The plan's facts of a chat. The caller has checked that the user may read the chat. */
export async function readChatTodo(
  db: Pick<PrismaClient, '$queryRaw'>,
  taskId: string,
): Promise<ChatTodoTurns> {
  const rows = await db.$queryRaw<TurnRow[]>`
    WITH recent AS (
      SELECT id, turn_no, status, rejected_at FROM task_turns
      WHERE task_id = ${taskId}::uuid AND undone_at IS NULL
      ORDER BY turn_no DESC LIMIT 2)
    SELECT r.turn_no, r.status::text AS status, r.rejected_at IS NOT NULL AS rejected, e.list
    FROM recent r LEFT JOIN LATERAL (
      SELECT (SELECT a.ev FROM jsonb_array_elements(t.payload->'events') WITH ORDINALITY a(ev, n)
              WHERE a.ev->>'type' = 'todo_list' ORDER BY a.n DESC LIMIT 1) AS list
      FROM task_events t
      WHERE t.turn_id = r.id
        AND t.type::text = 'turn.output'::text
        AND t.payload @> '{"events": [{"type": "todo_list"}]}'::jsonb
      ORDER BY t.id DESC LIMIT 1) e ON true
    ORDER BY r.turn_no DESC`
  const [latest, previous] = rows.map((row): TurnTodoFacts => ({
    turn: row.turn_no,
    // TurnStatus of the database is exactly todoTurnStatuses (enums.test.ts).
    status: row.status,
    rejected: row.rejected,
    list: listOf(row.list),
  }))
  return { latest: latest ?? null, previous: previous ?? null }
}
