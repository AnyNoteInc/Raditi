import type { HealthReport } from '@repo/observability'
import { describe, expect, it, vi } from 'vitest'

import { healthResponse, redisCheck, WEB_BUCKETS, type RedisProbe } from './health'

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

describe('checks', () => {
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

  it('web checks only its own buckets (spec §14)', () => {
    expect([...WEB_BUCKETS].sort()).toEqual(['artifacts', 'inbox', 'logs'])
  })
})
