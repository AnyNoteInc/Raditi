import { describe, expect, it } from 'vitest'
import { createSseDecoder, maxSseEventBytes, SseDecodeError, type SseEvent } from './sse.ts'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('bounded incremental SSE decoder', () => {
  it.each(['\n', '\r\n', '\r'])(
    'decodes multiline data with %j at every byte boundary',
    (newline) => {
      const events: SseEvent[] = []
      const decoder = createSseDecoder((event) => {
        events.push(event)
      })
      const source = bytes(
        [
          '\uFEFF: comment',
          'event: result',
          'id: ignored',
          'data: Привет 🙂',
          'data:  second line',
          '',
          'data',
          '',
          '',
        ].join(newline),
      )
      for (const byte of source) decoder.push(Uint8Array.of(byte))
      decoder.end()
      expect(events).toEqual([
        { event: 'result', data: 'Привет 🙂\n second line' },
        { event: 'message', data: '' },
      ])
    },
  )

  it('ignores comment-only frames and resets event names after empty frames', () => {
    const events: SseEvent[] = []
    const decoder = createSseDecoder((event) => {
      events.push(event)
    })
    decoder.push(bytes('event: ignored\n: ping\n\nevent: first\nevent: final\ndata: x\n\n'))
    decoder.push(bytes('data: y\n\n'))
    expect(events).toEqual([
      { event: 'final', data: 'x' },
      { event: 'message', data: 'y' },
    ])
  })

  it.each(['data: tail', 'data: tail\n', 'event: done\ndata: tail\n'])(
    'never dispatches an EOF tail %j',
    (tail) => {
      const events: SseEvent[] = []
      const decoder = createSseDecoder((event) => {
        events.push(event)
      })
      decoder.push(bytes('data: committed\n\n' + tail))
      decoder.end()
      decoder.end()
      expect(events).toEqual([{ event: 'message', data: 'committed' }])
    },
  )

  it('retains terminal events without decoding later bytes in the same chunk', () => {
    const events: SseEvent[] = []
    const decoder = createSseDecoder((event) => {
      events.push(event)
      return false
    })
    decoder.push(Uint8Array.from([...bytes('data: done\n\n'), 0xff, 10]))
    decoder.push(Uint8Array.of(0xff))
    decoder.end()
    expect(events).toEqual([{ event: 'message', data: 'done' }])
  })

  it('rejects invalid UTF-8 without exposing line contents', () => {
    const decoder = createSseDecoder(() => {})
    try {
      decoder.push(Uint8Array.from([...bytes('data: secret-marker'), 0xff, 10]))
      expect.fail('invalid UTF-8 accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(SseDecodeError)
      expect(String(error)).toContain('utf8')
      expect(String(error)).not.toContain('secret-marker')
    }
  })

  it('discards an incomplete UTF-8 EOF tail', () => {
    const decoder = createSseDecoder(() => expect.fail('tail dispatched'))
    decoder.push(Uint8Array.from([...bytes('data: '), 0xf0, 0x9f]))
    expect(() => decoder.end()).not.toThrow()
  })

  it('bounds the whole event across lines and resets the bound for the next event', () => {
    let received = 0
    const decoder = createSseDecoder(() => {
      received += 1
    }, 9)
    for (let i = 0; i < 1000; i += 1) decoder.push(bytes('data: x\n\n'))
    expect(received).toBe(1000)
    expect(() => decoder.push(bytes('data: x\ndata: y\n\n'))).toThrow('event_limit')
    expect(() => decoder.push(bytes('\n'))).toThrow('closed')
  })

  it('bounds a single line before a newline is received', () => {
    const decoder = createSseDecoder(() => {}, 5000)
    decoder.push(bytes('x'.repeat(5000)))
    expect(() => decoder.push(bytes('x'))).toThrow('event_limit')
  })

  it.each([0, -1, 0.1, Infinity, maxSseEventBytes + 1])(
    'rejects an invalid frame limit %s',
    (limit) => {
      expect(() => createSseDecoder(() => {}, limit)).toThrow(RangeError)
    },
  )
})
