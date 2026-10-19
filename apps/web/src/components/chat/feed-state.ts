import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { DialogFeed, FeedRow } from './chat-types'

// The state of a dialog's screen between two reads of `task.feed` (feed design, «Чтение по
// идентификатору»; plan 53, R9). Pure: the hook that polls only dispatches answers and failures
// and asks `pollDelay` when to read again.

/** Everything of an answer but its rows: the head, the preview, the candidate, the commands. */
export type FeedHeadState = Omit<DialogFeed, 'events' | 'cursor' | 'more'>

export interface FeedState {
  /** The head of the latest answer; null before the first. */
  head: FeedHeadState | null
  /** Rows by id, in the order of their ids. A row once read is never dropped. */
  rows: FeedRow[]
  /** What the next read asks for: rows after this id. */
  cursor: string
  /** Reads that failed in a row; what is on the screen stays. */
  failures: number
  /** The server answered that there is no such dialog: reading stops. */
  missing: boolean
  /** The next read is due at once: a page of rows is left, or the status changed. */
  now: boolean
}

export const initialFeedState: FeedState = Object.freeze({
  head: null,
  rows: [],
  cursor: '0',
  failures: 0,
  missing: false,
  now: true,
}) as FeedState

export type FeedAction =
  { type: 'answer'; answer: DialogFeed; after: string } | { type: 'failed'; notFound: boolean }

/** Ids are bigints as strings of digits without leading zeros: a longer one is larger. */
export function compareRowIds(first: string, second: string): number {
  if (first.length !== second.length) return first.length - second.length
  return first < second ? -1 : first > second ? 1 : 0
}

/** Rows of both by id; a row read again replaces the copy read before. */
export function mergeRows(known: readonly FeedRow[], read: readonly FeedRow[]): FeedRow[] {
  if (read.length === 0) return known as FeedRow[]
  const byId = new Map(known.map((row) => [row.id, row]))
  for (const row of read) byId.set(row.id, row)
  return [...byId.values()].sort((first, second) => compareRowIds(first.id, second.id))
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  if (action.type === 'failed') {
    return {
      ...state,
      failures: action.notFound ? state.failures : state.failures + 1,
      missing: action.notFound,
      now: false,
    }
  }
  const { answer, after } = action
  const { events, cursor, more, ...head } = answer
  // A status changed between two reads: the rows of the dialog are read again from the start,
  // so the screen is drawn from one consistent history of the new status.
  const reread =
    after !== '0' && state.head !== null && state.head.task.status !== answer.task.status
  // A read that started from a cursor the state has left since — a read from the start was
  // asked for meanwhile — gives its rows and its head, never its cursor: the read from the
  // start is not lost to it.
  const current = after === state.cursor
  return {
    head,
    rows: mergeRows(state.rows, events),
    cursor: reread ? '0' : current ? cursor : state.cursor,
    failures: 0,
    missing: false,
    now: reread || (current ? more : state.now),
  }
}

/** How often a dialog is read: while someone works on it, while it waits for the client. */
export const feedPolling = Object.freeze({ working: 2_000, waiting: 15_000, max: 30_000 })

const WORKING = new Set(['queued', 'preparing', 'running', 'deploying', 'verifying'])
const BUILDING = new Set(['pending', 'building'])

/** The undo of the dialog's release goes on (docs/plan/53, «Отмена выпуска»). */
export const undoing = (head: FeedHeadState): boolean =>
  head.undo?.run !== undefined && head.undo.run !== null && head.undo.run.outcome === null

/**
 * Milliseconds until the next read; null — no more reads: the dialog has ended (and no undo of its
 * release goes on), or there is no such dialog. 2 s while the agent, a release, an undo or the
 * preview is at work, 15 s while the dialog waits for the client; after a failed read the pause
 * doubles, up to 30 s. A hidden page is not read at all — the hook waits for it to be shown again.
 */
export function pollDelay(state: FeedState): number | null {
  if (state.missing) return null
  if (state.now && state.failures === 0) return 0
  const head = state.head
  if (head !== null && terminalTaskStatuses.includes(head.task.status) && !undoing(head))
    return null
  const busy =
    head === null ||
    WORKING.has(head.task.status) ||
    undoing(head) ||
    (head.preview !== null && BUILDING.has(head.preview.status))
  const base = busy ? feedPolling.working : feedPolling.waiting
  return Math.min(base * 2 ** state.failures, feedPolling.max)
}

/** Three failed reads in a row: the screen offers to read again by hand. */
export const showsRefresh = (state: FeedState): boolean => state.failures >= 3
