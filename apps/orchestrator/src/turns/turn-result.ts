import {
  turnOutputRejected,
  turnResultSchema,
  type AgentDriver,
  type AgentEvent,
  type TurnResult,
} from '@repo/domain'

/** A fenced block: its body ends at the next fence, whatever the lines around it. */
const FENCED = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi

/**
 * The one JSON candidate of a final message that wraps its result in prose or a code fence: the
 * body of its only fenced block, else everything from its first `{` to its last `}`. undefined
 * when the message has no candidate, or several fenced blocks to choose from. One pass over a
 * message the event schema already bounds; whether the candidate is a result is not decided here.
 */
export function resultCandidate(message: string): string | undefined {
  const fenced = [...message.matchAll(FENCED)]
  if (fenced.length > 1) return undefined
  if (fenced.length === 1) return fenced[0]![1]!.trim()
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  return start >= 0 && end > start ? message.slice(start, end + 1) : undefined
}

/**
 * The validated result of a turn whose agent finished — spec §8 «Итог хода». The driver reads its
 * final message first. A model whose CLI does not enforce the output schema tends to wrap the
 * object in a sentence or a code fence: that message is read once more through the driver, from
 * its one JSON candidate. Only the last message counts, and nothing is accepted that the driver
 * and the schema do not accept as a whole.
 *
 * Not done here: spec §8 gives the agent one attempt to fix an invalid result. That is a second
 * exec in the same container — new driver files, argv and secrets after the first exec, a second
 * exec in the journal that recovery tells from the first — and neither TurnExecution.launch nor
 * the runner's `launch` command carries any of it yet. Until they do (P12), an invalid result
 * ends the turn as TURN_OUTPUT_REJECTED and the client may run it again.
 */
export function readTurnResult(
  driver: Pick<AgentDriver, 'extractResult'>,
  events: readonly AgentEvent[],
): TurnResult {
  let parsed = turnResultSchema.safeParse(driver.extractResult(events, null))
  if (!parsed.success) {
    const last = events.findLast((event) => event.type === 'message')
    const candidate = last ? resultCandidate(last.text) : undefined
    if (candidate !== undefined && candidate !== last!.text.trim())
      parsed = turnResultSchema.safeParse(driver.extractResult(events, candidate))
  }
  // Only a fixed text: the issues of a schema error name keys and values the agent chose.
  if (!parsed.success) throw turnOutputRejected('Agent result failed its schema')
  return parsed.data
}
