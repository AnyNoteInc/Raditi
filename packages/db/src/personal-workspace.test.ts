import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  ensurePersonalWorkspace,
  findPersonalWorkspace,
  lockUserRow,
  PERSONAL_WORKSPACE_NAME,
  personalWorkspaceDataClass,
} from './personal-workspace.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-00000000000a'

function fakeTx(found: { id: string } | null = null) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: USER }]),
    workspace: {
      findFirst: vi.fn().mockResolvedValue(found),
      create: vi.fn().mockResolvedValue({ id: randomUUID() }),
    },
  }
  return { tx, db: tx as unknown as Parameters<typeof ensurePersonalWorkspace>[0] }
}

describe('personal workspace rule', () => {
  it.each([
    ['production', 'client'],
    ['development', 'synthetic'],
    ['test', 'synthetic'],
  ] as const)('gives APP_ENV=%s the data class %s', (appEnv, dataClass) => {
    expect(personalWorkspaceDataClass(appEnv)).toBe(dataClass)
  })

  it('locks the user row without blocking writes that reference the user', async () => {
    const { tx, db } = fakeTx()
    expect(await lockUserRow(db, USER)).toBe(true)
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM users WHERE id = ?::uuid FOR NO KEY UPDATE',
    )
    expect(values).toEqual([USER])
    tx.$queryRaw.mockResolvedValue([])
    expect(await lockUserRow(db, USER)).toBe(false)
  })

  it('looks for a workspace the user created and solely owns, the oldest first', async () => {
    const { tx, db } = fakeTx({ id: 'found' })
    expect(await findPersonalWorkspace(db, { userId: USER, appEnv: 'production' })).toEqual({
      id: 'found',
    })
    expect(tx.workspace.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        createdById: USER,
        dataClass: 'client',
        members: {
          some: { userId: USER, role: 'owner' },
          every: { userId: USER, role: 'owner' },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('creates the workspace under the user lock when there is none', async () => {
    const { tx, db } = fakeTx()
    const created = await ensurePersonalWorkspace(db, { userId: USER, appEnv: 'test' })
    expect(created).toEqual(await tx.workspace.create.mock.results[0]!.value)
    expect(tx.workspace.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        name: PERSONAL_WORKSPACE_NAME,
        createdById: USER,
        dataClass: 'synthetic',
        members: { create: { userId: USER, role: 'owner' } },
      },
      select: { id: true },
    })
    const order = [tx.$queryRaw, tx.workspace.findFirst, tx.workspace.create].map(
      (call) => call.mock.invocationCallOrder[0],
    )
    expect(order).toEqual([...order].sort((a, b) => a! - b!))
  })

  it('returns the existing workspace without creating another', async () => {
    const { tx, db } = fakeTx({ id: 'existing' })
    expect(await ensurePersonalWorkspace(db, { userId: USER, appEnv: 'test' })).toEqual({
      id: 'existing',
    })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.workspace.create).not.toHaveBeenCalled()
  })

  it('refuses a user who no longer exists before reading or writing a workspace', async () => {
    const { tx, db } = fakeTx()
    tx.$queryRaw.mockResolvedValue([])
    await expect(
      ensurePersonalWorkspace(db, { userId: USER, appEnv: 'test' }),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'UNAUTHORIZED', httpStatus: 401 })
    expect(tx.workspace.findFirst).not.toHaveBeenCalled()
    expect(tx.workspace.create).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL personal workspace', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    // Members go with their workspace; a workspace does not go with its creator.
    await db.workspace.deleteMany({ where: { createdById: { in: ids } } })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function user() {
    const created = await db.user.create({
      data: { name: 'Workspace verification', email: `${randomUUID()}@workspaces.example.ru` },
    })
    userIds.push(created.id)
    return created.id
  }

  const ensure = (userId: string, appEnv: 'test' | 'production' = 'test') =>
    db.$transaction((tx) => ensurePersonalWorkspace(tx, { userId, appEnv }), {
      isolationLevel: 'ReadCommitted',
    })

  it('finds nothing before the first call and the created workspace after it', async () => {
    const userId = await user()
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
    const workspace = await ensure(userId)
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toEqual(workspace)
    expect(await ensure(userId)).toEqual(workspace)
    expect(
      await db.workspace.findUniqueOrThrow({
        where: { id: workspace.id },
        include: { members: { select: { userId: true, role: true } } },
      }),
    ).toMatchObject({
      name: 'Мои проекты',
      createdById: userId,
      dataClass: 'synthetic',
      members: [{ userId, role: 'owner' }],
    })
  })

  it('creates one workspace for concurrent first calls of one user', async () => {
    const userId = await user()
    const workspaces = await Promise.all(Array.from({ length: 6 }, () => ensure(userId)))
    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(1)
    expect(await db.workspace.count({ where: { createdById: userId } })).toBe(1)
  })

  it('keeps one workspace per data class', async () => {
    const userId = await user()
    const synthetic = await ensure(userId, 'test')
    const client = await ensure(userId, 'production')
    expect(client.id).not.toBe(synthetic.id)
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'development' })).toEqual(synthetic)
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'production' })).toEqual(client)
    expect(await db.workspace.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({
      dataClass: 'client',
    })
  })

  it('does not take a shared workspace or one the user no longer owns for personal', async () => {
    const userId = await user()
    const guestId = await user()
    const shared = await ensure(userId)
    await db.member.create({ data: { workspaceId: shared.id, userId: guestId, role: 'member' } })
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
    // The guest's membership does not make it the guest's workspace either.
    expect(await findPersonalWorkspace(db, { userId: guestId, appEnv: 'test' })).toBeNull()

    const own = await ensure(userId)
    expect(own.id).not.toBe(shared.id)
    await db.member.updateMany({ where: { workspaceId: own.id }, data: { role: 'member' } })
    expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
    const next = await ensure(userId)
    expect([shared.id, own.id]).not.toContain(next.id)
  })

  it('refuses a deleted user and writes nothing', async () => {
    const userId = await user()
    await db.user.delete({ where: { id: userId } })
    await expect(ensure(userId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(await db.workspace.count({ where: { createdById: userId } })).toBe(0)
  })
})
