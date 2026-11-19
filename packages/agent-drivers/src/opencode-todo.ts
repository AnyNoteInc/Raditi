import {
  agentTodoLimits,
  feedText,
  hasVisibleText,
  type AgentEvent,
  type AgentTodoItem,
  type AgentTodoStatus,
} from '@repo/domain'

import { events, object, text, type JsonObject } from './jsonl.ts'

// What OpenCode's `todowrite` wrote, as the common event `todo_list` (docs/plan/89-agent-todos.md,
// §5.2, ТД3). Every call sends the agent's whole list, `{ todos: [{ content, status, priority }] }`;
// `status` is free text on the wire (the model is told four words, its schema has no enum), and
// an item has no id: its place in the list is what it is. This file knows the shape of the tool;
// its name stands here, at the branch of opencode-events.ts and in the permissions of opencode.ts.

const statusWords = new Map<string, AgentTodoStatus>([
  ['completed', 'completed'],
  ['complete', 'completed'],
  ['done', 'completed'],
  ['finished', 'completed'],
  ['in_progress', 'in_progress'],
  ['in-progress', 'in_progress'],
  ['active', 'in_progress'],
  // Still the agent's business: not done, and not to be skipped.
  ['blocked', 'in_progress'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['skipped', 'cancelled'],
])

/** Any other word, or none, is a step ahead: nothing is marked done that the agent did not say. */
const statusOf = (value: unknown): AgentTodoStatus =>
  (typeof value === 'string' ? statusWords.get(value.trim().toLowerCase()) : undefined) ?? 'pending'

/**
 * An item as the client reads it: the rules of the feed (no control, invisible or bidi
 * characters, masking markers in words), one line, within the limit. feedText goes first: it
 * drops U+0000 and half of a pair, where text() would put U+FFFD, and what it drops may leave
 * two spaces side by side. text() then cuts it, never between the halves of a pair.
 */
function itemText(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const line = feedText(value).replace(/\s+/gu, ' ').trim()
  if (!hasVisibleText(line)) return
  if (line.length <= agentTodoLimits.text) return line
  return `${text(line, agentTodoLimits.text - 1)!.trimEnd()}…`
}

function itemsOf(todos: readonly unknown[]): AgentTodoItem[] {
  return todos.flatMap((todo) => {
    const entry = object(todo)
    const shown = itemText(entry?.content)
    return shown === undefined ? [] : [{ text: shown, status: statusOf(entry?.status) }]
  })
}

/**
 * At most `agentTodoLimits.items`: completed items leave first, going from the head, then the
 * tail is cut — so the item at work stays in view. Once completed items are left out, the tail
 * holds none of them: what it counts is still to do, and a cancelled item there is no step.
 */
function bounded(items: AgentTodoItem[]) {
  const max = agentTodoLimits.items
  const excess = Math.max(0, items.length - max)
  let completed = 0
  const kept = items.filter((item) => {
    if (completed === excess || item.status !== 'completed') return true
    completed += 1
    return false
  })
  const other = kept.slice(max).filter((item) => item.status !== 'cancelled').length
  const omitted = (count: number) => Math.min(count, agentTodoLimits.omitted)
  return {
    items: kept.slice(0, max),
    ...(completed + other > 0
      ? { omitted: { completed: omitted(completed), other: omitted(other) } }
      : {}),
  }
}

/**
 * The event of a completed `todowrite` call: the list of its input, or of its metadata (the
 * CLI's copy) when the input holds none. [] when neither holds a list: the call is then read
 * as any other tool.
 */
export function todoListEvents(state: JsonObject): AgentEvent[] {
  const todos = [object(state.input)?.todos, object(state.metadata)?.todos].find((value) =>
    Array.isArray(value),
  )
  if (!Array.isArray(todos)) return []
  return events({ type: 'todo_list', ...bounded(itemsOf(todos)) })
}
