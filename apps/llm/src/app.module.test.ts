import { Logger } from '@nestjs/common'
import type { TestingModule } from '@nestjs/testing'
import type { SecretStore } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LlmRoleConfig } from './config/config.ts'
import type * as EgressModule from './egress/egress.ts'
import type * as EgressProbeModule from './egress/egress-probe.ts'
import { testRole, testRoleConfig as config } from './testing/role.ts'

// The role as AppModule builds it, over fakes of what reaches outside the process: the order it
// starts and stops in is a property of the composition (LlmRuntime).
const fakes = vi.hoisted(() => ({
  collectLost: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  createGateway: vi.fn(),
  createTransport: vi.fn(),
  transportRequest: vi.fn(),
  createControlEgress: vi.fn(),
  createProbe: vi.fn(),
  probe: vi.fn(),
  poolTick: vi.fn(),
  poolClose: vi.fn(),
}))
vi.mock('./accounting/gateway-store.ts', () => ({
  PostgresGatewayStore: class {
    collectLost = fakes.collectLost
  },
}))
vi.mock('./gateway/server.ts', () => ({ createLlmGateway: fakes.createGateway }))
vi.mock('./egress/egress.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressModule>()),
  createEgressTransport: (...args: unknown[]) => {
    fakes.createTransport(...args)
    return { request: fakes.transportRequest }
  },
  createControlEgress: fakes.createControlEgress,
}))
vi.mock('./egress/egress-probe.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressProbeModule>()),
  createEgressProbe: fakes.createProbe,
}))
vi.mock('./pool/pool-health.ts', () => ({
  SubscriptionPoolHealth: class {
    recheckRegion = vi.fn().mockResolvedValue(false)
    tick = fakes.poolTick
    close = fakes.poolClose
  },
}))

import { AppModule } from './app.module.ts'
import { LlmRuntime } from './gateway/llm-runtime.ts'
import type { LlmGatewayOptions } from './gateway/server.ts'

const role = (
  roleConfig: LlmRoleConfig,
  prisma: object = { $disconnect: vi.fn() },
  secrets: Partial<SecretStore> = {},
): Promise<TestingModule> =>
  testRole([AppModule.forRoot(roleConfig)], { prisma, secrets }).compile()

// A database and a Vault that answer the health probe of the role.
const answering = () => ({
  prisma: { $disconnect: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([]) },
  secrets: {
    health: vi.fn().mockResolvedValue({ initialized: true, sealed: false }),
  } as Partial<SecretStore>,
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
    fakes.poolTick.mockResolvedValue(undefined)
    fakes.poolClose.mockResolvedValue(undefined)
  })

  it('collects lost reservations before listening and serves without a proxy', async () => {
    const prisma = { $disconnect: vi.fn() }
    const app = await role(config(), prisma)
    await app.get(LlmRuntime).listen()
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
    await app.close()
    expect(prisma.$disconnect).toHaveBeenCalledOnce()
  })

  it.each([
    [false, 'direct'],
    [true, 'proxy'],
  ] as const)(
    'says at start which way it goes to the providers (proxy configured: %s)',
    async (withEgress, path) => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
      const app = await role(config(withEgress))
      await app.get(LlmRuntime).listen()
      // An operator who lost the proxy variables reads it here: the role serves either way.
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_egress_path', path }))
      log.mockRestore()
      await app.close()
    },
  )

  it('waits for the initial egress probe before listening and opens admission only after success', async () => {
    vi.useFakeTimers()
    const passed = Promise.withResolvers<boolean>()
    fakes.probe.mockReturnValueOnce(passed.promise)
    const app = await role(config(true))
    const listening = app.get(LlmRuntime).listen()
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
    await app.close()
  })

  it('starts with admission closed and answers degraded when the first scan for lost calls fails', async () => {
    fakes.collectLost.mockRejectedValue(new Error('private-database-error'))
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { prisma, secrets } = answering()
    const app = await role(config(), prisma, secrets)
    await app.get(LlmRuntime).listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    // The database and Vault answer the probe: the collector alone closes both.
    expect(options.ready?.()).toBe(false)
    expect(await options.health?.()).toBe(false)
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_collector_failed' }))
    warn.mockRestore()
    await app.close()
  })

  it('scans for lost calls every 30 s once listening and reopens admission only after a fresh scan in time', async () => {
    vi.useFakeTimers()
    let resolveScan: () => void = () => {}
    fakes.collectLost.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveScan = resolve
        }),
    )
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const app = await role(config(true))
    const listening = app.get(LlmRuntime).listen()
    // The first scan is bounded: the role listens with admission closed.
    await vi.advanceTimersByTimeAsync(10_000)
    await listening
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    expect(options.ready?.()).toBe(false)
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_collector_timeout' }))
    // The runtime's own interval finds the hung scan still running and starts no second one.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fakes.collectLost).toHaveBeenCalledOnce()
    resolveScan()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.ready?.()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fakes.collectLost).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(true)
    warn.mockRestore()
    await app.close()
  })

  it('probes the channel on its own schedule once listening and again within seconds after a failure', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const app = await role(config(true))
    await app.get(LlmRuntime).listen()
    const options = fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions
    expect(fakes.probe).toHaveBeenCalledOnce()
    fakes.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    // One failed probe does not close admission; the next comes in seconds, not in five minutes.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fakes.probe).toHaveBeenCalledTimes(2)
    expect(options.ready?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fakes.probe).toHaveBeenCalledTimes(3)
    expect(options.ready?.()).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fakes.probe).toHaveBeenCalledTimes(4)
    expect(options.ready?.()).toBe(true)
    warn.mockRestore()
    await app.close()
  })

  it('answers /health from the transport of the role: degraded, with admission left open, while its own connections to a provider fail', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { prisma, secrets } = answering()
    const app = await role(config(), prisma, secrets)
    await app.get(LlmRuntime).listen()
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
    warn.mockRestore()
    await app.close()
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
    const app = await role(config(), { $disconnect: disconnect })
    await app.get(LlmRuntime).listen()
    const closing = app.close()
    // Nest reaches the hook of the runtime after the hooks it runs first.
    await vi.waitFor(() => expect(fakes.close).toHaveBeenCalledOnce())
    expect(disconnect).not.toHaveBeenCalled()
    unblock()
    await closing
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('bounds collector and database shutdown even when established queries stay stuck', async () => {
    vi.useFakeTimers()
    const disconnect = vi.fn(() => new Promise<void>(() => {}))
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const app = await role(config(), { $disconnect: disconnect })
    await app.get(LlmRuntime).listen()
    fakes.collectLost.mockImplementationOnce(() => new Promise<void>(() => {}))
    await vi.advanceTimersByTimeAsync(30_000)
    const closing = app.close()
    await vi.advanceTimersByTimeAsync(3000)
    await closing
    expect(disconnect).toHaveBeenCalledOnce()
    expect((fakes.createGateway.mock.calls[0]![0] as LlmGatewayOptions).ready?.()).toBe(false)
    // The pool the stuck query holds is given up with a word, not waited for.
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'llm_database_shutdown_timeout' }))
    warn.mockRestore()
  })

  it('closes maintenance and drains running jobs before disconnecting SQL', async () => {
    vi.useFakeTimers()
    const ticked = Promise.withResolvers<void>()
    fakes.poolTick.mockReturnValueOnce(ticked.promise)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const app = await role(config(true), { $disconnect: disconnect })
    await app.get(LlmRuntime).listen()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakes.poolTick).toHaveBeenCalledOnce()
    const closing = app.close()
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
