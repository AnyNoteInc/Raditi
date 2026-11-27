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
  applyPageChange,
  applyPageEdit,
  applyPageFile,
  clearStaleUncheckedSections,
  createChatDocument,
  deletePage,
  deleteTreeFile,
  dropAbandonedPages,
  listTreeFiles,
  purgeDeletedPage,
  readPageSource,
  reservePageChange,
  reservePageFile,
  reservePageFileDeletion,
  returnDeletedPage,
  currentDocMarkdown,
  docVersionMarkdown,
  docVersions,
  listWorkspacePages,
  moveDocSection,
  operatorPageDecision,
  pageSiteStats,
  pendingPageReservations,
  readChatDocument,
  removeDocSection,
  requestDocFinish,
  reservePagePublication,
  restorePage,
  servedFile,
  servedContent,
  servedPage,
  setPagePassword,
  settlePageReservation,
  setTreeName,
  settleTurnSections,
  takeDownPage,
  uncheckedSectionsOfTurn,
  updatePage,
  writeDocSection,
} from './pages.ts'
import { uuidv7 } from './uuidv7.ts'

/**
 * The page at a path as these tests read it before sites (docs/plan/73-pages-sites.md, Дер11):
 * the take-down and the trash of the site are the home page's, the password the site's.
 */
async function servedFlat(...args: Parameters<typeof servedPage>) {
  const site = await servedPage(...args)
  if (site === null) return null
  return {
    id: site.page?.id ?? site.treeId,
    treeId: site.treeId,
    state: site.gone === 'taken_down' ? ('taken_down' as const) : (site.page?.state ?? 'pending'),
    deleted: site.gone === 'deleted' || (site.page?.deleted ?? false),
    kind: site.page?.kind,
    passwordHash: site.passwordHash,
    passwordEpoch: site.passwordEpoch,
    content: site.page?.content ?? null,
  }
}

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

  /**
   * A tariff of the test with as many sites as a test makes (docs/plan/73-pages-sites.md, Дер36):
   * without a paid tariff a workspace has one site, and these tests make many pages.
   */
  async function onTariff(workspaceId: string, pageSites = 1000, pageCustomNames = false) {
    const plan = await db.plan.create({
      data: {
        slug: `sites-${uuidv7()}`,
        name: 'Тест',
        kind: 'quota',
        price: '0.00',
        creditsPerMonth: 1,
        pageSites,
        pageCustomNames,
        isActive: false,
      },
    })
    const now = new Date()
    await db.subscription.create({
      data: {
        workspaceId,
        planId: plan.id,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        periodAnchor: now,
      },
    })
  }

  /** A chat without a project in a synthetic workspace, on a tariff of many sites. */
  async function chat(
    options: {
      pageSites?: number | null
      author?: 'owner' | 'admin' | 'member'
      names?: boolean
    } = {},
  ) {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic pages', dataClass: 'synthetic' },
    })
    if (options.pageSites !== null)
      await onTariff(workspace.id, options.pageSites, options.names ?? false)
    // The author of the chat and their role: who the changes of its agent are allowed to (Дер24).
    let createdById: string | null = null
    if (options.author) {
      const user = await db.user.create({
        data: { name: 'Автор', email: `author-${uuidv7()}@example.test` },
      })
      await db.member.create({
        data: { workspaceId: workspace.id, userId: user.id, role: options.author },
      })
      createdById = user.id
    }
    const task = await db.task.create({
      data: {
        id: uuidv7(),
        workspaceId: workspace.id,
        title: 'Синтетический чат',
        needsBrowser: false,
        createdById,
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
      expect((await servedFlat(db, first.slug))?.content).toBeNull()

      const [reservation] = await pendingPageReservations(db, taskId, 1)
      expect(reservation?.fileName).toBe('прайс.html')
      await applyPageVersion(db, {
        pageId: first.pageId,
        bytes: bytes('<p>v1'),
        source: 'outbox',
        reservationId: reservation!.id,
      })
      const served = await servedFlat(db, first.slug)
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
      expect(next).toMatchObject({ pageId: page.pageId, slug: page.slug, version: 2 })
      expect(
        await applyPageVersion(db, { pageId: page.pageId, bytes: bytes('v2'), source: 'outbox' }),
      ).toEqual({
        version: 2,
      })
      expect(await db.pageContent.count({ where: { pageId: page.pageId } })).toBe(1)
      expect(await db.pageVersion.count({ where: { pageId: page.pageId } })).toBe(2)
      expect(Buffer.from((await servedFlat(db, page.slug))!.content!.bytes).toString()).toBe('v2')
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
      expect((await servedFlat(db, page.slug))?.state).toBe('pending')
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

    // A hundred and twenty publications, each a site of its own: slow under the parallel sets.
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
    }, 60_000)

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
      expect((await servedFlat(db, page.slug))?.state).toBe('taken_down')
      // The content stays: a taken-down page comes back as it was.
      await restorePage(db, { pageId: page.pageId, workspaceId })
      const back = await servedFlat(db, page.slug)
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
    }, 60_000)

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

  describe('sites of pages (docs/plan/73-pages-sites.md, Дер11–Дер19, Дер36)', () => {
    const html = (text: string) => new TextEncoder().encode(text)

    /** A page published by a turn as its end does: reserved, then its version fulfils it. */
    async function publish(
      at: { workspaceId: string; taskId: string },
      fileName: string,
      options: { place?: { treeId: string; path: string }; pageId?: string; turnNo?: number } = {},
    ) {
      const reserved = await reservePagePublication(db, {
        ...at,
        turnNo: options.turnNo ?? 1,
        title: fileName,
        target: { fileName },
        ...(options.place ? { place: options.place } : {}),
        ...(options.pageId ? { pageId: options.pageId } : {}),
      })
      const reservation = await db.pageReservation.findFirstOrThrow({
        where: { pageId: reserved.pageId, outcome: null },
      })
      await applyPageVersion(db, {
        pageId: reserved.pageId,
        bytes: html(`<p>${fileName}</p>`),
        source: 'outbox',
        reservationId: reservation.id,
      })
      return reserved
    }

    it('gives a workspace without a tariff one site, and one on a tariff its sites', async () => {
      const free = await chat({ pageSites: null })
      await publish(free, 'a.html')
      await expect(publish(free, 'b.html', { turnNo: 2 })).rejects.toMatchObject({
        code: 'PAGE_SITE_LIMIT',
        details: { limit: 1 },
      })
      const start = await chat({ pageSites: 2 })
      const first = await publish(start, 'a.html')
      await publish(start, 'b.html', { turnNo: 2 })
      await expect(publish(start, 'c.html', { turnNo: 3 })).rejects.toMatchObject({
        code: 'PAGE_SITE_LIMIT',
        details: { limit: 2 },
      })
      // A page of a site is no site: the limit stops a new site only.
      await publish(start, 'uslugi.html', {
        turnNo: 4,
        place: { treeId: first.treeId, path: '/uslugi' },
      })
      // A site in the trash does not count.
      await deletePage(db, {
        pageId: first.pageId,
        workspaceId: start.workspaceId,
        by: 'client',
        actor: { type: 'system', service: 'test' },
      })
      await publish(start, 'c.html', { turnNo: 5 })
    })

    it('puts a page of a site at its path under a page that is there, once', async () => {
      const at = await chat()
      const home = await publish(at, 'index.html')
      expect(home).toMatchObject({ path: '/' })
      const uslugi = await publish(at, 'uslugi.html', {
        turnNo: 2,
        place: { treeId: home.treeId, path: '/uslugi' },
      })
      expect(uslugi).toMatchObject({ treeId: home.treeId, slug: home.slug, path: '/uslugi' })
      const remont = await publish(at, 'remont.html', {
        turnNo: 3,
        place: { treeId: home.treeId, path: '/uslugi/remont' },
      })
      expect(remont.path).toBe('/uslugi/remont')
      const place = (path: string) => ({ treeId: home.treeId, path })
      await expect(
        publish(at, 'x.html', { turnNo: 4, place: place('/uslugi') }),
      ).rejects.toMatchObject({ code: 'PAGE_PATH_TAKEN' })
      await expect(
        publish(at, 'x.html', { turnNo: 5, place: place('/net/stranicy') }),
      ).rejects.toMatchObject({ code: 'PAGE_PARENT_MISSING' })
      for (const path of ['/', '/Uslugi', '/uslugi/', '/a..b'])
        await expect(
          publish(at, 'x.html', { turnNo: 6, place: place(path) }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      const other = await chat()
      await expect(
        publish(other, 'x.html', { place: { treeId: home.treeId, path: '/chuzhoy' } }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })

      expect(await servedPage(db, home.slug, '/uslugi/remont')).toMatchObject({
        treeId: home.treeId,
        gone: null,
        page: { id: remont.pageId, state: 'live', content: { version: 1 } },
      })
      expect((await servedPage(db, home.slug, '/net'))?.page).toBeNull()
      const listed = await listWorkspacePages(db, at.workspaceId)
      expect(listed.find((each) => each.id === remont.pageId)).toMatchObject({
        treeId: home.treeId,
        parentId: uslugi.pageId,
        path: '/uslugi/remont',
        slug: home.slug,
      })
    })

    it('deletes a branch to the trash and returns it whole; the home page takes its site', async () => {
      const at = await chat()
      const home = await publish(at, 'index.html')
      const place = (path: string) => ({ treeId: home.treeId, path })
      const uslugi = await publish(at, 'uslugi.html', { turnNo: 2, place: place('/uslugi') })
      await publish(at, 'remont.html', { turnNo: 3, place: place('/uslugi/remont') })
      await publish(at, 'kontakty.html', { turnNo: 4, place: place('/kontakty') })
      const actor = { type: 'system', service: 'test' } as const
      const branch = await deletePage(db, {
        pageId: uslugi.pageId,
        workspaceId: at.workspaceId,
        by: 'client',
        actor,
      })
      expect(branch.pages).toBe(2)
      // Bytes read after the check that let the page through: a page in the trash gives none.
      expect(await servedContent(db, uslugi.pageId)).toBeNull()
      expect((await servedContent(db, home.pageId))?.bytes.byteLength).toBeGreaterThan(0)
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.page?.deleted).toBe(true)
      expect((await servedPage(db, home.slug, '/kontakty'))?.page?.deleted).toBe(false)
      expect((await servedPage(db, home.slug))?.gone).toBeNull()
      // A page of the branch is not returned alone while the page above it is in the trash.
      const remont = (await listWorkspacePages(db, at.workspaceId)).find(
        (each) => each.path === '/uslugi/remont',
      )!
      await expect(
        returnDeletedPage(db, { pageId: remont.id, workspaceId: at.workspaceId, actor }),
      ).rejects.toMatchObject({ code: 'PAGE_PARENT_DELETED' })
      await returnDeletedPage(db, { pageId: uslugi.pageId, workspaceId: at.workspaceId, actor })
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.page?.deleted).toBe(false)

      // The home page takes the whole site to the trash: 410 on every path.
      const site = await deletePage(db, {
        pageId: home.pageId,
        workspaceId: at.workspaceId,
        by: 'client',
        actor,
      })
      expect(site.pages).toBe(4)
      for (const path of ['/', '/kontakty', '/net'])
        expect((await servedPage(db, home.slug, path))?.gone).toBe('deleted')
      // Purged, the site keeps its row as the tombstone of its slug: 410 for ever (Дер2).
      await purgeDeletedPage(db, { pageId: home.pageId, workspaceId: at.workspaceId, actor })
      expect(await db.page.count({ where: { treeId: home.treeId } })).toBe(0)
      expect(await servedPage(db, home.slug)).toMatchObject({ gone: 'deleted', page: null })
    })

    it('takes a site down on every path from its home page, a page alone at its own path', async () => {
      const at = await chat()
      const home = await publish(at, 'index.html')
      const uslugi = await publish(at, 'uslugi.html', {
        turnNo: 2,
        place: { treeId: home.treeId, path: '/uslugi' },
      })
      await takeDownPage(db, { pageId: uslugi.pageId, by: 'client', workspaceId: at.workspaceId })
      expect((await servedPage(db, home.slug, '/uslugi'))?.page?.state).toBe('taken_down')
      expect((await servedPage(db, home.slug))?.gone).toBeNull()
      await takeDownPage(db, { pageId: home.pageId, by: 'client', workspaceId: at.workspaceId })
      expect((await servedPage(db, home.slug, '/net'))?.gone).toBe('taken_down')
      await restorePage(db, { pageId: home.pageId, workspaceId: at.workspaceId })
      expect((await servedPage(db, home.slug))?.gone).toBeNull()
      expect((await servedPage(db, home.slug, '/uslugi'))?.page?.state).toBe('taken_down')
    })

    it('sets one password for the site from any page of it (Дер17)', async () => {
      const at = await chat()
      const home = await publish(at, 'index.html')
      const uslugi = await publish(at, 'uslugi.html', {
        turnNo: 2,
        place: { treeId: home.treeId, path: '/uslugi' },
      })
      await setPagePassword(db, {
        workspaceId: at.workspaceId,
        pageId: uslugi.pageId,
        passwordHash: 'hash-1',
      })
      expect(await servedPage(db, home.slug)).toMatchObject({
        passwordHash: 'hash-1',
        passwordEpoch: 1,
      })
      expect((await listWorkspacePages(db, at.workspaceId)).every((each) => each.hasPassword)).toBe(
        true,
      )
    })
  })

  describe('changes of a turn (docs/plan/73-pages-sites.md, Дер23–Дер27)', () => {
    const html = (text: string) => new TextEncoder().encode(text)

    async function site(at: { workspaceId: string; taskId: string }) {
      const publishAt = async (
        fileName: string,
        turnNo: number,
        path?: string,
        treeId?: string,
      ) => {
        const reserved = await reservePagePublication(db, {
          ...at,
          turnNo,
          title: fileName,
          target: { fileName },
          ...(path && treeId ? { place: { treeId, path } } : {}),
        })
        const reservation = await db.pageReservation.findFirstOrThrow({
          where: { pageId: reserved.pageId, outcome: null },
        })
        await applyPageVersion(db, {
          pageId: reserved.pageId,
          bytes: html(`<p>${fileName}</p>`),
          source: 'outbox',
          reservationId: reservation.id,
        })
        return reserved
      }
      const home = await publishAt('index.html', 1)
      const uslugi = await publishAt('uslugi.html', 2, '/uslugi', home.treeId)
      const remont = await publishAt('remont.html', 3, '/uslugi/remont', home.treeId)
      const kontakty = await publishAt('kontakty.html', 4, '/kontakty', home.treeId)
      return { home, uslugi, remont, kontakty }
    }

    const apply = async (at: { workspaceId: string; taskId: string }, reservationId: string) =>
      applyPageChange(db, { reservationId, ...at })

    /** A page of the site published in a turn, as its end makes it (another chat's or this one's). */
    async function publishUnder(
      at: { workspaceId: string; taskId: string },
      fileName: string,
      treeId: string,
      path: string,
      turnNo: number,
    ) {
      const reserved = await reservePagePublication(db, {
        ...at,
        turnNo,
        title: fileName,
        target: { fileName },
        place: { treeId, path },
      })
      const reservation = await db.pageReservation.findFirstOrThrow({
        where: { pageId: reserved.pageId, outcome: null },
      })
      await applyPageVersion(db, {
        pageId: reserved.pageId,
        bytes: html(`<p>${fileName}</p>`),
        source: 'outbox',
        reservationId: reservation.id,
      })
    }

    it('allows the changes to a chat whose author manages the workspace only (Дер24)', async () => {
      for (const author of [undefined, 'member'] as const) {
        const at = await chat(author ? { author } : {})
        const { uslugi } = await site(at)
        await expect(
          reservePageChange(db, {
            ...at,
            turnNo: 9,
            change: { kind: 'update', pageId: uslugi.pageId, expectedVersion: 1, title: 'X' },
          }),
        ).rejects.toMatchObject({ code: 'PAGE_FORBIDDEN' })
      }
    })

    it('moves a branch to a new address, every former path sending on to its page, no chains (Дер19)', async () => {
      const at = await chat({ author: 'owner' })
      const { home, uslugi, remont } = await site(at)
      const first = await reservePageChange(db, {
        ...at,
        turnNo: 9,
        change: { kind: 'update', pageId: uslugi.pageId, expectedVersion: 1, segment: 'ceny' },
      })
      await apply(at, first.reservationId)
      expect((await servedPage(db, home.slug, '/ceny/remont'))?.page?.id).toBe(remont.pageId)
      expect(await servedPage(db, home.slug, '/uslugi/remont')).toMatchObject({
        page: null,
        redirect: '/ceny/remont',
      })
      // Moved again: the first former path leads to where the page is now, not to the second.
      const second = await reservePageChange(db, {
        ...at,
        turnNo: 10,
        change: { kind: 'update', pageId: uslugi.pageId, expectedVersion: 1, segment: 'price' },
      })
      await apply(at, second.reservationId)
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.redirect).toBe('/price/remont')
      expect((await servedPage(db, home.slug, '/ceny'))?.redirect).toBe('/price')
      // A new page at a former path takes it from its redirect.
      const back = await reservePagePublication(db, {
        ...at,
        turnNo: 11,
        title: 'Новые услуги',
        target: { fileName: 'u.html' },
        place: { treeId: home.treeId, path: '/uslugi' },
      })
      expect((await servedPage(db, home.slug, '/uslugi'))?.page?.id).toBe(back.pageId)
      expect((await servedPage(db, home.slug, '/uslugi'))?.redirect).toBeNull()
    })

    it('refuses a place a page cannot take, and the home page its address', async () => {
      const at = await chat({ author: 'admin' })
      const { home, uslugi, remont } = await site(at)
      const update = (pageId: string, change: { segment?: string; parentId?: string }) =>
        reservePageChange(db, {
          ...at,
          turnNo: 9,
          change: { kind: 'update', pageId, expectedVersion: 1, ...change },
        })
      await expect(update(home.pageId, { segment: 'x' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      await expect(update(uslugi.pageId, { parentId: remont.pageId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      await expect(update(remont.pageId, { segment: 'Remont' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      await expect(update(uslugi.pageId, { segment: 'kontakty' })).rejects.toMatchObject({
        code: 'PAGE_PATH_TAKEN',
      })
      await expect(
        reservePageChange(db, {
          ...at,
          turnNo: 9,
          change: { kind: 'update', pageId: uslugi.pageId, expectedVersion: 7, title: 'X' },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_VERSION_CHANGED' })
    })

    it('moves a branch to the trash by the agent and back, at most 20 pages a turn (Дер27)', async () => {
      const at = await chat({ author: 'owner' })
      const { home, uslugi } = await site(at)
      await expect(
        reservePageChange(db, {
          ...at,
          turnNo: 9,
          change: { kind: 'delete', pageId: uslugi.pageId, withChildren: false },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_HAS_CHILDREN' })
      const deletion = await reservePageChange(db, {
        ...at,
        turnNo: 9,
        change: { kind: 'delete', pageId: uslugi.pageId, withChildren: true },
      })
      expect(deletion.pages).toBe(2)
      expect(await apply(at, deletion.reservationId)).toMatchObject({ kind: 'delete', pages: 2 })
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.page?.deleted).toBe(true)
      const audit = await db.auditLog.findFirstOrThrow({
        where: { workspaceId: at.workspaceId, action: 'pages.delete' },
      })
      expect(audit).toMatchObject({ actorType: 'agent', actorId: at.taskId })
      const restore = await reservePageChange(db, {
        ...at,
        turnNo: 10,
        change: { kind: 'restore', pageId: uslugi.pageId },
      })
      expect(await apply(at, restore.reservationId)).toMatchObject({ kind: 'restore', pages: 2 })
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.page?.deleted).toBe(false)

      const big = await chat({ author: 'owner' })
      const tree = await site(big)
      for (let i = 0; i < 19; i += 1)
        await reservePagePublication(db, {
          ...big,
          turnNo: 20 + i,
          title: `p${i}`,
          target: { fileName: `p${i}.html` },
          place: { treeId: tree.home.treeId, path: `/kontakty/p${i}` },
        })
      await expect(
        reservePageChange(db, {
          ...big,
          turnNo: 50,
          change: { kind: 'delete', pageId: tree.kontakty.pageId, withChildren: true },
        }),
      ).resolves.toMatchObject({ pages: 20 })
      await expect(
        reservePageChange(db, {
          ...big,
          turnNo: 50,
          change: { kind: 'delete', pageId: tree.uslugi.pageId, withChildren: true },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_DELETE_LIMIT' })
    })

    it('applies a change after a version of the same turn, and refuses one after another chat’s (Дер25)', async () => {
      const at = await chat({ author: 'owner' })
      const { home, uslugi } = await site(at)
      // A new version of «Услуги» in turn 9, published with the version it read: 1.
      const next = await reservePagePublication(db, {
        ...at,
        turnNo: 9,
        title: 'Услуги',
        target: { fileName: 'uslugi-2.html' },
        pageId: uslugi.pageId,
        expectedVersion: 1,
      })
      expect(next.version).toBe(2)
      // Then a rename in the same turn, with the version the publication answered.
      const rename = await reservePageChange(db, {
        ...at,
        turnNo: 9,
        change: { kind: 'update', pageId: uslugi.pageId, expectedVersion: 2, title: 'Цены' },
      })
      const reservation = await db.pageReservation.findFirstOrThrow({
        where: { pageId: uslugi.pageId, kind: 'version', outcome: null },
      })
      await applyPageVersion(db, {
        pageId: uslugi.pageId,
        bytes: html('<p>2</p>'),
        source: 'outbox',
        taskId: at.taskId,
        turnNo: 9,
        reservationId: reservation.id,
      })
      await expect(apply(at, rename.reservationId)).resolves.toMatchObject({ kind: 'update' })
      // Another version of the client comes between a reservation and the end of its turn.
      const late = await reservePageChange(db, {
        ...at,
        turnNo: 10,
        change: { kind: 'update', pageId: home.pageId, expectedVersion: 1, title: 'Главная' },
      })
      await applyPageVersion(db, {
        pageId: home.pageId,
        bytes: html('<p>клиент</p>'),
        source: 'file',
      })
      await expect(apply(at, late.reservationId)).rejects.toMatchObject({
        code: 'PAGE_VERSION_CHANGED',
      })
    })

    it('makes two edits of one turn one after the other, under the page lock (Дер23)', async () => {
      const at = await chat({ author: 'owner' })
      const { uslugi } = await site(at)
      const edit = (old: string, value: string) =>
        reservePageChange(db, {
          ...at,
          turnNo: 9,
          change: {
            kind: 'edit',
            pageId: uslugi.pageId,
            expectedVersion: 1,
            edits: [{ old, new: value }],
          },
        })
      const first = await edit('uslugi.html', 'Услуги')
      const second = await edit('<p>', '<p class="x">')
      await expect(
        applyPageEdit(db, {
          ...at,
          reservationId: first.reservationId,
          readVersion: 1,
          bytes: html('<p>Услуги</p>'),
          markdown: null,
        }),
      ).resolves.toEqual({ version: 2 })
      // Read before the first was written: read again.
      await expect(
        applyPageEdit(db, {
          ...at,
          reservationId: second.reservationId,
          readVersion: 1,
          bytes: html('<p class="x">uslugi.html</p>'),
          markdown: null,
        }),
      ).rejects.toMatchObject({ code: 'PAGE_READ_STALE' })
      await expect(
        applyPageEdit(db, {
          ...at,
          reservationId: second.reservationId,
          readVersion: 2,
          bytes: html('<p class="x">Услуги</p>'),
          markdown: null,
        }),
      ).resolves.toEqual({ version: 3 })
      expect((await readPageSource(db, { ...at, pageId: uslugi.pageId })).text).toBe(
        '<p class="x">Услуги</p>',
      )
    })

    it('deletes no more than the branch the agent counted: pages added below it since stay (rule 4)', async () => {
      const at = await chat({ author: 'owner' })
      const { home, kontakty } = await site(at)
      const deletion = await reservePageChange(db, {
        ...at,
        turnNo: 9,
        change: { kind: 'delete', pageId: kontakty.pageId, withChildren: false },
      })
      await publishUnder(at, 'karta.html', home.treeId, '/kontakty/karta', 9)
      await expect(apply(at, deletion.reservationId)).rejects.toMatchObject({
        code: 'PAGE_HAS_CHILDREN',
      })
      const asked = await reservePageChange(db, {
        ...at,
        turnNo: 10,
        change: { kind: 'delete', pageId: kontakty.pageId, withChildren: true },
      })
      await publishUnder(at, 'shema.html', home.treeId, '/kontakty/shema', 10)
      await expect(apply(at, asked.reservationId)).rejects.toMatchObject({
        code: 'PAGE_BRANCH_CHANGED',
      })
      expect((await servedPage(db, home.slug, '/kontakty'))?.page?.deleted).toBe(false)
    })

    it('returns a page under its parent where the parent is now, its branch rebased', async () => {
      const at = await chat({ author: 'owner' })
      const { home, uslugi, remont } = await site(at)
      await deletePage(db, {
        ...at,
        pageId: remont.pageId,
        by: 'client',
        actor: { type: 'system', service: 'test' },
      })
      await updatePage(db, { ...at, pageId: uslugi.pageId, segment: 'ceny' })
      await returnDeletedPage(db, {
        ...at,
        pageId: remont.pageId,
        actor: { type: 'system', service: 'test' },
      })
      const page = await db.page.findUniqueOrThrow({ where: { id: remont.pageId } })
      expect(page.path).toBe('/ceny/remont')
      expect((await servedPage(db, home.slug, '/ceny/remont'))?.page?.id).toBe(remont.pageId)
      // Its former path leads to it, as every path the move of /uslugi made.
      expect((await servedPage(db, home.slug, '/uslugi/remont'))?.redirect).toBe('/ceny/remont')
    })

    it('gives the client back their own take-down when the support returns what it took down', async () => {
      const at = await chat()
      const { home, uslugi } = await site(at)
      const decide = (path: string, decision: 'take_down' | 'return') =>
        operatorPageDecision(db, {
          slug: home.slug,
          path,
          decision,
          reason: 'Жалоба',
          operator: 'op',
        })
      await takeDownPage(db, { pageId: home.pageId, workspaceId: at.workspaceId, by: 'client' })
      await takeDownPage(db, { pageId: uslugi.pageId, workspaceId: at.workspaceId, by: 'client' })
      await decide('/', 'take_down')
      await decide('/uslugi', 'take_down')
      await decide('/', 'return')
      await decide('/uslugi', 'return')
      // Still down, by the client now: they put it back themselves.
      expect((await servedPage(db, home.slug))?.gone).toBe('taken_down')
      expect(await db.pageTree.findUniqueOrThrow({ where: { id: home.treeId } })).toMatchObject({
        takenDownBy: 'client',
      })
      expect(await db.page.findUniqueOrThrow({ where: { id: uslugi.pageId } })).toMatchObject({
        state: 'taken_down',
        takenDownBy: 'client',
      })
      await restorePage(db, { pageId: home.pageId, workspaceId: at.workspaceId })
      expect((await servedPage(db, home.slug))?.gone).toBeNull()
    })

    it('puts one file of a turn once: again at the same path is the same, elsewhere or as a page refused', async () => {
      const at = await chat()
      const { home } = await site(at)
      const put = (path: string) =>
        reservePageFile(db, { ...at, turnNo: 30, treeId: home.treeId, fileName: 'a.css', path })
      const first = await put('/_files/a.css')
      expect(await put('/_files/a.css')).toEqual(first)
      await expect(put('/_files/b.css')).rejects.toMatchObject({ code: 'PAGE_RESERVED' })
      await expect(
        reservePagePublication(db, {
          ...at,
          turnNo: 30,
          title: 'A',
          target: { fileName: 'a.css' },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_RESERVED' })
    })

    it('deletes a shared file at the end of the turn of a chat of an owner, and only one that is there (Дер34)', async () => {
      for (const author of [undefined, 'member'] as const) {
        const at = await chat(author ? { author } : {})
        const { home } = await site(at)
        await expect(
          reservePageFileDeletion(db, {
            ...at,
            turnNo: 60,
            treeId: home.treeId,
            path: '/_files/a.css',
          }),
        ).rejects.toMatchObject({ code: 'PAGE_FORBIDDEN' })
      }
      const at = await chat({ author: 'owner' })
      const { home } = await site(at)
      await expect(
        reservePageFileDeletion(db, {
          ...at,
          turnNo: 60,
          treeId: home.treeId,
          path: '/_files/a.css',
        }),
      ).rejects.toMatchObject({ code: 'PAGE_FILE_NOT_FOUND' })
      const put = await reservePageFile(db, {
        ...at,
        turnNo: 60,
        treeId: home.treeId,
        fileName: 'a.css',
        path: '/_files/a.css',
      })
      await applyPageFile(db, { reservationId: put.reservationId, bytes: html('a{}') })
      const deletion = await reservePageFileDeletion(db, {
        ...at,
        turnNo: 61,
        treeId: home.treeId,
        path: '/_files/a.css',
      })
      // Still served until the end of the turn.
      expect(await servedFile(db, home.treeId, '/_files/a.css')).not.toBeNull()
      expect(await apply(at, deletion.reservationId)).toMatchObject({
        kind: 'file_delete',
        pages: 0,
      })
      expect(await servedFile(db, home.treeId, '/_files/a.css')).toBeNull()
      expect(
        await db.auditLog.count({
          where: { workspaceId: at.workspaceId, action: 'pages.file_delete' },
        }),
      ).toBe(1)
    })

    it('counts the sites by state and the bytes of the trash, for metrics without ids (73.12)', async () => {
      const before = await pageSiteStats(db)
      const at = await chat({ author: 'owner' })
      const { home, uslugi } = await site(at)
      const actor = { type: 'system', service: 'test' } as const
      await deletePage(db, {
        pageId: uslugi.pageId,
        workspaceId: at.workspaceId,
        by: 'client',
        actor,
      })
      const after = await pageSiteStats(db)
      expect(after.sites.live).toBe(before.sites.live + 1)
      // «Услуги» and the page below it are in the trash with their bytes.
      expect(after.trashBytes).toBeGreaterThan(before.trashBytes)
      await deletePage(db, {
        pageId: home.pageId,
        workspaceId: at.workspaceId,
        by: 'client',
        actor,
      })
      const deleted = await pageSiteStats(db)
      expect(deleted.sites.deleted).toBe(before.sites.deleted + 1)
      expect(deleted.sites.live).toBe(before.sites.live)
    })

    it('counts a site a turn left without a version no more, and keeps a site with files or a name', async () => {
      const at = await chat({ pageSites: 2, names: true })
      await site(at)
      // A new site whose home the turn left: the sweep has not removed it yet.
      const left = await reservePagePublication(db, {
        ...at,
        turnNo: 40,
        title: 'Брошенный',
        target: { fileName: 'left.html' },
      })
      const reservation = await db.pageReservation.findFirstOrThrow({
        where: { pageId: left.pageId, outcome: null },
      })
      await settlePageReservation(db, reservation.id, 'missing')
      // Not counted: a second site is made at once.
      const named = await reservePagePublication(db, {
        ...at,
        turnNo: 41,
        title: 'Второй',
        target: { fileName: 'second.html' },
      })
      await setTreeName(db, {
        pageId: named.pageId,
        workspaceId: at.workspaceId,
        name: `n${uuidv7().slice(0, 8)}`,
      })
      const second = await db.pageReservation.findFirstOrThrow({
        where: { pageId: named.pageId, outcome: null },
      })
      await settlePageReservation(db, second.id, 'missing')
      const later = new Date(Date.now() + 2 * 86_400_000)
      await db.page.updateMany({
        where: { id: { in: [left.pageId, named.pageId] } },
        data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
      })
      await dropAbandonedPages(db, later)
      expect(await db.pageTree.findUnique({ where: { id: left.treeId } })).toBeNull()
      // The named site stays: its name is its own for ever.
      expect(await db.pageTree.findUnique({ where: { id: named.treeId } })).not.toBeNull()
      expect(await db.page.findUnique({ where: { id: named.pageId } })).not.toBeNull()
    })

    it('purges the shared files of a site with its last page, and keeps its names when the site goes', async () => {
      const at = await chat({ names: true })
      const { home } = await site(at)
      const reserved = await reservePageFile(db, {
        ...at,
        turnNo: 50,
        treeId: home.treeId,
        fileName: 'site.css',
        path: '/_files/site.css',
      })
      await applyPageFile(db, { reservationId: reserved.reservationId, bytes: html('body{}') })
      const name = `p${uuidv7().slice(0, 8)}`
      await setTreeName(db, { pageId: home.pageId, workspaceId: at.workspaceId, name })
      const actor = { type: 'system', service: 'test' } as const
      await deletePage(db, {
        pageId: home.pageId,
        workspaceId: at.workspaceId,
        by: 'client',
        actor,
      })
      await purgeDeletedPage(db, { pageId: home.pageId, workspaceId: at.workspaceId, actor })
      expect(await db.pageFile.count({ where: { treeId: home.treeId } })).toBe(0)
      expect((await servedPage(db, home.slug))?.gone).toBe('deleted')
      // Even the row of the site gone, the name is taken for ever.
      await db.pageTree.delete({ where: { id: home.treeId } })
      expect(await db.pageTreeName.findUnique({ where: { name } })).toMatchObject({ treeId: null })
      const other = await chat({ names: true })
      const { home: theirs } = await site(other)
      await expect(
        setTreeName(db, { pageId: theirs.pageId, workspaceId: other.workspaceId, name }),
      ).rejects.toMatchObject({ code: 'PAGE_NAME_TAKEN' })
    })

    it('renames and moves a page from the cabinet at once (Дер30)', async () => {
      const at = await chat()
      const { home, uslugi, kontakty } = await site(at)
      expect(
        await updatePage(db, {
          pageId: kontakty.pageId,
          workspaceId: at.workspaceId,
          title: 'Контакты',
          parentId: uslugi.pageId,
        }),
      ).toEqual({ path: '/uslugi/kontakty' })
      expect((await servedPage(db, home.slug, '/kontakty'))?.redirect).toBe('/uslugi/kontakty')
      expect(
        (await listWorkspacePages(db, at.workspaceId)).find((each) => each.id === kontakty.pageId),
      ).toMatchObject({ title: 'Контакты', parentId: uslugi.pageId })
    })

    it('lets the operator take down a site by its host or one page by its path, and put back only theirs (Дер18)', async () => {
      const at = await chat()
      const { home, uslugi } = await site(at)
      const decide = (path: string, decision: 'take_down' | 'return') =>
        operatorPageDecision(db, {
          slug: home.slug,
          path,
          decision,
          reason: 'Жалоба',
          operator: 'op',
        })
      expect(await decide('/uslugi', 'take_down')).toMatchObject({ kind: 'done', site: false })
      expect((await servedPage(db, home.slug, '/uslugi'))?.page?.state).toBe('taken_down')
      expect(await decide('/uslugi', 'take_down')).toMatchObject({ kind: 'repeated' })
      // The client cannot put back what the support took down.
      await expect(
        restorePage(db, { pageId: uslugi.pageId, workspaceId: at.workspaceId }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
      expect(await decide('/', 'take_down')).toMatchObject({ kind: 'done', site: true })
      expect((await servedPage(db, home.slug, '/kontakty'))?.gone).toBe('taken_down')
      // Neither the trash nor its purge takes away what the support took down.
      await expect(
        deletePage(db, {
          pageId: home.pageId,
          workspaceId: at.workspaceId,
          by: 'client',
          actor: { type: 'system', service: 'test' },
        }),
      ).rejects.toMatchObject({ code: 'PAGE_TAKEN_DOWN' })
      expect(await decide('/', 'return')).toMatchObject({ kind: 'done', site: true })
      expect((await servedPage(db, home.slug))?.gone).toBeNull()
      expect(await decide('/net', 'take_down')).toEqual({ kind: 'not_found' })
      const entries = await db.auditLog.findMany({
        where: { workspaceId: at.workspaceId, actorType: 'operator' },
        orderBy: { createdAt: 'asc' },
      })
      expect(entries.map((entry) => entry.action)).toEqual([
        'pages.take_down',
        'pages.take_down',
        'pages.put_back',
      ])
    })

    it('gives a site its own name on a tariff that gives names, for ever (Дер32, Дер33)', async () => {
      const plain = await chat()
      const first = await site(plain)
      await expect(
        setTreeName(db, {
          pageId: first.home.pageId,
          workspaceId: plain.workspaceId,
          name: 'moya-firma',
        }),
      ).rejects.toMatchObject({ code: 'PAGE_NAME_NEEDS_PLAN' })
      const at = await chat({ names: true })
      const { home, uslugi } = await site(at)
      for (const name of ['ab', 'Moya', 'moya--firma', '-moya', 'www', 'a'.repeat(26)])
        await expect(
          setTreeName(db, { pageId: home.pageId, workspaceId: at.workspaceId, name }),
        ).rejects.toMatchObject({ code: 'PAGE_NAME_INVALID' })
      const name = `firma-${uuidv7().slice(-6)}`
      expect(
        await setTreeName(db, { pageId: uslugi.pageId, workspaceId: at.workspaceId, name }),
      ).toEqual({ name })
      expect(await servedPage(db, name, '/uslugi')).toMatchObject({
        host: null,
        page: { id: uslugi.pageId },
      })
      // Its slug sends on to the name.
      expect((await servedPage(db, home.slug))?.host).toBe(name)
      // A new name: the former one leads on to it, and stays the site's.
      const second = `${name}-2`
      await setTreeName(db, { pageId: home.pageId, workspaceId: at.workspaceId, name: second })
      expect((await servedPage(db, name))?.host).toBe(second)
      const other = await chat({ names: true })
      const theirs = await site(other)
      await expect(
        setTreeName(db, { pageId: theirs.home.pageId, workspaceId: other.workspaceId, name }),
      ).rejects.toMatchObject({ code: 'PAGE_NAME_TAKEN' })
      // Its own former name it may take back.
      await setTreeName(db, { pageId: home.pageId, workspaceId: at.workspaceId, name })
      expect((await servedPage(db, second))?.host).toBe(name)
      expect(
        (await listWorkspacePages(db, at.workspaceId)).find((each) => each.id === home.pageId),
      ).toMatchObject({ slug: name, name })
    })

    it('writes a shared file of a site a turn put, checked by its type, and serves it (Дер34)', async () => {
      const at = await chat()
      const { home } = await site(at)
      const put = async (fileName: string, path: string, bytes: Uint8Array, turnNo = 20) => {
        const reserved = await reservePageFile(db, {
          ...at,
          turnNo,
          treeId: home.treeId,
          fileName,
          path,
        })
        return applyPageFile(db, { reservationId: reserved.reservationId, bytes })
      }
      await expect(
        reservePageFile(db, {
          ...at,
          turnNo: 20,
          treeId: home.treeId,
          fileName: 'x.html',
          path: '/_files/x.html',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await put('style.css', '/_files/style.css', html('body{color:red}'))
      expect(await servedFile(db, home.treeId, '/_files/style.css')).toMatchObject({
        type: 'text/css; charset=utf-8',
      })
      // A «picture» that is something else is refused; nothing is written.
      await expect(put('logo.png', '/_files/logo.png', html('<script>'), 21)).rejects.toMatchObject(
        {
          code: 'PAGE_FILE_REFUSED',
        },
      )
      expect(await servedFile(db, home.treeId, '/_files/logo.png')).toBeNull()
      // The same path again replaces it.
      await put('style2.css', '/_files/style.css', html('body{color:blue}'), 22)
      const served = await servedFile(db, home.treeId, '/_files/style.css')
      expect(new TextDecoder().decode(served!.bytes)).toBe('body{color:blue}')
      expect(await listTreeFiles(db, { workspaceId: at.workspaceId, treeId: home.treeId })).toEqual(
        [expect.objectContaining({ path: '/_files/style.css', sizeBytes: 16 })],
      )
      const other = await chat()
      expect(
        await listTreeFiles(db, { workspaceId: other.workspaceId, treeId: home.treeId }),
      ).toEqual([])
      await deleteTreeFile(db, {
        workspaceId: at.workspaceId,
        treeId: home.treeId,
        path: '/_files/style.css',
      })
      expect(await servedFile(db, home.treeId, '/_files/style.css')).toBeNull()
    })

    it('gives the agent the text a page shows, the Markdown of a page of text (Дер26)', async () => {
      const at = await chat()
      const page = await reservePagePublication(db, {
        ...at,
        turnNo: 1,
        title: 'Отчёт',
        target: { fileName: 'r.md' },
      })
      const reservation = await db.pageReservation.findFirstOrThrow({
        where: { pageId: page.pageId },
      })
      await applyPageVersion(db, {
        pageId: page.pageId,
        bytes: html('<h1>Отчёт</h1>'),
        markdown: html('# Отчёт'),
        source: 'outbox',
        reservationId: reservation.id,
      })
      expect(
        await readPageSource(db, { pageId: page.pageId, workspaceId: at.workspaceId }),
      ).toMatchObject({
        version: 1,
        format: 'markdown',
        text: '# Отчёт',
      })
      const other = await chat()
      await expect(
        readPageSource(db, { pageId: page.pageId, workspaceId: other.workspaceId }),
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
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
      const row = await db.artifactBlock.findFirstOrThrow({
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

    it('keeps the text of every version, for the switch of versions (14.11.2026)', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'Первый')
      await write(ids, 'sources', 'Источники')
      await requestDocFinish(db, { ...ids, turnNo: 1 })
      await endOfTurn(ids.taskId, 1)
      await write(ids, 'summary', 'Второй', 2)
      await requestDocFinish(db, { ...ids, turnNo: 2 })
      const [settled] = await endOfTurn(ids.taskId, 2)
      expect(settled?.version).toBe(2)
      const versions = await docVersions(db, ids)
      expect(versions.map((version) => [version.no, version.kept])).toEqual([
        [1, true],
        [2, true],
      ])
      expect(await docVersionMarkdown(db, { ...ids, version: 1 })).toContain('Первый')
      expect(await docVersionMarkdown(db, { ...ids, version: 2 })).toContain('Второй')
      expect(await docVersionMarkdown(db, { ...ids, version: 3 })).toBeNull()
      await expect(
        docVersions(db, { workspaceId: uuidv7(), documentId: ids.documentId }),
      ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' })
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
      const document = await db.artifact.findUniqueOrThrow({ where: { id: ids.documentId } })
      expect(document).toMatchObject({ currentVersion: 0, finishTaskId: null, finishTurnNo: null })
    })

    it('lets no other chat read a section before core checked it', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'значение сайта А')
      const other = await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: ids.workspaceId,
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
      const sections = await db.artifactBlock.findMany({
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
        (await db.artifact.findUniqueOrThrow({ where: { id: ids.documentId } })).finishTurnNo,
      ).toBe(2)
    })

    it('clears text no end of a turn checked, once its document is left a day', async () => {
      const ids = await skeleton()
      await write(ids, 'summary', 'непроверенное')
      await db.artifact.update({
        where: { id: ids.documentId },
        data: { updatedAt: new Date('2020-01-01') },
      })
      expect(await clearStaleUncheckedSections(db, new Date('2021-01-01'))).toBe(1)
      const row = await db.artifactBlock.findFirstOrThrow({
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
        (await db.artifact.findUniqueOrThrow({ where: { id: ids.documentId } })).finishTaskId,
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
