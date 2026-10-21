import { Logger } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LlmRoleConfig } from '../config.ts'
import { llmConfigFromEnv } from '../llm-config.ts'
import type * as EgressModule from './egress.ts'
import type * as EgressProbeModule from './egress-probe.ts'

const fakes = vi.hoisted(() => ({
  collectLost: vi.fn(),
  createStore: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  createGateway: vi.fn(),
  createTransport: vi.fn(),
  transportRequest: vi.fn(),
  createControlEgress: vi.fn(),
  createProbe: vi.fn(),
  probe: vi.fn(),
  createPool: vi.fn(),
  poolPause: vi.fn(),
  poolObserve: vi.fn(),
  poolProbe: vi.fn(),
  poolRefresh: vi.fn(),
  poolRecheck: vi.fn(),
  poolTick: vi.fn(),
  poolClose: vi.fn(),
}))
vi.mock('../accounting/gateway-store.ts', () => ({
  PostgresGatewayStore: class {
    constructor(_db: unknown, options: unknown) {
      fakes.createStore(options)
    }
    collectLost = fakes.collectLost
  },
}))
vi.mock('./server.ts', () => ({ createLlmGateway: fakes.createGateway }))
vi.mock('./egress.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressModule>()),
  createEgressTransport: (...args: unknown[]) => {
    fakes.createTransport(...args)
    return { request: fakes.transportRequest }
  },
  createControlEgress: fakes.createControlEgress,
}))
vi.mock('./egress-probe.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressProbeModule>()),
  createEgressProbe: fakes.createProbe,
}))
vi.mock('./pool-health.ts', () => ({
  SubscriptionPoolHealth: class {
    constructor(options: unknown) {
      fakes.createPool(options)
    }
    pause = fakes.poolPause
    observe = fakes.poolObserve
    probeAccount = fakes.poolProbe
    refreshAccount = fakes.poolRefresh
    recheckRegion = fakes.poolRecheck
    tick = fakes.poolTick
    close = fakes.poolClose
  },
}))

import type { GatewayFinish } from '@repo/turn-keys'

import type { GatewayCall } from '../accounting/gateway-types.ts'
import { EgressNotDelivered } from './egress.ts'
import { LlmRuntime } from './llm-app.module.ts'
import type { LlmGatewayOptions } from './server.ts'
import type { SubscriptionPoolHealthOptions } from './pool-health.ts'

const config = (withEgress = false): LlmRoleConfig => ({
  ...llmConfigFromEnv(
    {
      ...(withEgress
        ? {
            LLM_EGRESS_PROXY_URL: 'https://127.0.0.1:8443',
            LLM_EGRESS_CA_FILE: '/test/ca.pem',
            LLM_EGRESS_CLIENT_CERT_FILE: '/test/client.pem',
            LLM_EGRESS_CLIENT_KEY_FILE: '/test/client.key',
          }
        : {}),
    },
    'test',
  ),
  db: { databaseUrl: 'postgresql://unused' },
  vault: { addr: 'http://unused' },
  metricsToken: 'test',
})

describe('llm role lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  beforeEach(() => {
    vi.resetAllMocks()
    fakes.collectLost.mockResolvedValue(0)
    fakes.listen.mockResolvedValue({ address: '127.0.0.1', port: 8084 })
    fakes.close.mockResolvedValue(undefined)
    fakes.createGateway.mockReturnValue({ listen: fakes.listen, close: fakes.close })
    fakes.createControlEgress.mockImplementation((transport: { request: unknown }) => ({
      request: transport.request,
    }))
    // As the real probe: without a proxy there is no channel of the platform to measure.
    fakes.createProbe.mockImplementation((egress: { proxyUrl: URL | null }) => ({
      check: (signal: AbortSignal) =>
        egress.proxyUrl ? fakes.probe(signal) : Promise.resolve(true),
    }))
    fakes.probe.mockResolvedValue(true)
    fakes.poolPause.mockReturnValue(null)
    fakes.poolObserve.mockResolvedValue(undefined)
    fakes.poolProbe.mockResolvedValue(null)
    fakes.poolRefresh.mockResolvedValue(null)
    fakes.poolRecheck.mockResolvedValue(false)
    fakes.poolTick.mockResolvedValue(undefined)
    fakes.poolClose.mockResolvedValue(undefined)
  })

  it('collects lost reservations before listening and serves without a proxy', async () => {
    const prisma = { $disconnect: vi.fn() } as unknown as PrismaClient
    const runtime = new LlmRuntime(config(), prisma, {} as SecretStore)
    await runtime.listen()
    expect(fakes.collectLost.mock.invocationCallOrder[0]).toBeLessThan(
      fakes.listen.mock.invocationCallOrder[0]!,
    )
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    // Nothing of the platform stands between the role and a provider, so nothing was measured;
    // what the transport may reach without the proxy is the adapters' own word (egress.test.ts).
    expect(options.ready?.()).toBe(true)
    expect(fakes.probe).not.toHaveBeenCalled()
    expect(fakes.createProbe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ proxyUrl: null }),
    )
    expect(options.backends.map((backend) => backend.id)).toEqual(['zai-coding', 'zai-api'])
    await runtime.onApplicationShutdown()
    expect(prisma.$disconnect).toHaveBeenCalledOnce()
  })

  it('answers degraded, with admission left open, while its own connections to a provider fail', async () => {
    const prisma = {
      $disconnect: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient
    const secrets = {
      health: vi.fn().mockResolvedValue({ initialized: true, sealed: false }),
    } as unknown as SecretStore
    const runtime = new LlmRuntime(config(), prisma, secrets)
    await runtime.listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    const { onDirectConnection } = fakes.createTransport.mock.calls[0]![2] as {
      onDirectConnection: (established: boolean) => void
    }
    expect(await options.health?.()).toBe(true)
    // Without a proxy nothing probes a provider: the transport's own word is the one sign.
    for (let failure = 0; failure < 3; failure++) onDirectConnection(false)
    expect(await options.health?.()).toBe(false)
    expect(options.ready?.()).toBe(true)
    onDirectConnection(true)
    expect(await options.health?.()).toBe(true)
    await runtime.onApplicationShutdown()
  })

  it.each([
    [false, 'direct'],
    [true, 'proxy'],
  ] as const)(
    'says at start which way it goes to the providers (proxy configured: %s)',
    async (withEgress, path) => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
      const runtime = new LlmRuntime(
        config(withEgress),
        { $disconnect: vi.fn() } as unknown as PrismaClient,
        {} as SecretStore,
      )
      await runtime.listen()
      // An operator who lost the proxy variables reads it here: the role serves either way.
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_egress_path', path }))
      log.mockRestore()
      await runtime.onApplicationShutdown()
    },
  )

  it('closes admission when the stale-call collector cannot read the database', async () => {
    fakes.collectLost.mockRejectedValue(new Error('private-database-error'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Every control transport is mocked; collector failure still gets a health listener.
    const runtime = new LlmRuntime(
      config(),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    expect((fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions).ready?.()).toBe(false)
    await runtime.onApplicationShutdown()
    warn.mockRestore()
  })

  it('waits for HTTP accounting to finish before closing the database pool', async () => {
    let unblock: () => void = () => {}
    fakes.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve
        }),
    )
    const disconnect = vi.fn()
    const runtime = new LlmRuntime(
      config(),
      { $disconnect: disconnect } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    const closing = runtime.onApplicationShutdown()
    expect(disconnect).not.toHaveBeenCalled()
    unblock()
    await closing
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('bounds a hung collector, keeps one scan and recovers only after a fresh successful scan', async () => {
    vi.useFakeTimers()
    let resolveScan: () => void = () => {}
    fakes.collectLost.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveScan = resolve
        }),
    )
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    const listening = runtime.listen()
    await vi.advanceTimersByTimeAsync(10_000)
    await listening
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    expect(options.ready?.()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fakes.collectLost).toHaveBeenCalledOnce()
    resolveScan()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.ready?.()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fakes.collectLost).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(true)
    await runtime.onApplicationShutdown()
  })

  it('bounds collector and database shutdown even when established queries stay stuck', async () => {
    vi.useFakeTimers()
    const disconnect = vi.fn(() => new Promise<void>(() => {}))
    const runtime = new LlmRuntime(
      config(),
      { $disconnect: disconnect } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    fakes.collectLost.mockImplementationOnce(() => new Promise<void>(() => {}))
    await vi.advanceTimersByTimeAsync(30_000)
    const closing = runtime.onApplicationShutdown()
    await vi.advanceTimersByTimeAsync(3000)
    await closing
    expect(disconnect).toHaveBeenCalledOnce()
    expect((fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions).ready?.()).toBe(false)
  })

  it('waits for the initial egress probe before listening and opens admission only after success', async () => {
    vi.useFakeTimers()
    const passed = Promise.withResolvers<boolean>()
    fakes.probe.mockReturnValueOnce(passed.promise)
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    const listening = runtime.listen()
    await vi.advanceTimersByTimeAsync(0)
    expect(fakes.probe).toHaveBeenCalledOnce()
    expect(fakes.listen).not.toHaveBeenCalled()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    expect(options.ready?.()).toBe(false)
    passed.resolve(true)
    await listening
    expect(options.ready?.()).toBe(true)
    expect(fakes.probe.mock.invocationCallOrder[0]).toBeLessThan(
      fakes.listen.mock.invocationCallOrder[0]!,
    )
    // One for provider traffic, one for the region recheck over the channel alone.
    expect(fakes.createControlEgress).toHaveBeenCalledTimes(2)
    await runtime.onApplicationShutdown()
  })

  it('keeps transport closed after a failed initial egress probe', async () => {
    fakes.probe.mockResolvedValue(false)
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    expect(options.ready?.()).toBe(false)
    await expect(
      options.egress.request(
        {
          method: 'GET',
          url: 'https://api.z.ai/api/monitor/usage/quota/limit',
          headers: new Headers(),
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(EgressNotDelivered)
    expect(fakes.transportRequest).not.toHaveBeenCalled()
    await runtime.onApplicationShutdown()
  })

  it('keeps a confirmed region closed through channel probes until an account recheck lifts it', async () => {
    vi.useFakeTimers()
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    const pool = fakes.createPool.mock.calls[0]![0] as SubscriptionPoolHealthOptions
    expect(options.ready?.()).toBe(true)
    pool.onRegion('synthetic-account')
    expect(options.ready?.()).toBe(false)
    const usage = {
      method: 'GET' as const,
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      headers: new Headers(),
    }
    const signal = new AbortController().signal
    await expect(pool.http.request(usage, { signal })).rejects.toBeInstanceOf(EgressNotDelivered)
    expect(fakes.transportRequest).not.toHaveBeenCalled()
    // Only the recheck may use the channel while the region block holds.
    fakes.transportRequest.mockResolvedValueOnce({ status: 200 })
    await pool.regionHttp!.request(usage, { signal })
    expect(fakes.transportRequest).toHaveBeenCalledOnce()
    // Healthy byte probes of the channel never reopen it.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fakes.probe).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(false)
    expect(fakes.poolRecheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fakes.poolRecheck).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(options.ready?.()).toBe(false)
    fakes.poolRecheck.mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fakes.poolRecheck).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(true)
    await runtime.onApplicationShutdown()
  })

  it('reprobes a failed channel within seconds instead of closing admission for five minutes', async () => {
    vi.useFakeTimers()
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    fakes.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fakes.probe).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fakes.probe).toHaveBeenCalledTimes(3)
    expect(options.ready?.()).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fakes.probe).toHaveBeenCalledTimes(4)
    expect(options.ready?.()).toBe(true)
    await runtime.onApplicationShutdown()
  })

  it('reports rows the gateway collector cannot close and keeps the per-key limits', async () => {
    const runtime = new LlmRuntime(
      { ...config(), maxCallsPerKey30s: 7, maxCallsPerKey: 70 },
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    const options = fakes.createStore.mock.calls[0]![0] as {
      maxRequestsPerKey: number
      maxCallsPerKey30s: number
      maxCallsPerKey: number
      logger?: { warn(message: string): void }
    }
    expect(options.maxRequestsPerKey).toBe(2)
    // The pace and the ceiling of a key come from the configuration of the role.
    expect(options).toMatchObject({ maxCallsPerKey30s: 7, maxCallsPerKey: 70 })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    options.logger!.warn('{"event":"llm_collector_row_failed","kind":"call"}')
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '{"event":"llm_collector_row_failed","kind":"call"}',
    )
    warn.mockRestore()
    await runtime.onApplicationShutdown()
  })

  it('coalesces an unfinished maintenance job across timer ticks', async () => {
    vi.useFakeTimers()
    const ticked = Promise.withResolvers<void>()
    fakes.poolTick.mockReturnValueOnce(ticked.promise)
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Five ticks of the timer found the first pass still running and started no second one.
    expect(fakes.poolTick).toHaveBeenCalledOnce()
    ticked.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakes.poolTick).toHaveBeenCalledTimes(2)
    await runtime.onApplicationShutdown()
  })

  it('forwards lifecycle calls to the bound account', async () => {
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: vi.fn() } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    const call = { accountId: 'synthetic-account', credentialVersion: 7 } as GatewayCall
    const finish = { state: 'completed' } as GatewayFinish
    fakes.poolPause.mockReturnValue({ reason: 'transient', retryAfterMs: 1000 })
    expect(options.lifecycle?.pause(call)).toEqual({ reason: 'transient', retryAfterMs: 1000 })
    await options.lifecycle?.observe(call, finish)
    expect(fakes.poolPause).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(fakes.poolObserve).toHaveBeenCalledExactlyOnceWith(call, finish)
    await options.lifecycle?.probeAccounts?.(['synthetic-account', 'other-synthetic-account'])
    // Core's issue asks because the windows are unknown, without a snapshot of its own.
    expect(fakes.poolProbe.mock.calls).toEqual([
      ['synthetic-account', {}],
      ['other-synthetic-account', {}],
    ])
    const unknownWindows = { limitsSeenAt: new Date(0) }
    await options.lifecycle?.probeAccounts?.(['synthetic-account'], unknownWindows)
    expect(fakes.poolProbe).toHaveBeenLastCalledWith('synthetic-account', unknownWindows)
    // A snapshot that has only grown old is the pool's own question: neither unknown windows
    // nor a signal waiting for its confirmation.
    await options.lifecycle?.refreshAccount?.('synthetic-account')
    expect(fakes.poolRefresh).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(fakes.poolProbe).toHaveBeenCalledTimes(3)
    await runtime.onApplicationShutdown()
  })

  it('closes maintenance and drains running jobs before disconnecting SQL', async () => {
    vi.useFakeTimers()
    const ticked = Promise.withResolvers<void>()
    fakes.poolTick.mockReturnValueOnce(ticked.promise)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const runtime = new LlmRuntime(
      config(true),
      { $disconnect: disconnect } as unknown as PrismaClient,
      {} as SecretStore,
    )
    await runtime.listen()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakes.poolTick).toHaveBeenCalledOnce()
    const closing = runtime.onApplicationShutdown()
    await vi.advanceTimersByTimeAsync(0)
    expect(fakes.poolClose).toHaveBeenCalledOnce()
    // The pass of the pool that was running at shutdown is waited for, within its bound.
    expect(disconnect).not.toHaveBeenCalled()
    ticked.resolve()
    await closing
    expect(fakes.close.mock.invocationCallOrder[0]).toBeLessThan(
      fakes.poolClose.mock.invocationCallOrder[0]!,
    )
    expect(fakes.poolClose.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]!,
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fakes.poolTick).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
