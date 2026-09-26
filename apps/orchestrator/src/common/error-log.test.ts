import { describe, expect, it, vi } from 'vitest'

import { throttledErrorLog } from './error-log.ts'

describe('throttledErrorLog', () => {
  it('logs the first error and then once per window with the number of repeats', () => {
    let now = 0
    const logger = { warn: vi.fn() }
    const log = throttledErrorLog(logger, 'queue notifications', 60_000, () => now)

    log(new Error('connect ECONNREFUSED'))
    now = 1_000
    log(new Error('connect ECONNREFUSED'))
    now = 2_000
    log(new Error('connect ECONNREFUSED'))
    now = 61_000
    log(new Error('connect ECONNREFUSED'))

    expect(logger.warn.mock.calls).toEqual([
      ['queue notifications: connect ECONNREFUSED'],
      ['queue notifications: connect ECONNREFUSED (repeated 2 times since the last report)'],
    ])
  })
})
