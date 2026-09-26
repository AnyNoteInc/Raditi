import { Buffer } from 'node:buffer'

import {
  agentEventSchema,
  badRequest,
  type AgentDriver,
  type AgentEvent,
  type ExecCursor,
  type ExecHandle,
} from '@repo/domain'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 256 * 1024
const MAX_EVENTS = 10_000
const MAX_CHUNKS = 100_000

/** Strict byte accounting precedes decoding; oversized final lines cannot revive an older result. */
export async function readTurnOutput(
  handle: Pick<ExecHandle, 'output'>,
  driver: Pick<AgentDriver, 'parseEvent'>,
  record: (cursor: ExecCursor, events: AgentEvent[]) => Promise<void>,
  assertActive: () => void,
  knownSecrets: readonly string[] = [],
): Promise<{ events: AgentEvent[]; cursor: ExecCursor }> {
  const cursor = { stdout: 0, stderr: 0 }
  const events: AgentEvent[] = []
  let pending = Buffer.alloc(0)
  let chunks = 0
  const decode = (line: Uint8Array): AgentEvent[] => {
    if (line.byteLength > MAX_LINE_BYTES) throw badRequest('Agent output line exceeds its limit')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
    const containsSecret = (value: unknown): boolean => {
      if (typeof value === 'string')
        return knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))
      if (Array.isArray(value)) return value.some(containsSecret)
      if (value !== null && typeof value === 'object')
        return Object.values(value).some(containsSecret)
      return false
    }
    if (containsSecret(text)) throw badRequest('Agent output contains a turn credential')
    const parsed = driver.parseEvent(text).map((event) => agentEventSchema.parse(event))
    if (containsSecret(parsed)) throw badRequest('Agent output contains a turn credential')
    if (events.length + parsed.length > MAX_EVENTS) throw badRequest('Agent event limit exceeded')
    events.push(...parsed)
    return parsed
  }
  for await (const chunk of handle.output()) {
    assertActive()
    if (
      ++chunks > MAX_CHUNKS ||
      !['stdout', 'stderr'].includes(chunk.stream) ||
      !(chunk.data instanceof Uint8Array) ||
      chunk.data.byteLength === 0 ||
      chunk.offset !== cursor[chunk.stream]
    )
      throw badRequest('Invalid agent output stream')
    cursor[chunk.stream] += chunk.data.byteLength
    if (cursor.stdout + cursor.stderr > MAX_BYTES) throw badRequest('Agent output limit exceeded')
    const batch: AgentEvent[] = []
    if (chunk.stream === 'stdout') {
      let offset = 0
      const bytes = Buffer.from(chunk.data)
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        if (pending.length + end - offset > MAX_LINE_BYTES)
          throw badRequest('Agent output line exceeds its limit')
        pending = Buffer.concat([pending, bytes.subarray(offset, end)])
        if (newline < 0) break
        batch.push(...decode(pending))
        pending = Buffer.alloc(0)
        offset = newline + 1
      }
    }
    // The caller persists the cursor together with the events before consuming another chunk.
    // A durable stdout cursor only acknowledges complete lines. On reconnect the
    // trailing partial line is replayed in full instead of losing its prefix.
    await record({ ...cursor, stdout: cursor.stdout - pending.length }, batch)
  }
  if (pending.length > 0) await record({ ...cursor }, decode(pending))
  return { events, cursor }
}
