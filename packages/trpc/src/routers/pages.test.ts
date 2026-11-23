import { randomUUID } from 'node:crypto'

import {
  applyPageVersion,
  createPrismaClient,
  insertFeedEvent,
  purgeExpiredPages,
  reservePagePublication,
  servedPage,
  verifyPagePassword,
  type PrismaClient,
} from '@repo/db'
import { readingPage } from '@repo/doc-render'
import { chatFileKey, legalDocuments } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { cabinetDocMarkdown } from '../services/pages.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { Context } from '../trpc.ts'

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

// «Страницы» of the cabinet on PostgreSQL (docs/plan/69-pages.md, Ст13–Ст15, Ст20, Ст30): rows of
// its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const address = { baseDomain: 'pages.localhost', scheme: 'http' as const, port: 8092 }

describe.skipIf(!databaseUrl)('pages router with PostgreSQL', () => {
  let db: PrismaClient
  const users: string[] = []
  const workspaces: string[] = []
  const plans: string[] = []

  /**
   * A tariff of the test with as many sites as a test makes (docs/plan/73-pages-sites.md, Дер36):
   * without a paid tariff a workspace has one site. Removed at the end with its subscription.
   */
  async function onTariff(workspaceId: string, pageSites = 1000) {
    const plan = await db.plan.create({
      data: {
        slug: `sites-${randomUUID()}`,
        name: 'Тест',
        kind: 'quota',
        price: '0.00',
        creditsPerMonth: 1,
        pageSites,
        isActive: false,
      },
    })
    plans.push(plan.id)
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

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    if (!db) return
    await db.page.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.auditLog.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.pageTree.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.subscription.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.plan.deleteMany({ where: { id: { in: plans } } })
    await db.task.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.member.deleteMany({ where: { workspaceId: { in: workspaces } } })
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } })
    await db.userConsent.deleteMany({ where: { userId: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
    await db.$disconnect()
  })

  async function person() {
    const user = await db.user.create({
      data: { name: 'Анна', email: `pages-${randomUUID()}@example.test`, emailVerified: true },
    })
    users.push(user.id)
    for (const document of legalDocuments)
      if (document.required && document.consentType)
        await db.userConsent.create({
          data: {
            userId: user.id,
            documentType: document.consentType,
            documentVersion: document.version,
            granted: true,
            source: 'sign_up',
          },
        })
    return user
  }

  /** The bucket of the chat's files: what `storage.get` returns, by key. */
  const objects = new Map<string, Uint8Array>()
  const storage = {
    get: async (_bucket: string, key: string) => {
      const bytes = objects.get(key)
      return bytes === undefined
        ? null
        : (async function* () {
            yield bytes
          })()
    },
  }

  function callerOf(user: { id: string; name: string; email: string }, pages = true) {
    const now = new Date()
    const context: Context = {
      prisma: db,
      headers: new Headers(),
      user: {
        ...user,
        lastName: null,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      } as never,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: randomUUID(),
        expiresAt: new Date('2030-01-01'),
        createdAt: now,
        updatedAt: now,
      } as never,
      billing: null,
      chat: (pages
        ? { pages: address, storage: () => storage }
        : { pages: null, storage: () => storage }) as unknown as ChatContext,
    }
    return createCaller(context)
  }

  /** A workspace with its owner, a plain member, and a live page of a chat. */
  async function workspaceWithPage() {
    const owner = await person()
    const member = await person()
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    await onTariff(workspace.id)
    await db.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } })
    await db.member.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'member' },
    })
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        needsBrowser: false,
        title: 'Цены',
      },
    })
    const page = await reservePagePublication(db, {
      workspaceId: workspace.id,
      taskId: task.id,
      turnNo: 1,
      title: 'Прайс',
      target: { fileName: 'p.html' },
    })
    // As the end of its turn does: the version fulfils the reservation, which closes.
    const reservation = await db.pageReservation.findFirstOrThrow({
      where: { pageId: page.pageId },
    })
    await applyPageVersion(db, {
      pageId: page.pageId,
      bytes: new TextEncoder().encode('<p>'),
      source: 'outbox',
      reservationId: reservation.id,
    })
    return { owner, member, workspace, task, page }
  }

  it('lists the pages of the user’s workspaces with their one address, and no chat (plan 73, Дер8)', async () => {
    const { owner, member, page } = await workspaceWithPage()
    const listed = await callerOf(owner).pages.list()
    expect(listed.enabled).toBe(true)
    expect(listed.pages).toEqual([
      expect.objectContaining({
        pageId: page.pageId,
        title: 'Прайс',
        url: `http://${page.slug}.pages.localhost:8092/`,
        state: 'live',
        version: 1,
        hasPassword: false,
        trash: null,
        canManage: true,
      }),
    ])
    expect(listed.pages[0]).not.toHaveProperty('chat')
    expect((await callerOf(member).pages.list()).pages[0]?.canManage).toBe(false)
    expect(await callerOf(await person()).pages.list()).toEqual({ enabled: true, pages: [] })
    expect(await callerOf(owner, false).pages.list()).toEqual({ enabled: false, pages: [] })
  })

  it('lets the owner set and clear the password, a member not, a stranger not even see it', async () => {
    const { owner, member, page } = await workspaceWithPage()
    await callerOf(owner).pages.setPassword({ pageId: page.pageId, password: 'секрет-1' })
    const served = await servedFlat(db, page.slug)
    expect(await verifyPagePassword('секрет-1', served!.passwordHash!)).toBe(true)
    expect((await callerOf(owner).pages.list()).pages[0]?.hasPassword).toBe(true)
    await expect(
      callerOf(member).pages.setPassword({ pageId: page.pageId, password: 'другой' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      callerOf(await person()).pages.setPassword({ pageId: page.pageId, password: 'другой' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      callerOf(owner).pages.setPassword({ pageId: page.pageId, password: 'abc' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await callerOf(owner).pages.setPassword({ pageId: page.pageId, password: null })
    expect((await servedFlat(db, page.slug))?.passwordHash).toBeNull()
  })

  it('takes a page down and puts it back, for the owner only', async () => {
    const { owner, member, page } = await workspaceWithPage()
    await expect(callerOf(member).pages.takeDown({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await callerOf(owner).pages.takeDown({ pageId: page.pageId })
    expect((await servedFlat(db, page.slug))?.state).toBe('taken_down')
    expect((await callerOf(owner).pages.list()).pages[0]).toMatchObject({
      state: 'taken_down',
      takenDownBy: 'client',
    })
    await callerOf(owner).pages.restore({ pageId: page.pageId })
    expect((await servedFlat(db, page.slug))?.state).toBe('live')
  })

  it('lets no stranger take a page down, no client put back what the support took down, and shows no hash', async () => {
    const { owner, page } = await workspaceWithPage()
    const stranger = callerOf(await person())
    await expect(stranger.pages.takeDown({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(stranger.pages.restore({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await callerOf(owner).pages.setPassword({ pageId: page.pageId, password: 'секрет-1' })
    const listed = await callerOf(owner).pages.list()
    expect(JSON.stringify(listed)).not.toContain('scrypt')
    // The support takes the host down: the site of the home page (Дер18).
    await db.pageTree.update({
      where: { id: listed.pages[0]!.treeId },
      data: { takenDownAt: new Date(), takenDownBy: 'operator' },
    })
    await expect(callerOf(owner).pages.restore({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect((await servedFlat(db, page.slug))?.state).toBe('taken_down')
  })

  // ——————————————————————————————— the trash (docs/plan/73-pages-sites.md, Дер1–Дер4)

  it('deletes a page to the trash: 410 at once, back with the same address and version', async () => {
    const { owner, workspace, page } = await workspaceWithPage()
    const before = Date.now()
    const { purgeAfter } = await callerOf(owner).pages.delete({ pageId: page.pageId })
    const days = (Date.parse(purgeAfter) - before) / 86_400_000
    expect(days).toBeGreaterThan(29.99)
    expect(days).toBeLessThan(30.01)
    expect(await servedFlat(db, page.slug)).toMatchObject({ deleted: true, content: null })
    expect((await callerOf(owner).pages.list()).pages[0]?.trash).toEqual({
      deletedAt: expect.any(String),
      purgeAfter,
    })
    // Deleting again changes nothing; a password does not land on a deleted page.
    expect((await callerOf(owner).pages.delete({ pageId: page.pageId })).purgeAfter).toBe(
      purgeAfter,
    )
    await expect(
      callerOf(owner).pages.setPassword({ pageId: page.pageId, password: 'секрет-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('в корзине') })

    await callerOf(owner).pages.returnDeleted({ pageId: page.pageId })
    expect(await servedFlat(db, page.slug)).toMatchObject({
      deleted: false,
      state: 'live',
      content: { version: 1 },
    })
    const audit = await db.auditLog.findMany({
      where: { workspaceId: workspace.id, targetId: page.pageId },
      orderBy: { createdAt: 'asc' },
    })
    expect(audit.map((row) => [row.action, row.actorType, row.actorId])).toEqual([
      ['pages.delete', 'user', owner.id],
      ['pages.return', 'user', owner.id],
    ])
    expect(JSON.stringify(audit)).not.toContain('<p>')
  })

  it('lets only the owner delete: a member is refused, a stranger sees nothing', async () => {
    const { member, page } = await workspaceWithPage()
    await expect(callerOf(member).pages.delete({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const stranger = callerOf(await person())
    for (const call of [
      () => stranger.pages.delete({ pageId: page.pageId }),
      () => stranger.pages.returnDeleted({ pageId: page.pageId }),
      () => stranger.pages.purge({ pageId: page.pageId }),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await servedFlat(db, page.slug))?.deleted).toBe(false)
  })

  it('deletes no page the support took down, nor one a turn is publishing now (Дер3)', async () => {
    const { owner, task, workspace, page } = await workspaceWithPage()
    await reservePagePublication(db, {
      workspaceId: workspace.id,
      taskId: task.id,
      turnNo: 2,
      title: 'Прайс',
      target: { fileName: 'p.html' },
      pageId: page.pageId,
    })
    await expect(callerOf(owner).pages.delete({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Агент сейчас публикует'),
    })
    await db.pageReservation.updateMany({
      where: { pageId: page.pageId, outcome: null },
      data: { outcome: 'failed', settledAt: new Date() },
    })
    await db.page.update({
      where: { id: page.pageId },
      data: { state: 'taken_down', takenDownAt: new Date(), takenDownBy: 'operator' },
    })
    await expect(callerOf(owner).pages.delete({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Страницу сняла поддержка — удалить её нельзя',
    })
    expect((await servedFlat(db, page.slug))?.deleted).toBe(false)
  })

  it('keeps a deleted page from the agent: no new version of it, a new page of the file instead', async () => {
    const { owner, task, workspace, page } = await workspaceWithPage()
    await callerOf(owner).pages.delete({ pageId: page.pageId })
    await expect(
      reservePagePublication(db, {
        workspaceId: workspace.id,
        taskId: task.id,
        turnNo: 3,
        title: 'Прайс',
        target: { fileName: 'p.html' },
        pageId: page.pageId,
      }),
    ).rejects.toMatchObject({ code: 'PAGE_DELETED' })
    const fresh = await reservePagePublication(db, {
      workspaceId: workspace.id,
      taskId: task.id,
      turnNo: 3,
      title: 'Прайс',
      target: { fileName: 'p2.html' },
    })
    expect(fresh.pageId).not.toBe(page.pageId)
  })

  it('purges a page in the trash for good, by the client at once or by the sweep after 30 days', async () => {
    const { owner, workspace, page } = await workspaceWithPage()
    await expect(callerOf(owner).pages.purge({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await callerOf(owner).pages.delete({ pageId: page.pageId })
    await callerOf(owner).pages.purge({ pageId: page.pageId })
    // The site keeps its row as the tombstone of its slug: 410 for ever (Дер2).
    expect(await servedFlat(db, page.slug)).toMatchObject({ deleted: true, content: null })
    expect(await db.pageVersion.count({ where: { pageId: page.pageId } })).toBe(0)

    const other = await workspaceWithPage()
    await callerOf(other.owner).pages.delete({ pageId: other.page.pageId })
    // Not yet due: the sweep leaves it. (Only pages already due are swept — the base may be shared.)
    await purgeExpiredPages(db)
    expect(await servedFlat(db, other.page.slug)).not.toBeNull()
    await db.page.update({
      where: { id: other.page.pageId },
      data: { purgeAfter: new Date(Date.now() - 1000) },
    })
    await purgeExpiredPages(db)
    expect(await servedFlat(db, other.page.slug)).toMatchObject({ deleted: true, content: null })
    expect(await db.page.count({ where: { id: other.page.pageId } })).toBe(0)
    const purges = await db.auditLog.findMany({
      where: { action: 'pages.purge', workspaceId: { in: [workspace.id, other.workspace.id] } },
    })
    expect(purges.map((row) => [row.actorType, row.actorId]).sort()).toEqual(
      [
        ['system', 'core'],
        ['user', owner.id],
      ].sort(),
    )
  })

  it('deletes the page of a document that waits for its version, and tells the chat (review)', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const document = await db.artifact.create({
      data: { workspaceId: workspace.id, taskId: task.id, title: 'Аудит' },
    })
    const waiting = await reservePagePublication(db, {
      workspaceId: workspace.id,
      taskId: task.id,
      turnNo: 4,
      title: 'Аудит',
      target: { documentId: document.id },
    })
    await callerOf(owner).pages.delete({ pageId: waiting.pageId })
    const reservation = await db.pageReservation.findFirstOrThrow({
      where: { pageId: waiting.pageId },
    })
    expect(reservation.outcome).toBe('failed')
    expect(await db.taskEvent.count({ where: { taskId: task.id, type: 'feed.page_left' } })).toBe(1)
    // The agent cannot publish the document again onto the page in the trash.
    await expect(
      reservePagePublication(db, {
        workspaceId: workspace.id,
        taskId: task.id,
        turnNo: 5,
        title: 'Аудит',
        target: { documentId: document.id },
      }),
    ).rejects.toMatchObject({ code: 'PAGE_DELETED', message: expect.stringContaining('document') })
  })

  it('writes no version into the trash, and purges no page the support took down there', async () => {
    const { owner, workspace, page } = await workspaceWithPage()
    await callerOf(owner).pages.delete({ pageId: page.pageId })
    await expect(
      applyPageVersion(db, {
        pageId: page.pageId,
        workspaceId: workspace.id,
        bytes: new TextEncoder().encode('<p>2'),
        source: 'outbox',
      }),
    ).rejects.toMatchObject({ code: 'PAGE_DELETED' })
    await db.page.update({
      where: { id: page.pageId },
      data: {
        state: 'taken_down',
        takenDownAt: new Date(),
        takenDownBy: 'operator',
        purgeAfter: new Date(Date.now() - 1000),
      },
    })
    await expect(callerOf(owner).pages.purge({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Страницу сняла поддержка — удалить её нельзя',
    })
    await purgeExpiredPages(db)
    expect(await servedFlat(db, page.slug)).toMatchObject({ state: 'taken_down', deleted: true })
  })

  it('reads a document for its card: checked text only, nothing for a stranger', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const document = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        taskId: task.id,
        title: 'Аудит',
        sections: {
          create: [
            {
              sectionKey: 'a',
              intent: 'Итог',
              position: 0,
              state: 'written',
              heading: 'Итог',
              markdown: 'проверено',
              writtenTaskId: task.id,
              writtenTurn: 1,
              checkedTurn: 1,
            },
            {
              sectionKey: 'b',
              intent: 'Метод',
              position: 1,
              state: 'written',
              heading: 'Метод',
              markdown: 'не проверено',
              writtenTaskId: task.id,
              writtenTurn: 2,
            },
            { sectionKey: 'c', intent: 'Источники', position: 2 },
          ],
        },
      },
    })
    const read = await callerOf(owner).pages.doc({ docId: document.id })
    // The bar counts what the agent wrote, checked or not (plan 74, Д3).
    expect(read.progress).toEqual({ written: 2, total: 3 })
    expect(read).toMatchObject({ view: 'text', draft: true })
    expect(read.sections.map((each) => [each.key, each.state, each.markdown])).toEqual([
      ['a', 'shown', 'проверено'],
      ['b', 'unchecked', null],
      ['c', 'pending', null],
    ])
    expect(JSON.stringify(read)).not.toContain('не проверено')
    await expect(callerOf(await person()).pages.doc({ docId: document.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await db.artifact.delete({ where: { id: document.id } })
  })

  it('names the downloaded Markdown by the title, without direction marks or leading dots', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const document = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        taskId: task.id,
        title: '..Отчёт\u202Egpj.exe',
        currentVersion: 1,
      },
    })
    await db.artifactVersion.create({
      data: { documentId: document.id, no: 1, sizeBytes: 9, sha256: 'a'.repeat(64) },
    })
    await db.artifactContent.create({
      data: { documentId: document.id, versionNo: 1, markdown: '# Отчёт\n' },
    })
    const markdown = await cabinetDocMarkdown(db, { documentId: document.id, userId: owner.id })
    expect(markdown).toMatchObject({ markdown: '# Отчёт\n', version: 1 })
    expect(markdown!.name).toBe('Отчёт gpj.exe.md')
    expect(
      await cabinetDocMarkdown(db, { documentId: document.id, userId: (await person()).id }),
    ).toBeNull()
    await db.artifact.delete({ where: { id: document.id } })
  })

  it('shows a page document as its page to read, downloads it as .html, and tells a draft (plan 74)', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const markdown = '# Аудит\n\n## Итог\n\nТри причины.\n'
    const document = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        taskId: task.id,
        title: 'Аудит',
        view: 'page',
        currentVersion: 1,
        sections: {
          create: [
            {
              sectionKey: 'a',
              intent: 'Итог',
              position: 0,
              state: 'written',
              heading: 'Итог',
              markdown: 'Три причины.',
              writtenTaskId: task.id,
              writtenTurn: 1,
              checkedTurn: 1,
            },
          ],
        },
      },
    })
    await db.artifactVersion.create({
      data: { documentId: document.id, no: 1, sizeBytes: 9, sha256: 'a'.repeat(64) },
    })
    await db.artifactContent.create({
      data: { documentId: document.id, versionNo: 1, markdown },
    })
    const caller = callerOf(owner)
    expect(await caller.pages.doc({ docId: document.id })).toMatchObject({
      view: 'page',
      draft: false,
      progress: { written: 1, total: 1 },
    })
    const page = await caller.pages.docPage({ docId: document.id, version: 1 })
    expect(page?.version).toBe(1)
    expect(page?.html).toContain('Три причины.')
    expect(page?.html).not.toContain('<script')
    const download = await cabinetDocMarkdown(db, { documentId: document.id, userId: owner.id })
    expect(download).toMatchObject({ name: 'Аудит.html', view: 'page' })
    expect(download?.html).toContain('Три причины.')
    // The agent changes the section again: the tab shows the sections until the next version.
    await db.artifactBlock.updateMany({
      where: { documentId: document.id },
      data: { markdown: 'Четыре причины.', checkedTurn: 2, writtenTurn: 2 },
    })
    expect((await caller.pages.doc({ docId: document.id })).draft).toBe(true)
    await db.artifact.update({ where: { id: document.id }, data: { view: 'text' } })
    expect(await caller.pages.docPage({ docId: document.id, version: 1 })).toBeNull()
    await db.artifact.delete({ where: { id: document.id } })
  })

  /** A document of the chat with one version of `markdown`. */
  async function documentWithVersion(workspaceId: string, taskId: string, markdown: string) {
    const document = await db.artifact.create({
      data: { workspaceId, taskId, title: 'Аудит', currentVersion: 1 },
    })
    await db.artifactVersion.create({
      data: { documentId: document.id, no: 1, sizeBytes: 9, sha256: 'a'.repeat(64) },
    })
    await db.artifactContent.create({
      data: { documentId: document.id, versionNo: 1, markdown },
    })
    return document
  }

  it('publishes a document by link: its version drawn for reading, the owner only (Ст25)', async () => {
    const { owner, member, workspace, task } = await workspaceWithPage()
    const markdown = '# Аудит\n\nТри причины.'
    const document = await documentWithVersion(workspace.id, task.id, markdown)
    await expect(callerOf(member).pages.publishDoc({ docId: document.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const first = await callerOf(owner).pages.publishDoc({ docId: document.id })
    expect(first.version).toBe(1)
    expect(first.url).toMatch(/^http:\/\/[a-z2-7]{26}\.pages\.localhost:8092\/$/)
    const slug = new URL(first.url).hostname.split('.')[0]!
    const served = await servedFlat(db, slug)
    expect(served).toMatchObject({ state: 'live', content: { version: 1 } })
    expect(Buffer.from(served!.content!.bytes).toString()).toBe(
      await readingPage({ title: 'Аудит', markdown }),
    )
    // Again: the next version of the same page.
    const again = await callerOf(owner).pages.publishDoc({ docId: document.id })
    expect(again).toMatchObject({ pageId: first.pageId, url: first.url, version: 2 })
    expect((await callerOf(owner).pages.doc({ docId: document.id })).page).toMatchObject({
      pageId: first.pageId,
      version: 2,
    })
    expect((await callerOf(owner).pages.doc({ docId: document.id })).canPublish).toBe(true)
    expect((await callerOf(member).pages.doc({ docId: document.id })).canPublish).toBe(false)
    // Pages not set up here: nothing is published.
    await expect(
      callerOf(owner, false).pages.publishDoc({ docId: document.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('publishes no document still written, nor one with a key in it', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const written = await db.artifact.create({
      data: { workspaceId: workspace.id, taskId: task.id, title: 'Пишется' },
    })
    await expect(callerOf(owner).pages.publishDoc({ docId: written.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Документ ещё пишется: опубликовать можно, когда агент его допишет',
    })
    const keyed = await documentWithVersion(
      workspace.id,
      task.id,
      `# Ключ\n\nsk-rdt-${'x'.repeat(43)}`,
    )
    await expect(callerOf(owner).pages.publishDoc({ docId: keyed.id })).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      message:
        'В странице есть то, что похоже на ключ или пароль: показывать это всем нельзя. Попросите агента убрать это',
    })
    expect(await db.page.count({ where: { documentId: keyed.id } })).toBe(0)
  })

  it('publishes no document of a removed chat, nor one the agent is publishing now', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const busy = await documentWithVersion(workspace.id, task.id, '# Аудит\n\nТекст')
    // A turn under way reserved it: the number of the version is the turn's.
    await reservePagePublication(db, {
      workspaceId: workspace.id,
      taskId: task.id,
      turnNo: 7,
      title: 'Аудит',
      target: { documentId: busy.id },
    })
    await expect(callerOf(owner).pages.publishDoc({ docId: busy.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Агент сейчас публикует эту страницу. Опубликуйте её, когда он закончит ответ',
    })
    const removed = await db.task.create({
      data: {
        workspaceId: workspace.id,
        needsBrowser: false,
        deletedAt: new Date(),
      },
    })
    const orphan = await documentWithVersion(workspace.id, removed.id, '# Старое\n\nТекст')
    await expect(callerOf(owner).pages.publishDoc({ docId: orphan.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  /** «Новой страницей» (docs/plan/73-pages-sites.md, Дер9). */
  const NEW = { new: {} }

  /** A file of the chat, as `ChatFiles.deliver` leaves it: a `feed.file` row and its object. */
  async function chatFile(taskId: string, name: string, text: string) {
    const fileId = randomUUID()
    const bytes = new TextEncoder().encode(text)
    await insertFeedEvent(db, {
      taskId,
      turnId: null,
      row: { type: 'feed.file', payload: { v: 1, fileId, name, sizeBytes: bytes.byteLength } },
    })
    objects.set(chatFileKey(taskId, fileId), bytes)
    return fileId
  }

  it('publishes a page of the chat as it is, and a .md drawn for reading (Ст32)', async () => {
    const { owner, member, task } = await workspaceWithPage()
    const html = await chatFile(task.id, 'Прайс.html', '<!doctype html><p>Цены</p>')
    await expect(callerOf(member).pages.canPublish({ taskId: task.id })).resolves.toBe(false)
    await expect(callerOf(owner).pages.canPublish({ taskId: task.id })).resolves.toBe(true)
    await expect(callerOf(owner, false).pages.canPublish({ taskId: task.id })).resolves.toBe(false)
    await expect(
      callerOf(member).pages.publishFile({ taskId: task.id, fileId: html, target: NEW }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const page = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: html,
      target: NEW,
    })
    const slug = new URL(page.url).hostname.split('.')[0]!
    expect(Buffer.from((await servedFlat(db, slug))!.content!.bytes).toString()).toBe(
      '<!doctype html><p>Цены</p>',
    )
    // The same file again, as a version of its page the client chose (Дер9).
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: task.id,
        fileId: html,
        target: { pageId: page.pageId, expectedVersion: 1 },
      }),
    ).resolves.toMatchObject({ pageId: page.pageId, version: 2 })

    const markdown = '# Отчёт\n\n<script>alert(1)</script>Текст'
    const md = await chatFile(task.id, 'отчёт.md', markdown)
    const drawn = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: md,
      target: NEW,
    })
    expect(drawn.pageId).not.toBe(page.pageId)
    const served = await servedFlat(db, new URL(drawn.url).hostname.split('.')[0]!)
    expect(Buffer.from(served!.content!.bytes).toString()).toBe(
      await readingPage({ title: 'Отчёт', markdown }),
    )
    expect(
      await db.page.findUniqueOrThrow({ where: { id: drawn.pageId }, select: { kind: true } }),
    ).toEqual({ kind: 'markdown' })
  })

  it('refuses a file that is no page, one with a key, and a page the client took down', async () => {
    const { owner, task } = await workspaceWithPage()
    const sheet = await chatFile(task.id, 'смета.csv', 'a;b')
    await expect(
      callerOf(owner).pages.publishFile({ taskId: task.id, fileId: sheet, target: NEW }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const binary = await chatFile(task.id, 'b.html', '\uFFFD')
    objects.set(chatFileKey(task.id, binary), new Uint8Array([0xff, 0xfe, 0xfd]))
    await db.taskEvent.updateMany({
      where: { taskId: task.id, type: 'feed.file', payload: { path: ['fileId'], equals: binary } },
      data: { payload: { v: 1, fileId: binary, name: 'b.html', sizeBytes: 3 } },
    })
    await expect(
      callerOf(owner).pages.publishFile({ taskId: task.id, fileId: binary, target: NEW }),
    ).rejects.toMatchObject({
      message: 'Это не текстовый документ: страницей его опубликовать нельзя',
    })
    const keyed = await chatFile(task.id, 'k.html', `<p>sk-rdt-${'x'.repeat(43)}</p>`)
    await expect(
      callerOf(owner).pages.publishFile({ taskId: task.id, fileId: keyed, target: NEW }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' })
    const html = await chatFile(task.id, 'a.html', '<p>a</p>')
    const page = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: html,
      target: NEW,
    })
    await callerOf(owner).pages.takeDown({ pageId: page.pageId })
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: task.id,
        fileId: html,
        target: { pageId: page.pageId, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // Someone else's chat: not found.
    await expect(
      callerOf(await person()).pages.publishFile({ taskId: task.id, fileId: html, target: NEW }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // ——————————————————————————————— a page belongs to its workspace (plan 73, Дер9)

  it('makes a new page without a target page, even of a file of the same name in the same chat', async () => {
    const { owner, task } = await workspaceWithPage()
    const first = await chatFile(task.id, 'Прайс.html', '<p>1</p>')
    const again = await chatFile(task.id, 'Прайс.html', '<p>2</p>')
    const a = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: first,
      target: NEW,
    })
    const b = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: again,
      target: { new: { title: 'Прайс — декабрь' } },
    })
    expect(b.pageId).not.toBe(a.pageId)
    expect(b.version).toBe(1)
    const listed = (await callerOf(owner).pages.list()).pages
    expect(listed.find((each) => each.pageId === b.pageId)).toMatchObject({
      title: 'Прайс — декабрь',
      sourceFileName: 'Прайс.html',
    })
  })

  it('puts a file of another chat into the page the client chose, at the version they saw', async () => {
    const { owner, workspace, page } = await workspaceWithPage()
    const other = await db.task.create({
      data: {
        workspaceId: workspace.id,
        needsBrowser: false,
        title: 'Другой чат',
      },
    })
    const md = await chatFile(other.id, 'прайс.md', '# Прайс\n\nНовые цены')
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: other.id,
        fileId: md,
        target: { pageId: page.pageId, expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('новая версия'),
    })
    const next = await callerOf(owner).pages.publishFile({
      taskId: other.id,
      fileId: md,
      target: { pageId: page.pageId, expectedVersion: 1 },
    })
    expect(next).toMatchObject({ pageId: page.pageId, version: 2 })
    // A version keeps the title of its page and names the file it now shows (review of 73.4).
    const row = (await callerOf(owner).pages.list()).pages.find(
      (each) => each.pageId === page.pageId,
    )
    expect(row).toMatchObject({ title: 'Прайс', sourceFileName: 'прайс.md' })
    // A .md serves for reading: the page took the kind of its new file.
    expect(await servedFlat(db, page.slug)).toMatchObject({
      kind: 'markdown',
      content: { version: 2 },
    })
  })

  it('puts no file into a page of another workspace, of a document, or one the support took down', async () => {
    const { owner, task } = await workspaceWithPage()
    const foreign = await workspaceWithPage()
    const html = await chatFile(task.id, 'x.html', '<p>x</p>')
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: task.id,
        fileId: html,
        target: { pageId: foreign.page.pageId, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const document = await documentWithVersion(task.workspaceId, task.id, '# Аудит\n\nТекст')
    const docPage = await callerOf(owner).pages.publishDoc({ docId: document.id })
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: task.id,
        fileId: html,
        target: { pageId: docPage.pageId, expectedVersion: docPage.version },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const made = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: html,
      target: NEW,
    })
    await db.page.update({
      where: { id: made.pageId },
      data: { state: 'taken_down', takenDownAt: new Date(), takenDownBy: 'operator' },
    })
    await expect(
      callerOf(owner).pages.publishFile({
        taskId: task.id,
        fileId: html,
        target: { pageId: made.pageId, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('offers as targets the live pages of files of the chat’s own workspace only', async () => {
    const { owner, member, task, page } = await workspaceWithPage()
    const foreign = await workspaceWithPage()
    const html = await chatFile(task.id, 'z.html', '<p>z</p>')
    const down = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: html,
      target: NEW,
    })
    await callerOf(owner).pages.takeDown({ pageId: down.pageId })
    const trashed = await callerOf(owner).pages.publishFile({
      taskId: task.id,
      fileId: html,
      target: NEW,
    })
    await callerOf(owner).pages.delete({ pageId: trashed.pageId })
    const document = await documentWithVersion(task.workspaceId, task.id, '# Аудит\n\nТекст')
    await callerOf(owner).pages.publishDoc({ docId: document.id })
    expect(await callerOf(owner).pages.targets({ taskId: task.id })).toEqual([
      { pageId: page.pageId, title: 'Прайс', version: 1, sourceFileName: 'p.html' },
    ])
    expect(await callerOf(member).pages.targets({ taskId: task.id })).toEqual([])
    await expect(callerOf(foreign.owner).pages.targets({ taskId: task.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
