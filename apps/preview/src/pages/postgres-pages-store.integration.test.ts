import { randomUUID } from 'node:crypto'

import {
  applyPageVersion,
  createPrismaClient,
  hashPagePassword,
  reservePagePublication,
  setPagePassword,
  type PrismaClient,
} from '@repo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresPagesStore } from './pages.module.ts'

// A workspace and a chat of its own, removed at the end; run by verify:db's disposable database (or
// any throwaway one) with RADITI_GATEWAY_DB_TESTS=1.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('PostgresPagesStore (plan 69, Ст4, Ст13)', () => {
  let db: PrismaClient
  let store: PostgresPagesStore
  let workspaceId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl! })
    store = new PostgresPagesStore(db)
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic pages', dataClass: 'synthetic' } })
    ).id
  })
  afterAll(async () => {
    if (!db) return
    await db.page.deleteMany({ where: { workspaceId } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.$disconnect()
  })

  it('reads a page by its slug and checks its password', async () => {
    const task = await db.task.create({
      data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: false },
    })
    const page = await reservePagePublication(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 1,
      title: 'Прайс',
      target: { fileName: 'p.html' },
    })
    expect((await store.served(page.slug))?.state).toBe('pending')
    await applyPageVersion(db, {
      pageId: page.pageId,
      bytes: new TextEncoder().encode('<p>1'),
      source: 'outbox',
    })
    const hash = await hashPagePassword('секрет-1')
    await setPagePassword(db, { workspaceId, pageId: page.pageId, passwordHash: hash })
    const served = await store.served(page.slug)
    expect(served).toMatchObject({ state: 'live', passwordEpoch: 1, content: { version: 1 } })
    expect(await store.verify('секрет-1', served!.passwordHash!)).toBe(true)
    expect(await store.verify('другой', served!.passwordHash!)).toBe(false)
    expect(await store.served('a'.repeat(26))).toBeNull()
  })

  it('counts the attempts of a window in rate_limits', async () => {
    const key = `page-password:${randomUUID()}`
    expect(await store.admit(key, 1, 60_000, 0)).toBe(true)
    expect(await store.admit(key, 1, 60_000, 1)).toBe(false)
    await db.rateLimit.deleteMany({ where: { key } })
  })
})
