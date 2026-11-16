import { randomUUID } from 'node:crypto'

import { createPrismaClient, reserveMemoryChange, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { MemoryChanges } from './memory-changes.ts'

// The notes of memory a turn reserved, applied at the end of its pass (docs/plan/84-projects.md,
// ПР18, §4.3, step 8): active on «запомни» in a clean pass, «Предложено» after a tool of outside or
// a command, refused when the text is a secret or a value of the client, a change of the client's
// entry only a proposal. Rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const quiet = { log: vi.fn(), warn: vi.fn() }
const VALUE = 'синтетическое-значение-переменной'
const refuses = (text: string) => (text.includes(VALUE) ? ('client_value' as const) : null)
const clean = { outside: false, commands: false }

describe.skipIf(!enabled)('the memory of a pass with PostgreSQL (plan 84, 84.12)', () => {
  let db: PrismaClient
  let workspaceId: string
  let userId: string
  let changes: MemoryChanges

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    userId = (
      await db.user.create({
        data: { name: 'Автор', email: `memory-${randomUUID()}@example.test` },
      })
    ).id
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic memory', dataClass: 'synthetic' } })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
    changes = new MemoryChanges({ db, logger: quiet })
  })
  afterAll(async () => {
    if (!db) return
    await db.memoryEntry.deleteMany({ where: { workspaceId } })
    await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    await db.$disconnect()
  })

  const chat = () =>
    db.task.create({ data: { workspaceId, createdById: userId }, select: { id: true } })
  const save = (taskId: string, text: string, turnNo = 1) =>
    reserveMemoryChange(db, {
      taskId,
      turnNo,
      scope: { workspaceId, userId, projectId: null },
      change: { kind: 'save', entryKind: 'fact', text },
    })
  const rows = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: { in: ['feed.memory_change', 'feed.memory_left'] } },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true },
      })
    ).map((row) => [row.type, row.payload])
  const entry = (text: string) => db.memoryEntry.findFirst({ where: { workspaceId, text } })

  it('saves a note on «запомни» in a clean pass and tells «Запомнено»', async () => {
    const task = await chat()
    await save(task.id, 'Цены — только из прайса')
    await changes.apply(task.id, 1, refuses, { remember: true, evidence: clean })
    const saved = await entry('Цены — только из прайса')
    expect(saved).toMatchObject({ status: 'active', author: 'agent', sourceTaskId: task.id })
    expect(await rows(task.id)).toEqual([
      [
        'feed.memory_change',
        {
          v: 1,
          action: 'saved',
          entryId: saved!.id,
          kind: 'fact',
          text: 'Цены — только из прайса',
        },
      ],
    ])
  })

  it('only proposes after webfetch, after a command, without «запомни» and when nothing is known', async () => {
    const cases = [
      {
        text: 'После webfetch',
        pass: { remember: true, evidence: { outside: true, commands: false } },
      },
      {
        text: 'После команды',
        pass: { remember: true, evidence: { outside: false, commands: true } },
      },
      { text: 'Без просьбы', pass: { remember: false, evidence: clean } },
      { text: 'Без сведений о ходе', pass: { remember: true } },
      { text: 'Без надзора', pass: { remember: true, evidence: clean, unattended: true } },
    ]
    for (const { text, pass } of cases) {
      const task = await chat()
      await save(task.id, text)
      await changes.apply(task.id, 1, refuses, pass)
      expect(await entry(text), text).toMatchObject({ status: 'proposed' })
      expect((await rows(task.id))[0]?.[1], text).toMatchObject({ action: 'proposed', text })
    }
  })

  it('refuses a secret and a value of a variable, and tells it without the text', async () => {
    const task = await chat()
    await save(task.id, `Токен сервиса — ${VALUE}`)
    // A secret the reservation let through by its form is still refused at the end (second line).
    await db.memoryReservation.create({
      data: {
        id: randomUUID(),
        workspaceId,
        taskId: task.id,
        turnNo: 1,
        kind: 'save',
        payload: { projectId: null, kind: 'fact', text: 'Пароль: Qwerty12345!' },
      },
    })
    await changes.apply(task.id, 1, refuses, { remember: true, evidence: clean })
    expect(await db.memoryEntry.count({ where: { sourceTaskId: task.id } })).toBe(0)
    expect(await rows(task.id)).toEqual([
      ['feed.memory_left', { v: 1, action: 'save', reason: 'secret' }],
      ['feed.memory_left', { v: 1, action: 'save', reason: 'secret' }],
    ])
    expect(JSON.stringify(await rows(task.id))).not.toContain(VALUE)
  })

  it('changes an entry of the client only by a proposal: the former text acts until «Сохранить»', async () => {
    const client = await db.memoryEntry.create({
      data: {
        id: randomUUID(),
        workspaceId,
        userId,
        kind: 'preference',
        text: 'Отвечать коротко',
        status: 'active',
        author: 'client',
      },
    })
    const confirmed = await db.memoryEntry.create({
      data: {
        id: randomUUID(),
        workspaceId,
        userId,
        kind: 'fact',
        text: 'Доставка по Москве',
        status: 'active',
        author: 'agent',
        confirmedAt: new Date(),
      },
    })
    const task = await chat()
    const scopeNow = { workspaceId, userId, projectId: null }
    await reserveMemoryChange(db, {
      taskId: task.id,
      turnNo: 1,
      scope: scopeNow,
      change: { kind: 'update', entryId: client.id, text: 'Отвечать подробно', expectedVersion: 1 },
    })
    await reserveMemoryChange(db, {
      taskId: task.id,
      turnNo: 1,
      scope: scopeNow,
      change: { kind: 'forget', entryId: confirmed.id, expectedVersion: 1 },
    })
    await changes.apply(task.id, 1, refuses, { remember: true, evidence: clean })
    expect(await db.memoryEntry.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({
      text: 'Отвечать коротко',
      status: 'active',
      pendingAction: 'update',
      pendingText: 'Отвечать подробно',
    })
    expect(await db.memoryEntry.findUniqueOrThrow({ where: { id: confirmed.id } })).toMatchObject({
      status: 'active',
      pendingAction: 'forget',
    })
    expect(
      (await rows(task.id)).map(([, payload]) => (payload as { action: string }).action),
    ).toEqual(['update_proposed', 'forget_proposed'])
  })

  it('applies nothing when the memory was turned off, after a failed pass, or without the values of the client', async () => {
    const off = await chat()
    await save(off.id, 'Выключено')
    await db.user.update({ where: { id: userId }, data: { agentMemory: false } })
    await changes.apply(off.id, 1, refuses, { remember: true, evidence: clean })
    await db.user.update({ where: { id: userId }, data: { agentMemory: true } })
    expect(await rows(off.id)).toEqual([
      ['feed.memory_left', { v: 1, action: 'save', reason: 'off' }],
    ])

    const failed = await chat()
    await save(failed.id, 'Упавший проход')
    await changes.fail(failed.id, 1)
    expect(await rows(failed.id)).toEqual([
      ['feed.memory_left', { v: 1, action: 'save', reason: 'failed' }],
    ])

    const unchecked = await chat()
    await save(unchecked.id, 'Без Vault')
    await changes.apply(unchecked.id, 1, null, { remember: true, evidence: clean })
    expect(await entry('Без Vault')).toBeNull()
    expect(
      await db.memoryReservation.findFirstOrThrow({ where: { taskId: unchecked.id } }),
    ).toMatchObject({
      outcome: 'failed',
    })
    for (const text of ['Выключено', 'Упавший проход']) expect(await entry(text)).toBeNull()
  })
})
