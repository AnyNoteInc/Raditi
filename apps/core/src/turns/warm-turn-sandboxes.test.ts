import type { PrismaClient } from '@repo/db'
import type { Sandbox } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { CoreWarmSandboxes, openTasks } from './warm-turn-sandboxes.ts'

const prismaWith = (ids: string[]) => {
  const findMany = vi.fn(async () => ids.map((id) => ({ id })))
  return { prisma: { task: { findMany } } as unknown as Pick<PrismaClient, 'task'>, findMany }
}

describe('warm containers of core', () => {
  it('keeps a container for a task that may still run a turn, on a site not deleted', async () => {
    const { prisma, findMany } = prismaWith(['task1'])
    expect(await openTasks(prisma, ['task1', 'task2'])).toEqual(new Set(['task1']))
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['task1', 'task2'] },
        status: { in: ['queued', 'preparing', 'running', 'awaiting_user', 'awaiting_approval'] },
        site: { deletedAt: null },
      },
      select: { id: true },
    })
  })

  it('removes every waiting container when core stops', async () => {
    const { prisma } = prismaWith(['task1'])
    const sandbox = {
      id: 'c1',
      labels: { workspaceId: 'w', siteId: 's', taskId: 'task1', sessionId: 'x', turn: 1 },
      reset: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    } as unknown as Sandbox
    const warm = new CoreWarmSandboxes({ get: async () => sandbox }, prisma, 10 * 60_000)
    expect(await warm.park(sandbox, 'k', Date.now() + 19 * 60_000)).toBe(true)
    await warm.onModuleDestroy()
    expect(sandbox.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c1')).toBe(false)
  })
})
