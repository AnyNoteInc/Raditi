import { describe, expect, it, vi } from 'vitest'

import { errorMessage, throttledLogger } from './logging.ts'

describe('errorMessage', () => {
  it('uses the message of an error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('unwraps an AggregateError with an empty message (localhost connection failures)', () => {
    const error = Object.assign(
      new AggregateError([
        new Error('connect ECONNREFUSED ::1:6379'),
        new Error('connect ECONNREFUSED 127.0.0.1:6379'),
      ]),
      { code: 'ECONNREFUSED' },
    )
    expect(errorMessage(error)).toBe(
      'connect ECONNREFUSED ::1:6379; connect ECONNREFUSED 127.0.0.1:6379',
    )
  })

  it('adds the code to a Prisma error that has no reason in its message', () => {
    const error = Object.assign(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\n'), {
      code: 'ECONNREFUSED',
    })
    expect(errorMessage(error)).toBe('Invalid `prisma.$queryRaw()` invocation: (ECONNREFUSED)')
  })

  it('falls back to the error code, then to the name', () => {
    expect(errorMessage(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET')
    expect(errorMessage(new TypeError(''))).toBe('TypeError')
  })
})

describe('throttledLogger', () => {
  it('logs the first failure and then once per window with the number of repeats', () => {
    let now = 0
    const log = vi.fn()
    const warn = throttledLogger(log, { windowMs: 60_000, now: () => now })

    warn('queue notifications', new Error('connect ECONNREFUSED'))
    now = 1_000
    warn('queue notifications', new Error('connect ECONNREFUSED'))
    now = 2_000
    warn('queue notifications', new Error('connect ECONNREFUSED'))
    now = 61_000
    warn('queue notifications', new Error('connect ECONNREFUSED'))

    expect(log.mock.calls).toEqual([
      ['queue notifications: connect ECONNREFUSED'],
      ['queue notifications: connect ECONNREFUSED (repeated 2 times since the last report)'],
    ])
  })

  it('throttles each source on its own, once a minute by default', () => {
    let now = 0
    const log = vi.fn()
    const warn = throttledLogger(log, { now: () => now })

    warn('redis is unavailable', new Error('ECONNREFUSED'))
    warn('redis is unavailable', new Error('ECONNREFUSED'))
    warn('vault is unavailable', new Error('timed out'))
    now = 59_999
    warn('redis is unavailable', new Error('ECONNREFUSED'))
    now = 60_000
    warn('redis is unavailable', new AggregateError([new Error('connect ECONNREFUSED ::1:6379')]))

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'redis is unavailable: ECONNREFUSED',
      'vault is unavailable: timed out',
      'redis is unavailable: connect ECONNREFUSED ::1:6379 (repeated 2 times since the last report)',
    ])
  })
})
