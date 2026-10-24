import type { TaskStatus } from '@repo/domain'
import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { FeedHeadState } from './feed-state'
import type { FeedRow } from './chat-types'

// How the rows of a dialog become what its screen draws (feed design, «Экраны, которых нет на
// макетах»). Pure: the components only draw what these functions decide.

export type StepRow = Extract<FeedRow, { type: 'feed.step' }>
export type QuestionRow = Extract<FeedRow, { type: 'feed.question' }>
export type CandidateRow = Extract<FeedRow, { type: 'feed.candidate' }>
export type ResultRow = Extract<FeedRow, { type: 'feed.result' }>
export type FailureRow = Extract<FeedRow, { type: 'feed.failure' }>

export type FeedEntry =
  | { kind: 'row'; key: string; row: FeedRow }
  /** The stages of a finished turn, folded into «Агент работал …». */
  | { kind: 'worked'; key: string; turn: number; steps: StepRow[]; seconds: number }

/** The statuses whose stages the live block shows instead of the feed. */
const LIVE: readonly TaskStatus[] = ['preparing', 'running']

/** A press or words of the client that move the dialog on: an answer closes a question. */
function movesOn(row: FeedRow): boolean {
  return row.type === 'feed.request' && row.kind !== 'command'
}

const isStep = (row: FeedRow): row is StepRow => row.type === 'feed.step'

/** The feed shows a press of the browser with this id: the server has taken it. */
export function requestShown(rows: readonly FeedRow[], requestId: string): boolean {
  const id = requestId.toLowerCase()
  return rows.some(
    (row) => row.type === 'feed.request' && row.kind !== 'other' && row.requestId === id,
  )
}

/**
 * The client asked to stop a pass that is under way: `/cancel` was taken while the agent works,
 * and core has not ended the dialog yet. A dialog that waits is closed at once, so a press of
 * `/cancel` in a dialog that has not ended is a pass being stopped.
 *
 * A task in the browser (`browser`, docs/plan/57-browser-tasks.md, Б24) is stopped by core in any
 * status — waiting for the client too: until then the newest press, other commands aside, is
 * `/cancel`, as the server reads it (`cancelPending`), and the task takes nothing else.
 */
export function stopRequested(
  rows: readonly FeedRow[],
  status: TaskStatus | undefined,
  browser = false,
): boolean {
  if (status === undefined || terminalTaskStatuses.includes(status)) return false
  if (browser) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!
      if (row.type !== 'feed.request') continue
      if (row.kind !== 'command') return false
      if (row.command === 'cancel') return true
    }
    return false
  }
  if (status !== 'queued' && status !== 'preparing' && status !== 'running') return false
  return rows.some(
    (row) => row.type === 'feed.request' && row.kind === 'command' && row.command === 'cancel',
  )
}

/**
 * The entries of the feed: every row as it is, except the stages. The stages of a turn are
 * folded into one line at the place of its first stage, with the time the turn worked — from the
 * first stage to the row that ended the turn. The stages of the turn at work stay in the live
 * block and are not repeated here. A stage the reader does not know (`skipped`) is left out.
 */
export function feedEntries(rows: readonly FeedRow[], head: FeedHeadState | null): FeedEntry[] {
  const liveTurn = head !== null && LIVE.includes(head.task.status) ? head.task.turnNo : Number.NaN
  const byTurn = new Map<number, StepRow[]>()
  for (const row of rows) {
    if (!isStep(row)) continue
    const steps = byTurn.get(row.turn) ?? []
    steps.push(row)
    byTurn.set(row.turn, steps)
  }
  const entries: FeedEntry[] = []
  const placed = new Set<number>()
  rows.forEach((row, index) => {
    if (row.type === 'skipped') return
    if (!isStep(row)) {
      entries.push({ kind: 'row', key: row.id, row })
      return
    }
    if (row.turn === liveTurn || placed.has(row.turn)) return
    placed.add(row.turn)
    const steps = byTurn.get(row.turn) ?? [row]
    const last = steps.at(-1) ?? row
    const lastIndex = rows.indexOf(last)
    const ending = rows
      .slice(Math.max(lastIndex, index) + 1)
      .find((later) => !isStep(later) && later.type !== 'feed.request')
    const start = Date.parse(row.at)
    const end = Date.parse(ending?.at ?? last.at)
    entries.push({
      kind: 'worked',
      key: `worked-${row.id}`,
      turn: row.turn,
      steps,
      seconds: Number.isFinite(end - start) ? Math.max(0, (end - start) / 1000) : 0,
    })
  })
  return entries
}

/** The stages of the turn at work, for the live block. */
export function liveSteps(rows: readonly FeedRow[], head: FeedHeadState | null): StepRow[] {
  if (head === null || !LIVE.includes(head.task.status)) return []
  return rows.filter(isStep).filter((row) => row.turn === head.task.turnNo)
}

/**
 * The question the dialog waits on: the last question of the feed, while nothing the client
 * wrote or pressed — besides a command — has come after it. A question of the agent is open in
 * `awaiting_user`; the platform's question about credits also while the dialog waits with its
 * changes (`awaiting_approval`).
 */
export function openQuestion(
  rows: readonly FeedRow[],
  status: TaskStatus | undefined,
): QuestionRow | null {
  if (status !== 'awaiting_user' && status !== 'awaiting_approval') return null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (movesOn(row)) return null
    if (row.type === 'feed.question') {
      if (row.kind === 'agent' && status !== 'awaiting_user') return null
      return row
    }
  }
  return null
}

/**
 * The failure «Попробовать ещё» answers (docs/plan/53, «Попробовать ещё (18.10)»): the newest
 * failure of the feed, while the server offers the retry — it decides by the same row. null —
 * no retry is offered, or the row is not read yet.
 */
export function retryFailure(
  rows: readonly FeedRow[],
  head: FeedHeadState | null,
): FailureRow | null {
  if (head?.task.canRetry !== true) return null
  return rows.findLast((row): row is FailureRow => row.type === 'feed.failure') ?? null
}

/** The row of the candidate the dialog waits with; null — it has none, or it is not in the feed. */
export function liveCandidateRow(
  rows: readonly FeedRow[],
  head: FeedHeadState | null,
): CandidateRow | null {
  const revision = head?.candidate?.revision
  if (revision === undefined) return null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.type === 'feed.candidate' && row.revision === revision) return row
  }
  return null
}

/**
 * What the agent said about the changes of a candidate: the message of the result of the same
 * turn, else of the last result before it. The agent's own words — shown as its words, never as
 * a fact about the site.
 */
export function candidateMessage(
  rows: readonly FeedRow[],
  candidate: CandidateRow | null,
): string | null {
  if (candidate === null) return null
  let found: ResultRow | null = null
  for (const row of rows) {
    if (row.id === candidate.id) break
    if (row.type === 'feed.result') found = row
  }
  const sameTurn = rows.find(
    (row): row is ResultRow => row.type === 'feed.result' && row.turn === candidate.turn,
  )
  return (sameTurn ?? found)?.message ?? null
}
