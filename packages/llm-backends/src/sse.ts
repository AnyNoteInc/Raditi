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

/** Returning false stops parsing at a provider terminal, even within a larger chunk. */
export function createSseDecoder(
  onEvent: (event: SseEvent) => boolean | void,
  eventLimit = maxSseEventBytes,
): { push(chunk: Uint8Array): void; end(): void } {
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > maxSseEventBytes)
    throw new RangeError('Invalid SSE event limit')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let line = new Uint8Array(Math.min(4096, eventLimit))
  let lineSize = 0
  let eventSize = 0
  let event = ''
  let data: string[] = []
  let skipLf = false
  let firstLine = true
  let ended = false
  let stopped = false

  const fail = (reason: 'event_limit' | 'utf8'): never => {
    ended = true
    line = new Uint8Array(0)
    data = []
    throw new SseDecodeError(reason)
  }
  const finishLine = () => {
    let text: string
    try {
      text = decoder.decode(line.subarray(0, lineSize))
    } catch {
      return fail('utf8')
    }
    lineSize = 0
    if (firstLine) {
      text = text.replace(/^\uFEFF/, '')
      firstLine = false
    }
    if (text === '') {
      const message = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : null
      event = ''
      data = []
      eventSize = 0
      if (line.length > 4096) line = new Uint8Array(4096)
      if (message !== null && onEvent(message) === false) stopped = true
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    if (field === 'event') event = value
  }

  return {
    push(chunk) {
      if (stopped) return
      if (ended) throw new SseDecodeError('closed')
      for (const byte of chunk) {
        if (skipLf) {
          skipLf = false
          if (byte === 10) continue
        }
        eventSize += 1
        if (eventSize > eventLimit) fail('event_limit')
        if (byte === 10 || byte === 13) {
          skipLf = byte === 13
          finishLine()
          if (stopped) return
        } else {
          if (lineSize === line.length) {
            const grown = new Uint8Array(Math.min(eventLimit, line.length * 2))
            grown.set(line)
            line = grown
          }
          line[lineSize++] = byte
        }
      }
    },
    end() {
      // EOF never dispatches a pending line/event, including an incomplete UTF-8 tail.
      ended = true
      line = new Uint8Array(0)
      data = []
    },
  }
}
