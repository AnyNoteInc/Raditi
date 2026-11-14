import {
  createChatDocument,
  createPrismaClient,
  currentDocMarkdown,
  readChatDocument,
  requestDocFinish,
  reservePagePublication,
  servedPage,
  writeDocSection,
  type PrismaClient,
} from '@repo/db'
import { readingPage } from '@repo/doc-render'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DocSections } from './doc-sections.ts'
import { PagePublications } from './page-publications.ts'

// The end of a turn for the documents of a chat on PostgreSQL (docs/plan/69-pages.md, Ст19, Ст22):
// rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const quiet = { log: vi.fn(), warn: vi.fn() }
const VALUE = 'synthetic-client-value-0001'
const refusesText = (text: string) => (text.includes(VALUE) ? ('client_value' as const) : null)

describe.skipIf(!databaseUrl)(
  'the sections of documents at the end of a turn with PostgreSQL',
  () => {
    let db: PrismaClient
    let workspaceId: string

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      workspaceId = (
        await db.workspace.create({ data: { name: 'Synthetic docs', dataClass: 'synthetic' } })
      ).id
    })
    afterAll(async () => {
      if (!db) return
      await db.page.deleteMany({ where: { workspaceId } })
      await db.chatDocument.deleteMany({ where: { workspaceId } })
      await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
      await db.$disconnect()
    })

    async function documentOfChat() {
      const task = await db.task.create({
        data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: false },
      })
      const document = await createChatDocument(db, {
        workspaceId,
        taskId: task.id,
        title: 'Аудит',
        view: 'text',
        sections: [
          { key: 'summary', intent: 'Итог' },
          { key: 'sources', intent: 'Источники' },
        ],
      })
      const ids = { workspaceId, documentId: document.id, taskId: task.id }
      return { task, ids }
    }
    const rows = (taskId: string) =>
      db.taskEvent.findMany({
        where: { taskId },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true },
      })

    it('shows the passed sections, sends back the one with a value of the client, and says only how many', async () => {
      const { task, ids } = await documentOfChat()
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'Три причины.',
        turnNo: 1,
      })
      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: `ключ ${VALUE}`,
        turnNo: 1,
      })
      await new DocSections({ db, logger: quiet }).settle(task.id, 1, refusesText)
      const read = await readChatDocument(db, {
        workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.sections.map((each) => [each.key, each.checked, each.state])).toEqual([
        ['summary', true, 'written'],
        ['sources', false, 'pending'],
      ])
      expect((await rows(task.id)).map((row) => row.type)).toEqual([
        'feed.doc_touch',
        'feed.doc_left',
      ])
      expect((await rows(task.id))[1]!.payload).toEqual({
        v: 1,
        docId: ids.documentId,
        sections: 1,
        reason: 'refused',
      })
      expect(JSON.stringify(await rows(task.id))).not.toContain(VALUE)
      const row = await db.chatDocumentSection.findFirstOrThrow({
        where: { documentId: ids.documentId, sectionKey: 'sources' },
      })
      expect(JSON.stringify(row)).not.toContain(VALUE)
    })

    it('makes the version a doc_finish asked for, once every section passed', async () => {
      const { task, ids } = await documentOfChat()
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'Текст',
        turnNo: 1,
      })
      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: '- https://example.ru/',
        turnNo: 1,
      })
      await requestDocFinish(db, { ...ids, turnNo: 1 })
      await new DocSections({ db, logger: quiet }).settle(task.id, 1, refusesText)
      expect(
        await currentDocMarkdown(db, { workspaceId, documentId: ids.documentId }),
      ).toMatchObject({ version: 1 })
    })

    it('checks a section while the turn runs, and leaves doc_finish to its end (plan 74, Д2)', async () => {
      const { task, ids } = await documentOfChat()
      const docs = new DocSections({ db, logger: quiet })
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'Текст',
        turnNo: 1,
      })
      await docs.checkLive(task.id, 1, refusesText)
      const first = await readChatDocument(db, {
        workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(first.sections.map((each) => [each.key, each.checked, each.markdown])).toEqual([
        ['summary', true, 'Текст'],
        ['sources', false, null],
      ])
      expect((await rows(task.id)).map((row) => row.type)).toEqual(['feed.doc_touch'])
      // Nothing new to check: no row, no change.
      await docs.checkLive(task.id, 1, refusesText)
      expect(await rows(task.id)).toHaveLength(1)
      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: `ключ ${VALUE}`,
        turnNo: 1,
      })
      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: '- https://example.ru/',
        turnNo: 1,
      })
      await requestDocFinish(db, { ...ids, turnNo: 1, view: 'page' })
      await docs.checkLive(task.id, 1, refusesText)
      // Both sections checked, but no version while the turn runs; the finish still waits.
      expect(await currentDocMarkdown(db, { workspaceId, documentId: ids.documentId })).toBeNull()
      expect(
        await db.chatDocument.findUniqueOrThrow({
          where: { id: ids.documentId },
          select: { finishTurnNo: true, view: true },
        }),
      ).toEqual({ finishTurnNo: 1, view: 'page' })
      await docs.settle(task.id, 1, refusesText)
      expect(
        await currentDocMarkdown(db, { workspaceId, documentId: ids.documentId }),
      ).toMatchObject({ version: 1 })
    })

    it('sends back a section with a value of the client while the turn runs', async () => {
      const { task, ids } = await documentOfChat()
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: `ключ ${VALUE}`,
        turnNo: 1,
      })
      await new DocSections({ db, logger: quiet }).checkLive(task.id, 1, refusesText)
      const read = await readChatDocument(db, {
        workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.sections[0]).toMatchObject({ state: 'pending', checked: false, markdown: null })
      expect((await rows(task.id)).map((row) => row.type)).toEqual([
        'feed.doc_touch',
        'feed.doc_left',
      ])
    })

    const sections = (pages: PagePublications) => new DocSections({ db, logger: quiet, pages })

    it('draws the version of a published document into its page, at the end of the turn (Ст7, Ст11)', async () => {
      const { task, ids } = await documentOfChat()
      const pages = new PagePublications({ db, logger: quiet })
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId: task.id,
        turnNo: 1,
        title: 'Аудит',
        target: { documentId: ids.documentId },
      })
      // Written but not finished: the page still answers «Документ ещё пишется».
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'Текст',
        turnNo: 1,
      })
      await sections(pages).settle(task.id, 1, refusesText)
      expect((await servedPage(db, page.slug))?.content ?? null).toBeNull()

      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: '- https://example.ru/',
        turnNo: 2,
      })
      await requestDocFinish(db, { ...ids, turnNo: 2 })
      await sections(pages).settle(task.id, 2, refusesText)
      const { markdown } = (await currentDocMarkdown(db, {
        workspaceId,
        documentId: ids.documentId,
      }))!
      const served = await servedPage(db, page.slug)
      expect(served).toMatchObject({ state: 'live', content: { version: 1 } })
      expect(Buffer.from(served!.content!.bytes).toString()).toBe(
        await readingPage({ title: 'Аудит', markdown }),
      )
      const feed = (await rows(task.id)).filter((row) => row.type === 'feed.page')
      expect(feed.map((row) => row.payload)).toEqual([
        { v: 1, pageId: page.pageId, slug: page.slug, title: 'Аудит', version: 1, kind: 'doc' },
      ])
      // Another end of a turn publishes nothing again.
      await sections(pages).settle(task.id, 3, refusesText)
      expect((await servedPage(db, page.slug))!.content!.version).toBe(1)
    })

    it('tells a publication of a document whose section was sent back, without a version', async () => {
      const { task, ids } = await documentOfChat()
      const pages = new PagePublications({ db, logger: quiet })
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId: task.id,
        turnNo: 1,
        title: 'Аудит',
        target: { documentId: ids.documentId },
      })
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'Текст',
        turnNo: 1,
      })
      await writeDocSection(db, {
        ...ids,
        key: 'sources',
        heading: 'Источники',
        markdown: `ключ ${VALUE}`,
        turnNo: 1,
      })
      await requestDocFinish(db, { ...ids, turnNo: 1 })
      await sections(pages).settle(task.id, 1, refusesText)
      expect((await servedPage(db, page.slug))?.content ?? null).toBeNull()
      expect(
        (await rows(task.id))
          .filter((row) => row.type === 'feed.page_left')
          .map((row) => row.payload),
      ).toEqual([{ v: 1, pageId: page.pageId, reason: 'refused' }])
    })

    it('checks at the next end of a turn what a failed turn wrote', async () => {
      const { task, ids } = await documentOfChat()
      await writeDocSection(db, {
        ...ids,
        key: 'summary',
        heading: 'Итог',
        markdown: 'из упавшего хода',
        turnNo: 1,
      })
      await new DocSections({ db, logger: quiet }).settle(task.id, 2, refusesText)
      const read = await readChatDocument(db, {
        workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.sections[0]).toMatchObject({ checked: true, markdown: 'из упавшего хода' })
    })
  },
)
