import type { SiteLeaseGrant, SiteLeaseStore } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LeaseGuard } from './lease-guard.ts'

function fixture(ttlMs = 30_000, hardTimeoutMs = 60_000) {
  vi.useFakeTimers()
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
    renew: vi.fn(async () => ({
      ...grant,
      serverNow: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
    })),
  } as unknown as SiteLeaseStore
  const external = new AbortController()
  const guard = new LeaseGuard(grant, store, ttlMs, hardTimeoutMs, external.signal)
  return { guard, store, external }
}

afterEach(() => vi.useRealTimers())

describe('turn lease watchdog', () => {
  it('fails closed before lease expiry even while a renewal and DB assertion are stuck', async () => {
    const f = fixture()
    vi.mocked(f.store.renew).mockImplementation(() => new Promise(() => {}))
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

  it('stops immediately when renewal loses its epoch', async () => {
    const f = fixture()
    vi.mocked(f.store.renew).mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.guard.reason).toBe('lease_lost')
    expect(f.guard.signal.aborted).toBe(true)
    f.guard.close()
  })

  it('enforces the total turn deadline despite successful heartbeat renewal', async () => {
    const f = fixture(30_000, 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.store.renew).toHaveBeenCalledOnce()
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
    expect(f.store.renew).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
