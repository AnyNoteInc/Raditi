import {
  agentEventSchema,
  clipCommandOutput,
  maskEnvValuesDeep,
  turnOutputRejected,
  type AgentEvent,
} from '@repo/domain'

/**
 * The agent's events with every value of the client's variables of the turn replaced by
 * ENV_VALUE_MASK (docs/plan/53-chat-preview-release.md, Р13). The agent's commands may print a
 * value; the journal, the feed and the logs never hold one. The executor masks each line before
 * it is parsed (readTurnOutput of @repo/local-turns), so here nothing is left to mask; core still
 * checks every batch before it is journaled, whichever executor read it, and checks each event
 * it changes against its schema again.
 */
export function maskTurnEvents(
  events: readonly AgentEvent[],
  values: readonly string[],
): AgentEvent[] {
  if (values.length === 0) return [...events]
  return events.map((event) => {
    const masked = maskEnvValuesDeep(event, values)
    // A mask may be longer than the value it hides: what a command printed is clipped again,
    // rather than a turn failing on the output the chat only shows.
    if (masked.type === 'command' && masked.output !== undefined) {
      const clipped = clipCommandOutput(masked.output)
      masked.output = clipped.output
      if (clipped.outputCut) masked.outputCut = true
    }
    const checked = agentEventSchema.safeParse(masked)
    if (!checked.success) throw turnOutputRejected('Agent event failed its schema')
    return checked.data
  })
}
