import { randomUUID } from 'node:crypto'

import { MAX_SANDBOX_TURN_MS, type Sandbox, type TurnPlan } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunnerHub } from '../runner-api/runner-hub.ts'
import { loopbackTransport } from '../testing/runner-loopback.ts'
import { fence, labels } from '../testing/runner-sandbox.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RunnerCallError } from './core-client.ts'
import { RunnerReconciler } from './runner-reconciler.ts'

const hubs: RunnerHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close()
})

const otherTask = '00000000-0000-4000-8000-000000000009'
const turnLabels = { ...labels, leaseEpoch: 1 }
const orphanLabels = { ...labels, taskId: otherTask, leaseEpoch: 1 }

function fakeDocker() {
  const containers = {
    owned: turnLabels,
    orphan: orphanLabels,
    changed: orphanLabels,
    held: orphanLabels,
  }
  const sandboxes = new Map<string, Sandbox>(
    Object.entries(containers).map(([id, containerLabels]) => [
      id,
      {
        id,
        // The container found under `changed` now carries other labels.
        labels: id === 'changed' ? { ...containerLabels, turn: 7 } : containerLabels,
        destroy: vi.fn(async () => {}),
      } as unknown as Sandbox,
    ]),
  )
  return {
    sandboxes,
    provider: {
      kind: 'docker' as const,
      create: vi.fn(),
      // Nothing here is taken to work in: the reconciler only removes.
      get: vi.fn(async () => null),
      getForRemoval: vi.fn(async (id: string) => sandboxes.get(id) ?? null),
      list: vi.fn(async () =>
        Object.entries(containers).map(([id, containerLabels]) => ({
          id,
          labels: containerLabels,
          createdAt: new Date(),
        })),
      ),
    },
  }
}

describe('RunnerReconciler', () => {
  it('removes only orphans it reported, holds no turn of and whose identity is unchanged', async () => {
    const assignments = new MemoryTurnAssignments()
    const hub = new RunnerHub({
      assignments,
      leases: { assert: vi.fn() },
      logger: { warn: vi.fn() },
    })
    hubs.push(hub)
    const session = randomUUID()
    const assignment = (await assignments.open({
      fence,
      sessionId: labels.sessionId,
      turn: labels.turn,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!
    await assignments.claim({
      ids: [assignment.id],
      runnerId: 'sandbox-1',
      runnerSession: session,
      limit: 1,
    })
    const docker = fakeDocker()
    const reconciler = new RunnerReconciler({
      runner: { session, holds: (id) => id === 'held' },
      transport: loopbackTransport(hub),
      sandboxes: docker.provider,
    })

    expect(await reconciler.reconcile()).toEqual({
      removed: ['orphan'],
      kept: ['held'],
      uncertain: ['changed'],
    })
    expect(docker.sandboxes.get('orphan')!.destroy).toHaveBeenCalledWith('gc')
    for (const id of ['owned', 'changed', 'held'])
      expect(docker.sandboxes.get(id)!.destroy).not.toHaveBeenCalled()
  })

  it('removes nothing while core cannot tell the owners', async () => {
    const docker = fakeDocker()
    const reconciler = new RunnerReconciler({
      runner: { session: randomUUID(), holds: () => false },
      transport: {
        reconcile: vi.fn(async () => {
          throw new RunnerCallError('reconcile', 503, { error: 'UNAVAILABLE' })
        }),
      },
      sandboxes: docker.provider,
      logger: { warn: vi.fn() },
    })

    await expect(reconciler.reconcile()).rejects.toBeInstanceOf(RunnerCallError)
    expect(docker.provider.getForRemoval).not.toHaveBeenCalled()
  })
})
