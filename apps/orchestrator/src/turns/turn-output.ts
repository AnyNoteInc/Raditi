import { Buffer } from 'node:buffer'

import {
  agentEventSchema,
  agentOutputLimits,
  containsEnvValue,
  maskEnvValues,
  maskEnvValuesDeep,
  turnOutputRejected,
  turnOutputTooLarge,
  type AgentDriver,
  type AgentEvent,
  type ExecCursor,
  type ExecHandle,
} from '@repo/domain'

const MAX_BYTES = 32 * 1024 * 1024
/** What the drivers' parsers read of one line: a longer one yields no events there either. */
const MAX_LINE_BYTES = 256 * 1024
const MAX_CHUNKS = 100_000
/**
 * Left in place of a stdout line longer than MAX_LINE_BYTES, as the agent's message: a result is
 * read only from the last message, so a skipped final line never revives an older one. Not JSON.
 */
export const SKIPPED_LINE_MESSAGE = '[Часть вывода агента пропущена: слишком длинная строка]'

/** Where reading starts: a re-attached exec continues from the journal's cursor and count. */
export interface TurnOutputStart {
  cursor: ExecCursor
  /** Events journaled before: the per-turn limits span the reconnect. */
  eventCount: number
}

/**
 * A line of the agent's output with every value of the client's variables masked before the
 * driver parses it (docs/plan/53-chat-preview-release.md, Р13): the parser clips long text,
 * and a value cut there could no longer be found. A JSON line is masked string by string — a
 * value with a quote in it may spell a piece of the line's own syntax — any other line as text.
 */
export function maskOutputLine(text: string, values: readonly string[]): string {
  if (values.length === 0 || !containsEnvValue(text, values)) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return maskEnvValues(text, values)
  }
  return JSON.stringify(maskEnvValuesDeep(parsed, values))
}

/**
 * Strict byte accounting precedes decoding. A line longer than the parsers read — the whole
 * output of a tool in one row of the CLI, say — does not end the turn: it is skipped whole,
 * neither kept nor decoded, and leaves SKIPPED_LINE_MESSAGE in its place, so an over-long final
 * line cannot revive an older result. Everything a turn prints stays bounded by MAX_BYTES.
 * The values of the client's variables of the turn (`envValues`) are masked in each line before
 * it is parsed (maskOutputLine). Returns only the events read here.
 */
export async function readTurnOutput(
  handle: Pick<ExecHandle, 'output'>,
  driver: Pick<AgentDriver, 'parseEvent'>,
  record: (cursor: ExecCursor, events: AgentEvent[]) => Promise<void>,
  assertActive: () => void,
  knownSecrets: readonly string[] = [],
  start: TurnOutputStart = { cursor: { stdout: 0, stderr: 0 }, eventCount: 0 },
  envValues: readonly string[] = [],
): Promise<{ events: AgentEvent[]; cursor: ExecCursor }> {
  const cursor = { stdout: start.cursor.stdout, stderr: start.cursor.stderr }
  const events: AgentEvent[] = []
  let pending = Buffer.alloc(0)
  /** Bytes of the unfinished stdout line: kept in `pending`, or skipped once it is over-long. */
  let lineBytes = 0
  let skipping = false
  let chunks = 0
  const accept = (parsed: AgentEvent[]): AgentEvent[] => {
    if (start.eventCount + events.length + parsed.length > agentOutputLimits.turnEvents)
      throw turnOutputTooLarge('Agent event limit exceeded')
    events.push(...parsed)
    return parsed
  }
  const decode = (line: Uint8Array): AgentEvent[] => {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(line)
    } catch {
      throw turnOutputRejected('Agent output is not valid UTF-8')
    }
    const containsSecret = (value: unknown): boolean => {
      if (typeof value === 'string')
        return knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))
      if (Array.isArray(value)) return value.some(containsSecret)
      if (value !== null && typeof value === 'object')
        return Object.values(value).some(containsSecret)
      return false
    }
    if (containsSecret(text)) throw turnOutputRejected('Agent output contains a turn credential')
    const parsed = driver.parseEvent(maskOutputLine(text, envValues)).map((event) => {
      const checked = agentEventSchema.safeParse(event)
      if (!checked.success) throw turnOutputRejected('Agent event failed its schema')
      return checked.data
    })
    if (containsSecret(parsed)) throw turnOutputRejected('Agent output contains a turn credential')
    return accept(parsed)
  }
  const skipped = (): AgentEvent[] => accept([{ type: 'message', text: SKIPPED_LINE_MESSAGE }])
  for await (const chunk of handle.output()) {
    assertActive()
    if (++chunks > MAX_CHUNKS) throw turnOutputTooLarge('Agent output chunk limit exceeded')
    if (
      !['stdout', 'stderr'].includes(chunk.stream) ||
      !(chunk.data instanceof Uint8Array) ||
      chunk.data.byteLength === 0 ||
      chunk.offset !== cursor[chunk.stream]
    )
      throw turnOutputRejected('Invalid agent output stream')
    cursor[chunk.stream] += chunk.data.byteLength
    if (cursor.stdout + cursor.stderr > MAX_BYTES)
      throw turnOutputTooLarge('Agent output limit exceeded')
    const batch: AgentEvent[] = []
    if (chunk.stream === 'stdout') {
      let offset = 0
      const bytes = Buffer.from(chunk.data)
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        lineBytes += end - offset
        if (lineBytes > MAX_LINE_BYTES) {
          skipping = true
          pending = Buffer.alloc(0)
        } else pending = Buffer.concat([pending, bytes.subarray(offset, end)])
        if (newline < 0) break
        batch.push(...(skipping ? skipped() : decode(pending)))
        pending = Buffer.alloc(0)
        lineBytes = 0
        skipping = false
        offset = newline + 1
      }
    }
    // The caller persists the cursor together with the events before consuming another chunk.
    // A durable stdout cursor only acknowledges complete lines. On reconnect the
    // trailing partial line is replayed in full instead of losing its prefix; replaying stderr
    // and lines without events is idempotent, so only chunks that yield events are journaled.
    if (batch.length > 0) await record({ ...cursor, stdout: cursor.stdout - lineBytes }, batch)
  }
  if (skipping) await record({ ...cursor }, skipped())
  else if (pending.length > 0) await record({ ...cursor }, decode(pending))
  return { events, cursor }
}

/**
 * The agent's events with every value of the client's variables of the turn replaced by
 * ENV_VALUE_MASK (docs/plan/53-chat-preview-release.md, Р13). The agent's commands may print a
 * value; the journal, the feed and the logs never hold one. The executor masks each line before
 * it is parsed (readTurnOutput), so here nothing is left to mask; core still checks every batch
 * before it is journaled, whichever executor read it, and checks each event it changes against
 * its schema again.
 */
export function maskTurnEvents(
  events: readonly AgentEvent[],
  values: readonly string[],
): AgentEvent[] {
  if (values.length === 0) return [...events]
  return events.map((event) => {
    const checked = agentEventSchema.safeParse(maskEnvValuesDeep(event, values))
    if (!checked.success) throw turnOutputRejected('Agent event failed its schema')
    return checked.data
  })
}
