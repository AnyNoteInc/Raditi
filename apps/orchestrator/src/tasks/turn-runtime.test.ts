import { afterEach, describe, expect, it, vi } from 'vitest'

import { LivePasses } from './live-passes.ts'
import { TaskSweepRuntime } from './task-sweep.ts'
import { turnInstructions } from './turn-instructions.ts'
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

describe('TaskSweepRuntime', () => {
  it('sweeps only in running applications, one pass at a time', async () => {
    let finish!: () => void
    const tick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    expect(new TaskSweepRuntime({ tick }, false).onApplicationBootstrap()).toBeUndefined()
    expect(tick).not.toHaveBeenCalled()

    const runtime = new TaskSweepRuntime({ tick }, true)
    runtime.onApplicationBootstrap()
    const second = runtime.tick()
    expect(tick).toHaveBeenCalledTimes(1)
    finish()
    await second
    await runtime.onModuleDestroy()
  })
})

describe('LivePasses', () => {
  it('stops the live pass of a task and lets one pass in at a time', () => {
    const live = new LivePasses()
    const controller = live.enter('task')!
    expect(live.enter('task')).toBeNull()
    expect(live.has('task')).toBe(true)
    expect(live.abort('task')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    live.leave('task', new AbortController())
    expect(live.has('task')).toBe(true)
    live.leave('task', controller)
    expect(live.abort('task')).toBe(false)
  })
})

describe('turnInstructions', () => {
  it('names the preview the browser tools open, or why there is none', () => {
    expect(
      turnInstructions({ state: 'serving', origin: 'http://site-a-chat-b.localhost:8090' }),
    ).toContain('http://site-a-chat-b.localhost:8090')
    expect(turnInstructions({ state: 'unavailable', reason: 'no_database' })).toContain(
      'no database',
    )
    const rules = turnInstructions({ state: 'absent' })
    expect(rules).toContain('«вы»')
    expect(rules).toContain('.gitea/')
    // What a release cannot carry is said to the client, not worked around (plan 53, Р3).
    expect(rules).toContain('## What a release can carry')
    expect(rules).toContain('no menus, widgets')
    expect(rules).not.toContain('{{database}}')
  })

  it("says the calls of the site's stack only as its adapter words them (rule 8)", () => {
    const bare = turnInstructions({ state: 'absent' })
    // Nothing of a stack in the rules of the platform: no routes, no code of a CMS.
    for (const words of ['/wp/v2', '$wpdb', 'dbDelta']) expect(bare).not.toContain(words)
    const guide = '- On this site: a stack of a test — `wp_rest` POST /x.\n'
    const told = turnInstructions({ state: 'absent' }, { names: [], hosts: [] }, guide)
    expect(told).toContain(`table of the platform created or extended.\n${guide}- A new page`)
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
