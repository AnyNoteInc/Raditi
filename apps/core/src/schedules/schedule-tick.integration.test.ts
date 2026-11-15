import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { NotificationDelivery } from '../tasks/notification-delivery.ts'
import { ScheduleNotify } from './schedule-notify.ts'
import { ScheduleTick } from './schedule-tick.ts'

// The tick on PostgreSQL (docs/plan/82-scheduled-tasks.md, Зп14, Зп19–Зп22): the claim of a due
// task with its run and its outbox event, the missed moments while the platform stood, the runs
// web never answered, and their notices — once. Rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const quiet = () => ({ log: vi.fn(), warn: vi.fn() })

describe.skipIf(!enabled)('the tick of scheduled tasks with PostgreSQL', () => {
  let db: PrismaClient
  let workspaceId: string
  let userId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    workspaceId = (
      await db.workspace.create({ data: { name: 'Synthetic tick', dataClass: 'synthetic' } })
    ).id
    userId = (
      await db.user.create({
        data: { name: 'Автор', email: `tick-${randomUUID()}@example.test`, emailVerified: true },
      })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
  })
  afterAll(async () => {
    if (!db) return
    const runs = await db.scheduledRun.findMany({
      where: { scheduledTask: { workspaceId } },
      select: { id: true },
    })
    await db.outboxEvent.deleteMany({
      where: {
        OR: [
          ...runs.map((run) => ({ dedupeKey: `schedule.start:${run.id}` })),
          {
            dedupeKey: { startsWith: 'chat.waiting:' },
            payload: { path: ['to'], string_contains: 'tick-' },
          },
        ],
      },
    })
    await db.scheduledTask.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    await db.$disconnect()
  })

  function tick(now: Date) {
    const delivery = new NotificationDelivery({
      db,
      appUrl: 'https://raditi.example',
      push: null,
      logger: quiet(),
      now: () => now,
    })
    const notify = new ScheduleNotify({ db, delivery, logger: quiet(), now: () => now })
    return new ScheduleTick({ db, notify, logger: quiet(), now: () => now })
  }

  const schedule = (nextRunAt: Date, triggers: unknown = [{ kind: 'daily', time: '09:00' }]) =>
    db.scheduledTask.create({
      data: {
        workspaceId,
        createdById: userId,
        name: 'Проверка сайта',
        instructions: 'Откройте главную и скажите, всё ли в порядке.',
        effort: 'low',
        triggers: triggers as never,
        timezone: 'Europe/Moscow',
        nextRunAt,
        createdVia: 'manual',
      },
    })

  /**
   * Now, and an hourly schedule whose last moment was a minute or two ago: the runs are written
   * with the clock of the database, which the stale runs are told by.
   */
  function hourly() {
    const now = new Date()
    const minute = (now.getUTCMinutes() + 59) % 60
    const due = new Date(now)
    due.setUTCSeconds(0, 0)
    due.setUTCMinutes(minute)
    if (due > now) due.setUTCHours(due.getUTCHours() - 1)
    return { now, due, triggers: [{ kind: 'hourly', minute }] }
  }

  it('claims a due task once: its run, its start, and the next moment from now', async () => {
    const { now, due, triggers } = hourly()
    const task = await schedule(due, triggers)
    expect(await tick(now).run()).toMatchObject({ claimed: 1, started: 1 })
    const runs = await db.scheduledRun.findMany({ where: { scheduledTaskId: task.id } })
    expect(runs).toEqual([
      expect.objectContaining({
        dueAt: due,
        trigger: 'schedule',
        status: 'pending',
        name: 'Проверка сайта',
        effort: 'low',
      }),
    ])
    const start = await db.outboxEvent.findFirstOrThrow({
      where: { dedupeKey: `schedule.start:${runs[0]!.id}` },
    })
    expect(start).toMatchObject({ topic: 'schedules', type: 'schedule.start' })
    expect(start.payload).toEqual({ runId: runs[0]!.id })
    const after = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.nextRunAt).toEqual(new Date(due.getTime() + 3_600_000))
    // The next tick of the same minute finds nothing due.
    expect(await tick(now).run()).toMatchObject({ claimed: 0 })
  })

  it('runs the last moment after an outage and tells the missed ones once (Зп14)', async () => {
    const { now, due, triggers } = hourly()
    const task = await schedule(new Date(due.getTime() - 2 * 3_600_000), triggers)
    expect(await tick(now).run()).toMatchObject({ claimed: 1, started: 1 })
    const runs = await db.scheduledRun.findMany({
      where: { scheduledTaskId: task.id },
      orderBy: { dueAt: 'asc' },
      select: { status: true, reason: true, missedCount: true, dueAt: true },
    })
    expect(runs).toEqual([
      {
        status: 'skipped',
        reason: 'missed',
        missedCount: 2,
        dueAt: new Date(due.getTime() - 2 * 3_600_000),
      },
      { status: 'pending', reason: null, missedCount: 0, dueAt: due },
    ])
    const notices = await db.chatNotification.findMany({
      where: { scheduledTaskId: task.id },
      select: { kind: true, taskId: true, emailed: true },
    })
    // «Пропустила запуск» goes without a letter (Зп39).
    expect(notices).toEqual([{ kind: 'missed', taskId: null, emailed: false }])
  })

  it('closes a run web never answered as a fault of the platform, told once', async () => {
    const now = new Date()
    const task = await schedule(new Date(now.getTime() + 86_400_000))
    const run = await db.scheduledRun.create({
      data: {
        scheduledTaskId: task.id,
        dueAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 80 * 60_000),
        trigger: 'schedule',
        status: 'pending',
        name: task.name,
        instructions: task.instructions,
        effort: task.effort,
        attempts: 8,
        createdAt: new Date(now.getTime() - 76 * 60_000),
      },
    })
    expect(await tick(now).run()).toMatchObject({ stale: 1 })
    expect(
      await db.scheduledRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { status: true, reason: true },
      }),
    ).toEqual({ status: 'refused', reason: 'platform' })
    const notices = await db.chatNotification.findMany({
      where: { scheduledTaskId: task.id },
      select: { kind: true, scheduledRunId: true, emailed: true },
    })
    expect(notices).toEqual([{ kind: 'not_started', scheduledRunId: run.id, emailed: true }])
    // The task keeps its schedule: a fault of the platform is no refusal of the client.
    expect(
      await db.scheduledTask.findUniqueOrThrow({
        where: { id: task.id },
        select: { enabled: true, refusalStreak: true },
      }),
    ).toEqual({ enabled: true, refusalStreak: 0 })
    expect(await tick(now).run()).toMatchObject({ stale: 0 })
    expect(await db.chatNotification.count({ where: { scheduledTaskId: task.id } })).toBe(1)
  })
})
