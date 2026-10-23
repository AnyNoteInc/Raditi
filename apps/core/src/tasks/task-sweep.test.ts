import { describe, expect, it, vi } from 'vitest'

import { TaskSweepRuntime } from './task-sweep.ts'

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
