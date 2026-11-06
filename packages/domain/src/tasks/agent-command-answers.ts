import type { FeedAgentCommandId, FeedEvent } from './client-feed.ts'

/** A row of the feed with its id, as `task.feed` sends it and as core reads it back. */
type Row = FeedEvent & { readonly id: string }

/** The row holds words, as the planner reads them (`pass-facts.ts`): a kind with a text. */
const hasWords = (row: Row): boolean =>
  row.type === 'feed.request' && 'text' in row && typeof row.text === 'string'

/**
 * The results that answer a command of the agent (docs/plan/61-chats-first.md, §5.14): the first
 * result after it. A press of the same work (`retry`, «Продолжить»), a failure and a question end
 * none of it. Words after `/compact` do: the planner gives a pass an action only while no words wait
 * (`actionOf`), so the turn they get is an ordinary one, and so does «Обновить» that moved the
 * candidate — a `feed.candidate` after its press, a press that moved nothing leaves `feed.update`:
 * the next pass is a new session on the new head (`startOf`), with nothing to shorten. Words after
 * `/init` on a session that lives go on with it, for its prompt carries the command again
 * (`promptOf`); a new session tells only the client's words, and the feed cannot tell the two
 * apart, so the result counts as the answer.
 * Inferred from the order of the rows: the feed keeps no mark of the request a turn answered.
 */
export function agentCommandAnswerIds(
  rows: readonly Row[],
  command: FeedAgentCommandId,
): ReadonlySet<string> {
  const answers = new Set<string>()
  let asked = false
  let updating = false
  for (const row of rows) {
    if (row.type === 'feed.result') {
      if (asked) answers.add(row.id)
      asked = false
    } else if (row.type === 'feed.request' && row.kind === 'agent_command') {
      asked = row.command === command
    } else if (command !== 'compact') {
      continue
    } else if (hasWords(row)) {
      asked = false
    } else if (row.type === 'feed.request' && row.kind === 'command') {
      if (row.command === 'update') updating = true
    } else if (row.type === 'feed.update') {
      updating = false
    } else if (row.type === 'feed.candidate' && updating) {
      asked = false
      updating = false
    }
  }
  return answers
}

/**
 * The results that answer any command of the agent: they say nothing of the changes of a candidate
 * — a compaction answers in the platform's line, `/init` describes the code (§5.14).
 */
export function agentCommandAnswers(rows: readonly Row[]): ReadonlySet<string> {
  return new Set([
    ...agentCommandAnswerIds(rows, 'init'),
    ...agentCommandAnswerIds(rows, 'compact'),
  ])
}
