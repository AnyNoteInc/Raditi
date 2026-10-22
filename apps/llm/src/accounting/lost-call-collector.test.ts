import { afterEach, describe, expect, it, vi } from 'vitest'

import { LostCallCollector } from './lost-call-collector.ts'

const logger = () => ({ warn: vi.fn() })

describe('llm role lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes admission when the stale-call collector cannot read the database', async () => {
    const warnings = logger()
    const collector = new LostCallCollector(
      { collectLost: vi.fn().mockRejectedValue(new Error('private-database-error')) },
      warnings,
    )
    await collector.collect()
    // The gateway admits while the collector is healthy (readiness.test.ts): it is not.
    expect(collector.healthy()).toBe(false)
    expect(warnings.warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'llm_collector_failed' }),
    )
  })

  it('bounds a hung collector, keeps one scan and recovers only after a fresh successful scan', async () => {
    vi.useFakeTimers()
    let resolveScan: () => void = () => {}
    const collectLost = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveScan = resolve
          }),
      )
      .mockResolvedValue(0)
    const warnings = logger()
    const collector = new LostCallCollector({ collectLost }, warnings)
    const first = collector.collect()
    await vi.advanceTimersByTimeAsync(10_000)
    await first
    expect(collector.healthy()).toBe(false)
    expect(warnings.warn).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_collector_timeout' }))
    collector.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(collectLost).toHaveBeenCalledOnce()
    resolveScan()
    await vi.advanceTimersByTimeAsync(0)
    expect(collector.healthy()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(collectLost).toHaveBeenCalledTimes(2)
    expect(collector.healthy()).toBe(true)
    collector.stop()
  })
})
