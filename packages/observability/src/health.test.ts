import type { BucketKind } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cachedHealthProbe,
  databaseCheck,
  runHealthChecks,
  s3Check,
  vaultCheck,
  type HealthReport,
} from './health.ts'

afterEach(() => {
  vi.useRealTimers()
})

const passing = async () => true
const allOk = { database: passing, redis: passing, s3: passing, vault: passing }

const okReport: HealthReport = {
  status: 'ok',
  checks: { database: 'ok', redis: 'ok', s3: 'ok', vault: 'ok' },
}
const degradedReport: HealthReport = {
  status: 'degraded',
  checks: { database: 'fail', redis: 'ok', s3: 'ok', vault: 'ok' },
}

describe('runHealthChecks', () => {
  it('reports every check ok', async () => {
    await expect(runHealthChecks(allOk)).resolves.toEqual(okReport)
  })

  it('turns false, rejections and synchronous throws into fail and reports each', async () => {
    const onFailure = vi.fn()
    const report = await runHealthChecks(
      {
        database: () => Promise.reject(new Error('ECONNREFUSED')),
        redis: async () => false,
        s3: () => {
          throw new Error('invalid S3 configuration')
        },
        vault: passing,
      },
      { onFailure },
    )

    expect(report).toEqual({
      status: 'degraded',
      checks: { database: 'fail', redis: 'fail', s3: 'fail', vault: 'ok' },
    })
    expect(
      Object.fromEntries(onFailure.mock.calls.map(([name, error]) => [name, error.message])),
    ).toEqual({
      database: 'ECONNREFUSED',
      redis: 'redis health check returned false',
      s3: 'invalid S3 configuration',
    })
  })

  it('fails a hanging check after its timeout and still answers', async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const report = runHealthChecks(
      { ...allOk, database: () => new Promise<boolean>(() => {}) },
      { timeoutMs: 2_000, onFailure },
    )

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(report).resolves.toEqual(degradedReport)
    expect(onFailure).toHaveBeenCalledWith(
      'database',
      expect.objectContaining({
        name: 'TimeoutError',
        message: 'database health check timed out after 2000 ms',
      }),
    )
  })
})

describe('cachedHealthProbe', () => {
  it('reuses a report for the cache period, then runs the checks again', async () => {
    let now = 0
    const database = vi.fn(async () => true)
    const probe = cachedHealthProbe({ ...allOk, database }, { ttlMs: 5_000, now: () => now })

    await expect(probe()).resolves.toEqual(okReport)
    now = 4_999
    await expect(probe()).resolves.toEqual(okReport)
    expect(database).toHaveBeenCalledTimes(1)

    now = 5_000
    await probe()
    expect(database).toHaveBeenCalledTimes(2)
  })

  it('caches a failing report for 5 seconds by default', async () => {
    let now = 0
    const database = vi.fn(async () => false)
    const probe = cachedHealthProbe({ ...allOk, database }, { now: () => now })

    await expect(probe()).resolves.toEqual(degradedReport)
    now = 4_999
    await expect(probe()).resolves.toEqual(degradedReport)
    expect(database).toHaveBeenCalledTimes(1)
    now = 5_000
    await probe()
    expect(database).toHaveBeenCalledTimes(2)
  })

  it('shares one run between concurrent callers', async () => {
    let finish: (ok: boolean) => void = () => {}
    const database = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)))
    const probe = cachedHealthProbe({ ...allOk, database })

    const calls = Array.from({ length: 10 }, () => probe())
    await vi.waitFor(() => expect(database).toHaveBeenCalledTimes(1))
    finish(true)

    const reports = await Promise.all(calls)
    expect(reports.every((report) => report.status === 'ok')).toBe(true)
    expect(database).toHaveBeenCalledTimes(1)
  })
})

describe('checks', () => {
  it('database runs SELECT 1', async () => {
    const $queryRaw = vi.fn(async (query: TemplateStringsArray) => query.join(''))

    await expect(databaseCheck(() => ({ $queryRaw }))()).resolves.toBe(true)
    expect($queryRaw).toHaveBeenCalledTimes(1)
    expect($queryRaw.mock.calls[0]?.[0].join('')).toBe('SELECT 1')
  })

  it('s3 asks only for the given buckets and is ok only when all of them are reachable', async () => {
    const checkBuckets = vi.fn(async (kinds: readonly BucketKind[] = []) =>
      Object.fromEntries(kinds.map((kind) => [kind, kind !== 'logs'])),
    )

    await expect(s3Check(() => ({ checkBuckets }), ['inbox', 'sessions'])()).resolves.toBe(true)
    await expect(s3Check(() => ({ checkBuckets }), ['inbox', 'logs'])()).resolves.toBe(false)
    expect(checkBuckets.mock.calls).toEqual([[['inbox', 'sessions']], [['inbox', 'logs']]])
  })

  it('s3 fails when a bucket is missing from the answer', async () => {
    const checkBuckets = async () => ({ inbox: true })
    await expect(s3Check(() => ({ checkBuckets }), ['inbox', 'logs'])()).resolves.toBe(false)
  })

  it('vault is ok when initialized and unsealed, a standby node included', async () => {
    const vault = (initialized: boolean, sealed: boolean) =>
      vaultCheck(() => ({
        health: async () => ({ initialized, sealed, standby: true, version: '2.6.0' }),
      }))

    await expect(vault(true, false)()).resolves.toBe(true)
    await expect(vault(true, true)()).resolves.toBe(false)
    await expect(vault(false, true)()).resolves.toBe(false)
  })
})
