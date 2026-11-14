import { randomUUID } from 'node:crypto'

import {
  applyPageVersion,
  createPrismaClient,
  deletePage,
  reservePageChange,
  reservePagePublication,
  servedPage,
  type PrismaClient,
} from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { editedText, PageChanges } from './page-changes.ts'

// The changes a turn asked of its pages, applied at its end (docs/plan/73-pages-sites.md,
// Дер23–Дер27): an edit is checked as a version is, a stale one is refused and told, a rename
// and a deletion are told by `feed.page_change`. Rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const quiet = { log: vi.fn(), warn: vi.fn() }
const SECRET = 'синтетическое-значение-клиента'
const refuses = (text: string) => (text.includes(SECRET) ? ('client_value' as const) : null)

describe('editedText', () => {
  it('replaces what is found once, every time with all, and nothing found twice without it', () => {
    expect(editedText('a b a', [{ old: 'b', new: 'c' }])).toBe('a c a')
    expect(editedText('a b a', [{ old: 'a', new: 'x', all: true }])).toBe('x b x')
    expect(editedText('a b a', [{ old: 'a', new: 'x' }])).toBeNull()
    expect(editedText('a b a', [{ old: 'z', new: 'x' }])).toBeNull()
  })
})

describe.skipIf(!enabled)('the changes of a turn with PostgreSQL', () => {
  let db: PrismaClient
  let workspaceId: string
  let userId: string
  let planId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic pages', dataClass: 'synthetic' } })
    ).id
    const plan = await db.plan.create({
      data: {
        slug: `sites-${randomUUID()}`,
        name: 'Тест',
        kind: 'quota',
        price: '0.00',
        creditsPerMonth: 1,
        maxSites: 1,
        pageSites: 1000,
        isActive: false,
      },
    })
    planId = plan.id
    const now = new Date()
    await db.subscription.create({
      data: {
        workspaceId,
        planId,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        periodAnchor: now,
      },
    })
    userId = (
      await db.user.create({
        data: { name: 'Автор', email: `author-${randomUUID()}@example.test` },
      })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
  })
  afterAll(async () => {
    if (!db) return
    await db.auditLog.deleteMany({ where: { workspaceId } })
    await db.pageTree.deleteMany({ where: { workspaceId } })
    await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.subscription.deleteMany({ where: { workspaceId } })
    await db.plan.delete({ where: { id: planId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    await db.$disconnect()
  })

  async function chat() {
    return db.task.create({
      data: {
        workspaceId,
        siteId: null,
        needsRepository: false,
        needsBrowser: false,
        createdById: userId,
      },
    })
  }

  async function page(taskId: string, text: string, place?: { treeId: string; path: string }) {
    const reserved = await reservePagePublication(db, {
      workspaceId,
      taskId,
      turnNo: 1,
      title: 'Главная',
      target: { fileName: `${randomUUID()}.html` },
      ...(place ? { place } : {}),
    })
    const reservation = await db.pageReservation.findFirstOrThrow({
      where: { pageId: reserved.pageId, outcome: null },
    })
    await applyPageVersion(db, {
      pageId: reserved.pageId,
      bytes: new TextEncoder().encode(text),
      source: 'outbox',
      reservationId: reservation.id,
    })
    return reserved
  }

  const rows = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: { in: ['feed.page', 'feed.page_left', 'feed.page_change'] } },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true },
      })
    ).map((row) => [row.type, row.payload])

  it('makes an edit the next version and tells it, its links checked against the site', async () => {
    const task = await chat()
    const home = await page(task.id, '<p>Цены: 100</p><a href="/uslugi">Услуги</a>')
    await reservePageChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 2,
      change: {
        kind: 'edit',
        pageId: home.pageId,
        expectedVersion: 1,
        edits: [{ old: '100', new: '200' }],
      },
    })
    await new PageChanges({ db, logger: quiet }).apply(task.id, 2, refuses)
    const served = await servedPage(db, home.slug)
    expect(new TextDecoder().decode(served!.page!.content!.bytes)).toBe(
      '<p>Цены: 200</p><a href="/uslugi">Услуги</a>',
    )
    expect(await rows(task.id)).toEqual([
      [
        'feed.page',
        expect.objectContaining({
          pageId: home.pageId,
          version: 2,
          warnings: [{ href: '/uslugi', problem: 'missing' }],
        }),
      ],
    ])
  })

  it('refuses an edit with a value of the client, and one of a version the page left, and tells why', async () => {
    const task = await chat()
    const home = await page(task.id, '<p>Цены: 100</p>')
    const reserve = (expectedVersion: number, value: string) =>
      reservePageChange(db, {
        workspaceId,
        taskId: task.id,
        turnNo: 2,
        change: {
          kind: 'edit',
          pageId: home.pageId,
          expectedVersion,
          edits: [{ old: '100', new: value }],
        },
      })
    await reserve(1, SECRET)
    await new PageChanges({ db, logger: quiet }).apply(task.id, 2, refuses)
    const second = await reserve(1, '300')
    // Another version came between the call and the end of the turn.
    await applyPageVersion(db, {
      pageId: home.pageId,
      bytes: new TextEncoder().encode('<p>Цены: 100</p><p>ещё</p>'),
      source: 'file',
    })
    await new PageChanges({ db, logger: quiet }).apply(task.id, 2, refuses)
    expect(second.pages).toBe(1)
    expect(
      (await rows(task.id)).map(([type, payload]) => [
        type,
        (payload as { reason?: string }).reason,
      ]),
    ).toEqual([
      ['feed.page_left', 'refused'],
      ['feed.page_left', 'changed'],
    ])
    const served = await servedPage(db, home.slug)
    expect(new TextDecoder().decode(served!.page!.content!.bytes)).not.toContain(SECRET)
  })

  it('makes two edits of one turn both, the second on the text of the first', async () => {
    const task = await chat()
    const home = await page(task.id, '<p>Цены: 100</p>')
    const edit = (old: string, value: string) =>
      reservePageChange(db, {
        workspaceId,
        taskId: task.id,
        turnNo: 2,
        change: {
          kind: 'edit',
          pageId: home.pageId,
          expectedVersion: 1,
          edits: [{ old, new: value }],
        },
      })
    await edit('100', '200')
    await edit('Цены: 200', 'Цены: 300')
    await new PageChanges({ db, logger: quiet }).apply(task.id, 2, refuses)
    const served = await servedPage(db, home.slug)
    expect(new TextDecoder().decode(served!.page!.content!.bytes)).toBe('<p>Цены: 300</p>')
    expect(
      (await rows(task.id)).map(([type, payload]) => [
        type,
        (payload as { version?: number }).version,
      ]),
    ).toEqual([
      ['feed.page', 2],
      ['feed.page', 3],
    ])
  })

  it('tells nothing of a deletion the client made first, and a refused change as a change', async () => {
    const task = await chat()
    const home = await page(task.id, '<p>Главная</p>')
    const uslugi = await page(task.id, '<p>Услуги</p>', { treeId: home.treeId, path: '/uslugi' })
    await reservePageChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 3,
      change: { kind: 'delete', pageId: uslugi.pageId, withChildren: false },
    })
    await reservePageChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 3,
      change: { kind: 'update', pageId: home.pageId, expectedVersion: 1, title: SECRET },
    })
    // The client deleted it in the cabinet during the turn.
    await deletePage(db, {
      pageId: uslugi.pageId,
      workspaceId,
      by: 'client',
      actor: { type: 'system', service: 'test' },
    })
    await new PageChanges({ db, logger: quiet }).apply(task.id, 3, refuses)
    expect(await rows(task.id)).toEqual([
      ['feed.page_left', { v: 1, pageId: home.pageId, reason: 'refused', of: 'change' }],
    ])
  })

  it('renames, readdresses and deletes, each told; a title with a value of the client is refused', async () => {
    const task = await chat()
    const home = await page(task.id, '<p>Главная</p>')
    const uslugi = await page(task.id, '<p>Услуги</p>', { treeId: home.treeId, path: '/uslugi' })
    const change = (change: Parameters<typeof reservePageChange>[1]['change']) =>
      reservePageChange(db, { workspaceId, taskId: task.id, turnNo: 3, change })
    await change({
      kind: 'update',
      pageId: uslugi.pageId,
      expectedVersion: 1,
      segment: 'ceny',
      title: 'Цены',
    })
    await change({ kind: 'update', pageId: home.pageId, expectedVersion: 1, title: SECRET })
    await change({ kind: 'delete', pageId: uslugi.pageId, withChildren: false })
    await new PageChanges({ db, logger: quiet }).apply(task.id, 3, refuses)
    expect(await servedPage(db, home.slug, '/uslugi')).toMatchObject({ redirect: null })
    expect((await servedPage(db, home.slug, '/ceny'))?.page?.deleted).toBe(true)
    expect(await rows(task.id)).toEqual([
      ['feed.page_change', expect.objectContaining({ change: 'updated', title: 'Цены', pages: 1 })],
      ['feed.page_left', expect.objectContaining({ pageId: home.pageId, reason: 'refused' })],
      ['feed.page_change', expect.objectContaining({ change: 'trashed', pages: 1 })],
    ])
  })
})
