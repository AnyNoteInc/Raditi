import { randomUUID } from 'node:crypto'

import {
  applyPageVersion,
  createPrismaClient,
  reservePagePublication,
  servedPage,
  verifyPagePassword,
  type PrismaClient,
} from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { cabinetDocMarkdown } from '../services/pages.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { Context } from '../trpc.ts'

// «Страницы» of the cabinet on PostgreSQL (docs/plan/69-pages.md, Ст13–Ст15, Ст20, Ст30): rows of
// its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const address = { baseDomain: 'pages.localhost', scheme: 'http' as const, port: 8092 }

describe.skipIf(!databaseUrl)('pages router with PostgreSQL', () => {
  let db: PrismaClient
  const users: string[] = []
  const workspaces: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    if (!db) return
    await db.page.deleteMany({ where: { workspaceId: { in: workspaces } } })
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
      chat: (pages ? { pages: address } : { pages: null }) as ChatContext,
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
    await db.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } })
    await db.member.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'member' },
    })
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: null,
        needsRepository: false,
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
    await applyPageVersion(db, {
      pageId: page.pageId,
      bytes: new TextEncoder().encode('<p>'),
      source: 'outbox',
    })
    return { owner, member, workspace, task, page }
  }

  it('lists the pages of the user’s workspaces with their one address', async () => {
    const { owner, member, task, page } = await workspaceWithPage()
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
        chat: { id: task.id, title: 'Цены' },
        canManage: true,
      }),
    ])
    expect((await callerOf(member).pages.list()).pages[0]?.canManage).toBe(false)
    expect(await callerOf(await person()).pages.list()).toEqual({ enabled: true, pages: [] })
    expect(await callerOf(owner, false).pages.list()).toEqual({ enabled: false, pages: [] })
  })

  it('lets the owner set and clear the password, a member not, a stranger not even see it', async () => {
    const { owner, member, page } = await workspaceWithPage()
    await callerOf(owner).pages.setPassword({ pageId: page.pageId, password: 'секрет-1' })
    const served = await servedPage(db, page.slug)
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
    expect((await servedPage(db, page.slug))?.passwordHash).toBeNull()
  })

  it('takes a page down and puts it back, for the owner only', async () => {
    const { owner, member, page } = await workspaceWithPage()
    await expect(callerOf(member).pages.takeDown({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await callerOf(owner).pages.takeDown({ pageId: page.pageId })
    expect((await servedPage(db, page.slug))?.state).toBe('taken_down')
    expect((await callerOf(owner).pages.list()).pages[0]).toMatchObject({
      state: 'taken_down',
      takenDownBy: 'client',
    })
    await callerOf(owner).pages.restore({ pageId: page.pageId })
    expect((await servedPage(db, page.slug))?.state).toBe('live')
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
    await db.page.update({
      where: { id: page.pageId },
      data: { state: 'taken_down', takenDownAt: new Date(), takenDownBy: 'operator' },
    })
    await expect(callerOf(owner).pages.restore({ pageId: page.pageId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect((await servedPage(db, page.slug))?.state).toBe('taken_down')
  })

  it('reads a document for its card: checked text only, nothing for a stranger', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const document = await db.chatDocument.create({
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
    expect(read.progress).toEqual({ written: 1, total: 3 })
    expect(read.sections.map((each) => [each.key, each.state, each.markdown])).toEqual([
      ['a', 'shown', 'проверено'],
      ['b', 'unchecked', null],
      ['c', 'pending', null],
    ])
    expect(JSON.stringify(read)).not.toContain('не проверено')
    await expect(callerOf(await person()).pages.doc({ docId: document.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await db.chatDocument.delete({ where: { id: document.id } })
  })

  it('names the downloaded Markdown by the title, without direction marks or leading dots', async () => {
    const { owner, workspace, task } = await workspaceWithPage()
    const document = await db.chatDocument.create({
      data: {
        workspaceId: workspace.id,
        taskId: task.id,
        title: '..Отчёт\u202Egpj.exe',
        currentVersion: 1,
      },
    })
    await db.chatDocumentVersion.create({
      data: { documentId: document.id, no: 1, sizeBytes: 9, sha256: 'a'.repeat(64) },
    })
    await db.chatDocumentContent.create({
      data: { documentId: document.id, versionNo: 1, markdown: '# Отчёт\n' },
    })
    const markdown = await cabinetDocMarkdown(db, { documentId: document.id, userId: owner.id })
    expect(markdown).toMatchObject({ markdown: '# Отчёт\n', version: 1 })
    expect(markdown!.name).toBe('Отчёт gpj.exe.md')
    expect(
      await cabinetDocMarkdown(db, { documentId: document.id, userId: (await person()).id }),
    ).toBeNull()
    await db.chatDocument.delete({ where: { id: document.id } })
  })
})
