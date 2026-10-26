import { Logger, type OnModuleDestroy } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SandboxProvider } from '@repo/domain'
import { WarmSandboxes } from '@repo/local-turns'

/** The statuses of a task that may still run a turn: in work or waiting for the client. */
const OPEN_STATUSES = [
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'awaiting_approval',
] as const

/** Of these tasks, the ones not ended whose site is not deleted. */
export async function openTasks(
  prisma: Pick<PrismaClient, 'task'>,
  taskIds: readonly string[],
): Promise<Set<string>> {
  const rows = await prisma.task.findMany({
    where: {
      id: { in: [...taskIds] },
      status: { in: [...OPEN_STATUSES] },
      site: { deletedAt: null },
    },
    select: { id: true },
  })
  return new Set(rows.map((row) => row.id))
}

/**
 * The warm containers of core's own Docker (owner's decision of 26.10.2026; spec §8, «Тёплая
 * песочница»): a container waits while its task is open and its site is not deleted, and every
 * waiting one is removed when core stops; a container a turn took stays with that turn.
 */
export class CoreWarmSandboxes extends WarmSandboxes implements OnModuleDestroy {
  constructor(
    sandboxes: Pick<SandboxProvider, 'get'>,
    prisma: Pick<PrismaClient, 'task'>,
    warmMs: number,
  ) {
    super({
      sandboxes,
      warmMs,
      wanted: (taskIds) => openTasks(prisma, taskIds),
      logger: new Logger('WarmSandboxes'),
    })
  }

  onModuleDestroy(): Promise<void> {
    return this.close()
  }
}
