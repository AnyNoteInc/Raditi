import { randomUUID } from 'node:crypto'

import { isDomainError, type MemoryPassConditions } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  applyMemoryChange,
  chatMemory,
  closeStaleMemoryReservations,
  failMemoryTurn,
  listChatMemory,
  memoryEntriesOfPass,
  pendingMemoryChanges,
  reserveMemoryChange,
  type MemoryScope,
} from './memory.ts'
import { createProject, trashProject } from './projects.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const clean: MemoryPassConditions = {
  asked: true,
  outside: false,
  commands: false,
  repository: false,
  unattended: false,
}

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : String(error)
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL: the memory (plan 84, 84.11)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'memory')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const projectId = uuidv7()
    await db.$transaction((tx) =>
      createProject(tx, {
        id: projectId,
        workspaceId: workspace.id,
        userId: user.id,
        name: 'Сайт кофейни',
        goal: null,
        now: new Date(),
      }),
    )
    const chat = (project: string | null) =>
      db.task.create({
        data: { workspaceId: workspace.id, createdById: user.id, projectId: project },
        select: { id: true },
      })
    const scope = (project: string | null): MemoryScope => ({
      workspaceId: workspace.id,
      userId: user.id,
      projectId: project,
    })
    return { user, workspace, projectId, chat, scope }
  }

  const reserve = (
    taskId: string,
    scope: MemoryScope,
    change: Parameters<typeof reserveMemoryChange>[1]['change'],
    turnNo = 1,
  ) => reserveMemoryChange(db, { taskId, turnNo, scope, change })
  const apply = (
    taskId: string,
    reservationId: string,
    memory: MemoryScope,
    conditions = clean,
    turnNo = 1,
  ) => applyMemoryChange(db, { reservationId, taskId, turnNo, memory, conditions })

  it('saves a note active on «запомни» and a proposal otherwise, and the pass reads only the active', async () => {
    const { projectId, chat, scope } = await owner()
    const task = await chat(projectId)
    const memory = await chatMemory(db, task.id)
    expect(memory).toEqual({ ...scope(projectId), accountMemory: true })
    const a = await reserve(task.id, scope(projectId), {
      kind: 'save',
      entryKind: 'fact',
      text: ' Цены — из прайса ',
    })
    const b = await reserve(task.id, scope(projectId), {
      kind: 'save',
      entryKind: 'preference',
      text: 'Отвечать коротко',
    })
    expect((await pendingMemoryChanges(db, task.id, 1)).map((row) => row.id)).toEqual([
      a.reservationId,
      b.reservationId,
    ])
    expect(await apply(task.id, a.reservationId, scope(projectId))).toMatchObject({
      outcome: 'done',
      action: 'saved',
      kind: 'fact',
      text: 'Цены — из прайса',
    })
    expect(
      await apply(task.id, b.reservationId, scope(projectId), { ...clean, outside: true }),
    ).toMatchObject({
      outcome: 'done',
      action: 'proposed',
    })
    // Applied once: a second end of the turn finds it closed.
    expect(await apply(task.id, a.reservationId, scope(projectId))).toBeNull()
    expect((await memoryEntriesOfPass(db, memory!)).map((entry) => entry.text)).toEqual([
      'Цены — из прайса',
    ])
    expect((await listChatMemory(db, memory!)).map((entry) => entry.status).sort()).toEqual([
      'active',
      'proposed',
    ])
    const saved = await db.memoryEntry.findFirstOrThrow({ where: { text: 'Цены — из прайса' } })
    expect(saved).toMatchObject({
      author: 'agent',
      sourceTaskId: task.id,
      sourceTurn: 1,
      version: 1,
    })
  })

  it('reads the account memory in a project only while the project lets it, and nothing when it is off', async () => {
    const { user, projectId, chat, scope } = await owner()
    const free = await chat(null)
    const account = await reserve(free.id, scope(null), {
      kind: 'save',
      entryKind: 'fact',
      text: 'Часовой пояс — Москва',
    })
    await apply(free.id, account.reservationId, scope(null))
    const inProject = await chat(projectId)
    const memory = await chatMemory(db, inProject.id)
    expect((await memoryEntriesOfPass(db, memory!)).map((entry) => entry.text)).toEqual([
      'Часовой пояс — Москва',
    ])
    await db.project.update({ where: { id: projectId }, data: { useAccountMemory: false } })
    expect(await memoryEntriesOfPass(db, (await chatMemory(db, inProject.id))!)).toEqual([])
    // A note of the account is not changed from a chat of a project: another memory.
    const entry = await db.memoryEntry.findFirstOrThrow({ where: { userId: user.id } })
    expect(
      await codeOf(() =>
        reserve(inProject.id, scope(projectId), {
          kind: 'forget',
          entryId: entry.id,
          expectedVersion: 1,
        }),
      ),
    ).toBe('MEMORY_NOT_FOUND')
    await db.user.update({ where: { id: user.id }, data: { agentMemory: false } })
    expect(await chatMemory(db, free.id)).toBeNull()
    await db.user.update({ where: { id: user.id }, data: { agentMemory: true } })
    await trashProject(db, { projectId, userId: user.id, now: new Date() })
    expect(await chatMemory(db, inProject.id)).toBeNull()
  })

  it('refuses one of two changes of one entry at the same version, side by side', async () => {
    const { chat, scope } = await owner()
    const first = await chat(null)
    const saved = await reserve(first.id, scope(null), {
      kind: 'save',
      entryKind: 'decision',
      text: 'Доставка по Москве',
    })
    const done = await apply(first.id, saved.reservationId, scope(null))
    if (done?.outcome !== 'done') throw new Error('not saved')
    const second = await chat(null)
    const third = await chat(null)
    const x = await reserve(second.id, scope(null), {
      kind: 'update',
      entryId: done.entryId,
      text: 'Доставка по России',
      expectedVersion: 1,
    })
    const y = await reserve(third.id, scope(null), {
      kind: 'update',
      entryId: done.entryId,
      text: 'Доставка по области',
      expectedVersion: 1,
    })
    const results = await Promise.all([
      apply(second.id, x.reservationId, scope(null)),
      apply(third.id, y.reservationId, scope(null)),
    ])
    expect(results.map((result) => result?.outcome).sort()).toEqual(['done', 'refused'])
    expect(results.find((result) => result?.outcome === 'refused')).toMatchObject({
      reason: 'version',
    })
    const entry = await db.memoryEntry.findUniqueOrThrow({ where: { id: done.entryId } })
    expect(entry.version).toBe(2)
    // A change at a version the entry left is refused at once, before the end of the turn.
    expect(
      await codeOf(() =>
        reserve(
          second.id,
          scope(null),
          { kind: 'forget', entryId: done.entryId, expectedVersion: 1 },
          2,
        ),
      ),
    ).toBe('MEMORY_VERSION_CHANGED')
  })

  it('changes an entry of the client only by a proposal: its text stays until the client saves', async () => {
    const { user, workspace, chat, scope } = await owner()
    const entry = await db.memoryEntry.create({
      data: {
        id: uuidv7(),
        workspaceId: workspace.id,
        userId: user.id,
        kind: 'preference',
        text: 'Отвечать коротко',
        status: 'active',
        author: 'client',
      },
    })
    const task = await chat(null)
    const update = await reserve(task.id, scope(null), {
      kind: 'update',
      entryId: entry.id,
      text: 'Отвечать подробно',
      expectedVersion: 1,
    })
    expect(await apply(task.id, update.reservationId, scope(null))).toMatchObject({
      action: 'update_proposed',
      text: 'Отвечать подробно',
    })
    expect(await db.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      text: 'Отвечать коротко',
      status: 'active',
      pendingAction: 'update',
      pendingText: 'Отвечать подробно',
      version: 2,
    })
    const forget = await reserve(
      task.id,
      scope(null),
      { kind: 'forget', entryId: entry.id, expectedVersion: 2 },
      2,
    )
    expect(await apply(task.id, forget.reservationId, scope(null), clean, 2)).toMatchObject({
      action: 'forget_proposed',
      text: 'Отвечать коротко',
    })
    expect(await db.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      status: 'active',
      pendingAction: 'forget',
      pendingText: null,
    })
    // Its own note the agent forgets at once.
    const own = await reserve(
      task.id,
      scope(null),
      { kind: 'save', entryKind: 'fact', text: 'Логотип синий' },
      3,
    )
    const ownDone = await apply(task.id, own.reservationId, scope(null), clean, 3)
    if (ownDone?.outcome !== 'done') throw new Error('not saved')
    const gone = await reserve(
      task.id,
      scope(null),
      { kind: 'forget', entryId: ownDone.entryId, expectedVersion: 1 },
      4,
    )
    expect(await apply(task.id, gone.reservationId, scope(null), clean, 4)).toMatchObject({
      action: 'forgotten',
    })
    expect(await db.memoryEntry.findUnique({ where: { id: ownDone.entryId } })).toBeNull()
    expect(
      await db.memoryReservation.findUniqueOrThrow({ where: { id: gone.reservationId } }),
    ).toMatchObject({ outcome: 'done', entryId: null })
  })

  it('keeps the limits: 10 changes a turn, 40 entries a memory, a text without a secret', async () => {
    const { workspace, user, chat, scope } = await owner()
    const task = await chat(null)
    for (let n = 0; n < 10; n += 1)
      await reserve(task.id, scope(null), { kind: 'save', entryKind: 'fact', text: `Факт ${n}` })
    expect(
      await codeOf(() =>
        reserve(task.id, scope(null), { kind: 'save', entryKind: 'fact', text: 'Ещё' }),
      ),
    ).toBe('MEMORY_CHANGES_LIMIT')
    expect(
      await codeOf(() =>
        reserve(
          task.id,
          scope(null),
          { kind: 'save', entryKind: 'fact', text: 'Пароль: Qwerty12345!' },
          2,
        ),
      ),
    ).toBe('MEMORY_HAS_SECRET')
    await db.memoryEntry.createMany({
      data: Array.from({ length: 39 }, (_, n) => ({
        id: uuidv7(),
        workspaceId: workspace.id,
        userId: user.id,
        kind: 'fact',
        text: `Запись ${n}`,
        status: 'active',
        author: 'client',
      })),
    })
    // One room left: the open reservation of this turn takes it, a second is refused at once.
    const last = await reserve(
      task.id,
      scope(null),
      { kind: 'save', entryKind: 'fact', text: 'Сороковая' },
      3,
    )
    expect(
      await codeOf(() =>
        reserve(task.id, scope(null), { kind: 'save', entryKind: 'fact', text: 'Лишняя' }, 3),
      ),
    ).toBe('MEMORY_LIMIT')
    // The ten of the first turn were never applied: the end of a lost pass closes them.
    expect(await closeStaleMemoryReservations(db, new Date(Date.now() + 1000), 100)).toHaveLength(
      11,
    )
    expect(
      await db.memoryReservation.findUniqueOrThrow({ where: { id: last.reservationId } }),
    ).toMatchObject({ outcome: 'failed', reason: 'failed' })
  })

  it('refuses a change asked in another memory than the chat is in now, and fails a failed turn at once', async () => {
    const { projectId, chat, scope } = await owner()
    const task = await chat(projectId)
    const saved = await reserve(task.id, scope(projectId), {
      kind: 'save',
      entryKind: 'fact',
      text: 'Цвет — синий',
    })
    expect(await apply(task.id, saved.reservationId, scope(null))).toEqual({
      outcome: 'refused',
      action: 'save',
      reason: 'not_found',
    })
    const lost = await reserve(
      task.id,
      scope(projectId),
      { kind: 'save', entryKind: 'fact', text: 'Шрифт — Golos' },
      2,
    )
    expect(await failMemoryTurn(db, task.id, 2)).toEqual([{ id: lost.reservationId, kind: 'save' }])
    expect(await failMemoryTurn(db, task.id, 2)).toEqual([])
  })
})
