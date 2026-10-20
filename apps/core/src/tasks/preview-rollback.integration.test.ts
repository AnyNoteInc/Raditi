import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { PreviewTurnRollback } from './preview-rollback.ts'

const databaseUrl = process.env.DATABASE_URL
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`

describe.skipIf(!databaseUrl)('the undo of a replaced turn with PostgreSQL', () => {
  let db: PrismaClient
  const workspaces: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = workspaces.splice(0)
    const of = { task: { workspaceId: { in: ids } } }
    for (const preview of await db.previewEnvironment.findMany({ where: of, select: { id: true } }))
      await db.outboxEvent.deleteMany({
        where: { dedupeKey: { startsWith: `preview.sync:${preview.id}:` } },
      })
    await db.previewEnvironment.deleteMany({ where: of })
    await db.task.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.site.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function turn() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic rollback verification', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Rollback test',
        url: `https://${randomUUID()}.example.invalid`,
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status: 'preparing', turnNo: 1 },
    })
    const row = await db.taskTurn.create({
      data: { taskId: task.id, turnNo: 1, status: 'failed', driverId: sampleDriverId, image },
    })
    const fence = { siteId: site.id, taskId: task.id, operation: 'turn' as const, epoch: 1 }
    return { site, task, turn: row, fence }
  }

  it('takes the preview back to the last candidate', async () => {
    const { site, task, fence } = await turn()
    const preview = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        hostname: `site-${site.alias}-chat-${task.alias}.localhost`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })

    await new PreviewTurnRollback(db).rollback({ fence, turn: 1 })

    expect(
      await db.outboxEvent.count({ where: { dedupeKey: `preview.sync:${preview.id}:0:2` } }),
    ).toBe(1)
  })
})
