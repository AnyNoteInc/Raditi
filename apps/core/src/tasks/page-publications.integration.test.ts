import { createPrismaClient, reservePagePublication, servedPage, type PrismaClient } from '@repo/db'
import { readingPage } from '@repo/doc-render'
import { packOutbox } from '@repo/snapshots'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ChatFiles } from './chat-files.ts'
import { PagePublications } from './page-publications.ts'
import { PAGE_SWEEP_AFTER_MS, TaskSweep } from './task-sweep.ts'

// The pages of a turn on PostgreSQL (docs/plan/69-pages.md, Ст6, Ст8, Ст23): the file a reservation
// names becomes the version of its page, not a file of the chat; a missing file, a refused page and a
// repeated delivery each leave the feed as the client should read it. Rows of its own, removed at
// the end.

const databaseUrl = process.env.DATABASE_URL
const quiet = { log: vi.fn(), warn: vi.fn() }

// The sweep in it closes and removes rows of the whole database: a disposable one only.
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('the pages of a turn with PostgreSQL', () => {
  let db: PrismaClient
  let workspaceId: string
  const put = vi.fn(async () => undefined)

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic pages', dataClass: 'synthetic' } })
    ).id
  })
  afterAll(async () => {
    if (!db) return
    await db.page.deleteMany({ where: { workspaceId } })
    await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.$disconnect()
  })

  const files = () =>
    new ChatFiles({
      db,
      storage: { put },
      logger: quiet,
      pages: new PagePublications({ db, logger: quiet }),
    })

  async function chat() {
    return db.task.create({
      data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: false },
    })
  }
  const reserve = (taskId: string, fileName: string, turnNo = 1, pageId?: string) =>
    reservePagePublication(db, {
      workspaceId,
      taskId,
      turnNo,
      title: 'Прайс',
      target: { fileName },
      ...(pageId ? { pageId } : {}),
    })
  const rows = (taskId: string) =>
    db.taskEvent.findMany({
      where: { taskId },
      orderBy: { id: 'asc' },
      select: { type: true, payload: true },
    })

  it('makes the reserved file the version of its page, and the others files of the chat', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'прайс.html')
    put.mockClear()
    const written = await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([
        { name: 'прайс.html', bytes: '<!doctype html><p>Цены</p>' },
        { name: 'смета.xlsx', bytes: 'xlsx' },
      ]),
    })
    expect(written).toBe(1)
    expect(put).toHaveBeenCalledTimes(1)
    const served = await servedPage(db, page.slug)
    expect(served).toMatchObject({ state: 'live', content: { version: 1 } })
    expect(Buffer.from(served!.content!.bytes).toString()).toBe('<!doctype html><p>Цены</p>')
    expect((await rows(task.id)).map((row) => row.type)).toEqual(['feed.page', 'feed.file'])
    expect((await rows(task.id))[0]!.payload).toMatchObject({
      v: 1,
      pageId: page.pageId,
      slug: page.slug,
      version: 1,
      kind: 'html',
    })

    // A delivery repeated after a crash writes nothing new.
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([
        { name: 'прайс.html', bytes: '<!doctype html><p>Цены</p>' },
        { name: 'смета.xlsx', bytes: 'xlsx' },
      ]),
    })
    expect(await rows(task.id)).toHaveLength(2)
    expect((await servedPage(db, page.slug))!.content!.version).toBe(1)

    // The next turn: the next version at the same address.
    await reserve(task.id, 'прайс.html', 2, page.pageId)
    await files().deliver({
      taskId: task.id,
      turn: 2,
      outbox: await packOutbox([{ name: 'прайс.html', bytes: '<p>v2' }]),
    })
    expect((await servedPage(db, page.slug))!.content!.version).toBe(2)
  })

  it('tells the client of a page whose file never came, also when the turn left no files', async () => {
    const task = await chat()
    const lost = await reserve(task.id, 'нет.html')
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([{ name: 'другой.txt', bytes: 'x' }]),
    })
    const none = await reserve(task.id, 'тоже-нет.html', 2)
    await files().deliver({ taskId: task.id, turn: 2, outbox: null })
    const left = (await rows(task.id)).filter((row) => row.type === 'feed.page_left')
    expect(left.map((row) => row.payload)).toEqual([
      { v: 1, pageId: lost.pageId, reason: 'missing' },
      { v: 1, pageId: none.pageId, reason: 'missing' },
    ])
    expect((await servedPage(db, lost.slug))?.state).toBe('pending')
  })

  it('refuses a page that asks for a password for another address, without saying why', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'вход.html')
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([
        {
          name: 'вход.html',
          bytes: '<form action="https://evil.example/"><input type="password"></form>',
        },
      ]),
    })
    expect((await rows(task.id)).map((row) => row.payload)).toEqual([
      { v: 1, pageId: page.pageId, reason: 'refused' },
    ])
    expect((await servedPage(db, page.slug))?.state).toBe('pending')
  })

  it('tells of every page of a turn whose outbox was refused whole', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'a.html')
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([], { refused: true }),
    })
    expect((await rows(task.id)).map((row) => row.type)).toEqual([
      'feed.page_left',
      'feed.file_left',
    ])
    expect((await rows(task.id))[0]!.payload).toMatchObject({
      pageId: page.pageId,
      reason: 'refused',
    })
  })

  it('draws a Markdown file into a page for reading, not a file of the chat (Ст11)', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'отчёт.md')
    const markdown = '# Отчёт\n\n[сайт](https://example.ru/)\n\n<script>alert(1)</script>'
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([{ name: 'отчёт.md', bytes: markdown }]),
    })
    expect((await rows(task.id)).map((row) => row.type)).toEqual(['feed.page'])
    expect((await rows(task.id))[0]!.payload).toMatchObject({ version: 1, kind: 'markdown' })
    const served = await servedPage(db, page.slug)
    expect(served).toMatchObject({ state: 'live', content: { version: 1 } })
    expect(Buffer.from(served!.content!.bytes).toString()).toBe(
      await readingPage({ title: 'Отчёт', markdown }),
    )
    // The title of the reservation, which no scan of the turn read, is not on the page.
    expect(Buffer.from(served!.content!.bytes).toString()).not.toContain('Прайс')
  })

  it('tells the pages of a failed turn at once, and each closing once', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'a.html')
    await files().failPages(task.id, 1)
    await files().failPages(task.id, 1)
    await files().deliver({
      taskId: task.id,
      turn: 1,
      outbox: await packOutbox([{ name: 'a.html', bytes: '<p>' }]),
    })
    expect((await rows(task.id)).map((row) => row.payload)).toEqual([
      { v: 1, pageId: page.pageId, reason: 'failed' },
    ])
  })

  it('keeps the page of a document, which a viewer may have seen as «Документ ещё пишется»', async () => {
    const task = await chat()
    const document = await db.chatDocument.create({
      data: { workspaceId, taskId: task.id, title: 'Аудит' },
    })
    const page = await reservePagePublication(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 1,
      title: 'Аудит',
      target: { documentId: document.id },
    })
    const sweep = new TaskSweep({
      db,
      pages: new PagePublications({ db, logger: quiet }),
      logger: quiet,
      now: () => new Date(Date.now() + PAGE_SWEEP_AFTER_MS + 60_000),
    } as never)
    await sweep.sweepPages()
    expect(await db.page.findUnique({ where: { id: page.pageId } })).not.toBeNull()
  })

  it('fails a publication no end of turn settled, and removes the page that never got a version', async () => {
    const task = await chat()
    const page = await reserve(task.id, 'забытая.html')
    const now = () => new Date(Date.now() + PAGE_SWEEP_AFTER_MS + 60_000)
    const sweep = new TaskSweep({
      db,
      pages: new PagePublications({ db, logger: quiet }),
      logger: quiet,
      now,
    } as never)
    expect(await sweep.sweepPages()).toBeGreaterThanOrEqual(1)
    expect((await rows(task.id)).map((row) => row.payload)).toEqual([
      { v: 1, pageId: page.pageId, reason: 'failed' },
    ])
    expect(await db.page.findUnique({ where: { id: page.pageId } })).toBeNull()
  })
})
