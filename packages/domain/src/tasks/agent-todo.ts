import { z } from 'zod'

import { hiddenContactText } from './client-feed-text.ts'

// The agent's plan of its work (docs/plan/89-agent-todos.md, ТД2, ТД5, ТД11): the list a driver
// reads from the agent's own to-do tool, carried as the common event `todo_list`, and what the
// chat shows of it. Every call of such a tool sends the whole list, and the last one wins — so
// do OpenCode `todowrite`, Claude Code `TodoWrite`, Codex `update_plan` and ACP `plan`. Pure: no
// input or output; the browser takes it as `@repo/domain/tasks/agent-todo`.

/** The four statuses of an item, as ACP v2 names them. A driver maps its own to these. */
export const agentTodoStatuses = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export type AgentTodoStatus = (typeof agentTodoStatuses)[number]

/**
 * Bounds of one list. Agent output is untrusted: a driver keeps a longer list or a longer item
 * within these before the event is validated (an event over them is dropped whole).
 */
export const agentTodoLimits = Object.freeze({
  items: 50,
  text: 300,
  /** Items a driver left out of one list over `items`. */
  omitted: 10_000,
})

export const agentTodoItemSchema = z.object({
  text: z.string().min(1).max(agentTodoLimits.text),
  status: z.enum(agentTodoStatuses),
})
export type AgentTodoItem = z.infer<typeof agentTodoItemSchema>

const omittedCount = z.number().int().min(0).max(agentTodoLimits.omitted)

/** The fields of the event `todo_list` after its `type` (agentEventSchema). */
export const agentTodoListShape = {
  /** The agent's whole list at this moment, in its order; [] — the agent keeps no list. */
  items: z.array(agentTodoItemSchema).max(agentTodoLimits.items),
  /**
   * Items the driver left out over the limit: completed ones from the head first, then the
   * rest from the tail — so the item at work stays in view. Cancelled ones of the tail are not
   * counted.
   */
  omitted: z.object({ completed: omittedCount, other: omittedCount }).optional(),
}
export const agentTodoListSchema = z.object(agentTodoListShape)
export type AgentTodoList = z.infer<typeof agentTodoListSchema>

/**
 * A list of fewer steps is no plan to show: a single step says nothing of progress (ТД5). Steps
 * are the items not cancelled; a list the agent cancelled whole is shown as such while it has as
 * many items.
 */
export const TODO_MIN_ITEMS = 2

export interface TodoProgress {
  /** Completed items, the left-out ones among them. */
  done: number
  /** Items not cancelled, the left-out ones among them: what «из N» counts. */
  total: number
  /** The index in `items` of the item at work — the first `in_progress` — or null. */
  current: number | null
  /** Every item of the list is cancelled. */
  abandoned: boolean
}

export function todoProgressOf(list: AgentTodoList): TodoProgress {
  const omitted = list.omitted ?? { completed: 0, other: 0 }
  const done = list.items.filter((item) => item.status === 'completed').length + omitted.completed
  const kept = list.items.filter((item) => item.status !== 'cancelled').length
  const total = kept + omitted.completed + omitted.other
  const current = list.items.findIndex((item) => item.status === 'in_progress')
  return {
    done,
    total,
    current: current < 0 ? null : current,
    abandoned: list.items.length > 0 && total === 0,
  }
}

/** Every item the list has, shown or left out. */
export const todoItemCount = (list: AgentTodoList): number =>
  list.items.length + (list.omitted?.completed ?? 0) + (list.omitted?.other ?? 0)

/** Something of the list is still to do: an item ahead, at work, or left out of the tail. */
export const todoUnfinished = (list: AgentTodoList): boolean =>
  (list.omitted?.other ?? 0) > 0 ||
  list.items.some((item) => item.status === 'pending' || item.status === 'in_progress')

const cyrillic = /\p{Script=Cyrillic}/u

/**
 * Russian words the platform itself puts into the agent's text: the mask of a variable's value
 * (ENV_VALUE_MASK of workspace-env/env-masking.ts, kept here as a literal so the browser module stays
 * small — a test holds the two equal) and the words in place of a hidden contact.
 */
export const todoPlatformWords: readonly string[] = Object.freeze([
  '[скрыто]',
  ...Object.values(hiddenContactText),
])

const agentWords = (text: string): string =>
  todoPlatformWords.reduce((rest, word) => rest.replaceAll(word, ''), text)

/**
 * Whether the agent wrote the list in Russian: false when no item holds a Cyrillic letter of its
 * own — the platform's words (todoPlatformWords) do not count. Such a list is shown by its count
 * alone (rule 10, ТД11) — judged over the whole list, not item by item: «Шаг 1, Шаг 2…» in place
 * of single items would tell the client nothing.
 */
export const todoListReadsRussian = (items: readonly AgentTodoItem[]): boolean =>
  items.some((item) => cyrillic.test(agentWords(item.text)))

/** What tells two snapshots of one turn apart for the client: the count and the item at work. */
export function todoStepKey(list: AgentTodoList): string {
  const progress = todoProgressOf(list)
  const current = progress.current === null ? '' : list.items[progress.current]!.text
  return `${progress.done}/${progress.total}:${current}`
}

/** The statuses of a turn (enum TurnStatus of the database). */
export const todoTurnStatuses = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
] as const
export type TodoTurnStatus = (typeof todoTurnStatuses)[number]

/** One counted turn of a chat (not undone) and the last list it wrote, if any. */
export interface TurnTodoFacts {
  turn: number
  status: TodoTurnStatus
  /** The platform refused the result of the turn (`task_turns.rejected_at`): never continued. */
  rejected: boolean
  /**
   * The turn ended with the agent's answer to the client (a `feed.result` row of the turn), not
   * a question, a request for help or a failure (ТД17).
   */
  answered?: boolean
  list: AgentTodoList | null
}

/**
 * The list as the end of its turn left it (ТД17, owner's answer of 20.11.2026): a turn that
 * completed with the agent's answer did its work — the answer says so —, so the items the model
 * forgot to close are done; the tail it left out is counted done too. A stop, a failure, a refused
 * result and a question keep the list as the agent wrote it: unfinished is never shown as done
 * there (§3, «Конец работы»).
 */
export function todoListAtEnd(facts: TurnTodoFacts): AgentTodoList | null {
  const list = facts.list
  if (list === null || facts.status !== 'completed' || facts.rejected || facts.answered !== true)
    return list
  if (!todoUnfinished(list)) return list
  const items = list.items.map((item) =>
    item.status === 'pending' || item.status === 'in_progress'
      ? { ...item, status: 'completed' as const }
      : item,
  )
  const omitted = list.omitted
  return omitted === undefined
    ? { items }
    : { items, omitted: { completed: omitted.completed + omitted.other, other: 0 } }
}

/**
 * What the card of the plan shows:
 * - `working` — the turn at work wrote this list;
 * - `carried` — the turn at work has written none yet, and the list is the unfinished one of the
 *   turn before, which ended well: the agent goes on in the same session;
 * - `ended` — the last turn ended with an answer;
 * - `stopped` — the client stopped it;
 * - `failed` — it broke off, or the platform refused its result.
 */
export const chatTodoStates = ['working', 'carried', 'ended', 'stopped', 'failed'] as const
export type ChatTodoState = (typeof chatTodoStates)[number]

export const chatTodoSchema = z.strictObject({
  turn: z.number().int().min(1),
  state: z.enum(chatTodoStates),
  items: z.array(z.strictObject(agentTodoItemSchema.shape)).max(agentTodoLimits.items),
  omitted: z.strictObject({ completed: omittedCount, other: omittedCount }).optional(),
})
export type ChatTodo = z.infer<typeof chatTodoSchema>

const atWork = (status: TodoTurnStatus) => status === 'pending' || status === 'running'

function stateOf(facts: TurnTodoFacts): ChatTodoState {
  if (atWork(facts.status)) return 'working'
  if (facts.rejected) return 'failed'
  switch (facts.status) {
    case 'completed':
      return 'ended'
    case 'cancelled':
      return 'stopped'
    default:
      return 'failed'
  }
}

function shown(turn: number, state: ChatTodoState, list: AgentTodoList): ChatTodo | null {
  const progress = todoProgressOf(list)
  if (todoItemCount(list) < TODO_MIN_ITEMS) return null
  if (progress.total < TODO_MIN_ITEMS && !progress.abandoned) return null
  return { turn, state, items: list.items, ...(list.omitted ? { omitted: list.omitted } : {}) }
}

/**
 * The plan of a chat from its last two counted turns, newest first (ТД5). The last turn decides:
 * a turn that ended without a list takes away the list of the turn before — an unfinished list
 * the model never closed does not come back (OpenCode desktop clears such a list too). The one
 * exception is `carried`, while a turn is at work and has written no list yet.
 */
export function chatTodoOf(
  latest: TurnTodoFacts | null,
  previous: TurnTodoFacts | null,
): ChatTodo | null {
  if (latest === null) return null
  const latestList = todoListAtEnd(latest)
  if (latestList !== null && latestList.items.length > 0)
    return shown(latest.turn, stateOf(latest), latestList)
  // A list the turn emptied itself is no list; one it never wrote may be carried over.
  if (latestList !== null || !atWork(latest.status)) return null
  // A plan the turn before closed with its answer is not carried on (ТД17).
  const previousList = previous === null ? null : todoListAtEnd(previous)
  if (
    previous === null ||
    previous.status !== 'completed' ||
    previous.rejected ||
    previousList === null ||
    !todoUnfinished(previousList)
  )
    return null
  return shown(previous.turn, 'carried', previousList)
}
