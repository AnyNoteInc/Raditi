/** Only the current event is retained; the response stream has no cumulative buffer. */
export const maxSseEventBytes = 16 * 1024 * 1024

export interface SseEvent {
  event: string
  data: string
}

export class SseDecodeError extends Error {
  readonly reason: 'event_limit' | 'utf8' | 'closed'

  constructor(reason: 'event_limit' | 'utf8' | 'closed') {
    super(`Invalid upstream SSE: ${reason}`)
    this.name = 'SseDecodeError'
    this.reason = reason
  }
}

const LF = 10
const CR = 13

/**
 * Returning false stops parsing at a provider terminal, even within a larger chunk.
 *
 * `raw` is the event's own bytes, its blank line included, when they say nothing but its
 * `event` and `data`: only `event:` and `data:` lines, each ended by a single LF, no BOM. Those
 * bytes read as the event itself, so a caller may forward them instead of encoding it again;
 * any other event (comments, `id:`, `retry:`, CR line ends) comes without them.
 */
export function createSseDecoder(
  onEvent: (event: SseEvent, raw: Uint8Array | undefined) => boolean | void,
  eventLimit = maxSseEventBytes,
): { push(chunk: Uint8Array): void; end(): void } {
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > maxSseEventBytes)
    throw new RangeError('Invalid SSE event limit')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  // The bytes of the current event, line ends included: its lines are decoded from here, and
  // a plain event goes out of here as it came.
  let buffer = new Uint8Array(Math.min(4096, eventLimit))
  let size = 0
  let lineStart = 0
  let event = ''
  let data: string[] = []
  let plain = true
  let skipLf = false
  let firstLine = true
  let ended = false
  let stopped = false

  const fail = (reason: 'event_limit' | 'utf8'): never => {
    ended = true
    buffer = new Uint8Array(0)
    data = []
    throw new SseDecodeError(reason)
  }
  const append = (bytes: Uint8Array) => {
    if (bytes.length === 0) return
    if (size + bytes.length > eventLimit) fail('event_limit')
    if (size + bytes.length > buffer.length) {
      let length = buffer.length * 2
      while (length < size + bytes.length) length *= 2
      const grown = new Uint8Array(Math.min(eventLimit, length))
      grown.set(buffer.subarray(0, size))
      buffer = grown
    }
    buffer.set(bytes, size)
    size += bytes.length
  }
  /** The line before a line end that is already in the buffer (one byte, never counted twice). */
  const finishLine = (crlf: boolean) => {
    let text: string
    try {
      text = decoder.decode(buffer.subarray(lineStart, size - 1))
    } catch {
      return fail('utf8')
    }
    if (crlf) plain = false
    if (firstLine) {
      if (text.startsWith('﻿')) {
        text = text.slice(1)
        plain = false
      }
      firstLine = false
    }
    lineStart = size
    if (text === '') {
      const message = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : null
      const raw = message !== null && plain ? buffer.slice(0, size) : undefined
      event = ''
      data = []
      size = 0
      lineStart = 0
      plain = true
      if (buffer.length > 4096) buffer = new Uint8Array(4096)
      if (message !== null && onEvent(message, raw) === false) stopped = true
      return
    }
    if (text.startsWith(':')) {
      plain = false
      return
    }
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (colon < 0 || (field !== 'data' && field !== 'event')) plain = false
    if (field === 'data') data.push(value)
    if (field === 'event') event = value
  }

  return {
    push(chunk) {
      if (stopped) return
      if (ended) throw new SseDecodeError('closed')
      let offset = 0
      // A CR is rare: it is looked for again only once the scan has passed the last one found.
      let nextCr = chunk.indexOf(CR)
      while (offset < chunk.length) {
        if (skipLf) {
          skipLf = false
          // The LF of a CRLF: the line has ended at its CR already.
          if (chunk[offset] === LF) {
            offset += 1
            continue
          }
        }
        if (nextCr !== -1 && nextCr < offset) nextCr = chunk.indexOf(CR, offset)
        const nextLf = chunk.indexOf(LF, offset)
        const end = nextLf === -1 ? nextCr : nextCr === -1 ? nextLf : Math.min(nextLf, nextCr)
        if (end === -1) {
          append(chunk.subarray(offset))
          return
        }
        append(chunk.subarray(offset, end + 1))
        offset = end + 1
        skipLf = chunk[end] === CR
        finishLine(skipLf)
        if (stopped) return
      }
    },
    end() {
      // EOF never dispatches a pending line/event, including an incomplete UTF-8 tail.
      ended = true
      buffer = new Uint8Array(0)
      data = []
    },
  }
}
