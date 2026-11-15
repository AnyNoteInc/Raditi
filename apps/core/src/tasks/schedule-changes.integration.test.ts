import { randomUUID } from 'node:crypto'

import { createPrismaClient, reserveScheduleChange, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ScheduleChanges, scheduleLeftReasonOf } from './schedule-changes.ts'

// The changes a turn asked of the scheduled tasks, applied at its end (docs/plan/82-scheduled-
// tasks.md, Зп31–Зп35): checked again, told by `feed.schedule_change`, refused and told by
// `feed.schedule_left`; a failed turn refuses them at once, the sweep closes the rest. Rows of
// its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const SECRET = 'синтетическое-значение-клиента'
const refuses = (text: string) => (text.includes(SECRET) ? ('client_value' as const) : null)

describe('scheduleLeftReasonOf', () => {
  it('tells each refusal of the database by the reason of the card', () => {
    expect(scheduleLeftReasonOf('SCHEDULE_FORBIDDEN')).toBe('forbidden')
    expect(scheduleLeftReasonOf('SCHEDULE_LIMIT')).toBe('limit')
    expect(scheduleLeftReasonOf('SCHEDULE_NOT_FOUND')).toBe('not_found')
    expect(scheduleLeftReasonOf('NOT_FOUND')).toBe('not_found')
    expect(scheduleLeftReasonOf('TASK_TEXT_HAS_SECRET')).toBe('text_refused')
    expect(scheduleLeftReasonOf('SCHEDULE_TOO_OFTEN')).toBe('invalid')
    expect(scheduleLeftReasonOf('SCHEDULE_IN_PAST')).toBe('invalid')
    expect(scheduleLeftReasonOf('BAD_REQUEST')).toBe('invalid')
    expect(scheduleLeftReasonOf('SOMETHING_ELSE')).toBe('failed')
  })
})

describe.skipIf(!enabled)('the scheduled tasks a turn changed, with PostgreSQL', () => {
  let db: PrismaClient
  let workspaceId: string
  let userId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic schedules', dataClass: 'synthetic' } })
    ).id
    userId = (
      await db.user.create({
        data: {
          name: 'Автор',
          email: `author-${randomUUID()}@example.test`,
          timezone: 'Asia/Novosibirsk',
        },
      })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
  })
  afterAll(async () => {
    if (!db) return
    await db.scheduledTask.deleteMany({ where: { workspaceId } })
    await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    await db.$disconnect()
  })

  const changes = (now = new Date()) =>
    new ScheduleChanges({ db, logger: { log: vi.fn(), warn: vi.fn() }, now: () => now })

  async function chat() {
    return db.task.create({
      data: {
        workspaceId,
        siteId: null,
        needsRepository: false,
        needsBrowser: false,
        createdById: userId,
      },
    })
  }

  const rows = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: { in: ['feed.schedule_change', 'feed.schedule_left'] } },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true },
      })
    ).map((row) => [row.type, row.payload])

  const create = (
    taskId: string,
    turnNo: number,
    patch: { name?: string; instructions?: string } = {},
  ) =>
    reserveScheduleChange(db, {
      workspaceId,
      taskId,
      turnNo,
      now: new Date(),
      change: {
        kind: 'create',
        name: patch.name ?? 'Проверка сайта',
        instructions: patch.instructions ?? 'Откройте главную и скажите, всё ли в порядке.',
        project: 'none',
        triggers: [{ kind: 'daily', time: '09:00' }],
      },
    })

  it('makes the task the turn asked for and tells it, in the zone of its author', async () => {
    const task = await chat()
    const reserved = await create(task.id, 1)
    await changes().apply(task.id, 1, refuses)
    const made = await db.scheduledTask.findFirstOrThrow({ where: { sourceTaskId: task.id } })
    expect(made).toMatchObject({
      createdVia: 'chat',
      createdById: userId,
      workspaceId,
      timezone: 'Asia/Novosibirsk',
      effort: 'high',
      enabled: true,
      notify: true,
    })
    expect(made.nextRunAt).not.toBeNull()
    expect(await rows(task.id)).toEqual([
      [
        'feed.schedule_change',
        {
          v: 1,
          action: 'created',
          scheduleId: made.id,
          name: 'Проверка сайта',
          instructions: 'Откройте главную и скажите, всё ли в порядке.',
          triggers: [{ kind: 'daily', time: '09:00' }],
          timezone: 'Asia/Novosibirsk',
          nextRunAt: made.nextRunAt!.toISOString(),
          siteId: null,
          effort: 'high',
          notify: true,
        },
      ],
    ])
    expect(
      await db.scheduleReservation.findUniqueOrThrow({ where: { id: reserved.reservationId } }),
    ).toMatchObject({ outcome: 'done', scheduleId: made.id })
    // A second end of the same turn finds nothing open.
    await changes().apply(task.id, 1, refuses)
    expect(await rows(task.id)).toHaveLength(1)
  })

  it('refuses words with a value of the client, never telling a name that holds one', async () => {
    const task = await chat()
    await create(task.id, 1, { instructions: `Пароль ${SECRET}, проверьте вход` })
    await create(task.id, 1, { name: `Вход ${SECRET}` })
    await changes().apply(task.id, 1, refuses)
    expect(await rows(task.id)).toEqual([
      [
        'feed.schedule_left',
        { v: 1, action: 'create', name: 'Проверка сайта', reason: 'text_refused' },
      ],
      ['feed.schedule_left', { v: 1, action: 'create', name: null, reason: 'text_refused' }],
    ])
    expect(await db.scheduledTask.count({ where: { sourceTaskId: task.id } })).toBe(0)
    expect(
      await db.scheduleReservation.count({ where: { taskId: task.id, outcome: 'refused' } }),
    ).toBe(2)
  })

  it('pauses and deletes as asked, and refuses what the author may no longer do', async () => {
    const task = await chat()
    await create(task.id, 1)
    await changes().apply(task.id, 1, refuses)
    const made = await db.scheduledTask.findFirstOrThrow({ where: { sourceTaskId: task.id } })

    await reserveScheduleChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 2,
      now: new Date(),
      change: { kind: 'update', scheduleId: made.id, enabled: false },
    })
    await changes().apply(task.id, 2, refuses)
    const paused = await db.scheduledTask.findUniqueOrThrow({ where: { id: made.id } })
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
    expect((await rows(task.id)).at(-1)).toEqual([
      'feed.schedule_change',
      expect.objectContaining({ action: 'paused', nextRunAt: null, scheduleId: made.id }),
    ])

    // The author is a member only by the end of the turn: nothing is deleted, and it is told.
    await reserveScheduleChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 3,
      now: new Date(),
      change: { kind: 'delete', scheduleId: made.id },
    })
    await db.member.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role: 'member' },
    })
    try {
      await changes().apply(task.id, 3, refuses)
    } finally {
      await db.member.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: 'owner' },
      })
    }
    expect((await rows(task.id)).at(-1)).toEqual([
      'feed.schedule_left',
      { v: 1, action: 'delete', name: 'Проверка сайта', reason: 'forbidden' },
    ])
    expect(
      (await db.scheduledTask.findUniqueOrThrow({ where: { id: made.id } })).deletedAt,
    ).toBeNull()

    await reserveScheduleChange(db, {
      workspaceId,
      taskId: task.id,
      turnNo: 4,
      now: new Date(),
      change: { kind: 'delete', scheduleId: made.id },
    })
    await changes().apply(task.id, 4, refuses)
    expect((await rows(task.id)).at(-1)).toEqual([
      'feed.schedule_change',
      expect.objectContaining({ action: 'deleted', scheduleId: made.id }),
    ])
    expect(
      (await db.scheduledTask.findUniqueOrThrow({ where: { id: made.id } })).deletedAt,
    ).not.toBeNull()
  })

  it('refuses the changes of a turn that failed at once, the name of a new task untold', async () => {
    const task = await chat()
    await create(task.id, 1)
    await changes().failTurn(task.id, 1)
    expect(await rows(task.id)).toEqual([
      ['feed.schedule_left', { v: 1, action: 'create', name: null, reason: 'failed' }],
    ])
    // The end of the turn that comes after finds nothing to apply.
    await changes().apply(task.id, 1, refuses)
    expect(await db.scheduledTask.count({ where: { sourceTaskId: task.id } })).toBe(0)
    expect(await rows(task.id)).toHaveLength(1)
  })

  it('sweeps the changes no end of a turn reached, never those of a pass at its end', async () => {
    const task = await chat()
    const reserved = await create(task.id, 1)
    const now = new Date()
    // Young: the turn may still be ending.
    expect(await changes(now).sweep()).toBe(0)
    await db.scheduleReservation.update({
      where: { id: reserved.reservationId },
      data: { createdAt: new Date(now.getTime() - 10 * 60_000) },
    })
    // The chat changed a moment ago: its pass applies them itself.
    expect(await changes(now).sweep()).toBe(0)
    await db.$executeRaw`
      UPDATE tasks SET updated_at = ${new Date(now.getTime() - 10 * 60_000)} WHERE id = ${task.id}::uuid`
    // A pass of this process is still at its end.
    expect(await changes(now).sweep((id) => id === task.id)).toBe(0)
    expect(await changes(now).sweep()).toBe(1)
    expect(await rows(task.id)).toEqual([
      ['feed.schedule_left', { v: 1, action: 'create', name: null, reason: 'failed' }],
    ])
    expect(
      await db.scheduleReservation.findUniqueOrThrow({ where: { id: reserved.reservationId } }),
    ).toMatchObject({ outcome: 'failed' })
    expect(await changes(now).sweep()).toBe(0)
  })
})
