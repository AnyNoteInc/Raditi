import type {
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SiteLeaseAuthority,
  SiteLeaseStore,
  TurnAssignment,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { TurnReconciler } from './turn-reconciler.ts'

function fixture() {
  const item: SandboxInfo = {
    id: 'exact-container-id',
    labels: {
      workspaceId: 'ws',
      siteId: 'site',
      taskId: 'task',
      sessionId: 'session',
      turn: 1,
      leaseEpoch: 1,
    },
    createdAt: new Date(),
  }
  const authority: SiteLeaseAuthority = {
    siteId: 'site',
    taskId: 'task',
    operation: 'turn',
    epoch: 1,
    serverNow: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    heldForOperator: false,
  }
  const destroy = vi.fn(async () => {})
  const sandbox = { id: item.id, labels: item.labels, destroy } as unknown as Sandbox
  const sandboxes = {
    list: vi.fn(async () => [item]),
    getForRemoval: vi.fn(async () => sandbox),
  } as unknown as SandboxProvider
  const inspect = vi.fn(async (): Promise<SiteLeaseAuthority | null> => authority)
  const leases = { inspect } as unknown as SiteLeaseStore
  const owners: TurnAssignment[] = []
  const unfinished = vi.fn(async () => owners)
  return {
    item,
    authority,
    sandbox,
    sandboxes,
    inspect,
    destroy,
    owners,
    unfinished,
    reconcile: () => new TurnReconciler(sandboxes, leases, { unfinished }).reconcile(),
  }
}

/** The turn's assignment after recovery took it over under epoch 2. */
const adoptedBy = (containerId: string | null, epoch = 2) =>
  ({
    fence: { siteId: 'site', taskId: 'task', operation: 'turn', epoch },
    firstEpoch: 1,
    sessionId: 'session',
    turn: 1,
    containerId,
  }) as TurnAssignment

describe('turn reconciler', () => {
  it('preserves containers backed by a live matching epoch', async () => {
    const f = fixture()
    expect(await f.reconcile()).toEqual({ removed: [], preserved: [f.item.id], uncertain: [] })
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it.each(['orphan', 'expired', 'old-epoch', 'held'] as const)(
    'removes a proven %s container by its exact id',
    async (kind) => {
      const f = fixture()
      if (kind === 'orphan') f.inspect.mockResolvedValue(null)
      if (kind === 'expired') f.authority.expiresAt = new Date(0)
      if (kind === 'old-epoch') f.authority.epoch = 2
      if (kind === 'held') f.authority.heldForOperator = true
      expect((await f.reconcile()).removed).toEqual([f.item.id])
      expect(f.sandboxes.getForRemoval).toHaveBeenCalledWith(f.item.id)
      expect(f.destroy).toHaveBeenCalledWith('gc')
    },
  )

  it('does not infer expiry when lease authority is unavailable', async () => {
    const f = fixture()
    f.inspect.mockRejectedValue(new Error('database unavailable'))
    expect((await f.reconcile()).uncertain).toEqual([f.item.id])
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it('rechecks authority immediately before deletion', async () => {
    const f = fixture()
    f.inspect.mockResolvedValueOnce(null)
    expect((await f.reconcile()).preserved).toEqual([f.item.id])
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it('refuses a reused container name resolving to another immutable id', async () => {
    const f = fixture()
    f.inspect.mockResolvedValue(null)
    vi.mocked(f.sandboxes.getForRemoval).mockResolvedValue({ ...f.sandbox, id: 'different-id' })
    expect((await f.reconcile()).uncertain).toEqual([f.item.id])
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it('keeps a container recovery took over under the current epoch', async () => {
    const f = fixture()
    f.authority.epoch = 2
    f.owners.push(adoptedBy(f.item.id))
    expect((await f.reconcile()).preserved).toEqual([f.item.id])
    f.owners.splice(0, 1, adoptedBy(null))
    expect((await f.reconcile()).preserved).toEqual([f.item.id])
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it.each(['another container', 'an older takeover', 'held', 'no owner'] as const)(
    'removes a container of an older epoch when recovery holds %s',
    async (kind) => {
      const f = fixture()
      f.authority.epoch = 2
      if (kind === 'another container') f.owners.push(adoptedBy('other-container'))
      if (kind === 'an older takeover') {
        f.authority.epoch = 3
        f.owners.push(adoptedBy(f.item.id))
      }
      if (kind === 'held') {
        f.owners.push(adoptedBy(f.item.id))
        f.authority.heldForOperator = true
      }
      expect((await f.reconcile()).removed).toEqual([f.item.id])
    },
  )

  it('removes nothing while the owners are unknown', async () => {
    const f = fixture()
    f.inspect.mockResolvedValue(null)
    f.unfinished.mockRejectedValue(new Error('database unavailable'))
    expect(await f.reconcile()).toEqual({ removed: [], preserved: [], uncertain: [f.item.id] })
    expect(f.destroy).not.toHaveBeenCalled()
  })

  it('preserves legacy labels when the same task still holds the site', async () => {
    const f = fixture()
    delete f.item.labels.leaseEpoch
    expect((await f.reconcile()).preserved).toEqual([f.item.id])
    expect(f.destroy).not.toHaveBeenCalled()
  })
})
