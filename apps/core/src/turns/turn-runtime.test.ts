import { afterEach, describe, expect, it, vi } from 'vitest'

import { TurnRuntime, turnRuntimeOf } from './turn-runtime.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('TurnRuntime', () => {
  it('starts nothing in tests and tools', async () => {
    const recovery = { start: vi.fn(), stop: vi.fn(async () => {}) }
    const reconciler = {
      reconcile: vi.fn(async () => ({ removed: [], preserved: [], uncertain: [] })),
    }
    const runtime = new TurnRuntime(recovery, reconciler, false)

    runtime.onApplicationBootstrap()

    expect(recovery.start).not.toHaveBeenCalled()
    expect(reconciler.reconcile).not.toHaveBeenCalled()
    await runtime.onModuleDestroy()
    expect(recovery.stop).toHaveBeenCalledTimes(1)
  })

  it('starts recovery and the reconciler of the local executor, and stops them', async () => {
    const recovery = { start: vi.fn(), stop: vi.fn(async () => {}) }
    const reconciler = {
      reconcile: vi.fn(async () => ({ removed: [], preserved: [], uncertain: [] })),
    }
    const runtime = new TurnRuntime(recovery, reconciler, true)

    runtime.onApplicationBootstrap()
    await runtime.reconcile()

    expect(recovery.start).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalled()
    await runtime.onModuleDestroy()
    expect(recovery.stop).toHaveBeenCalledTimes(1)
  })

  it('logs a failed reconcile without its message and runs without git or a reconciler', async () => {
    const warn = vi.fn()
    const runtime = new TurnRuntime(
      null,
      { reconcile: vi.fn(async () => Promise.reject(new Error('docker said something'))) },
      true,
      { warn },
    )
    await runtime.reconcile()
    expect(warn).toHaveBeenCalledWith('turn_reconcile_failed')
    await runtime.onModuleDestroy()
    expect(() => new TurnRuntime(null, null, true).onApplicationBootstrap()).not.toThrow()
  })
})

describe('turnRuntimeOf', () => {
  it('names the runtime of the executor that runs the turn', () => {
    const sandbox = { runtime: 'runsc' as const, socketPath: '/var/run/docker.sock' }
    expect(turnRuntimeOf({ appEnv: 'development', sandbox, runnerRuntime: undefined })).toBe(
      'runsc',
    )
    // A gVisor runner of a stand (Colima) outside production.
    expect(turnRuntimeOf({ appEnv: 'development', sandbox: null, runnerRuntime: 'runsc' })).toBe(
      'runsc',
    )
    expect(turnRuntimeOf({ appEnv: 'development', sandbox: null })).toBe('runc')
    expect(turnRuntimeOf({ appEnv: 'production', sandbox: null })).toBe('runsc')
  })
})
