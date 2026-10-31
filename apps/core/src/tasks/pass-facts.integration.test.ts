import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  bindAttachments,
  createAttachment,
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  openBrowserSession,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import { BROWSER_ONLY, REPOSITORY_ONLY, siteIdOf, turnSkillsOf } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { readPassFacts } from './pass-facts.ts'

// What a pass reads of the client's variables of its site (docs/plan/53-chat-preview-release.md,
// Р13): the hosts the agent's commands may reach, never a value; and of the turns of its task.
// Reads only: any database.
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('the egress of a pass with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    // Files hold their site (Restrict): the fixtures' cleanup removes sites, not files.
    await db.attachment.deleteMany({
      where: { OR: [{ site: { name: 'Billing verification' } }, { fileName: 'смета.pdf' }] },
    })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function dialog({
    browser = false,
    chat,
  }: { browser?: boolean; chat?: { browser: boolean } } = {}) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      ...(browser ? { needsRepository: false, needsBrowser: true } : {}),
      ...(chat ? { siteId: null, needsRepository: false, needsBrowser: chat.browser } : {}),
    })
    // No reserve to read: the class ceiling stands for the budget.
    const task = await db.task.update({ where: { id: taskId }, data: { billable: false } })
    const requestEventId = await insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: userId,
          requestId: randomUUID(),
          text: 'Подключите оплату',
        },
      },
    })
    const facts = () =>
      readPassFacts(
        { db, adapter: getSiteAdapter, backends: llmBackends, previews: null },
        {
          taskId,
          attempt: 1,
          turnNo: 0,
          requestEventId: String(requestEventId),
          now: new Date(),
        },
      )
    return { task, workspaceId: workspace.id, userId, facts }
  }

  it('takes the hosts of the variables the agent gets, each once, and none for client data', async () => {
    const { task, workspaceId, facts } = await dialog()
    const consented = { toAgent: true, agentConsentAt: new Date() }
    await db.siteEnvVar.createMany({
      data: [
        {
          siteId: siteIdOf(task),
          name: 'PAYMENT_KEY',
          hosts: ['pay.example.ru:443', 'api.example.ru:443'],
          ...consented,
        },
        { siteId: siteIdOf(task), name: 'HOOK_TOKEN', hosts: ['api.example.ru:443'], ...consented },
        // The preview's alone: the agent never reaches its host.
        { siteId: siteIdOf(task), name: 'PREVIEW_ONLY', hosts: ['preview.example.ru:443'] },
      ],
    })
    const read = await facts()
    expect(read?.requirements).toEqual(REPOSITORY_ONLY)
    expect(read?.browser).toBeUndefined()
    expect(read?.egress).toEqual(['api.example.ru:443', 'pay.example.ru:443'])
    expect(read?.variables).toEqual(['HOOK_TOKEN', 'PAYMENT_KEY'])
    // What the agent is told of the database is the adapter's word for the site's stack.
    expect(read?.databaseGuide).toContain('/wp/v2/pages')
    // Until the gate of 152-FZ nothing of a workspace of client data reaches the agent.
    await db.workspace.update({ where: { id: workspaceId }, data: { dataClass: 'client' } })
    const closed = await facts()
    expect(closed?.egress).toEqual([])
    expect(closed?.variables).toEqual([])
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: a turn whose pass ended in a failure is replaced.
  it('reads which turns the platform refused, and still the head they wrote', async () => {
    const { task, facts } = await dialog()
    const turn = (turnNo: number, headSha: string, rejectedAt: Date | null) => ({
      taskId: task.id,
      turnNo,
      status: 'completed' as const,
      driverId: sampleDriverId,
      image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
      headSha,
      rejectedAt,
    })
    await db.taskTurn.createMany({
      data: [turn(1, 'b'.repeat(40), null), turn(2, 'd'.repeat(40), new Date())],
    })
    const read = await facts()
    expect([read?.turns.get(1)?.rejected, read?.turns.get(2)?.rejected]).toEqual([false, true])
    // The branch holds what the refused turn published: the next push is leased on it.
    expect(read?.writtenHead).toBe('d'.repeat(40))
  })

  // docs/plan/57-browser-tasks.md, Б2, Б8, Б20, Б26.
  describe('of a chat without a project (docs/plan/61-chats-first.md, §5.6)', () => {
    async function chat(browser: boolean) {
      const { task, workspaceId, userId, facts } = await dialog({ chat: { browser } })
      const file = (await createAttachment(db, {
        workspaceId,
        siteId: null,
        uploadedById: userId,
        fileName: 'смета.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      }))!
      await markAttachmentReady(db, {
        id: file.id,
        sizeBytes: 2048,
        contentType: 'application/pdf',
      })
      expect(
        await bindAttachments(db, {
          ids: [file.id],
          taskId: task.id,
          userId,
          workspaceId,
          siteId: null,
        }),
      ).toBe(true)
      return { task, file, facts }
    }

    it('reads no site, no repository, no variables and the skills every turn has', async () => {
      const { task, file, facts } = await chat(false)
      const read = await facts()
      expect(read).toMatchObject({
        task: { id: task.id, siteId: null },
        requirements: { repository: false, browser: false },
        repo: null,
        rules: { protectedPaths: [] },
        preview: { state: 'absent' },
        egress: [],
        variables: [],
        attachments: [{ id: file.id, fileName: 'смета.pdf' }],
      })
      expect(read).not.toHaveProperty('browser')
      expect(read).not.toHaveProperty('databaseGuide')
      expect(read!.skills).toEqual(turnSkillsOf([]))
    })

    it('reads the browser of the chat as its files alone', async () => {
      const { file, facts } = await chat(true)
      const read = await facts()
      expect(read!.browser).toEqual({
        siteUrl: null,
        agentNotes: null,
        attachments: [expect.objectContaining({ id: file.id })],
        saved: [],
        guide: null,
      })
      expect(read!.attachments).toEqual(read!.browser!.attachments)
    })
  })

  it('gives the files of a task with a repository to its turn', async () => {
    const { task, workspaceId, userId, facts } = await dialog()
    const file = (await createAttachment(db, {
      workspaceId,
      siteId: siteIdOf(task),
      uploadedById: userId,
      fileName: 'смета.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    }))!
    await markAttachmentReady(db, { id: file.id, sizeBytes: 2048, contentType: 'application/pdf' })
    expect(
      await bindAttachments(db, {
        ids: [file.id],
        taskId: task.id,
        userId,
        workspaceId,
        siteId: siteIdOf(task),
      }),
    ).toBe(true)

    const read = await facts()

    expect(read?.requirements).toEqual(REPOSITORY_ONLY)
    expect(read?.attachments).toEqual([expect.objectContaining({ id: file.id })])
    expect(read).not.toHaveProperty('browser')
  })

  it('reads of a task in the browser its site, its notes, its files and the stack’s guide', async () => {
    const { task, workspaceId, userId, facts } = await dialog({ browser: true })
    await db.site.update({ where: { id: siteIdOf(task) }, data: { agentNotes: 'Вход по /login' } })
    const file = (await createAttachment(db, {
      workspaceId,
      siteId: siteIdOf(task),
      uploadedById: userId,
      fileName: 'news.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    }))!
    await markAttachmentReady(db, { id: file.id, sizeBytes: 2048, contentType: 'application/pdf' })
    // A file uploaded and never sent is not the task's.
    await createAttachment(db, {
      workspaceId,
      siteId: siteIdOf(task),
      uploadedById: userId,
      fileName: 'unsent.png',
      contentType: 'image/png',
      sizeBytes: 10,
    })
    expect(
      await bindAttachments(db, {
        ids: [file.id],
        taskId: task.id,
        userId,
        workspaceId,
        siteId: siteIdOf(task),
      }),
    ).toBe(true)

    // What the task saved in an earlier session (Б22): a later pass tells the agent of it.
    const session = await openBrowserSession(db, { taskId: task.id })
    const siteUrl = (await db.site.findUniqueOrThrow({ where: { id: siteIdOf(task) } })).url
    const editUrl = (id: string) =>
      new URL(`/wp-admin/post.php?post=${id}&action=edit`, siteUrl).href
    const checkpoint = (objectId: string, state: 'seen' | 'unverified' | 'verified') =>
      upsertBrowserCheckpoint(db, {
        taskId: task.id,
        sessionId: session.id,
        ref: { kind: 'post', objectId, editUrl: editUrl(objectId) },
        state,
        ...(state === 'verified'
          ? {
              verified: {
                kind: 'post' as const,
                objectId,
                title: 'Новость о скидках',
                status: 'draft' as const,
                editUrl: editUrl(objectId),
                images: 1,
                files: 1,
                featuredImage: false,
              },
            }
          : {}),
      })
    await checkpoint('7', 'verified')
    // Only looked at: nothing saved.
    await checkpoint('8', 'seen')
    await checkpoint('9', 'unverified')

    const read = await facts()

    expect(read?.requirements).toEqual(BROWSER_ONLY)
    expect(read?.browser).toEqual({
      siteUrl,
      agentNotes: 'Вход по /login',
      attachments: [
        { id: file.id, fileName: 'news.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
      ],
      saved: [
        {
          kind: 'post',
          objectId: '7',
          state: 'verified',
          title: 'Новость о скидках',
          status: 'draft',
          editPath: '/wp-admin/post.php',
        },
        { kind: 'post', objectId: '9', state: 'unverified', editPath: '/wp-admin/post.php' },
      ],
      guide: getSiteAdapter('wordpress').browserGuide(),
    })
    // Б26: its files reach a page through the browser worker alone, never the sandbox.
    expect(read).not.toHaveProperty('attachments')
    // Nothing of a repository: no rules of a working copy, no guide to the database.
    expect(read?.rules).toEqual({ protectedPaths: [] })
    expect(read?.databaseGuide).toBeUndefined()
    // Never a key of a file, nor the query of an editor.
    expect(JSON.stringify(read?.browser)).not.toContain('inbox/')
    expect(JSON.stringify(read?.browser?.saved)).not.toContain('action=edit')
  })
})
