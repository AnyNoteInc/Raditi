import type { BucketKind } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cachedHealthProbe,
  databaseCheck,
  healthResponse,
  redisCheck,
  runHealthChecks,
  s3Check,
  throttledHealthLogger,
  vaultCheck,
  WEB_BUCKETS,
  type HealthChecks,
  type HealthReport,
  type RedisProbe,
} from './health'

afterEach(() => {
  vi.useRealTimers()
})

const passing = async () => true
const allOk: HealthChecks = { database: passing, redis: passing, s3: passing, vault: passing }

const TOKEN = 'a-metrics-token-of-at-least-32-chars'

const request = (authorization?: string) =>
  new Request('http://localhost:3000/api/health', {
    headers: authorization === undefined ? {} : { authorization },
  })

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

  it('names the failing dependencies', async () => {
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
    expect(onFailure.mock.calls.map(([name]) => name).sort()).toEqual(['database', 'redis', 's3'])
  })

  it('fails a hanging check after its timeout and still answers', async () => {
    vi.useFakeTimers()
    const report = runHealthChecks(
      { ...allOk, database: () => new Promise<boolean>(() => {}) },
      { timeoutMs: 2_000 },
    )

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(report).resolves.toEqual(degradedReport)
  })
})

describe('healthResponse', () => {
  it('answers anonymous callers with the status only', async () => {
    for (const [report, code] of [
      [okReport, 200],
      [degradedReport, 503],
    ] as const) {
      for (const authorization of [undefined, 'Bearer wrong-token', `Basic ${TOKEN}`, TOKEN]) {
        const res = await healthResponse(request(authorization), {
          probe: async () => report,
          token: TOKEN,
        })

        expect(res.status).toBe(code)
        expect(res.headers.get('cache-control')).toBe('no-store')
        await expect(res.json()).resolves.toEqual({ status: report.status })
      }
    }
  })

  it('shows the per-dependency checks with the metrics token', async () => {
    const ok = await healthResponse(request(`Bearer ${TOKEN}`), {
      probe: async () => okReport,
      token: TOKEN,
    })
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toEqual(okReport)

    const degraded = await healthResponse(request(`Bearer ${TOKEN}`), {
      probe: async () => degradedReport,
      token: TOKEN,
    })
    expect(degraded.status).toBe(503)
    await expect(degraded.json()).resolves.toEqual(degradedReport)
  })

  it('shows no details to anyone when no token is configured', async () => {
    const res = await healthResponse(request('Bearer '), {
      probe: async () => okReport,
      token: undefined,
    })
    await expect(res.json()).resolves.toEqual({ status: 'ok' })
  })
})

describe('cachedHealthProbe', () => {
  const countingChecks = () => {
    const database = vi.fn(async () => true)
    return { database, checks: { ...allOk, database } }
  }

  it('reuses a report for the cache period, then runs the checks again', async () => {
    let now = 0
    const { database, checks } = countingChecks()
    const probe = cachedHealthProbe(checks, { ttlMs: 5_000, now: () => now })

    await expect(probe()).resolves.toEqual(okReport)
    now = 4_999
    await expect(probe()).resolves.toEqual(okReport)
    expect(database).toHaveBeenCalledTimes(1)

    now = 5_000
    await probe()
    expect(database).toHaveBeenCalledTimes(2)
  })

  it('caches a failing report too', async () => {
    let now = 0
    const database = vi.fn(async () => false)
    const probe = cachedHealthProbe({ ...allOk, database }, { now: () => now })

    await expect(probe()).resolves.toEqual(degradedReport)
    now = 1_000
    await expect(probe()).resolves.toEqual(degradedReport)
    expect(database).toHaveBeenCalledTimes(1)
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

  it('redis pings and always disconnects', async () => {
    const probe = (ping: () => Promise<string>): RedisProbe => ({
      connect: vi.fn(async () => undefined),
      ping: vi.fn(ping),
      disconnect: vi.fn(),
    })
    const ok = probe(async () => 'PONG')
    const broken = probe(() => Promise.reject(new Error('Connection is closed')))

    await expect(
      redisCheck(
        () => 'redis://localhost:6379',
        () => ok,
      )(),
    ).resolves.toBe(true)
    await expect(
      redisCheck(
        () => 'redis://localhost:6379',
        () => broken,
      )(),
    ).rejects.toThrow()
    expect(ok.disconnect).toHaveBeenCalledTimes(1)
    expect(broken.disconnect).toHaveBeenCalledTimes(1)
  })

  it('redis fails without REDIS_URL', async () => {
    const connect = vi.fn()
    await expect(redisCheck(() => undefined, connect)()).rejects.toThrow('REDIS_URL')
    expect(connect).not.toHaveBeenCalled()
  })

  it('s3 asks only for the given buckets and is ok only when all of them are reachable', async () => {
    const checkBuckets = vi.fn(async (kinds: readonly BucketKind[] = []) =>
      Object.fromEntries(kinds.map((kind) => [kind, kind !== 'logs'])),
    )

    await expect(s3Check(() => ({ checkBuckets }), ['inbox', 'artifacts'])()).resolves.toBe(true)
    await expect(s3Check(() => ({ checkBuckets }), WEB_BUCKETS)()).resolves.toBe(false)
    expect(checkBuckets.mock.calls).toEqual([[['inbox', 'artifacts']], [WEB_BUCKETS]])
    // A bucket missing from the answer counts as unreachable.
    await expect(s3Check(() => ({ checkBuckets: async () => ({}) }), ['inbox'])()).resolves.toBe(
      false,
    )
  })

  it('web checks only its own buckets (spec §14)', () => {
    expect([...WEB_BUCKETS].sort()).toEqual(['artifacts', 'inbox', 'logs'])
  })

  it('vault is ok when initialized and unsealed', async () => {
    const vault = (initialized: boolean, sealed: boolean) =>
      vaultCheck(() => ({
        health: async () => ({ initialized, sealed, standby: false, version: '2.4.0' }),
      }))

    await expect(vault(true, false)()).resolves.toBe(true)
    await expect(vault(true, true)()).resolves.toBe(false)
    await expect(vault(false, true)()).resolves.toBe(false)
  })
})

describe('throttledHealthLogger', () => {
  it('logs a failing dependency at most once a minute', () => {
    const log = vi.fn()
    let now = 0
    const onFailure = throttledHealthLogger(log, () => now)

    onFailure('redis', new Error('ECONNREFUSED'))
    onFailure('redis', new Error('ECONNREFUSED'))
    onFailure('vault', new Error('timed out'))
    now = 60_000
    onFailure('redis', new Error('ECONNREFUSED'))

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[health] redis is unavailable: ECONNREFUSED',
      '[health] vault is unavailable: timed out',
      '[health] redis is unavailable: ECONNREFUSED',
    ])
  })
})
