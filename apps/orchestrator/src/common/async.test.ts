import { afterEach, describe, expect, it, vi } from 'vitest'

import { errorMessage, TimeoutError, withTimeout } from './async.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('settles with the promise when it is fast enough', async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, 'slow')).resolves.toBe(42)
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'slow')).rejects.toThrow(
      'boom',
    )
  })

  it('rejects with TimeoutError when the promise hangs', async () => {
    vi.useFakeTimers()
    const result = withTimeout(new Promise(() => {}), 2_000, 'database check timed out')
    const assertion = expect(result).rejects.toThrow(TimeoutError)

    await vi.advanceTimersByTimeAsync(2_000)
    await assertion
  })
})

describe('errorMessage', () => {
  it('uses the message of an error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('unwraps an AggregateError with an empty message (localhost connection failures)', () => {
    const err = Object.assign(
      new AggregateError([
        new Error('connect ECONNREFUSED ::1:6379'),
        new Error('connect ECONNREFUSED 127.0.0.1:6379'),
      ]),
      { code: 'ECONNREFUSED' },
    )
    expect(errorMessage(err)).toBe(
      'connect ECONNREFUSED ::1:6379; connect ECONNREFUSED 127.0.0.1:6379',
    )
  })

  it('adds the code to a Prisma error that has no reason in its message', () => {
    const err = Object.assign(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\n'), {
      code: 'ECONNREFUSED',
    })
    expect(errorMessage(err)).toBe('Invalid `prisma.$queryRaw()` invocation: (ECONNREFUSED)')
  })

  it('falls back to the error code, then to the name', () => {
    expect(errorMessage(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET')
    expect(errorMessage(new TypeError(''))).toBe('TypeError')
  })
})
