import { createPrismaClient, createChatDocument, type PrismaClient } from '@repo/db'
import { pageLimits } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { postgresDocsStore } from './docs-store.ts'

// The store of the agent's documents on PostgreSQL (docs/plan/69-pages.md, Ст21, Ст22): the counter
// of writes of a turn and the rows of the feed under the turn. Rows of its own, removed at the end;
// run with RADITI_GATEWAY_DB_TESTS=1 on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('postgresDocsStore', () => {
  let db: PrismaClient
  let workspaceId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl! })
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic docs', dataClass: 'synthetic' } })
    ).id
  })
  afterAll(async () => {
    if (!db) return
    await db.chatDocument.deleteMany({ where: { workspaceId } })
    await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.$disconnect()
  })

  it('counts the writes of one turn of one chat, and writes the rows of the feed', async () => {
    const task = await db.task.create({
      data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: false },
    })
    const store = postgresDocsStore(db, () => 1_000)
    for (let write = 0; write < pageLimits.sectionWritesPerTurn; write += 1)
      expect(await store.admitWrite(task.id, 1)).toBe(true)
    expect(await store.admitWrite(task.id, 1)).toBe(false)
    // The next turn counts anew.
    expect(await store.admitWrite(task.id, 2)).toBe(true)
    const document = await createChatDocument(db, {
      workspaceId,
      taskId: task.id,
      title: 'Аудит',
      sections: [{ key: 'summary', intent: 'Итог' }],
    })
    await store.feed(task.id, 1, { type: 'feed.doc', payload: { v: 1, docId: document.id } })
    const rows = await db.taskEvent.findMany({
      where: { taskId: task.id },
      select: { type: true, payload: true },
    })
    expect(rows).toEqual([{ type: 'feed.doc', payload: { v: 1, docId: document.id } }])
    await db.rateLimit.deleteMany({ where: { key: { startsWith: `doc-writes:${task.id}` } } })
  })
})
