import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { DialogFeed, FeedRow } from './chat-types'

// The state of a dialog's screen between two reads of `task.feed` (feed design, «Чтение по
// идентификатору»; plan 53, R9). Pure: the hook that polls only dispatches answers and failures
// and asks `pollDelay` when to read again.

/** Everything of an answer but its rows: the head, the browser, the commands. */
export type FeedHeadState = Omit<DialogFeed, 'events' | 'cursor' | 'more'>

export interface FeedState {
  /** The head of the latest answer; null before the first. */
  head: FeedHeadState | null
  /** Rows by id, in the order of their ids. A row once read is never dropped. */
  rows: FeedRow[]
  /**
   * What the next read asks for: rows after this id, and the rows of transactions the last read
   * could not see (`feedReadCursorSchema`): a row that commits late is never skipped, so a new
   * status needs no read from the start.
   */
  cursor: string
  /** Reads that failed in a row; what is on the screen stays. */
  failures: number
  /** The server answered that there is no such dialog: reading stops. */
  missing: boolean
  /** The next read is due at once: a page of rows is left. */
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

/**
 * Rows of both by id, in one pass over each; a row read again replaces the copy read before.
 * `known` is in the order of its ids, as every state keeps it; `read` is put in that order first.
 */
export function mergeRows(known: readonly FeedRow[], read: readonly FeedRow[]): FeedRow[] {
  if (read.length === 0) return known as FeedRow[]
  const incoming = [...read].sort((first, second) => compareRowIds(first.id, second.id))
  const last = known.at(-1)
  // The usual answer: rows after the last one known.
  if (last === undefined || compareRowIds(incoming[0]!.id, last.id) > 0) {
    const merged = [...known]
    for (const row of incoming)
      if (merged.length === 0 || compareRowIds(row.id, merged.at(-1)!.id) > 0) merged.push(row)
      else merged[merged.length - 1] = row
    return merged
  }
  const merged: FeedRow[] = []
  let at = 0
  for (const row of incoming) {
    while (at < known.length && compareRowIds(known[at]!.id, row.id) < 0) merged.push(known[at++]!)
    if (at < known.length && known[at]!.id === row.id) at += 1
    if (merged.at(-1)?.id === row.id) merged[merged.length - 1] = row
    else merged.push(row)
  }
  while (at < known.length) merged.push(known[at++]!)
  return merged
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
  // Rows that commit late come with the next read whatever their ids (the cursor names what the
  // read could not see), so a new status reads nothing again. A cursor of '0' is the server
  // starting the reader over (more late rows than a page): every row comes from the first one on,
  // page by page, and replaces its copy. A read that started from a cursor the state has left
  // since gives its rows and its head, never its cursor: the reads after the newer cursor are not
  // lost to it.
  const current = after === state.cursor
  return {
    head,
    rows: mergeRows(state.rows, events),
    cursor: current ? cursor : state.cursor,
    failures: 0,
    missing: false,
    now: current ? more : state.now,
  }
}

/** How often a dialog is read: while someone works on it, while it waits for the client. */
export const feedPolling = Object.freeze({
  working: 2_000,
  waiting: 15_000,
  max: 30_000,
  /** «Ход работы» of a live turn: what the agent is writing now comes about this often. */
  activity: 1_000,
})

const WORKING = new Set(['queued', 'preparing', 'running', 'deploying', 'verifying'])
const LIVE_BROWSER = new Set(['starting', 'ready'])

/**
 * Milliseconds until the next read; null — no more reads: the chat has ended, or there is no such
 * chat. 2 s while the agent is at work or the chat's browser is open, 15 s while the chat waits
 * for the client; after a failed read the pause doubles, up to 30 s. A hidden page is not read at all — the hook waits for it to be shown again.
 */
export function pollDelay(state: FeedState): number | null {
  if (state.missing) return null
  if (state.now && state.failures === 0) return 0
  const head = state.head
  if (head !== null && terminalTaskStatuses.includes(head.task.status)) return null
  const busy =
    head === null ||
    WORKING.has(head.task.status) ||
    // An open browser (docs/plan/57-browser-tasks.md): who drives it and what the agent asks
    // there change while the dialog waits.
    (head.browser !== null && LIVE_BROWSER.has(head.browser.status))
  const base = busy ? feedPolling.working : feedPolling.waiting
  return Math.min(base * 2 ** state.failures, feedPolling.max)
}

/** Three failed reads in a row: the screen offers to read again by hand. */
export const showsRefresh = (state: FeedState): boolean => state.failures >= 3
