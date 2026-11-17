import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  bindAttachments,
  createAttachment,
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  type PrismaClient,
} from '@repo/db'
import { turnSkillsOf } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { readPassFacts } from './pass-facts.ts'
import { INIT_PROMPT } from './turn-instructions.ts'

// What a pass reads of a chat (docs/plan/83-remove-projects.md): the names of the variables of its
// workspace, never a value; its requests, turns and files. Reads only: any database.
const databaseUrl = process.env.DATABASE_URL

/** A UUID of version 7, as the browser makes the id of a project. */
function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe.skipIf(!databaseUrl)('the facts of a pass with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const projects: string[] = []
  const projectTasks: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await db.attachment.deleteMany({ where: { fileName: 'смета.pdf' } })
    await db.task.updateMany({ where: { id: { in: projectTasks } }, data: { projectId: null } })
    await db.project.deleteMany({ where: { id: { in: projects } } })
    projects.length = 0
    projectTasks.length = 0
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function dialog({ browser = false }: { browser?: boolean } = {}) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      needsBrowser: browser,
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
        { db, backends: llmBackends },
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

  it('reads the names of the variables of the workspace, for client data too (БП4, БП14)', async () => {
    const { workspaceId, facts } = await dialog()
    await db.workspaceEnvVar.createMany({
      data: [
        { workspaceId, name: 'SMTP_PASSWORD' },
        { workspaceId, name: 'PAYMENT_KEY' },
      ],
    })
    expect((await facts())?.variables).toEqual(['PAYMENT_KEY', 'SMTP_PASSWORD'])
    // Real client data: the agent gets them all the same (the owner's decision of 17.11.2026).
    await db.workspace.update({ where: { id: workspaceId }, data: { dataClass: 'client' } })
    expect((await facts())?.variables).toEqual(['PAYMENT_KEY', 'SMTP_PASSWORD'])
  })

  it('reads `/init` as the words of the platform, `/compact` as an action, a press as no words (§5.2)', async () => {
    const { task, userId, facts } = await dialog()
    const base = { v: 1 as const, authorId: userId }
    for (const payload of [
      { ...base, kind: 'agent_command' as const, command: 'init' as const },
      { ...base, kind: 'agent_command' as const, command: 'compact' as const },
      { ...base, kind: 'command' as const, command: 'cancel' as const },
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
      { kind: 'command', text: null, action: undefined, command: 'cancel' },
    ])
  })

  it('reads which turns the platform refused and which the client took back by `/undo`', async () => {
    const { task, facts } = await dialog()
    const turn = (turnNo: number, patch: { rejectedAt?: Date; undoneAt?: Date }) => ({
      taskId: task.id,
      turnNo,
      status: 'completed' as const,
      driverId: sampleDriverId,
      image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
      ...patch,
    })
    await db.taskTurn.createMany({
      data: [turn(1, {}), turn(2, { rejectedAt: new Date() }), turn(3, { undoneAt: new Date() })],
    })
    const read = await facts()
    expect(read?.turns.get(1)).toMatchObject({ undone: false, rejected: false })
    expect(read?.turns.get(2)).toMatchObject({ undone: false, rejected: true })
    expect(read?.turns.get(3)).toMatchObject({ undone: true, rejected: false })
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

  async function withFile(browser: boolean) {
    const { task, workspaceId, userId, facts } = await dialog({ browser })
    const file = (await createAttachment(db, {
      workspaceId,
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
      }),
    ).toBe(true)
    return { task, file, facts }
  }

  it('reads no repository, its files and the skills every turn has', async () => {
    const { task, file, facts } = await withFile(false)
    const read = await facts()
    expect(read).toMatchObject({
      task: { id: task.id },
      requirements: { repository: false, browser: false },
      variables: [],
      attachments: [{ id: file.id, fileName: 'смета.pdf' }],
    })
    expect(read!.skills).toEqual(turnSkillsOf([]))
  })

  it('gives a chat with the browser the platform’s browser, not a second one in the sandbox', async () => {
    const { facts } = await withFile(true)
    const read = await facts()
    expect(read!.requirements).toEqual({ repository: false, browser: true })
    expect(read!.skills).toEqual(turnSkillsOf([], { platformBrowser: true }))
    expect(read!.skills?.map((skill) => skill.name)).not.toContain('playwright')
  })

  it('reads the active notes of the memory of the chat while its author has it on (ПР18)', async () => {
    const { task, workspaceId, userId, facts } = await dialog()
    // No author: no memory.
    expect((await facts())?.memory).toBeNull()
    await db.task.update({ where: { id: task.id }, data: { createdById: userId } })
    expect((await facts())?.memory).toEqual([])
    const note = (text: string, status: string) =>
      db.memoryEntry.create({
        data: { id: uuidv7(), workspaceId, userId, kind: 'fact', text, status, author: 'client' },
      })
    const active = await note('Цены — из прайса', 'active')
    await note('Ждёт решения', 'proposed')
    expect((await facts())?.memory).toEqual([
      { id: active.id, kind: 'fact', text: 'Цены — из прайса', updatedAt: active.updatedAt },
    ])
    await db.user.update({ where: { id: userId }, data: { agentMemory: false } })
    expect((await facts())?.memory).toBeNull()
  })

  it('reads the project of the chat: its name, goal and instructions, none from the trash (ПР7, ПР20)', async () => {
    const { task, workspaceId, userId, facts } = await dialog()
    expect((await facts())?.project).toBeNull()
    const projectId = uuidv7()
    projects.push(projectId)
    await db.project.create({
      data: {
        id: projectId,
        workspaceId,
        createdById: userId,
        name: 'Кофейня «Зерно»',
        goal: 'Сезонное меню',
        instructions: 'Пишите тепло.',
      },
    })
    projectTasks.push(task.id)
    await db.task.update({ where: { id: task.id }, data: { projectId } })
    const project = {
      name: 'Кофейня «Зерно»',
      goal: 'Сезонное меню',
      instructions: 'Пишите тепло.',
    }
    expect((await facts())?.project).toEqual(project)
    expect((await facts())?.projectFiles).toBeUndefined()
    // Its ready files of the context (ПР8), by path; one still uploading is not given.
    const file = (name: string, status: string) => {
      const id = uuidv7()
      return db.$executeRaw`
        INSERT INTO project_files (id, workspace_id, project_id, uploaded_by_id, kind, name,
          media_type, size_bytes, status, s3_key, expires_at, updated_at)
        VALUES (${id}::uuid, ${workspaceId}::uuid,
          ${status === 'ready' ? projectId : null}::uuid, ${userId}::uuid, 'file', ${name},
          'application/pdf', 10, ${status}, ${`projects/${workspaceId}/${id}`},
          ${status === 'ready' ? null : new Date(Date.now() + 86_400_000)}, now())`
    }
    await file('Фото/b.pdf', 'ready')
    await file('a.pdf', 'ready')
    await file('c.pdf', 'uploading')
    expect((await facts())?.projectFiles).toEqual(
      [
        { name: 'Фото/b.pdf', mediaType: 'application/pdf', sizeBytes: 10 },
        { name: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 10 },
      ].sort((x, y) => (x.name < y.name ? -1 : 1)),
    )
    // A project in the archive keeps its chats, and so the section of their passes.
    await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } })
    expect((await facts())?.project).toEqual(project)
    // One in the trash has its passes stopped: one that still starts goes without it.
    const now = new Date()
    await db.project.update({
      where: { id: projectId },
      data: { deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 86_400_000) },
    })
    expect((await facts())?.project).toBeNull()
    expect((await facts())?.projectFiles).toBeUndefined()
    await db.projectFile.deleteMany({ where: { workspaceId } })
  })
})
