import type { PrismaClient } from '@repo/db'
import { agentEventSchema, agentOutputLimits, type AgentEvent } from '@repo/domain'
import { z } from 'zod'

import { accessibleTask, taskNotFound } from './access.ts'

// The work of the agent as it goes (owner's decision of 26.10.2026: «при работе агента выводи
// всю информацию, все что он выводит»): what the agent wrote, ran and changed in one turn of a
// dialog, from the journal rows `turn.output` core wrote — after `maskTurnEvents`, so a value of
// the client's variables never is in them. The rows stay out of the feed (`client_visible` is
// false); this is their only reader for the page. A `failed` event's reason is raw CLI or
// provider text and never shown (spec §8), and `started`, `usage` and `completed` say nothing to
// the client. The turn's final message is its result object: the dialog shows it as its answer.

/**
 * An answer ends after the row that reaches one of these: rows, events, or UTF-16 units of the
 * events' text. A row is given whole, and a journal row is at most 1 MiB (TaskEventTurnJournal).
 */
export const activityLimits = Object.freeze({ rows: 40, events: 400, text: 256 * 1024 })

const shownEvent = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message'),
    text: z.string().max(agentOutputLimits.messageText),
  }),
  z.strictObject({
    type: z.literal('command'),
    command: z.string().max(agentOutputLimits.command),
    exitCode: z.number().int().nullable(),
  }),
  z.strictObject({
    type: z.literal('file_change'),
    path: z.string().max(agentOutputLimits.path),
    change: z.enum(['add', 'update', 'delete']),
  }),
  z.strictObject({
    type: z.literal('tool_call'),
    tool: z.string().max(agentOutputLimits.tool),
    ok: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('question'),
    text: z.string().max(agentOutputLimits.questionText),
    options: z.array(z.string().max(agentOutputLimits.questionOption)),
  }),
])

/** One event of the agent's work as the page shows it; `id` — `<row id>:<index in the row>`. */
export const activityEventSchema = z.intersection(
  z.strictObject({ id: z.string().regex(/^[1-9]\d{0,18}:\d{1,5}$/) }),
  shownEvent,
)
export type ActivityEvent = z.output<typeof activityEventSchema>

export interface TurnActivity {
  events: ActivityEvent[]
  /** The id of the last journal row read, or the `after` of the request. */
  cursor: string
  more: boolean
}

/** The turn's answer: the object the platform reads as its result, not words to show again. */
const RESULT_KEY = '"client_message"'

/** What of one event the page shows; null — nothing. */
export function shownActivity(event: AgentEvent): z.output<typeof shownEvent> | null {
  switch (event.type) {
    case 'message':
      return event.text.trim() === '' || event.text.includes(RESULT_KEY)
        ? null
        : { type: 'message', text: event.text }
    case 'command':
      return { type: 'command', command: event.command, exitCode: event.exitCode }
    case 'file_change':
      return { type: 'file_change', path: event.path, change: event.change }
    case 'tool_call':
      return { type: 'tool_call', tool: event.tool, ok: event.ok }
    case 'question':
      return { type: 'question', text: event.text, options: [...event.options] }
    case 'started':
    case 'usage':
    case 'completed':
    case 'failed':
      return null
  }
}

const textOf = (event: z.output<typeof shownEvent>): number => {
  switch (event.type) {
    case 'message':
      return event.text.length
    case 'command':
      return event.command.length
    case 'file_change':
      return event.path.length
    case 'tool_call':
      return event.tool.length
    case 'question':
      return event.text.length + event.options.reduce((sum, option) => sum + option.length, 0)
  }
}

/**
 * `task.activity`: the agent's events of one turn after the cursor, for a member of the task's
 * workspace. A row or an event that no longer reads is passed over; the cursor still moves past
 * it.
 */
export async function readTurnActivity(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  input: { userId: string; taskId: string; turn: number; after: string },
): Promise<TurnActivity> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (task === null) throw taskNotFound()
  const rows = await db.taskEvent.findMany({
    where: {
      taskId: task.id,
      type: 'turn.output',
      id: { gt: BigInt(input.after) },
      payload: { path: ['turn'], equals: input.turn },
    },
    orderBy: { id: 'asc' },
    take: activityLimits.rows + 1,
    select: { id: true, payload: true },
  })
  let more = rows.length > activityLimits.rows
  const events: ActivityEvent[] = []
  let cursor = input.after
  let text = 0
  for (const row of rows.slice(0, activityLimits.rows)) {
    // A row is given whole: once a page holds enough, the next row waits for the next page.
    if (events.length >= activityLimits.events || text >= activityLimits.text) {
      more = true
      break
    }
    cursor = String(row.id)
    const payload = row.payload as { events?: unknown } | null
    const list = Array.isArray(payload?.events) ? payload.events : []
    list.forEach((raw, index) => {
      const parsed = agentEventSchema.safeParse(raw)
      const shown = parsed.success ? shownActivity(parsed.data) : null
      if (shown === null) return
      events.push({ id: `${row.id}:${index}`, ...shown })
      text += textOf(shown)
    })
  }
  return { events, cursor, more }
}
