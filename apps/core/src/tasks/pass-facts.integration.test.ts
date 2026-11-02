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
import type { AgentDriver, TurnPlan } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  sampleBackendId,
  sampleDriverId,
  sampleModelSlug,
  sampleProviderModelId,
} from '../testing/ids.ts'
import { readPassFacts } from './pass-facts.ts'
import { INIT_PROMPT } from './turn-instructions.ts'
import { planTurn } from './turn-planner.ts'

// What a pass reads of the client's variables of its site (docs/plan/53-chat-preview-release.md,
// Р13): the hosts the agent's commands may reach, never a value; and of the turns of its task.
// Reads only: any database.
const databaseUrl = process.env.DATABASE_URL

// The plan reads only these of a driver.
const driver = {
  id: sampleDriverId,
  image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
  cliVersion: '1.0.0',
  capabilities: {
    resume: true,
    jsonEvents: true,
    outputSchema: false,
    mcp: true,
    images: false,
    reasoningEvents: false,
    compaction: false,
  },
  prepare: () => {
    throw new Error('not called by the plan')
  },
  command: () => {
    throw new Error('not called by the plan')
  },
  parseEvent: () => [],
  sessionState: () => ({ root: `/agent-home/${sampleDriverId}`, include: [], exclude: [] }),
  extractResult: () => null,
} as unknown as AgentDriver

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
    await db.gitRepository.deleteMany({ where: { site: { name: 'Billing verification' } } })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function dialog({
    browser = false,
    both = false,
    chat,
  }: { browser?: boolean; both?: boolean; chat?: { browser: boolean } } = {}) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      ...(browser ? { needsRepository: false, needsBrowser: true } : {}),
      ...(both ? { needsRepository: true, needsBrowser: true } : {}),
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

  it('keeps the accesses of the wizard of a chat with the code alone, as it did (К21)', async () => {
    const { task, facts } = await dialog()
    const consented = { toAgent: true, agentConsentAt: new Date() }
    const siteId = siteIdOf(task)
    await db.siteEnvVar.createMany({
      data: [
        { siteId, name: 'SITE_DB_PASSWORD', hosts: ['db.example.ru:3306'], ...consented },
        { siteId, name: 'SITE_GIT_TOKEN', hosts: ['git.example.ru:443'], ...consented },
      ],
    })
    const read = await facts()
    expect(read?.variables).toEqual(['SITE_DB_PASSWORD', 'SITE_GIT_TOKEN'])
    expect(read?.egress).toEqual(['db.example.ru:3306', 'git.example.ru:443'])
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: a turn whose pass ended in a failure is replaced.
  it('reads `/init` as the words of the platform, `/compact` as an action, a press as no words (§5.2)', async () => {
    const { task, userId, facts } = await dialog()
    const base = { v: 1 as const, authorId: userId }
    for (const payload of [
      { ...base, kind: 'agent_command' as const, command: 'init' as const },
      { ...base, kind: 'agent_command' as const, command: 'compact' as const },
      { ...base, kind: 'command' as const, command: 'reset' as const },
    ])
      await insertFeedEvent(db, {
        taskId: task.id,
        row: { type: 'feed.request', payload: { ...payload, requestId: randomUUID() } },
      })

    const read = await facts()
    expect(
      read?.requests.map(({ kind, text, action, command }) => ({ kind, text, action, command })),
    ).toEqual([
      { kind: 'first', text: 'Подключите оплату', action: undefined, command: null },
      { kind: 'agent_command', text: INIT_PROMPT, action: undefined, command: null },
      { kind: 'agent_command', text: null, action: 'compact', command: null },
      { kind: 'command', text: null, action: undefined, command: 'reset' },
    ])
  })

  it('reads the notes of the site for a turn with the code alone (§5.7)', async () => {
    const { task, facts } = await dialog()
    await db.site.update({
      where: { id: siteIdOf(task) },
      data: { agentNotes: 'Тема — в wp-content/themes/shop' },
    })
    expect((await facts())?.agentNotes).toBe('Тема — в wp-content/themes/shop')
  })

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

  describe('where `/undo` left the branch', () => {
    const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
    const [first, second, third, moved] = ['b', 'd', 'e', 'f'].map((c) => c.repeat(40)) as [
      string,
      string,
      string,
      string,
    ]

    /** The saved plan of a turn that found the branch on `base`. */
    const planOf = (
      task: { id: string; workspaceId: string; siteId: string | null },
      turn: number,
      base: string,
    ): TurnPlan => ({
      sandbox: {
        image,
        labels: {
          workspaceId: task.workspaceId,
          siteId: siteIdOf(task),
          taskId: task.id,
          sessionId: task.id,
          turn,
        },
        runtime: 'runc',
        resources: { cpu: 1, memoryMiB: 256, pids: 64 },
        user: { uid: 10001, gid: 10001 },
        env: {},
        secrets: [],
        network: { mode: 'none' },
        hardTimeoutMs: 600_000,
      },
      context: {
        taskId: task.id,
        sessionId: task.id,
        turn,
        llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
        mcp: { url: 'http://mcp.invalid/mcp' },
        instructions: 'Synthetic',
      },
      input: { prompt: 'Synthetic', attachments: [] },
      driverId: sampleDriverId,
      driverVersion: '1.0.0',
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
        branch: `agent/${task.id}`,
        expectedBaseSha: base,
        protectedPaths: [],
      },
      committedAt: '2026-10-01T00:00:00.000Z',
    })
    const turnOf = async (
      task: { id: string; workspaceId: string; siteId: string | null },
      turnNo: number,
      turn: { headSha?: string; base: string; undone?: boolean; status?: 'completed' | 'failed' },
    ) => {
      await db.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo,
          status: turn.status ?? 'completed',
          driverId: sampleDriverId,
          image,
          headSha: turn.headSha ?? null,
          undoneAt: turn.undone ? new Date() : null,
        },
      })
      await db.turnAssignment.create({
        data: {
          taskId: task.id,
          siteId: siteIdOf(task),
          sessionId: task.id,
          turnNo,
          executor: 'local',
          plan: planOf(task, turnNo, turn.base),
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 60_000),
          outcome: turn.status ?? 'completed',
          finishedAt: new Date(),
        },
      })
    }

    it('finds it where the undone turn found it, not on the head of that turn', async () => {
      const { task, facts } = await dialog()
      await turnOf(task, 1, { headSha: first, base: 'a'.repeat(40) })
      await turnOf(task, 2, { headSha: second, base: first, undone: true })
      expect((await facts())?.writtenHead).toBe(first)
    })

    it('finds none after the first turn: its undo left no branch', async () => {
      const { task, facts } = await dialog()
      await turnOf(task, 1, { headSha: first, base: 'a'.repeat(40), undone: true })
      expect((await facts())?.writtenHead).toBeNull()
    })

    it('reads a turn that published after the undone one, past a failed turn too', async () => {
      const { task, facts } = await dialog()
      await turnOf(task, 1, { headSha: first, base: 'a'.repeat(40) })
      await turnOf(task, 2, { headSha: second, base: first, undone: true })
      await turnOf(task, 3, { headSha: third, base: first })
      await turnOf(task, 4, { base: third, status: 'failed' })
      expect((await facts())?.writtenHead).toBe(third)
    })

    it('finds it on the head of an «Обновить» that came after the undo', async () => {
      const { task, facts } = await dialog()
      await turnOf(task, 1, { headSha: first, base: 'a'.repeat(40) })
      await turnOf(task, 2, { headSha: second, base: first, undone: true })
      await db.task.update({ where: { id: task.id }, data: { turnNo: 2 } })
      await db.taskCandidate.create({
        data: {
          taskId: task.id,
          revision: 1,
          turnNo: 2,
          baseSha: 'a'.repeat(40),
          baseTree: 'c'.repeat(40),
          headSha: moved,
          dbPlanSha256: '0'.repeat(64),
          proposedBump: 'minor',
          proposedVersion: 'v0.1.0',
          facts: {},
        },
      })
      expect((await facts())?.writtenHead).toBe(moved)
    })
  })

  it('reads which turn the client took back by `/undo`: a thing apart from a refusal', async () => {
    const { task, facts } = await dialog()
    const turn = (turnNo: number, undoneAt: Date | null) => ({
      taskId: task.id,
      turnNo,
      status: 'completed' as const,
      driverId: sampleDriverId,
      image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
      undoneAt,
    })
    await db.taskTurn.createMany({ data: [turn(1, null), turn(2, new Date())] })
    const read = await facts()
    expect(read?.turns.get(1)).toMatchObject({ undone: false, rejected: false })
    expect(read?.turns.get(2)).toMatchObject({ undone: true, rejected: false })
  })

  it('reads which files came with which words: an undone request takes its files along', async () => {
    const { task, userId, facts } = await dialog()
    const file = randomUUID()
    await insertFeedEvent(db, {
      taskId: task.id,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'answer',
          authorId: userId,
          requestId: randomUUID(),
          text: 'Вот файл',
          attachments: [file],
          answersEventId: '1',
        },
      },
    })
    const read = await facts()
    expect(read?.requests.map((request) => request.attachments)).toEqual([[], [file]])
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

  // docs/plan/61-chats-first.md, §5.6, К21: the row as a test writes it, up to the plan of its turn.
  it('reads of a chat with the code and the browser what its turn gets, the accesses aside', async () => {
    const { task, workspaceId, userId, facts } = await dialog({ both: true })
    const siteId = siteIdOf(task)
    await db.gitRepository.create({
      data: {
        siteId,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${siteId}`,
        url: `https://git.example.ru/sites/site-${siteId}`,
      },
    })
    const consented = { toAgent: true, agentConsentAt: new Date() }
    await db.siteEnvVar.createMany({
      data: [
        { siteId, name: 'MAIL_API_KEY', hosts: ['mail.example.ru:443'], ...consented },
        { siteId, name: 'FTP_PASSWORD', hosts: ['ftp.example.ru:443'], ...consented },
        { siteId, name: 'SFTP_PRIVATE_KEY', hosts: ['sftp.example.ru:443'], ...consented },
        { siteId, name: 'SITE_DB_PASSWORD', hosts: ['db.example.ru:3306'], ...consented },
        { siteId, name: 'SITE_GIT_TOKEN', hosts: ['git.example.ru:443'], ...consented },
      ],
    })
    const file = (await createAttachment(db, {
      workspaceId,
      siteId,
      uploadedById: userId,
      fileName: 'смета.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    }))!
    await markAttachmentReady(db, { id: file.id, sizeBytes: 2048, contentType: 'application/pdf' })
    await bindAttachments(db, { ids: [file.id], taskId: task.id, userId, workspaceId, siteId })

    const read = await facts()

    expect(read?.requirements).toEqual({ repository: true, browser: true })
    expect(read?.repo).toMatchObject({ owner: 'sites', name: `site-${siteId}` })
    expect(read?.variables).toEqual(['MAIL_API_KEY'])
    expect(read?.egress).toEqual(['mail.example.ru:443'])
    expect(read?.attachments).toEqual([expect.objectContaining({ id: file.id })])
    expect(read?.browser?.attachments).toEqual([expect.objectContaining({ id: file.id })])
    // The repository's rules of the stack, which a task in the browser alone has none of.
    expect(read?.rules.protectedPaths).not.toEqual([])

    // The enabled model is the whole database's: the test names its own.
    const profile = {
      backend: sampleBackendId,
      modelSlug: sampleModelSlug,
      providerModelId: sampleProviderModelId,
    }
    const plan = await planTurn(
      { ...read!, profile },
      {
        driver,
        backends: llmBackends,
        runtime: 'runc',
        browser: true,
        mainHead: async () => 'a'.repeat(40),
        branchHead: async () => null,
      },
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.requirements).toEqual({ repository: true, browser: true })
    expect(plan.request.workspace).toBeDefined()
    expect(plan.request.requirements).toEqual({ repository: true, browser: true })
    expect(plan.request.input.prompt).toContain('https://')
    expect(plan.request.input.prompt).toContain('смета.pdf')
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
