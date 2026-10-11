import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { llmBackends } from '@repo/llm-backends'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { EgressConfig } from '../config/llm-config.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import { createEgressProbe, EgressHealth, egressProbeBytes } from './egress-probe.ts'

const certificates = createLlmTestCertificates()
afterAll(() => certificates.close())

async function fixture(options: { bytes?: number; status?: number; stall?: boolean } = {}) {
  const requests: string[] = []
  const server = createServer(
    {
      cert: readFileSync(certificates.certFile),
      key: readFileSync(certificates.keyFile),
      ca: readFileSync(certificates.certFile),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    (req, res) => {
      requests.push(`${req.method} ${req.url}`)
      res.writeHead(options.status ?? 200, { 'content-type': 'application/octet-stream' })
      if (options.stall) res.write('synthetic')
      else res.end(Buffer.alloc(options.bytes ?? egressProbeBytes))
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config: EgressConfig = {
    proxyUrl: new URL(`https://127.0.0.1:${(server.address() as { port: number }).port}`),
    caFile: certificates.certFile,
    clientCertFile: certificates.certFile,
    clientKeyFile: certificates.keyFile,
    upstreamCaFile: null,
    backendOrigins: new Map(),
  }
  return {
    config,
    requests,
    async close() {
      server.closeAllConnections()
      const closed = once(server, 'close')
      server.close()
      await closed
    },
  }
}

describe('authenticated egress channel probe', () => {
  it('requires exactly 64 KiB from the proxy over mTLS', async () => {
    const f = await fixture()
    try {
      expect(await createEgressProbe(f.config).check(AbortSignal.timeout(2000))).toBe(true)
      expect(f.requests).toEqual(['GET /probe?bytes=65536'])
    } finally {
      await f.close()
    }
  })

  it.each([
    { bytes: egressProbeBytes - 1 },
    { bytes: egressProbeBytes + 1 },
    { status: 302 },
    { status: 500 },
    { stall: true },
  ])(
    'keeps the channel closed for incomplete, excessive, redirected or stalled responses: %j',
    async (options) => {
      const f = await fixture(options)
      try {
        expect(await createEgressProbe(f.config).check(AbortSignal.timeout(150))).toBe(false)
        expect(f.requests).toHaveLength(1)
      } finally {
        await f.close()
      }
    },
  )

  it('has nothing to probe without a proxy: the role then opens no connection of its own accord', async () => {
    // Every origin the adapters declare points at this listener, so whatever a probe of the
    // direct path opened of its own accord would be counted here, before any TLS, and could
    // not reach a provider from a test run.
    let connections = 0
    const listener = createTcpServer((socket) => {
      connections += 1
      socket.destroy()
    })
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const { port } = listener.address() as AddressInfo
    const direct: EgressConfig = {
      proxyUrl: null,
      upstreamCaFile: certificates.certFile,
      backendOrigins: new Map(
        llmBackends.flatMap((backend) =>
          backend.egress.map((entry) => [entry.origin, `https://localhost:${port}`] as const),
        ),
      ),
    }
    try {
      // Every origin an adapter declares points at the listener: none is left to its real address.
      expect(direct.backendOrigins.size).toBeGreaterThan(0)
      expect(await createEgressProbe(direct).check(AbortSignal.timeout(2000))).toBe(true)
      // Long enough for a connection opened behind the answer to arrive.
      await delay(150)
      expect(connections).toBe(0)
      // The count is no decoration: a connection to that very address is seen.
      const socket = connect(port, 'localhost')
      socket.on('error', () => {})
      await vi.waitFor(() => expect(connections).toBe(1))
      socket.destroy()
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  })

  it('rejects an untrusted client', async () => {
    const f = await fixture()
    try {
      expect(
        await createEgressProbe({
          ...f.config,
          clientCertFile: certificates.otherCertFile,
          clientKeyFile: certificates.otherKeyFile,
        }).check(AbortSignal.timeout(2000)),
      ).toBe(false)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })
})

describe('egress readiness', () => {
  it('coalesces probes and permits refresh only after a successful channel check', async () => {
    const answer = Promise.withResolvers<boolean>()
    const check = vi.fn(() => answer.promise)
    const health = new EgressHealth({ check })
    expect(health.healthy()).toBe(false)
    const first = health.check()
    const second = health.check()
    await Promise.resolve()
    expect(check).toHaveBeenCalledOnce()
    answer.resolve(true)
    await Promise.all([first, second])
    expect(health.healthy()).toBe(true)
    await health.close()
    expect(health.healthy()).toBe(false)
  })

  it('keeps a confirmed region block through healthy channel probes until a provider recheck', async () => {
    let now = 0
    const answer = Promise.withResolvers<boolean>()
    const check = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => answer.promise)
      .mockResolvedValue(true)
    const health = new EgressHealth({ check }, undefined, () => now)
    await health.check()
    const pending = health.check()
    health.blockRegion('synthetic-account')
    answer.resolve(true)
    await pending
    expect(health.healthy()).toBe(false)
    // The byte probe proves only the channel to egress-1, never the provider's region.
    await health.check()
    expect(health.healthy()).toBe(false)
    expect(health.reachable()).toBe(true)
    expect(health.regionRecheck()).toBeNull()
    now += 10 * 60_000 - 1
    expect(health.regionRecheck()).toBeNull()
    expect(health.nextCheckMs()).toBe(1_000)
    now += 1
    const recheck = health.regionRecheck()
    expect(recheck).toMatchObject({ accountId: 'synthetic-account' })
    // One recheck at a time; an unsuccessful one is repeated ten minutes later.
    expect(health.regionRecheck()).toBeNull()
    expect(health.nextCheckMs()).toBe(5 * 60_000)
    // A region confirmed again while the recheck ran outlives that recheck.
    health.blockRegion('synthetic-account')
    health.clearRegion(recheck!.revision)
    expect(health.healthy()).toBe(false)
    now += 10 * 60_000
    const fresh = health.regionRecheck()!
    health.clearRegion(fresh.revision)
    expect(health.healthy()).toBe(true)
    await health.close()
  })

  it('offers no region recheck over an unreachable channel', async () => {
    let now = 0
    const health = new EgressHealth(
      { check: vi.fn().mockResolvedValue(false) },
      undefined,
      () => now,
    )
    health.blockRegion('synthetic-account')
    now += 60 * 60_000
    await health.check()
    expect(health.reachable()).toBe(false)
    expect(health.regionRecheck()).toBeNull()
    await health.close()
  })

  it('tolerates one failed probe of a healthy channel and retries within seconds', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const health = new EgressHealth({ check })
    await health.check()
    expect(health.nextCheckMs()).toBe(5 * 60_000)
    await health.check()
    expect(health.healthy()).toBe(true)
    expect(health.nextCheckMs()).toBe(5_000)
    await health.check()
    expect(health.healthy()).toBe(true)
    expect(health.nextCheckMs()).toBe(5 * 60_000)
    const delays: number[] = []
    for (let failure = 0; failure < 4; failure += 1) {
      await health.check()
      delays.push(health.nextCheckMs())
      expect(health.healthy()).toBe(failure === 0)
    }
    expect(delays).toEqual([5_000, 15_000, 30_000, 30_000])
    await health.check()
    expect(health.healthy()).toBe(true)
    expect(health.nextCheckMs()).toBe(5 * 60_000)
    await health.close()
  })

  it('opens a channel that was never healthy only after a successful probe', async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const health = new EgressHealth({ check })
    await health.check()
    expect(health.healthy()).toBe(false)
    expect(health.nextCheckMs()).toBe(5_000)
    await health.check()
    expect(health.healthy()).toBe(true)
    await health.close()
  })

  it('reads three connections of its own in a row that never opened as a provider out of reach', async () => {
    let now = 0
    const logger = { warn: vi.fn() }
    const health = new EgressHealth({ check: vi.fn().mockResolvedValue(true) }, logger, () => now)
    await health.check()
    expect(health.directReachable()).toBe(true)
    health.observeDirect(false)
    health.observeDirect(false)
    expect(health.directReachable()).toBe(true)
    // One that opened in between starts the count again.
    health.observeDirect(true)
    health.observeDirect(false)
    health.observeDirect(false)
    expect(health.directReachable()).toBe(true)
    health.observeDirect(false)
    expect(health.directReachable()).toBe(false)
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'llm_egress_direct_unreachable' }),
    )
    // A sign for the health answer alone: admission and provider traffic stay open, and the
    // next request that gets through is what restores it.
    expect(health.healthy()).toBe(true)
    health.observeDirect(false)
    expect(logger.warn).toHaveBeenCalledOnce()
    health.observeDirect(true)
    expect(health.directReachable()).toBe(true)
    // With nothing tried for five minutes nothing is known any longer.
    for (let failure = 0; failure < 3; failure++) health.observeDirect(false)
    now += 5 * 60_000 - 1
    expect(health.directReachable()).toBe(false)
    now += 1
    expect(health.directReachable()).toBe(true)
    await health.close()
  })

  it('bounds a hung probe and fails readiness closed', async () => {
    vi.useFakeTimers()
    const health = new EgressHealth({ check: () => new Promise(() => {}) })
    try {
      const pending = health.check()
      await vi.advanceTimersByTimeAsync(15_000)
      await pending
      expect(health.healthy()).toBe(false)
    } finally {
      await health.close()
      vi.useRealTimers()
    }
  })
})
