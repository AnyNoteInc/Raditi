import { pageLimits, pageSlugSchema } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  applyPageVersion,
  clearStaleUncheckedSections,
  createChatDocument,
  currentDocMarkdown,
  listWorkspacePages,
  moveDocSection,
  pendingPageReservations,
  readChatDocument,
  removeDocSection,
  requestDocFinish,
  reservePagePublication,
  restorePage,
  servedPage,
  setPagePassword,
  settlePageReservation,
  settleTurnSections,
  takeDownPage,
  uncheckedSectionsOfTurn,
  writeDocSection,
} from './pages.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const bytes = (text: string) => new TextEncoder().encode(text)

describe.skipIf(!databaseUrl)('PostgreSQL: pages and documents (plan 69)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'pages')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  /** A chat without a project in a synthetic workspace. */
  async function chat() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic pages', dataClass: 'synthetic' },
    })
    const task = await db.task.create({
      data: {
        id: uuidv7(),
        workspaceId: workspace.id,
        siteId: null,
        title: 'Синтетический чат',
        needsRepository: false,
        needsBrowser: false,
      },
    })
    return { workspaceId: workspace.id, taskId: task.id }
  }

  describe('pages', () => {
    it('reserves a page, keeps it pending, and makes v1 live at the end of the turn', async () => {
      const { workspaceId, taskId } = await chat()
      const target = { fileName: 'прайс.html' }
      const first = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Прайс',
        target,
      })
      expect(pageSlugSchema.safeParse(first.slug).success).toBe(true)
      expect(first.version).toBe(1)
      // The same file asked again in the turn is the same reservation.
      expect(
        await reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 1,
          title: 'Прайс',
          target,
        }),
      ).toEqual(first)
      expect((await servedPage(db, first.slug))?.content).toBeNull()

      const [reservation] = await pendingPageReservations(db, taskId, 1)
      expect(reservation?.fileName).toBe('прайс.html')
      await applyPageVersion(db, {
        pageId: first.pageId,
        bytes: bytes('<p>v1'),
        source: 'outbox',
        reservationId: reservation!.id,
      })
      const served = await servedPage(db, first.slug)
      expect(served?.state).toBe('live')
      expect(served?.content?.version).toBe(1)
      expect(Buffer.from(served!.content!.bytes).toString()).toBe('<p>v1')
      expect(await pendingPageReservations(db, taskId, 1)).toEqual([])
    })

    it('keeps one address and the bytes of the latest version only, numbers growing', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Меню',
        target: { fileName: 'menu.html' },
      })
      await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('v1'), source: 'outbox' })
      const next = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 2,
        title: 'Меню',
        target: { fileName: 'menu.html' },
        pageId: page.pageId,
      })
      expect(next).toEqual({ pageId: page.pageId, slug: page.slug, version: 2 })
      expect(
        await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('v2'), source: 'outbox' }),
      ).toEqual({
        version: 2,
      })
      expect(await db.pageContent.count({ where: { pageId: page.pageId } })).toBe(1)
      expect(await db.pageVersion.count({ where: { pageId: page.pageId } })).toBe(2)
      expect(Buffer.from((await servedPage(db, page.slug))!.content!.bytes).toString()).toBe('v2')
    })

    it('settles a reservation the turn could not fulfil, and the page stays pending', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Нет файла',
        target: { fileName: 'missing.html' },
      })
      const [reservation] = await pendingPageReservations(db, taskId, 1)
      await settlePageReservation(db, reservation!.id, 'missing')
      expect(
        (await db.pageReservation.findUniqueOrThrow({ where: { id: reservation!.id } })).outcome,
      ).toBe('missing')
      expect((await servedPage(db, page.slug))?.state).toBe('pending')
    })

    it('never shows another workspace a page', async () => {
      const mine = await chat()
      const theirs = await chat()
      const page = await reservePagePublication(db, {
        ...mine,
        turnNo: 1,
        title: 'Моя',
        target: { fileName: 'a.html' },
      })
      await expect(
        reservePagePublication(db, {
          ...theirs,
          turnNo: 1,
          title: 'Чужая',
          target: { fileName: 'a.html' },
          pageId: page.pageId,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
      await expect(
        setPagePassword(db, {
          workspaceId: theirs.workspaceId,
          pageId: page.pageId,
          passwordHash: 'x',
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
    })

    it('stops at the publications of an hour', async () => {
      const { workspaceId, taskId } = await chat()
      for (let turn = 1; turn <= pageLimits.publishesPerHour; turn += 1)
        await reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: turn,
          title: 'Страница',
          target: { fileName: `p${turn}.html` },
        })
      await expect(
        reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 999,
          title: 'Ещё',
          target: { fileName: 'more.html' },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_LIMIT', details: { limit: 'publishesPerHour' } })
    })

    it('changes the password epoch, takes a page down and puts it back', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'С паролем',
        target: { fileName: 'p.html' },
      })
      await expect(
        takeDownPage(db, { pageId: page.pageId, workspaceId, by: 'client' }),
      ).rejects.toMatchObject({
        code: 'PAGE_NOT_FOUND',
      })
      await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('x'), source: 'outbox' })
      expect(
        await setPagePassword(db, { workspaceId, pageId: page.pageId, passwordHash: 'hash-1' }),
      ).toEqual({
        passwordEpoch: 1,
      })
      expect(
        await setPagePassword(db, { workspaceId, pageId: page.pageId, passwordHash: null }),
      ).toEqual({
        passwordEpoch: 2,
      })
      await takeDownPage(db, { pageId: page.pageId, workspaceId, by: 'client' })
      expect((await servedPage(db, page.slug))?.state).toBe('taken_down')
      // The content stays: a taken-down page comes back as it was.
      await restorePage(db, { pageId: page.pageId, workspaceId })
      const back = await servedPage(db, page.slug)
      expect(back?.state).toBe('live')
      expect(back?.content?.version).toBe(1)
    })

    it('does not let the client put back a page the operator took down', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Жалоба',
        target: { fileName: 'p.html' },
      })
      await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('x'), source: 'outbox' })
      await takeDownPage(db, { pageId: page.pageId, by: 'operator' })
      await expect(restorePage(db, { pageId: page.pageId, workspaceId })).rejects.toMatchObject({
        code: 'PAGE_NOT_FOUND',
      })
      const [listed] = await listWorkspacePages(db, workspaceId)
      expect(listed).toMatchObject({
        state: 'taken_down',
        takenDownBy: 'operator',
        hasPassword: false,
      })
      expect(listed).not.toHaveProperty('passwordHash')
    })

    it('holds a page and its bytes to the database checks', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Чек',
        target: { fileName: 'p.html' },
      })
      // A live page without a version is refused by the CHECK, whoever writes it.
      await expect(
        db.page.update({ where: { id: page.pageId }, data: { state: 'live' } }),
      ).rejects.toThrow()
      await expect(
        applyPageVersion(db, {
          pageId: page.pageId,
          bytes: new Uint8Array(pageLimits.contentBytes + 1),
          source: 'outbox',
        }),
      ).rejects.toMatchObject({ code: 'PAGE_LIMIT' })
    })

    it('closes only an open reservation of the same page', async () => {
      const { workspaceId, taskId } = await chat()
      const one = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'А',
        target: { fileName: 'a.html' },
      })
      const two = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Б',
        target: { fileName: 'b.html' },
      })
      const [first, second] = await pendingPageReservations(db, taskId, 1)
      await expect(
        applyPageVersion(db, {
          pageId: two.pageId,
          bytes: bytes('x'),
          source: 'outbox',
          reservationId: first!.id,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
      // Nothing of the refused version stayed.
      expect(await db.pageVersion.count({ where: { pageId: two.pageId } })).toBe(0)
      await settlePageReservation(db, second!.id, 'failed')
      await expect(
        applyPageVersion(db, {
          pageId: two.pageId,
          bytes: bytes('x'),
          source: 'outbox',
          reservationId: second!.id,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
      void one
    })

    it('takes no version of a page the client or the operator took down, nor one file for two pages', async () => {
      const { workspaceId, taskId } = await chat()
      const page = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'С',
        target: { fileName: 's.html' },
      })
      await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('x'), source: 'outbox' })
      await takeDownPage(db, { pageId: page.pageId, by: 'client', workspaceId })
      const next = {
        workspaceId,
        taskId,
        turnNo: 2,
        title: 'С',
        target: { fileName: 's.html' },
        pageId: page.pageId,
      }
      await expect(reservePagePublication(db, next)).rejects.toMatchObject({
        code: 'PAGE_TAKEN_DOWN',
      })
      await takeDownPage(db, { pageId: page.pageId, by: 'operator' })
      await expect(reservePagePublication(db, next)).rejects.toMatchObject({
        code: 'PAGE_NOT_FOUND',
      })

      const other = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 3,
        title: 'Д',
        target: { fileName: 'd.html' },
      })
      await applyPageVersion(db, { pageId: other.pageId, bytes: bytes('x'), source: 'outbox' })
      await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 4,
        title: 'Е',
        target: { fileName: 'e.html' },
      })
      await expect(
        reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 4,
          title: 'Е',
          target: { fileName: 'e.html' },
          pageId: other.pageId,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_RESERVED' })
    })

    it('answers the same reservation to two racing calls of one turn', async () => {
      const { workspaceId, taskId } = await chat()
      const input = {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Гонка',
        target: { fileName: 'race.html' },
      }
      const [a, b] = await Promise.all([
        reservePagePublication(db, input),
        reservePagePublication(db, input),
      ])
      expect(a).toEqual(b)
      expect(await db.pageReservation.count({ where: { taskId } })).toBe(1)
    })

    it('gives the last place of the hour to one of two turns only', async () => {
      const { workspaceId, taskId } = await chat()
      for (let turn = 1; turn < pageLimits.publishesPerHour; turn += 1)
        await reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: turn,
          title: 'П',
          target: { fileName: `p${turn}.html` },
        })
      const outcomes = await Promise.allSettled([
        reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 900,
          title: 'П',
          target: { fileName: 'x.html' },
        }),
        reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 901,
          title: 'П',
          target: { fileName: 'y.html' },
        }),
      ])
      expect(outcomes.filter((each) => each.status === 'fulfilled')).toHaveLength(1)
    })

    it('keeps a page of a document apart from files, and a chat of another workspace out', async () => {
      const { workspaceId, taskId } = await chat()
      const file = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Ф',
        target: { fileName: 'f.html' },
      })
      const document = await createChatDocument(db, {
        workspaceId,
        taskId,
        title: 'Д',
        view: 'text',
        sections: [{ key: 'a', intent: 'А' }],
      })
      await expect(
        reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 2,
          title: 'Ф',
          target: { documentId: document.id },
          pageId: file.pageId,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
      const other = await chat()
      await expect(
        reservePagePublication(db, {
          workspaceId,
          taskId: other.taskId,
          turnNo: 1,
          title: 'Ч',
          target: { fileName: 'c.html' },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
    })

    it('counts the published pages of a workspace, not the reservations that never came true', async () => {
      const { workspaceId, taskId } = await chat()
      await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'П',
        target: { fileName: 'p.html' },
      })
      expect(await db.page.count({ where: { workspaceId, state: { not: 'pending' } } })).toBe(0)
    })
  })

  describe('documents', () => {
    async function skeleton() {
      const ids = await chat()
      const document = await createChatDocument(db, {
        ...ids,
        title: 'Аудит скорости',
        view: 'text',
        sections: [
          { key: 'summary', intent: 'Итог: три причины' },
          { key: 'sources', intent: 'Источники' },
        ],
      })
      return { ...ids, documentId: document.id }
    }

    /** What core does at the end of a turn: scans every unchecked section of the chat. */
    async function endOfTurn(
      taskId: string,
      turnNo: number,
      refuse: (markdown: string | null) => 'client_value' | 'turn_key' | null = () => null,
    ) {
      const sections = await uncheckedSectionsOfTurn(db, taskId, turnNo)
      return settleTurnSections(db, {
        taskId,
        turnNo,
        sections: sections.map((each) => ({
          sectionId: each.id,
          digest: each.digest,
          refusal: refuse(each.markdown),
        })),
      })
    }

    const write = (
      ids: { workspaceId: string; taskId: string; documentId: string },
      key: string,
      markdown: string,
      turnNo = 1,
    ) => writeDocSection(db, { ...ids, key, heading: `Раздел ${key}`, markdown, turnNo })

    it('shows the client a section, heading and text, only after the end of the turn', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'Три причины.')
      const forClient = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(
        forClient.sections.map((each) => [
          each.key,
          each.state,
          each.heading,
          each.markdown,
          each.intent,
        ]),
      ).toEqual([
        ['summary', 'written', null, null, 'Итог: три причины'],
        ['sources', 'pending', null, null, 'Источники'],
      ])
      const forAgent = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'agent',
        taskId: ids.taskId,
      })
      expect(forAgent.sections[0]).toMatchObject({
        heading: 'Раздел summary',
        markdown: 'Три причины.',
      })

      const [settled] = await endOfTurn(ids.taskId, 1)
      expect(settled).toMatchObject({ documentId: ids.documentId, refused: 0, version: null })
      const after = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(after.sections[0]).toMatchObject({
        heading: 'Раздел summary',
        markdown: 'Три причины.',
        checked: true,
      })
    })

    it('does not mark checked a section written again after the scan', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'первое')
      const scanned = await uncheckedSectionsOfTurn(db, ids.taskId, 1)
      await write(ids, 'summary', 'второе, не прочитанное')
      await settleTurnSections(db, {
        taskId: ids.taskId,
        turnNo: 1,
        sections: scanned.map((each) => ({
          sectionId: each.id,
          digest: each.digest,
          refusal: null,
        })),
      })
      const read = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.sections[0]).toMatchObject({ checked: false, markdown: null })
    })

    it('checks at the end of the next turn the sections of a turn that failed', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'из упавшего хода', 1)
      // Turn 1 ended without its end of turn; turn 2 wrote another section.
      await write(ids, 'sources', 'из второго хода', 2)
      await endOfTurn(ids.taskId, 2)
      const read = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.sections.map((each) => each.checked)).toEqual([true, true])
    })

    it('sends a refused section back to pending with its intent and reason, and keeps no trace of it', async () => {
      const ids = await skeleton()
      await writeDocSection(db, {
        ...ids,
        key: 'extra',
        heading: 'секрет в заголовке',
        markdown: 'значение',
        after: null,
        turnNo: 1,
      })
      const [settled] = await endOfTurn(ids.taskId, 1, () => 'client_value')
      expect(settled?.refused).toBe(1)
      const read = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'agent',
        taskId: ids.taskId,
      })
      expect(read.sections[0]).toMatchObject({
        key: 'extra',
        state: 'pending',
        heading: null,
        markdown: null,
        refusal: 'client_value',
        intent: 'Новый раздел',
      })
      const row = await db.chatDocumentSection.findFirstOrThrow({
        where: { documentId: ids.documentId, sectionKey: 'extra' },
      })
      expect(JSON.stringify(row)).not.toContain('секрет')
    })

    it('refuses doc_finish while a section is pending, and makes v1 at the end of the turn', async () => {
      const ids = await skeleton()
      await expect(requestDocFinish(db, { ...ids, turnNo: 1 })).rejects.toMatchObject({
        code: 'DOC_PENDING_SECTIONS',
      })
      await write(ids, 'summary', 'Текст summary')
      await write(ids, 'sources', 'Текст sources')
      await requestDocFinish(db, { ...ids, turnNo: 1 })
      expect(await currentDocMarkdown(db, ids)).toBeNull()
      const [settled] = await endOfTurn(ids.taskId, 1)
      expect(settled?.version).toBe(1)
      expect(await currentDocMarkdown(db, ids)).toEqual({
        version: 1,
        markdown:
          '# Аудит скорости\n\n## Раздел summary\n\nТекст summary\n\n## Раздел sources\n\nТекст sources\n',
      })
    })

    it('drops a doc_finish the scan broke, and makes no version', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'плохо')
      await write(ids, 'sources', 'хорошо')
      await requestDocFinish(db, { ...ids, turnNo: 1 })
      const [settled] = await endOfTurn(ids.taskId, 1, (markdown) =>
        markdown === 'плохо' ? 'turn_key' : null,
      )
      expect(settled?.version).toBeNull()
      const document = await db.chatDocument.findUniqueOrThrow({ where: { id: ids.documentId } })
      expect(document).toMatchObject({ currentVersion: 0, finishTaskId: null, finishTurnNo: null })
    })

    it('lets no other chat read a section before core checked it', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'значение сайта А')
      const other = await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: ids.workspaceId,
          siteId: null,
          needsRepository: false,
          needsBrowser: false,
        },
      })
      const fromOther = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'agent',
        taskId: other.id,
      })
      expect(fromOther.sections[0]).toMatchObject({
        state: 'written',
        checked: false,
        heading: null,
        markdown: null,
      })
      await endOfTurn(ids.taskId, 1)
      const after = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'agent',
        taskId: other.id,
      })
      expect(after.sections[0]?.markdown).toBe('значение сайта А')
    })

    it('makes neutral a title and intents the end of the turn refused, counted as sent back', async () => {
      const ids = await skeleton()
      const sections = await db.chatDocumentSection.findMany({
        where: { documentId: ids.documentId },
      })
      const [settled] = await settleTurnSections(db, {
        taskId: ids.taskId,
        turnNo: 1,
        sections: [],
        labels: [{ documentId: ids.documentId, title: true, intents: [sections[0]!.id] }],
      })
      expect(settled?.refused).toBe(2)
      const read = await readChatDocument(db, {
        workspaceId: ids.workspaceId,
        documentId: ids.documentId,
        reader: 'client',
      })
      expect(read.title).toBe('Документ')
      // The first section (ordered by position) was named: its intent is neutral now.
      expect(read.sections.map((each) => each.intent).sort()).toContain('Раздел')
      expect(read.sections).toHaveLength(2)
    })

    it('does not let the end of a turn make the version a later turn of the chat asked for', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'а', 1)
      await write(ids, 'sources', 'б', 1)
      await requestDocFinish(db, { ...ids, turnNo: 2 })
      const [settled] = await endOfTurn(ids.taskId, 1)
      expect(settled?.version).toBeNull()
      expect(
        (await db.chatDocument.findUniqueOrThrow({ where: { id: ids.documentId } })).finishTurnNo,
      ).toBe(2)
    })

    it('clears text no end of a turn checked, once its document is left a day', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'непроверенное')
      await db.chatDocument.update({
        where: { id: ids.documentId },
        data: { updatedAt: new Date('2020-01-01') },
      })
      expect(await clearStaleUncheckedSections(db, new Date('2021-01-01'))).toBe(1)
      const row = await db.chatDocumentSection.findFirstOrThrow({
        where: { documentId: ids.documentId, sectionKey: 'summary' },
      })
      expect(row).toMatchObject({ state: 'pending', markdown: null, intent: 'Итог: три причины' })
    })

    it('lets a doc_finish wait for the end of the turn of the chat that wrote a section', async () => {
      const ids = await skeleton()
      const other = await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: ids.workspaceId,
          siteId: null,
          needsRepository: false,
          needsBrowser: false,
        },
      })
      await write(ids, 'summary', 'чат А')
      await writeDocSection(db, {
        ...ids,
        taskId: other.id,
        key: 'sources',
        heading: 'Источники',
        markdown: 'чат Б',
        turnNo: 1,
      })
      await requestDocFinish(db, { ...ids, taskId: other.id, turnNo: 1 })
      // The end of the turn of chat B: its section is checked, chat A's is not yet — no version.
      const [byB] = await endOfTurn(other.id, 1)
      expect(byB?.version).toBeNull()
      expect(
        (await db.chatDocument.findUniqueOrThrow({ where: { id: ids.documentId } })).finishTaskId,
      ).toBe(other.id)
      // The end of the turn of chat A makes it.
      const [byA] = await endOfTurn(ids.taskId, 1)
      expect(byA?.version).toBe(1)
    })

    it('inserts, moves and removes sections by id', async () => {
      const ids = await skeleton()
      await writeDocSection(db, {
        ...ids,
        key: 'method',
        heading: 'Как мерили',
        markdown: 'Замеры',
        after: 'summary',
        turnNo: 1,
      })
      const keys = async () =>
        (
          await readChatDocument(db, {
            workspaceId: ids.workspaceId,
            documentId: ids.documentId,
            reader: 'agent',
            taskId: ids.taskId,
          })
        ).sections.map((each) => each.key)
      expect(await keys()).toEqual(['summary', 'method', 'sources'])
      await moveDocSection(db, { ...ids, key: 'sources', after: null })
      expect(await keys()).toEqual(['sources', 'summary', 'method'])
      await removeDocSection(db, { ...ids, key: 'summary' })
      expect(await keys()).toEqual(['sources', 'method'])
      await expect(write(ids, 'nope', 'x')).rejects.toMatchObject({ code: 'DOC_SECTION_UNKNOWN' })
      await expect(
        moveDocSection(db, { ...ids, key: 'method', after: 'nope' }),
      ).rejects.toMatchObject({
        code: 'DOC_SECTION_UNKNOWN',
      })
    })

    it('publishes a document as one page, the same page again for its next version', async () => {
      const { workspaceId, taskId, documentId } = await skeleton()
      const first = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        title: 'Аудит',
        target: { documentId },
      })
      const again = await reservePagePublication(db, {
        workspaceId,
        taskId,
        turnNo: 2,
        title: 'Аудит',
        target: { documentId },
      })
      expect(again.pageId).toBe(first.pageId)
      expect((await db.page.findUniqueOrThrow({ where: { id: first.pageId } })).kind).toBe('doc')
    })

    it('keeps a document of another workspace unseen', async () => {
      const { documentId } = await skeleton()
      const other = await chat()
      await expect(
        readChatDocument(db, {
          workspaceId: other.workspaceId,
          documentId,
          reader: 'agent',
          taskId: other.taskId,
        }),
      ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' })
    })
  })
})
