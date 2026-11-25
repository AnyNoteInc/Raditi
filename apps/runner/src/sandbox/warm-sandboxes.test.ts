import { randomUUID } from 'node:crypto'

import type { Sandbox, SandboxLabels } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { RunnerLifecycle } from '../runner-lifecycle.ts'
import { SandboxRunner } from '../sandbox-runner/sandbox-runner.ts'
import { scriptedCore } from '../testing/scripted-core.ts'
import { runnerWarmSandboxes } from './sandbox.module.ts'

const session = randomUUID()
const taskId = randomUUID()

/** The container of a completed turn, as the executor parks it. */
function completed(): Sandbox {
  const labels: SandboxLabels = {
    workspaceId: 'ws1',
    siteId: randomUUID(),
    taskId,
    sessionId: 'session1',
    turn: 1,
    leaseEpoch: 1,
  }
  return {
    id: 'warm1',
    labels,
    deadline: Date.now() + 60_000,
    reset: vi.fn(async () => {}),
    extend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  } as unknown as Sandbox
}

const pool = (openTasks: () => Promise<unknown>) =>
  runnerWarmSandboxes(
    { warmMs: 60_000, warmMax: 2 },
    { get: vi.fn(async () => null) },
    { openTasks: vi.fn(openTasks) },
    session,
  )!

describe('runnerWarmSandboxes (docs/plan/93)', () => {
  it('is off with RUNNER_SANDBOX_WARM_MINUTES=0', () => {
    expect(
      runnerWarmSandboxes(
        { warmMs: 0, warmMax: 4 },
        { get: vi.fn() },
        { openTasks: vi.fn() },
        session,
      ),
    ).toBeNull()
  })

  it('keeps a container waiting only for a task core says is open, asked under its session', async () => {
    const openTasks = vi.fn(async () => ({ open: [taskId] }))
    const warm = runnerWarmSandboxes(
      { warmMs: 60_000, warmMax: 2 },
      { get: vi.fn(async () => null) },
      { openTasks },
      session,
    )!
    const sandbox = completed()
    expect(await warm.park(sandbox, 'key')).toBe(true)
    expect(openTasks).toHaveBeenCalledWith({ runnerSession: session, taskIds: [taskId] })
    expect(warm.holds('warm1')).toBe(true)
    await warm.close()
    expect(sandbox.destroy).toHaveBeenCalledWith('completed')
    expect(warm.holds('warm1')).toBe(false)
  })

  it('removes the container when the task ended, core failed or answered what it was not asked', async () => {
    for (const answer of [
      async () => ({ open: [] }),
      async () => {
        throw new Error('core unreachable')
      },
      async () => ({ open: ['not-a-uuid'] }),
    ]) {
      const warm = pool(answer)
      expect(await warm.park(completed(), 'key')).toBe(false)
      expect(warm.holds('warm1')).toBe(false)
      await warm.close()
    }
  })

  it('a waiting container is held by the runner: no reconcile removes it', async () => {
    const warm = pool(async () => ({ open: [taskId] }))
    const runner = new SandboxRunner({
      transport: scriptedCore().transport,
      executor: { list: vi.fn(async () => []) } as never,
      maxTurns: 1,
      session,
      warm,
    })
    expect(runner.session).toBe(session)
    expect(runner.holds('warm1')).toBe(false)
    await warm.park(completed(), 'key')
    expect(runner.holds('warm1')).toBe(true)
    await warm.close()
  })

  it('the waiting containers go when the runner stops, after polling ends', async () => {
    const order: string[] = []
    const lifecycle = new RunnerLifecycle(
      { start: vi.fn(), stop: vi.fn(async () => void order.push('runner')) },
      { start: vi.fn(), stop: vi.fn(async () => void order.push('reconciler')) },
      { close: vi.fn(() => void order.push('transport')) },
      { close: vi.fn(async () => void order.push('warm')) },
    )
    await lifecycle.onApplicationShutdown()
    expect(order).toEqual(['reconciler', 'runner', 'warm', 'transport'])
  })
})
