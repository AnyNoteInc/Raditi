import { randomUUID } from 'node:crypto'

import type { Sandbox } from '@repo/domain'
import { labels } from '@repo/local-turns/testing'
import { describe, expect, it, vi } from 'vitest'

import { RunnerCallError } from '../core-api/core-client.ts'
import { RunnerReconciler } from './runner-reconciler.ts'

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
    const session = randomUUID()
    // Core found an unfinished assignment for `owned` only: it names the other three.
    const transport = { reconcile: vi.fn(async () => ({ remove: ['orphan', 'changed', 'held'] })) }
    const docker = fakeDocker()
    const reconciler = new RunnerReconciler({
      runner: { session, holds: (id) => id === 'held' },
      transport,
      sandboxes: docker.provider,
    })

    expect(await reconciler.reconcile()).toEqual({
      removed: ['orphan'],
      kept: ['held'],
      uncertain: ['changed'],
    })
    expect(transport.reconcile).toHaveBeenCalledExactlyOnceWith({
      runnerSession: session,
      inventory: ['owned', 'orphan', 'changed', 'held'].map((containerId) => ({
        containerId,
        labels: containerId === 'owned' ? turnLabels : orphanLabels,
        ageMs: expect.any(Number),
      })),
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
