import { Buffer } from 'node:buffer'

import {
  agentEventSchema,
  turnOutputRejected,
  turnOutputTooLarge,
  type AgentDriver,
  type AgentEvent,
  type ExecCursor,
  type ExecHandle,
} from '@repo/domain'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 256 * 1024
const MAX_EVENTS = 10_000
const MAX_CHUNKS = 100_000

/** Where reading starts: a re-attached exec continues from the journal's cursor and count. */
export interface TurnOutputStart {
  cursor: ExecCursor
  /** Events journaled before: the per-turn limits span the reconnect. */
  eventCount: number
}

/**
 * Strict byte accounting precedes decoding; oversized final lines cannot revive an older result.
 * Returns only the events read here.
 */
export async function readTurnOutput(
  handle: Pick<ExecHandle, 'output'>,
  driver: Pick<AgentDriver, 'parseEvent'>,
  record: (cursor: ExecCursor, events: AgentEvent[]) => Promise<void>,
  assertActive: () => void,
  knownSecrets: readonly string[] = [],
  start: TurnOutputStart = { cursor: { stdout: 0, stderr: 0 }, eventCount: 0 },
): Promise<{ events: AgentEvent[]; cursor: ExecCursor }> {
  const cursor = { stdout: start.cursor.stdout, stderr: start.cursor.stderr }
  const events: AgentEvent[] = []
  let pending = Buffer.alloc(0)
  let chunks = 0
  const decode = (line: Uint8Array): AgentEvent[] => {
    if (line.byteLength > MAX_LINE_BYTES)
      throw turnOutputTooLarge('Agent output line exceeds its limit')
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
    const parsed = driver.parseEvent(text).map((event) => {
      const checked = agentEventSchema.safeParse(event)
      if (!checked.success) throw turnOutputRejected('Agent event failed its schema')
      return checked.data
    })
    if (containsSecret(parsed)) throw turnOutputRejected('Agent output contains a turn credential')
    if (start.eventCount + events.length + parsed.length > MAX_EVENTS)
      throw turnOutputTooLarge('Agent event limit exceeded')
    events.push(...parsed)
    return parsed
  }
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
        if (pending.length + end - offset > MAX_LINE_BYTES)
          throw turnOutputTooLarge('Agent output line exceeds its limit')
        pending = Buffer.concat([pending, bytes.subarray(offset, end)])
        if (newline < 0) break
        batch.push(...decode(pending))
        pending = Buffer.alloc(0)
        offset = newline + 1
      }
    }
    // The caller persists the cursor together with the events before consuming another chunk.
    // A durable stdout cursor only acknowledges complete lines. On reconnect the
    // trailing partial line is replayed in full instead of losing its prefix; replaying stderr
    // and lines without events is idempotent, so only chunks that yield events are journaled.
    if (batch.length > 0) await record({ ...cursor, stdout: cursor.stdout - pending.length }, batch)
  }
  if (pending.length > 0) await record({ ...cursor }, decode(pending))
  return { events, cursor }
}
