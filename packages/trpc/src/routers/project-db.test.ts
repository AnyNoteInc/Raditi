import { randomInt, randomUUID } from 'node:crypto'

import { underPrivateCreditRate } from '@repo/billing/testing'
import type { Prisma } from '@repo/db'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// «Проекты» on PostgreSQL (docs/plan/84-projects.md, 84.4): the router `project`, a chat that
// starts in a project, the list of the chats of a project and «Перенести в проект…». Every test
// works with users and workspaces of its own; `afterEach` removes what it wrote.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

/** A UUID of version 7, as the browser makes the id of a project and of a chat. */
function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Every writing transaction under a credit rate and a priced class `standard` no other transaction
 * sees, as in chat-db.test.ts: a new chat needs a reserve and a class a pass could run in.
 */
function underRate(db: PrismaClient): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) =>
                  underPrivateCreditRate(tx, () =>
                    underPricedStandard(tx, () =>
                      (work as (client: typeof tx) => Promise<unknown>)(tx),
                    ),
                  ),
                options,
              )
            : target.$transaction(work as never, options as never)
      }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function underPricedStandard<T>(
  tx: Prisma.TransactionClient,
  work: () => Promise<T>,
): Promise<T> {
  const model = await tx.llmModel.findFirst({
    where: { modelClass: 'standard', providerModelId: { not: null } },
    orderBy: [{ slug: 'asc' }, { provider: { slug: 'asc' } }],
    select: { id: true, enabled: true, provider: { select: { id: true, enabled: true } } },
  })
  if (model === null) throw new Error('The seeds have no model of the class standard')
  const price = await tx.llmModelPrice.create({
    data: {
      modelId: model.id,
      effectiveFrom: new Date(Date.UTC(2025, 11, 31) + randomInt(24 * 3600 * 1000)),
      inputPer1m: '100',
      outputPer1m: '1000',
      vatRate: '0.2200',
      sourceUrl: 'https://rates.invalid/projects-verification',
    },
  })
  if (!model.enabled) await tx.llmModel.update({ where: { id: model.id }, data: { enabled: true } })
  if (!model.provider.enabled)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: true } })
  const result = await work()
  await tx.llmModelPrice.delete({ where: { id: price.id } })
  if (!model.enabled)
    await tx.llmModel.update({ where: { id: model.id }, data: { enabled: false } })
  if (!model.provider.enabled)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: false } })
  return result
}

/** The code of the DomainError behind a refusal of a procedure, and its text for the client. */
async function refusal(act: () => Promise<unknown>): Promise<{ code: string; text: string }> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined
      return { code: cause?.code ?? error.code, text: error.message }
    }
    throw error
  }
  throw new Error('The procedure was not refused')
}

describe.skipIf(!databaseUrl)('PostgreSQL: projects and the chats in them', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    const tasks = await db.task.findMany({ where: owned, select: { id: true } })
    await db.outboxEvent.deleteMany({
      where: { OR: tasks.map(({ id }) => ({ dedupeKey: { contains: id } })) },
    })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Projects verification', email: `${randomUUID()}@projects.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  const secrets = { transitEnsureKey: async () => {} } as unknown as SecretStore
  const storage = { get: async () => null } as unknown as ObjectStorage

  function callerOf(user: User) {
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => storage,
      secrets: () => secrets,
    }
    return createCaller({
      prisma: underRate(db),
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `projects-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
    })
  }

  async function owner() {
    const user = await person()
    const caller = callerOf(user)
    const project = async (name = 'Сайт кофейни', goal?: string) => {
      const projectId = v7()
      await caller.project.create({ projectId, name, ...(goal === undefined ? {} : { goal }) })
      return projectId
    }
    const chat = async (projectId: string | null, text = 'Напишите текст для витрины') => {
      const taskId = v7()
      await caller.task.create({ taskId, text, projectId })
      return taskId
    }
    /** The pass of the chat answered: it waits for the client. */
    const answered = (taskId: string) =>
      db.$executeRaw`UPDATE tasks SET status = 'awaiting_user' WHERE id = ${taskId}::uuid`
    return { user, caller, project, chat, answered }
  }

  it('creates a project once, in the personal workspace of its author', async () => {
    const { user, caller } = await owner()
    const projectId = v7()
    const input = { projectId, name: '  Рассылки\nи тексты ', goal: 'Писать письма' }
    expect(await caller.project.create(input)).toEqual({ projectId, created: true })
    expect(await caller.project.create(input)).toEqual({ projectId, created: false })
    const project = await caller.project.get({ projectId })
    expect(project).toMatchObject({ name: 'Рассылки и тексты', goal: 'Писать письма', chats: 0 })
    const row = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: row.workspaceId } })
    expect(workspace.createdById).toBe(user.id)
    // The gift of the registration came with the workspace.
    expect(await db.billingAccount.count({ where: { workspaceId: workspace.id } })).toBeGreaterThan(
      0,
    )
  })

  it('refuses a name, a goal and instructions out of shape, in the client words', async () => {
    const { caller, project } = await owner()
    expect(await refusal(() => caller.project.create({ projectId: v7(), name: ' ' }))).toEqual({
      code: 'PROJECT_NAME_INVALID',
      text: 'Назовите проект — до 80 знаков',
    })
    const projectId = await project()
    expect(
      (await refusal(() => caller.project.update({ projectId, goal: 'я'.repeat(501) }))).code,
    ).toBe('PROJECT_GOAL_TOO_LONG')
    expect(
      (
        await refusal(() =>
          caller.project.setInstructions({ projectId, text: 'Пароль от админки: Qwerty123' }),
        )
      ).code,
    ).toBe('PROJECT_TEXT_HAS_SECRET')
    expect(await caller.project.setInstructions({ projectId, text: '  Пишите коротко  ' })).toEqual(
      { text: 'Пишите коротко' },
    )
    expect((await caller.project.get({ projectId })).instructions).toBe('Пишите коротко')
    expect(await caller.project.setInstructions({ projectId, text: '' })).toEqual({ text: '' })
    expect((await caller.project.get({ projectId })).instructions).toBeNull()
  })

  it('answers PROJECT_NOT_FOUND for a project of someone else', async () => {
    const { project } = await owner()
    const projectId = await project()
    const stranger = await owner()
    const notFound = { code: 'PROJECT_NOT_FOUND', text: 'Проекта нет или он удалён' }
    expect(await refusal(() => stranger.caller.project.get({ projectId }))).toEqual(notFound)
    expect(await refusal(() => stranger.caller.project.update({ projectId, name: 'Моё' }))).toEqual(
      notFound,
    )
    expect(await refusal(() => stranger.caller.project.remove({ projectId }))).toEqual(notFound)
    expect(await refusal(() => stranger.caller.task.list({ projectId }))).toEqual(notFound)
    expect(
      await refusal(() => stranger.caller.task.create({ taskId: v7(), text: 'Привет', projectId })),
    ).toEqual(notFound)
    expect((await stranger.caller.project.list()).items).toEqual([])
    // An id taken by someone else is not created again for another user either.
    expect(
      await refusal(() => stranger.caller.project.create({ projectId, name: 'Чужое' })),
    ).toEqual(notFound)
  })

  it('lists by tabs, stars, archives, puts into the trash and returns', async () => {
    const { caller, project } = await owner()
    const a = await project('Альфа')
    const b = await project('Бета')
    const ids = async (view?: 'all' | 'starred' | 'archive' | 'trash') =>
      (await caller.project.list(view === undefined ? undefined : { view })).items.map((p) => p.id)
    expect(await ids()).toEqual([b, a])
    // The menu of the field says what the agent will take from a project (ПР30).
    await caller.project.setInstructions({ projectId: a, text: 'Пишите коротко' })
    const listed = (await caller.project.list()).items
    expect(listed.map((p) => [p.id, p.hasInstructions])).toEqual([
      [a, true],
      [b, false],
    ])
    await caller.project.star({ projectId: a, starred: true })
    expect(await ids('starred')).toEqual([a])
    await caller.project.archive({ projectId: b, archived: true })
    expect(await ids()).toEqual([a])
    expect(await ids('archive')).toEqual([b])
    expect(
      await refusal(() => caller.task.create({ taskId: v7(), text: 'Привет', projectId: b })),
    ).toEqual({ code: 'PROJECT_ARCHIVED', text: 'Проект в архиве — верните его, чтобы начать чат' })
    const { purgeAfter } = await caller.project.remove({ projectId: a })
    expect(purgeAfter.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000)
    expect(await ids('trash')).toEqual([a])
    expect((await refusal(() => caller.project.get({ projectId: a }))).code).toBe(
      'PROJECT_NOT_FOUND',
    )
    await caller.project.restore({ projectId: a })
    expect(await ids()).toEqual([a])
  })

  it('starts a chat in a project: its workspace, its label, its list, and «Недавние»', async () => {
    const { caller, project, chat } = await owner()
    const first = await project('Первый')
    const second = await project('Второй')
    const before = (await caller.project.get({ projectId: first })).activityAt
    const inProject = await chat(first)
    const outside = await chat(null)
    const row = await db.task.findUniqueOrThrow({ where: { id: inProject } })
    const projectRow = await db.project.findUniqueOrThrow({ where: { id: first } })
    expect(row.projectId).toBe(first)
    expect(row.workspaceId).toBe(projectRow.workspaceId)
    expect(projectRow.activityAt.getTime()).toBeGreaterThan(before.getTime())
    // The project with a new chat rises in «Недавние».
    expect((await caller.project.list()).items.map((p) => p.id)).toEqual([first, second])
    expect((await caller.project.get({ projectId: first })).chats).toBe(1)

    expect((await caller.task.get({ taskId: inProject })).project).toEqual({
      id: first,
      name: 'Первый',
    })
    expect((await caller.task.get({ taskId: outside })).project).toBeNull()
    const list = await caller.task.list({})
    expect(list.items.map((item) => [item.id, item.project?.name ?? null])).toEqual([
      [outside, null],
      [inProject, 'Первый'],
    ])
    expect((await caller.task.list({ projectId: first })).items.map((item) => item.id)).toEqual([
      inProject,
    ])
    expect((await caller.task.list({ projectId: second })).items).toEqual([])
  })

  it('moves a chat into a project and out of it, never while its pass runs', async () => {
    const { caller, project, chat, answered } = await owner()
    const projectId = await project()
    const taskId = await chat(null)
    // The first pass of the chat is queued.
    expect(await refusal(() => caller.task.moveToProject({ taskId, projectId }))).toEqual({
      code: 'TASK_PROJECT_BUSY',
      text: 'Агент сейчас работает в этом чате — перенесите его, когда он ответит',
    })
    await answered(taskId)
    const place = (await db.task.findUniqueOrThrow({ where: { id: taskId } })).updatedAt
    expect(await caller.task.moveToProject({ taskId, projectId })).toEqual({ projectId })
    expect((await caller.task.list({ projectId })).items.map((item) => item.id)).toEqual([taskId])
    // The chat keeps its place in the list.
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).updatedAt).toEqual(place)
    expect(await caller.task.moveToProject({ taskId, projectId: null })).toEqual({
      projectId: null,
    })
    expect((await caller.task.list({ projectId })).items).toEqual([])

    const stranger = await owner()
    const theirs = await stranger.project()
    expect(
      (await refusal(() => caller.task.moveToProject({ taskId, projectId: theirs }))).code,
    ).toBe('PROJECT_NOT_FOUND')
  })

  it('hides the chats of a project in the trash, and shows them again when it is returned', async () => {
    const { caller, project, chat } = await owner()
    const projectId = await project()
    const taskId = await chat(projectId)
    await caller.project.remove({ projectId })
    expect((await caller.task.list({})).items).toEqual([])
    expect((await refusal(() => caller.task.get({ taskId }))).code).toBe('NOT_FOUND')
    expect(
      (await refusal(() => caller.task.create({ taskId: v7(), text: 'Ещё', projectId }))).code,
    ).toBe('PROJECT_NOT_FOUND')
    await caller.project.restore({ projectId })
    expect((await caller.task.list({})).items.map((item) => item.id)).toEqual([taskId])
    expect((await caller.task.get({ taskId })).project?.id).toBe(projectId)
  })
})
