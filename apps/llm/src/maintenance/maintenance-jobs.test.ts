import { afterEach, describe, expect, it, vi } from 'vitest'

import { MaintenanceJobs } from './maintenance-jobs.ts'

describe('llm role lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces an unfinished maintenance job across timer ticks', async () => {
    vi.useFakeTimers()
    const ticked = Promise.withResolvers<void>()
    const tick = vi.fn().mockReturnValueOnce(ticked.promise).mockResolvedValue(undefined)
    const jobs = new MaintenanceJobs({ warn: vi.fn() })
    jobs.every('pool', 60_000, tick)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Five ticks of the timer found the first pass still running and started no second one.
    expect(tick).toHaveBeenCalledOnce()
    ticked.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(2)
    jobs.close()
  })
})
