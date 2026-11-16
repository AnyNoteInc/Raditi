import { randomUUID } from 'node:crypto'

import { chatMemory, createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// «Память» on PostgreSQL (docs/plan/84-projects.md, ПР18, ПР28, §4.4; slice 84.13): the router
// `projectMemory` and «Агент запоминает важное». Every test works with users and workspaces of its
// own; `afterEach` removes what it wrote.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

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

describe.skipIf(!databaseUrl)('PostgreSQL: the memory of a project and of the account', () => {
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
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.memoryEntry.deleteMany({ where: owned })
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
      data: { name: 'Memory verification', email: `${randomUUID()}@memory.example.ru` },
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
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `memory-test-${randomUUID()}`,
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
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Сайт пекарни' })
    const { workspaceId } = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    /** A note of the agent, as the end of a pass leaves it. */
    const agentNote = (
      text: string,
      extra: {
        status?: 'active' | 'proposed'
        pendingAction?: 'update' | 'forget'
        pendingText?: string
        project?: string | null
      } = {},
    ) =>
      db.memoryEntry.create({
        data: {
          id: v7(),
          workspaceId,
          userId: user.id,
          projectId: extra.project === undefined ? projectId : extra.project,
          kind: 'preference',
          text,
          status: extra.status ?? 'proposed',
          author: 'agent',
          ...(extra.pendingAction ? { pendingAction: extra.pendingAction } : {}),
          ...(extra.pendingText ? { pendingText: extra.pendingText } : {}),
        },
      })
    return { user, caller, projectId, workspaceId, agentNote }
  }

  it('adds the client’s notes, counts them on the project and refuses at 40', async () => {
    const { caller, projectId } = await owner()
    const empty = await caller.projectMemory.list({ projectId })
    expect(empty).toMatchObject({
      entries: [],
      useAccountMemory: true,
      agentMemory: true,
      limit: 40,
    })

    const added = await caller.projectMemory.add({
      projectId,
      kind: 'decision',
      text: '  Торты на заказ принимаем за 48 часов ',
    })
    expect(added).toMatchObject({
      text: 'Торты на заказ принимаем за 48 часов',
      kind: 'decision',
      status: 'active',
      author: 'client',
      confirmed: true,
      version: 1,
    })
    expect((await caller.project.get({ projectId })).memory).toEqual({ active: 1, proposed: 0 })

    expect(
      await refusal(() =>
        caller.projectMemory.add({ projectId, kind: 'fact', text: 'Пароль от админки: Qwerty123' }),
      ),
    ).toEqual({ code: 'MEMORY_HAS_SECRET', text: 'Похоже, в записи пароль или ключ — уберите его' })
    expect(
      (await refusal(() => caller.projectMemory.add({ projectId, kind: 'fact', text: '   ' })))
        .code,
    ).toBe('MEMORY_TEXT_INVALID')
    for (let index = 1; index < 40; index += 1)
      await caller.projectMemory.add({ projectId, kind: 'fact', text: `Запись ${index}` })
    expect(
      await refusal(() => caller.projectMemory.add({ projectId, kind: 'fact', text: 'Лишняя' })),
    ).toEqual({ code: 'MEMORY_LIMIT', text: 'В памяти уже 40 записей — удалите ненужные' })
  })

  it('saves and drops the proposals of the agent at the version shown', async () => {
    const { caller, projectId, agentNote } = await owner()
    const proposed = await agentNote('Блоки сезонных товаров ставим под шапкой')
    const update = await agentNote('Ответы — коротко', {
      status: 'active',
      pendingAction: 'update',
      pendingText: 'Ответы — коротко, без таблиц',
    })
    const forget = await agentNote('Фото снимает Аня', {
      status: 'active',
      pendingAction: 'forget',
    })
    const dropped = await agentNote('Шрифт — Golos')
    expect((await caller.project.get({ projectId })).memory).toEqual({ active: 2, proposed: 4 })

    // A version the client did not see is never saved.
    expect(
      (await refusal(() => caller.projectMemory.confirm({ id: proposed.id, expectedVersion: 2 })))
        .code,
    ).toBe('MEMORY_VERSION_CHANGED')
    expect(
      await caller.projectMemory.confirm({ id: proposed.id, expectedVersion: 1 }),
    ).toMatchObject({ decision: 'saved', entry: { status: 'active', confirmed: true, version: 2 } })
    expect(await caller.projectMemory.confirm({ id: update.id, expectedVersion: 1 })).toMatchObject(
      {
        decision: 'updated',
        entry: { text: 'Ответы — коротко, без таблиц', pendingAction: null, pendingText: null },
      },
    )
    expect(await caller.projectMemory.confirm({ id: forget.id, expectedVersion: 1 })).toEqual({
      decision: 'forgotten',
      entry: null,
    })
    expect(await caller.projectMemory.reject({ id: dropped.id, expectedVersion: 1 })).toEqual({
      decision: 'dropped',
      entry: null,
    })
    // Nothing more to decide on a saved entry.
    expect(
      (await refusal(() => caller.projectMemory.confirm({ id: proposed.id, expectedVersion: 2 })))
        .code,
    ).toBe('MEMORY_VERSION_CHANGED')

    const kept = await agentNote('Цены — из прайса', { status: 'active', pendingAction: 'forget' })
    expect(await caller.projectMemory.reject({ id: kept.id, expectedVersion: 1 })).toMatchObject({
      decision: 'dropped',
      entry: { text: 'Цены — из прайса', status: 'active', pendingAction: null, version: 2 },
    })
    expect((await caller.project.get({ projectId })).memory).toEqual({ active: 3, proposed: 0 })
    expect(await caller.projectMemory.get({ id: dropped.id })).toBeNull()
  })

  it('edits, removes and clears; the audit keeps no text', async () => {
    const { user, caller, projectId, workspaceId, agentNote } = await owner()
    const note = await agentNote('Фото не трогаем', { status: 'active' })
    expect(
      await caller.projectMemory.update({
        id: note.id,
        text: 'Фото товаров не заменять без спроса',
        kind: 'decision',
        expectedVersion: 1,
      }),
    ).toMatchObject({
      text: 'Фото товаров не заменять без спроса',
      kind: 'decision',
      confirmed: true,
      version: 2,
    })
    expect(
      (
        await refusal(() =>
          caller.projectMemory.update({ id: note.id, text: 'Снова', expectedVersion: 1 }),
        )
      ).code,
    ).toBe('MEMORY_VERSION_CHANGED')
    await caller.projectMemory.remove({ id: note.id })
    expect(await db.memoryEntry.count({ where: { id: note.id } })).toBe(0)
    const audit = await db.auditLog.findFirstOrThrow({
      where: { workspaceId, action: 'memory.entry.remove' },
    })
    expect(audit).toMatchObject({ actorId: user.id, targetId: note.id })
    expect(JSON.stringify(audit.meta)).not.toContain('Фото')

    await agentNote('Первая')
    await agentNote('Вторая', { status: 'active' })
    const account = await agentNote('Из чата без проекта', { project: null, status: 'active' })
    expect(await caller.projectMemory.clear({ projectId })).toEqual({ removed: 2 })
    expect((await caller.projectMemory.list({ projectId })).entries).toEqual([])
    // The account's memory is another one.
    expect((await caller.projectMemory.list({ projectId: null })).entries.map((e) => e.id)).toEqual(
      [account.id],
    )
    expect(await caller.projectMemory.clear({ projectId: null })).toEqual({ removed: 1 })
  })

  it('answers MEMORY_NOT_FOUND for an entry of someone else or of a project in the trash', async () => {
    const { caller, projectId, agentNote } = await owner()
    const note = await agentNote('Пишем на «вы»')
    const stranger = await owner()
    const notFound = { code: 'MEMORY_NOT_FOUND', text: 'Такой записи в памяти нет' }
    expect(
      await refusal(() =>
        stranger.caller.projectMemory.confirm({ id: note.id, expectedVersion: 1 }),
      ),
    ).toEqual(notFound)
    expect(await refusal(() => stranger.caller.projectMemory.remove({ id: note.id }))).toEqual(
      notFound,
    )
    expect(await stranger.caller.projectMemory.get({ id: note.id })).toBeNull()
    expect((await refusal(() => stranger.caller.projectMemory.list({ projectId }))).code).toBe(
      'PROJECT_NOT_FOUND',
    )
    await caller.project.remove({ projectId })
    expect(
      await refusal(() => caller.projectMemory.confirm({ id: note.id, expectedVersion: 1 })),
    ).toEqual(notFound)
    expect((await refusal(() => caller.projectMemory.list({ projectId }))).code).toBe(
      'PROJECT_NOT_FOUND',
    )
  })

  it('keeps the account memory in the personal workspace and switches the memory of the user off', async () => {
    const { user, caller, projectId, workspaceId } = await owner()
    const added = await caller.projectMemory.add({
      projectId: null,
      kind: 'preference',
      text: 'Ответы — коротко',
    })
    const row = await db.memoryEntry.findUniqueOrThrow({ where: { id: added.id } })
    expect(row).toMatchObject({ workspaceId, projectId: null, userId: user.id })
    expect(await caller.project.update({ projectId, useAccountMemory: false })).toEqual({
      updated: true,
    })
    expect((await caller.projectMemory.list({ projectId })).useAccountMemory).toBe(false)

    // The memory a chat reads and writes (core: the section; mcp: the tools) is the switch's.
    const chat = await db.task.create({
      data: { workspaceId, createdById: user.id, projectId },
      select: { id: true },
    })
    expect(await chatMemory(db, chat.id)).toMatchObject({ projectId, accountMemory: false })
    expect(await caller.user.setAgentMemory({ on: false })).toEqual({ on: false })
    expect((await caller.projectMemory.list({ projectId: null })).agentMemory).toBe(false)
    expect(await chatMemory(db, chat.id)).toBeNull()
    // The entries stay while the memory is off.
    expect(await db.memoryEntry.count({ where: { id: added.id } })).toBe(1)
    await caller.user.setAgentMemory({ on: true })
    expect(await chatMemory(db, chat.id)).not.toBeNull()
  })
})
