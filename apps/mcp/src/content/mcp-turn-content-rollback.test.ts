import { randomUUID } from 'node:crypto'

import { conflict, leaseLost } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import type { McpHostScope } from '../access/mcp-access.ts'
import type { McpContentService } from './mcp-content.ts'
import type { PostgresMcpJournal } from './mcp-journal.ts'
import { McpTurnContentRollback } from './mcp-turn-content-rollback.ts'

function fixture() {
  const fence = {
    siteId: randomUUID(),
    taskId: randomUUID(),
    operation: 'turn' as const,
    epoch: 4,
  }
  const scope: McpHostScope = {
    siteId: fence.siteId,
    workspaceId: randomUUID(),
    stack: 'wordpress',
    url: 'https://site.example.test/',
    targetTaskId: fence.taskId,
    fence,
  }
  const hostScope = vi.fn<PostgresMcpJournal['hostScope']>(async () => scope)
  const targets = vi.fn<PostgresMcpJournal['replacementTargets']>(async () => [2, 1])
  const rollbackTurn = vi.fn<McpContentService['rollbackTurn']>(async () => [])
  const service = new McpTurnContentRollback(
    { hostScope, replacementTargets: targets } as unknown as PostgresMcpJournal,
    { rollbackTurn } as unknown as McpContentService,
  )
  const input = { fence, turn: 2 }
  return { scope, fence, hostScope, targets, rollbackTurn, service, input }
}

describe('trusted replacement content rollback', () => {
  it('is admitted by the fence of the turn lease alone: its own task is the target', async () => {
    const f = fixture()
    // A lease grant is passed as it is; its expiry and clock are not part of the fence.
    const grant = { ...f.fence, expiresAt: new Date(), serverNow: new Date() }
    await f.service.rollback({ fence: grant, turn: 2 })
    expect(f.hostScope).toHaveBeenCalledExactlyOnceWith(f.fence, f.fence.taskId)
    expect(f.targets).toHaveBeenCalledExactlyOnceWith(f.scope, 2)
    // Nothing of a turn credential is asked for or passed on.
    expect(JSON.stringify([f.hostScope.mock.calls, f.targets.mock.calls])).not.toMatch(
      /mcp_|token|keyId/i,
    )
  })

  it.each(['deploy', 'revert'] as const)(
    'refuses the fence of a %s lease before any lookup or undo',
    async (operation) => {
      const f = fixture()
      await expect(
        f.service.rollback({ ...f.input, fence: { ...f.fence, operation } }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(f.hostScope).not.toHaveBeenCalled()
      expect(f.targets).not.toHaveBeenCalled()
      expect(f.rollbackTurn).not.toHaveBeenCalled()
    },
  )

  it('refuses a fence that no longer holds the site before loading or restoring snapshots', async () => {
    const f = fixture()
    f.hostScope.mockRejectedValue(leaseLost('Synthetic stale fence'))
    await expect(f.service.rollback(f.input)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(f.targets).not.toHaveBeenCalled()
    expect(f.rollbackTurn).not.toHaveBeenCalled()
  })

  it('finishes each newer target before restoring the interrupted predecessor', async () => {
    const f = fixture()
    const restored: number[] = []
    f.rollbackTurn.mockImplementation(async (_, turn: number) => {
      restored.push(turn)
      return []
    })
    await f.service.rollback(f.input)
    expect(restored).toEqual([2, 1])
    expect(f.targets).toHaveBeenCalledWith(f.scope, 2)
  })

  it('stops the replacement at the first conflict instead of erasing an older turn', async () => {
    const f = fixture()
    f.rollbackTurn.mockRejectedValueOnce(conflict('Synthetic drift'))
    await expect(f.service.rollback(f.input)).rejects.toThrow('Synthetic drift')
    expect(f.rollbackTurn).toHaveBeenCalledOnce()
    expect(f.rollbackTurn).toHaveBeenCalledWith(f.scope, 2)
  })
})
