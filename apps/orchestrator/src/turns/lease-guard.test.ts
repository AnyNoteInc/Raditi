import { performance } from 'node:perf_hooks'

import type { SiteLeaseGrant, SiteLeaseStore } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LeaseGuard } from './lease-guard.ts'

function fixture(ttlMs = 30_000, hardTimeoutMs = 60_000, acquireElapsedMs = 0) {
  vi.useFakeTimers()
  // The monotonic clock follows the fake clock, as it would on a real host.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  const grant: SiteLeaseGrant = {
    siteId: 'site',
    taskId: 'task',
    operation: 'turn',
    epoch: 1,
    serverNow: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  }
  const store = {
    assert: vi.fn(async () => true),
    renew: vi.fn(),
  } as unknown as SiteLeaseStore
  const external = new AbortController()
  const logger = { warn: vi.fn() }
  const guard = new LeaseGuard(
    grant,
    store,
    hardTimeoutMs,
    external.signal,
    acquireElapsedMs,
    logger,
  )
  return { guard, store, external, logger }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('turn lease watchdog', () => {
  it('leaves the reserve for the steps after the agent, and times out when none is left', async () => {
    const f = fixture(200_000, 120_000)
    expect(f.guard.remainingBeforeReserveMs(30_000)).toBe(90_000)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(() => f.guard.remainingBeforeReserveMs(30_000)).toThrow('timeout')
    expect(f.guard.reason).toBe('timeout')
    f.guard.close()
  })

  it('fails closed before lease expiry even while every DB assertion is stuck', async () => {
    const f = fixture()
    vi.mocked(f.store.assert).mockImplementation(() => new Promise(() => {}))
    const rejected = expect(f.guard.assertFence()).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    await vi.advanceTimersByTimeAsync(25_000)
    await rejected
    expect(f.guard.signal.aborted).toBe(true)
    expect(f.guard.reason).toBe('lease_lost')
    f.guard.close()
  })

  it('stops as soon as a periodic fence check loses its epoch, without renewing', async () => {
    const f = fixture()
    vi.mocked(f.store.assert).mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.guard.reason).toBe('lease_lost')
    expect(f.guard.signal.aborted).toBe(true)
    expect(f.store.renew).not.toHaveBeenCalled()
    f.guard.close()
  })

  it('keeps running through transient periodic read errors and warns at most once a minute', async () => {
    const f = fixture(150_000, 200_000)
    vi.mocked(f.store.assert).mockRejectedValue(new Error('connection reset'))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.store.assert).toHaveBeenCalledTimes(3)
    expect(f.guard.signal.aborted).toBe(false)
    expect(f.logger.warn).toHaveBeenCalledTimes(2)
    expect(f.logger.warn.mock.calls[0]![0]).toContain('connection reset')
    vi.mocked(f.store.assert).mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.guard.reason).toBe('lease_lost')
    f.guard.close()
  })

  it('still expires locally at the lease deadline while every periodic read fails', async () => {
    const f = fixture(30_000, 60_000)
    vi.mocked(f.store.assert).mockRejectedValue(new Error('database down'))
    await vi.advanceTimersByTimeAsync(24_999)
    expect(f.guard.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.guard.signal.aborted).toBe(true)
    expect(f.guard.reason).toBe('lease_lost')
    f.guard.close()
  })

  it('treats a read error as a lost fence in the strict check before a side effect', async () => {
    const f = fixture()
    vi.mocked(f.store.assert).mockRejectedValueOnce(new Error('connection reset'))
    await expect(f.guard.assertFence()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.guard.reason).toBe('lease_lost')
    f.guard.close()
  })

  it('keeps going through a read error in the tolerant check, with a throttled warning', async () => {
    const f = fixture()
    vi.mocked(f.store.assert).mockRejectedValue(new Error('connection reset'))
    await f.guard.checkFence()
    await f.guard.checkFence()
    expect(f.guard.signal.aborted).toBe(false)
    expect(f.logger.warn).toHaveBeenCalledOnce()
    expect(f.logger.warn.mock.calls[0]![0]).toContain('connection reset')
    f.guard.close()
  })

  it('aborts as lease_lost when the tolerant check sees an explicit loss', async () => {
    const f = fixture()
    vi.mocked(f.store.assert).mockResolvedValueOnce(false)
    await expect(f.guard.checkFence()).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
      message: 'lease_lost',
    })
    expect(f.guard.reason).toBe('lease_lost')
    expect(f.logger.warn).not.toHaveBeenCalled()
    f.guard.close()
  })

  it('reports the time left before the local lease deadline without aborting', async () => {
    const f = fixture(30_000, 10_000)
    expect(f.guard.leaseRemainingMs).toBe(25_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.guard.reason).toBe('timeout')
    expect(f.guard.leaseRemainingMs).toBe(15_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.guard.leaseRemainingMs).toBe(0)
    f.guard.close()
  })

  it('checks the fence periodically, one call at a time', async () => {
    const f = fixture(150_000, 120_000)
    const pending = Promise.withResolvers<boolean>()
    vi.mocked(f.store.assert).mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.store.assert).toHaveBeenCalledOnce()
    pending.resolve(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.store.assert).toHaveBeenCalledTimes(2)
    expect(f.guard.signal.aborted).toBe(false)
    f.guard.close()
  })

  it('enforces the total turn deadline despite successful periodic checks', async () => {
    const f = fixture(30_000, 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.store.assert).toHaveBeenCalledOnce()
    expect(f.guard.signal.aborted).toBe(true)
    expect(f.guard.reason).toBe('timeout')
    f.guard.close()
  })

  it('counts the lease acquisition against the hard deadline', async () => {
    const f = fixture(150_000, 60_000, 40_000)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(f.guard.signal.aborted).toBe(false)
    expect(f.guard.remainingMs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.guard.reason).toBe('timeout')
    f.guard.close()
  })

  it('times out immediately when the acquisition already used the whole limit', () => {
    const f = fixture(150_000, 60_000, 60_000)
    expect(f.guard.signal.aborted).toBe(true)
    expect(f.guard.reason).toBe('timeout')
    f.guard.close()
  })

  it('cancels externally and removes every timer on close', async () => {
    const f = fixture()
    f.external.abort()
    expect(f.guard.reason).toBe('cancelled')
    f.guard.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.store.assert).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
