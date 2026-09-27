import { afterEach, describe, expect, it, vi } from 'vitest'

import { TimeoutError, withTimeout } from './async.ts'

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
    await expect(result).rejects.toThrow('database check timed out')
  })

  it('leaves no timer behind once the promise settles', async () => {
    vi.useFakeTimers()
    await withTimeout(Promise.resolve('done'), 60_000, 'slow')
    expect(vi.getTimerCount()).toBe(0)
  })
})
