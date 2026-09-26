import type { BucketKind } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CORE_BUCKETS, runHealthChecks, s3Check, vaultCheck } from './health-checks.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('runHealthChecks', () => {
  it('is ok when every check passes', async () => {
    await expect(
      runHealthChecks({ database: async () => true, redis: async () => true }),
    ).resolves.toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } })
  })

  it('turns false, rejections and synchronous throws into fail', async () => {
    const report = await runHealthChecks({
      database: async () => false,
      redis: () => Promise.reject(new Error('ECONNREFUSED')),
      s3: () => {
        throw new Error('bad config')
      },
      vault: async () => true,
    })

    expect(report).toEqual({
      status: 'degraded',
      checks: { database: 'fail', redis: 'fail', s3: 'fail', vault: 'ok' },
    })
  })

  it('fails a hanging check after its own timeout and still answers', async () => {
    vi.useFakeTimers()
    const report = runHealthChecks(
      { database: () => new Promise<boolean>(() => {}), redis: async () => true },
      2_000,
    )

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(report).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'fail', redis: 'ok' },
    })
  })
})

describe('checks', () => {
  it('s3 checks only the given buckets and is ok only when all of them are reachable', async () => {
    const checkBuckets = vi.fn(async (kinds?: readonly BucketKind[]) =>
      Object.fromEntries((kinds ?? []).map((kind) => [kind, kind !== 'logs'])),
    )

    await expect(s3Check({ checkBuckets }, ['inbox', 'sessions'])()).resolves.toBe(true)
    expect(checkBuckets).toHaveBeenLastCalledWith(['inbox', 'sessions'])
    await expect(s3Check({ checkBuckets }, ['inbox', 'logs'])()).resolves.toBe(false)
  })

  it('s3 fails when a bucket is missing from the answer', async () => {
    await expect(
      s3Check({ checkBuckets: async () => ({ inbox: true }) }, ['inbox', 'logs'])(),
    ).resolves.toBe(false)
  })

  it('core checks its own buckets: no backups, no platform', () => {
    expect(CORE_BUCKETS).toEqual(['inbox', 'sessions', 'logs', 'artifacts'])
  })

  it('vault is ok when initialized and unsealed', async () => {
    const health = { initialized: true, sealed: false, standby: true, version: '2.6.0' }
    await expect(vaultCheck({ health: async () => health })()).resolves.toBe(true)
    await expect(vaultCheck({ health: async () => ({ ...health, sealed: true }) })()).resolves.toBe(
      false,
    )
    await expect(
      vaultCheck({ health: async () => ({ ...health, initialized: false }) })(),
    ).resolves.toBe(false)
  })
})
