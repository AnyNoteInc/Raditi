import { scheduleLimits, scheduleStartDedupeKey, type ScheduleTrigger } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  applyScheduleChange,
  claimDueSchedule,
  countSiteSchedules,
  createScheduledTask,
  deleteScheduledTask,
  dropPendingRun,
  dueScheduleIds,
  insertManualRun,
  listScheduledTasks,
  passUnattended,
  pauseSchedule,
  pauseSiteSchedules,
  pendingScheduleChanges,
  readScheduledTask,
  recordRunOutcome,
  refuseScheduleChanges,
  rememberUserTimezone,
  reserveScheduleChange,
  setScheduledTaskEnabled,
  stalePendingRuns,
  staleScheduleReservations,
  updateScheduledTask,
  type ScheduledTaskInput,
} from './scheduled-tasks.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL

// Moscow has had no change of the clocks since 2014: 9:00 there is 6:00 UTC every day.
const MSK = 'Europe/Moscow'
const at = (iso: string) => new Date(iso)
/** Monday, 16 November 2026, 8:00 in Moscow. */
const monday = at('2026-11-16T05:00:00Z')
const minutes = (n: number) => n * 60_000
const daily9: ScheduleTrigger[] = [{ kind: 'daily', time: '09:00' }]

/** The code of a DomainError a promise was refused with. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL: scheduled tasks (plan 82)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'scheduled')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  /** A user, their workspace with a project, and the user's role there. */
  async function owner(role: 'owner' | 'admin' | 'member' = 'owner') {
    const user = await db.user.create({
      data: { name: 'Анна', email: `owner-${uuidv7()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role } })
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Сайт',
        url: `https://${uuidv7()}.example.test`,
        stack: 'wordpress',
      },
    })
    return { userId: user.id, workspaceId: workspace.id, siteId: site.id }
  }

  type Owner = Awaited<ReturnType<typeof owner>>

  const input = (who: Owner, extra: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput => ({
    userId: who.userId,
    workspaceId: who.workspaceId,
    siteId: who.siteId,
    name: 'Проверка сайта',
    instructions: 'Откройте сайт и проверьте главную страницу.',
    effort: 'low',
    triggers: daily9,
    timezone: MSK,
    createdVia: 'manual',
    now: monday,
    ...extra,
  })

  /** A chat of the user: of the project, or without one. */
  async function chat(
    who: Owner,
    options: { project?: boolean; status?: string; turnNo?: number } = {},
  ) {
    const project = options.project ?? true
    const task = await db.task.create({
      data: {
        id: uuidv7(),
        workspaceId: who.workspaceId,
        siteId: project ? who.siteId : null,
        needsRepository: project,
        needsBrowser: false,
        createdById: who.userId,
        ...(options.status ? { status: options.status as never } : {}),
        turnNo: options.turnNo ?? 1,
      },
    })
    return task.id
  }

  describe('the client', () => {
    it('creates a task with its next run in its zone, canonical, and lists it', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who, { timezone: 'Europe/Moscow' }))
      expect(task.nextRunAt).toEqual(at('2026-11-16T06:00:00Z'))
      expect(task.enabled).toBe(true)
      const listed = await listScheduledTasks(db, { userId: who.userId })
      expect(listed.map((row) => row.id)).toEqual([task.id])
      expect(
        (await readScheduledTask(db, { scheduleId: task.id, userId: who.userId })).runs,
      ).toEqual([])
      // «Только вручную»: on, never due.
      const manual = await createScheduledTask(db, input(who, { triggers: [] }))
      expect(manual.enabled).toBe(true)
      expect(manual.nextRunAt).toBeNull()
    })

    it('refuses a member, a deleted project, a past run, runs too close and a key', async () => {
      const member = await owner('member')
      expect(await codeOf(createScheduledTask(db, input(member)))).toBe('SCHEDULE_FORBIDDEN')
      const who = await owner()
      await db.site.update({ where: { id: who.siteId }, data: { deletedAt: monday } })
      expect(await codeOf(createScheduledTask(db, input(who)))).toBe('NOT_FOUND')
      const other = await owner()
      const once = (date: string): ScheduleTrigger[] => [{ kind: 'once', date, time: '07:00' }]
      expect(
        await codeOf(createScheduledTask(db, input(other, { triggers: once('2026-11-16') }))),
      ).toBe('SCHEDULE_IN_PAST')
      // A single run in the past is refused even beside a schedule that runs on (Зп15).
      expect(
        await codeOf(
          createScheduledTask(db, input(other, { triggers: [...daily9, ...once('2026-11-16')] })),
        ),
      ).toBe('SCHEDULE_IN_PAST')
      expect(
        await codeOf(
          createScheduledTask(
            db,
            input(other, { triggers: [...daily9, { kind: 'daily', time: '09:30' }] }),
          ),
        ),
      ).toBe('SCHEDULE_TOO_OFTEN')
      expect(
        await codeOf(
          createScheduledTask(
            db,
            input(other, { instructions: 'Пароль: sk-proj-4f9QzX2LmN8pR7tV1wY6bC3dE5gH0jK' }),
          ),
        ),
      ).toBe('TASK_TEXT_HAS_SECRET')
      expect(await codeOf(createScheduledTask(db, input(other, { timezone: 'Mars/Base' })))).toBe(
        'BAD_REQUEST',
      )
      expect(await db.scheduledTask.count({ where: { workspaceId: other.workspaceId } })).toBe(0)
    })

    it('keeps 20 enabled tasks a workspace: the 21st waits paused', async () => {
      const who = await owner()
      for (let index = 0; index < scheduleLimits.activePerWorkspace; index += 1)
        await createScheduledTask(db, input(who, { triggers: [] }))
      expect(await codeOf(createScheduledTask(db, input(who)))).toBe('SCHEDULE_LIMIT')
      const paused = await createScheduledTask(db, input(who, { enabled: false }))
      expect(paused.nextRunAt).toBeNull()
      expect(
        await codeOf(
          setScheduledTaskEnabled(db, {
            scheduleId: paused.id,
            userId: who.userId,
            enabled: true,
            now: monday,
          }),
        ),
      ).toBe('SCHEDULE_LIMIT')
    })

    it('moves the next run only for the schedule, the zone or the state (Зп13)', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      const later = new Date(monday.getTime() + minutes(30))
      const renamed = await updateScheduledTask(db, {
        scheduleId: task.id,
        userId: who.userId,
        patch: { name: 'Другое имя', notify: false },
        now: later,
      })
      expect(renamed.nextRunAt).toEqual(task.nextRunAt)
      const moved = await updateScheduledTask(db, {
        scheduleId: task.id,
        userId: who.userId,
        patch: { triggers: [{ kind: 'daily', time: '10:00' }] },
        now: later,
      })
      expect(moved.nextRunAt).toEqual(at('2026-11-16T07:00:00Z'))
      const paused = await setScheduledTaskEnabled(db, {
        scheduleId: task.id,
        userId: who.userId,
        enabled: false,
        now: later,
      })
      expect([paused.enabled, paused.nextRunAt, paused.pausedReason]).toEqual([false, null, null])
      const tomorrow = at('2026-11-17T08:00:00Z')
      const resumed = await setScheduledTaskEnabled(db, {
        scheduleId: task.id,
        userId: who.userId,
        enabled: true,
        now: tomorrow,
      })
      expect(resumed.nextRunAt).toEqual(at('2026-11-18T07:00:00Z'))
    })

    it('runs a completed task again when it takes a new date (Зп15)', async () => {
      const who = await owner()
      const once: ScheduleTrigger[] = [{ kind: 'once', date: '2026-11-16', time: '09:00' }]
      const task = await createScheduledTask(db, input(who, { triggers: once }))
      await db.$transaction((tx) => claimDueSchedule(tx, task.id, at('2026-11-16T06:00:10Z')))
      const done = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
      expect([done.enabled, done.pausedReason, done.nextRunAt]).toEqual([false, 'completed', null])
      const again = await updateScheduledTask(db, {
        scheduleId: task.id,
        userId: who.userId,
        patch: { triggers: [{ kind: 'once', date: '2026-11-20', time: '09:00' }] },
        now: at('2026-11-17T06:00:00Z'),
      })
      expect([again.enabled, again.pausedReason, again.nextRunAt]).toEqual([
        true,
        null,
        at('2026-11-20T06:00:00Z'),
      ])
    })

    it('deletes a task of its creator only, and remembers a zone', async () => {
      const who = await owner()
      const stranger = await owner()
      const task = await createScheduledTask(db, input(who))
      expect(
        await codeOf(
          deleteScheduledTask(db, { scheduleId: task.id, userId: stranger.userId, now: monday }),
        ),
      ).toBe('SCHEDULE_NOT_FOUND')
      const deleted = await deleteScheduledTask(db, {
        scheduleId: task.id,
        userId: who.userId,
        now: monday,
      })
      expect([deleted.enabled, deleted.nextRunAt]).toEqual([false, null])
      expect(await listScheduledTasks(db, { userId: who.userId })).toEqual([])
      expect(await rememberUserTimezone(db, who.userId, 'Asia/Novosibirsk')).toBe(
        'Asia/Novosibirsk',
      )
      expect((await db.user.findUniqueOrThrow({ where: { id: who.userId } })).timezone).toBe(
        'Asia/Novosibirsk',
      )
    })
  })

  describe('the tick', () => {
    it('runs a due task once, with a snapshot, its outbox event and the next moment', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      expect(await db.$transaction((tx) => claimDueSchedule(tx, task.id, monday))).toBeNull()
      const now = at('2026-11-16T06:00:30Z')
      expect(await dueScheduleIds(db, now, 1000)).toContain(task.id)
      const claim = await db.$transaction((tx) => claimDueSchedule(tx, task.id, now))
      expect(claim).toMatchObject({
        dueAt: at('2026-11-16T06:00:00Z'),
        missedCount: 0,
        missedRunId: null,
        busyRunId: null,
        nextRunAt: at('2026-11-17T06:00:00Z'),
        completed: false,
      })
      const run = await db.scheduledRun.findUniqueOrThrow({ where: { id: claim!.startRunId! } })
      expect(run).toMatchObject({
        status: 'pending',
        trigger: 'schedule',
        name: task.name,
        instructions: task.instructions,
        effort: 'low',
        siteId: who.siteId,
      })
      const events = await db.outboxEvent.findMany({
        where: { dedupeKey: scheduleStartDedupeKey({ runId: run.id }) },
      })
      expect(events.map((event) => [event.topic, event.type])).toEqual([
        ['schedules', 'schedule.start'],
      ])
      // Claimed: the same minute claims nothing more.
      expect(await db.$transaction((tx) => claimDueSchedule(tx, task.id, now))).toBeNull()
      expect(await dueScheduleIds(db, now, 1000)).not.toContain(task.id)
    })

    it('runs the last moment of several and keeps the earlier ones as one row «Пропущено»', async () => {
      const who = await owner()
      const task = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'hourly', minute: 0 }] }),
      )
      expect(task.nextRunAt).toEqual(at('2026-11-16T06:00:00Z'))
      const claim = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T09:30:00Z')),
      )
      expect(claim).toMatchObject({ dueAt: at('2026-11-16T09:00:00Z'), missedCount: 3 })
      const missed = await db.scheduledRun.findUniqueOrThrow({ where: { id: claim!.missedRunId! } })
      expect(missed).toMatchObject({
        status: 'skipped',
        reason: 'missed',
        missedCount: 3,
        dueAt: at('2026-11-16T06:00:00Z'),
      })
      expect(claim!.startRunId).not.toBeNull()
      expect(claim!.nextRunAt).toEqual(at('2026-11-16T10:00:00Z'))
    })

    it('does not catch up a moment older than 6 hours', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      const claim = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T13:00:00Z')),
      )
      expect(claim).toMatchObject({ startRunId: null, missedCount: 1, completed: false })
      expect(claim!.nextRunAt).toEqual(at('2026-11-17T06:00:00Z'))
      // One row «Пропущено», nothing handed to web.
      const runs = await db.scheduledRun.findMany({ where: { scheduledTaskId: task.id } })
      expect(runs.map((run) => [run.id, run.status, run.reason, run.dueAt])).toEqual([
        [claim!.missedRunId, 'skipped', 'missed', at('2026-11-16T06:00:00Z')],
      ])
      expect(
        await db.outboxEvent.count({
          where: { dedupeKey: scheduleStartDedupeKey({ runId: claim!.missedRunId! }) },
        }),
      ).toBe(0)
    })

    it('skips a moment while the previous run goes on: waiting for web, or its chat working', async () => {
      const who = await owner()
      const task = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'hourly', minute: 0 }] }),
      )
      const first = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T06:00:00Z')),
      )
      const second = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T07:00:00Z')),
      )
      expect(second).toMatchObject({ startRunId: null, missedCount: 0 })
      const busy = await db.scheduledRun.findUniqueOrThrow({ where: { id: second!.busyRunId! } })
      expect([busy.status, busy.reason]).toEqual(['skipped', 'previous_running'])
      // Its chat runs: still going on; then it waits for the client — the next one starts.
      const chatId = await chat(who, { status: 'running' })
      await recordRunOutcome(db, first!.startRunId!, { status: 'started', taskId: chatId })
      const third = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T08:00:00Z')),
      )
      expect(third!.busyRunId).not.toBeNull()
      await db.task.update({ where: { id: chatId }, data: { status: 'awaiting_user' } })
      const fourth = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T09:00:00Z')),
      )
      expect(fourth!.startRunId).not.toBeNull()
    })

    it('completes a single run once claimed', async () => {
      const who = await owner()
      const task = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'once', date: '2026-11-16', time: '09:00' }] }),
      )
      const claim = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T06:01:00Z')),
      )
      expect(claim).toMatchObject({ completed: true, nextRunAt: null })
      expect(claim!.startRunId).not.toBeNull()
      const row = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
      expect([row.enabled, row.pausedReason, row.lastRunAt]).toEqual([
        false,
        'completed',
        at('2026-11-16T06:00:00Z'),
      ])
    })

    it('skips a task another transaction holds', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      const now = at('2026-11-16T06:00:30Z')
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let locked!: () => void
      const isLocked = new Promise<void>((resolve) => (locked = resolve))
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM scheduled_tasks WHERE id = ${task.id}::uuid FOR UPDATE`
          locked()
          await held
        },
        { timeout: 20_000 },
      )
      await isLocked
      expect(await db.$transaction((tx) => claimDueSchedule(tx, task.id, now))).toBeNull()
      release()
      await holder
      expect(await db.$transaction((tx) => claimDueSchedule(tx, task.id, now))).not.toBeNull()
    })
  })

  describe('runs', () => {
    it('runs now once a minute, and not while a run goes on (Зп24)', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who, { enabled: false }))
      const now = at('2026-11-16T10:00:20Z')
      const first = await insertManualRun(db, { scheduleId: task.id, userId: who.userId, now })
      expect(first.created).toBe(true)
      const run = await db.scheduledRun.findUniqueOrThrow({ where: { id: first.runId } })
      expect([run.trigger, run.dueAt]).toEqual(['manual', at('2026-11-16T10:00:00Z')])
      // A second press of the same minute is the same run.
      expect(
        await insertManualRun(db, {
          scheduleId: task.id,
          userId: who.userId,
          now: at('2026-11-16T10:00:50Z'),
        }),
      ).toEqual({ runId: first.runId, created: false })
      expect(
        await codeOf(
          insertManualRun(db, {
            scheduleId: task.id,
            userId: who.userId,
            now: at('2026-11-16T10:01:10Z'),
          }),
        ),
      ).toBe('SCHEDULE_RUN_BUSY')
      // web could not start it: gone, as if never pressed.
      expect(await dropPendingRun(db, first.runId)).toBe(true)
      expect(
        (
          await insertManualRun(db, {
            scheduleId: task.id,
            userId: who.userId,
            now: at('2026-11-16T10:01:10Z'),
          })
        ).created,
      ).toBe(true)
      const stranger = await owner()
      expect(
        await codeOf(insertManualRun(db, { scheduleId: task.id, userId: stranger.userId, now })),
      ).toBe('SCHEDULE_NOT_FOUND')
      await db.member.updateMany({
        where: { userId: who.userId, workspaceId: who.workspaceId },
        data: { role: 'member' },
      })
      expect(
        await codeOf(insertManualRun(db, { scheduleId: task.id, userId: who.userId, now })),
      ).toBe('SCHEDULE_FORBIDDEN')
    })

    it('records an outcome once and stops the task after three refusals of the client', async () => {
      const who = await owner()
      const task = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'hourly', minute: 0 }] }),
      )
      const claimAt = async (iso: string) =>
        (await db.$transaction((tx) => claimDueSchedule(tx, task.id, at(iso))))!.startRunId!
      const first = await claimAt('2026-11-16T06:00:00Z')
      const refused = await recordRunOutcome(db, first, { status: 'refused', reason: 'no_credits' })
      expect(refused).toMatchObject({
        recorded: true,
        paused: null,
        repeated: false,
        refusalStreak: 1,
      })
      expect(
        (await recordRunOutcome(db, first, { status: 'refused', reason: 'no_credits' })).recorded,
      ).toBe(false)
      // A refusal of «Запустить сейчас» counts for nothing.
      const manual = await insertManualRun(db, {
        scheduleId: task.id,
        userId: who.userId,
        now: at('2026-11-16T06:30:00Z'),
      })
      expect(
        (await recordRunOutcome(db, manual.runId, { status: 'refused', reason: 'no_credits' }))
          .refusalStreak,
      ).toBe(1)
      const second = await claimAt('2026-11-16T07:00:00Z')
      expect(
        await recordRunOutcome(db, second, { status: 'refused', reason: 'no_credits' }),
      ).toMatchObject({ repeated: true, refusalStreak: 2, paused: null })
      const third = await claimAt('2026-11-16T08:00:00Z')
      expect(
        await recordRunOutcome(db, third, { status: 'refused', reason: 'weekly_limit' }),
      ).toMatchObject({ repeated: false, refusalStreak: 3, paused: 'refused' })
      const row = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
      expect([row.enabled, row.nextRunAt, row.pausedReason, row.lastRefusalReason]).toEqual([
        false,
        null,
        'refused',
        'weekly_limit',
      ])
      // Resumed by the client: the streak starts again.
      const resumed = await setScheduledTaskEnabled(db, {
        scheduleId: task.id,
        userId: who.userId,
        enabled: true,
        now: at('2026-11-16T08:10:00Z'),
      })
      expect([resumed.refusalStreak, resumed.pausedReason]).toEqual([0, null])
    })

    it('stops a task whose project is gone, and clears the refusals when a run starts', async () => {
      const who = await owner()
      const task = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'hourly', minute: 0 }] }),
      )
      const first = (await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T06:00:00Z')),
      ))!.startRunId!
      await recordRunOutcome(db, first, { status: 'refused', reason: 'needs_tariff' })
      const second = (await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T07:00:00Z')),
      ))!.startRunId!
      // The chat of the run answered and waits: the next moment starts.
      const chatId = await chat(who, { status: 'awaiting_user' })
      expect(
        await recordRunOutcome(
          db,
          second,
          { status: 'started', taskId: chatId },
          at('2026-11-16T07:00:05Z'),
        ),
      ).toMatchObject({ recorded: true, refusalStreak: 0 })
      const started = await db.scheduledRun.findUniqueOrThrow({ where: { id: second } })
      expect([started.status, started.taskId, started.startedAt]).toEqual([
        'started',
        chatId,
        at('2026-11-16T07:00:05Z'),
      ])
      const third = (await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T08:00:00Z')),
      ))!.startRunId!
      expect(
        await recordRunOutcome(db, third, { status: 'refused', reason: 'project_gone' }),
      ).toMatchObject({ paused: 'project_gone' })
    })

    it('finds the runs web never answered', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      const claim = await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T06:00:00Z')),
      )
      const stale = await stalePendingRuns(db, new Date(Date.now() + minutes(1)), 1000)
      expect(stale.map((run) => run.id)).toContain(claim!.startRunId)
      expect(
        (await stalePendingRuns(db, new Date(Date.now() - minutes(75)), 1000)).map((run) => run.id),
      ).not.toContain(claim!.startRunId)
    })
  })

  describe('a chat of a run', () => {
    it('goes without its client until the client writes in it (Зп27)', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      const runId = (await db.$transaction((tx) =>
        claimDueSchedule(tx, task.id, at('2026-11-16T06:00:00Z')),
      ))!.startRunId!
      const chatId = await chat(who)
      const plain = await chat(who)
      const request = (taskId: string) =>
        db.taskEvent.create({
          data: { taskId, type: 'feed.request', payload: { v: 1 }, clientVisible: true },
        })
      await request(chatId)
      await request(plain)
      expect(await passUnattended(db, chatId)).toBe(false)
      await recordRunOutcome(db, runId, { status: 'started', taskId: chatId })
      expect(await passUnattended(db, chatId)).toBe(true)
      expect(await passUnattended(db, plain)).toBe(false)
      await request(chatId)
      expect(await passUnattended(db, chatId)).toBe(false)
    })
  })

  describe('the project', () => {
    it('stops the tasks of a deleted project, the finished ones as they are', async () => {
      const who = await owner()
      const on = await createScheduledTask(db, input(who))
      const off = await createScheduledTask(db, input(who, { enabled: false }))
      const once = await createScheduledTask(
        db,
        input(who, { triggers: [{ kind: 'once', date: '2026-11-16', time: '09:00' }] }),
      )
      await db.$transaction((tx) => claimDueSchedule(tx, once.id, at('2026-11-16T06:00:00Z')))
      await createScheduledTask(db, input(who, { siteId: null }))
      expect(await countSiteSchedules(db, who.siteId)).toBe(2)
      expect(await db.$transaction((tx) => pauseSiteSchedules(tx, who.siteId))).toBe(2)
      const rows = await db.scheduledTask.findMany({
        where: { id: { in: [on.id, off.id, once.id] } },
        select: { id: true, enabled: true, pausedReason: true },
      })
      expect(Object.fromEntries(rows.map((row) => [row.id, row.pausedReason]))).toEqual({
        [on.id]: 'project_gone',
        [off.id]: 'project_gone',
        [once.id]: 'completed',
      })
      expect(await countSiteSchedules(db, who.siteId)).toBe(0)
    })

    it('stops a task the gate refused, once', async () => {
      const who = await owner()
      const task = await createScheduledTask(db, input(who))
      expect(await db.$transaction((tx) => pauseSchedule(tx, task.id, 'not_accepted'))).toBe(true)
      expect(await db.$transaction((tx) => pauseSchedule(tx, task.id, 'not_accepted'))).toBe(false)
      const row = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
      expect([row.enabled, row.nextRunAt, row.pausedReason]).toEqual([false, null, 'not_accepted'])
    })
  })

  describe('the agent', () => {
    const create = (extra: Record<string, unknown> = {}) => ({
      kind: 'create' as const,
      name: 'Заявки за сутки',
      instructions: 'Соберите заявки с форм за прошедшие сутки.',
      project: 'this_chat' as const,
      triggers: [{ kind: 'weekdays', time: '08:00' }] as ScheduleTrigger[],
      ...extra,
    })

    it('reserves a task of the chat, checked now, and applies it when the turn ended', async () => {
      const who = await owner()
      const taskId = await chat(who)
      const turn = { workspaceId: who.workspaceId, taskId, turnNo: 1, now: monday }
      expect(
        await codeOf(reserveScheduleChange(db, { ...turn, change: create({ project: 'none' }) })),
      ).toBe('BAD_REQUEST')
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            ...turn,
            change: create({ triggers: [{ kind: 'once', date: '2026-11-15', time: '09:00' }] }),
          }),
        ),
      ).toBe('SCHEDULE_IN_PAST')
      const reserved = await reserveScheduleChange(db, { ...turn, change: create() })
      expect(reserved).toMatchObject({ kind: 'create', scheduleId: null, cancelled: false })
      expect(reserved.fields).toMatchObject({ siteId: who.siteId, effort: 'high', timezone: MSK })
      // 8:00 of Monday is now itself: the next weekday.
      expect(reserved.nextRunAt).toEqual(at('2026-11-17T05:00:00Z'))
      expect(await db.scheduledTask.count({ where: { workspaceId: who.workspaceId } })).toBe(0)

      const applied = await applyScheduleChange(db, {
        reservationId: reserved.reservationId,
        workspaceId: who.workspaceId,
        taskId,
        now: new Date(monday.getTime() + minutes(1)),
      })
      expect(applied.action).toBe('created')
      expect(applied.schedule).toMatchObject({
        createdVia: 'chat',
        sourceTaskId: taskId,
        createdById: who.userId,
        siteId: who.siteId,
        name: 'Заявки за сутки',
      })
      const closed = await db.scheduleReservation.findUniqueOrThrow({
        where: { id: reserved.reservationId },
      })
      expect([closed.outcome, closed.scheduleId]).toEqual(['done', applied.schedule.id])
      expect(await pendingScheduleChanges(db, taskId, 1)).toEqual([])
    })

    it('takes a zone of the author and a single run some minutes from now (Зп15)', async () => {
      const who = await owner()
      await rememberUserTimezone(db, who.userId, 'Asia/Novosibirsk')
      const taskId = await chat(who, { project: false })
      const reserved = await reserveScheduleChange(db, {
        workspaceId: who.workspaceId,
        taskId,
        turnNo: 1,
        now: monday,
        change: create({ project: 'none', triggers: [{ kind: 'once', inMinutes: 15 }] }),
      })
      expect(reserved.fields).toMatchObject({
        timezone: 'Asia/Novosibirsk',
        siteId: null,
        triggers: [{ kind: 'once', date: '2026-11-16', time: '12:15' }],
      })
      expect(reserved.nextRunAt).toEqual(new Date(monday.getTime() + minutes(15)))
      // The turn ended after the moment, within six hours: it is due at once.
      const late = new Date(monday.getTime() + minutes(40))
      const applied = await applyScheduleChange(db, {
        reservationId: reserved.reservationId,
        workspaceId: who.workspaceId,
        taskId,
        now: late,
      })
      expect(applied.schedule.nextRunAt).toEqual(new Date(monday.getTime() + minutes(15)))
      const claim = await db.$transaction((tx) => claimDueSchedule(tx, applied.schedule.id, late))
      expect(claim).toMatchObject({ completed: true })
      expect(claim!.startRunId).not.toBeNull()
    })

    it('refuses the author who does not manage, five changes a turn and 20 with the open ones', async () => {
      const member = await owner('member')
      const memberChat = await chat(member)
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            workspaceId: member.workspaceId,
            taskId: memberChat,
            turnNo: 1,
            now: monday,
            change: create(),
          }),
        ),
      ).toBe('SCHEDULE_FORBIDDEN')

      const who = await owner()
      const taskId = await chat(who)
      const turn = { workspaceId: who.workspaceId, taskId, turnNo: 1, now: monday }
      const times = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00']
      for (const time of times.slice(0, scheduleLimits.changesPerTurn))
        await reserveScheduleChange(db, {
          ...turn,
          change: create({ triggers: [{ kind: 'daily', time }] }),
        })
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            ...turn,
            change: create({ triggers: [{ kind: 'daily', time: '18:00' }] }),
          }),
        ),
      ).toBe('SCHEDULE_CHANGE_LIMIT')

      // 19 enabled tasks and one open creation of another turn: the 20 are taken.
      const full = await owner()
      for (let index = 0; index < scheduleLimits.activePerWorkspace - 1; index += 1)
        await createScheduledTask(db, input(full, { triggers: [] }))
      const fullChat = await chat(full)
      await reserveScheduleChange(db, {
        workspaceId: full.workspaceId,
        taskId: fullChat,
        turnNo: 1,
        now: monday,
        change: create(),
      })
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            workspaceId: full.workspaceId,
            taskId: fullChat,
            turnNo: 2,
            now: monday,
            change: create(),
          }),
        ),
      ).toBe('SCHEDULE_LIMIT')
    })

    it('amends and cancels a reservation of its turn by reservedId', async () => {
      const who = await owner()
      const taskId = await chat(who)
      const turn = { workspaceId: who.workspaceId, taskId, turnNo: 1, now: monday }
      const first = await reserveScheduleChange(db, { ...turn, change: create() })
      const amended = await reserveScheduleChange(db, {
        ...turn,
        change: { kind: 'update', reservedId: first.reservationId, name: 'Заявки за день' },
      })
      expect(amended.reservationId).toBe(first.reservationId)
      expect(amended.fields?.name).toBe('Заявки за день')
      // Another turn's reservation is not this turn's.
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            ...turn,
            turnNo: 2,
            change: { kind: 'delete', reservedId: first.reservationId },
          }),
        ),
      ).toBe('SCHEDULE_NOT_FOUND')
      const cancelled = await reserveScheduleChange(db, {
        ...turn,
        change: { kind: 'delete', reservedId: first.reservationId },
      })
      expect(cancelled.cancelled).toBe(true)
      expect(await pendingScheduleChanges(db, taskId, 1)).toEqual([])
    })

    it('changes a task of the author and the chat’s project, a second change amending the first', async () => {
      const who = await owner()
      const other = await createScheduledTask(db, input(who, { siteId: null }))
      const task = await createScheduledTask(db, input(who))
      const taskId = await chat(who)
      const turn = { workspaceId: who.workspaceId, taskId, turnNo: 1, now: monday }
      // A task without a project is not of this chat's (Зп31).
      expect(
        await codeOf(
          reserveScheduleChange(db, {
            ...turn,
            change: { kind: 'update', scheduleId: other.id, enabled: false },
          }),
        ),
      ).toBe('SCHEDULE_NOT_FOUND')
      const first = await reserveScheduleChange(db, {
        ...turn,
        change: { kind: 'update', scheduleId: task.id, name: 'Проверка утром' },
      })
      const second = await reserveScheduleChange(db, {
        ...turn,
        change: { kind: 'update', scheduleId: task.id, enabled: false },
      })
      expect(second.reservationId).toBe(first.reservationId)
      expect(second.fields).toMatchObject({ name: 'Проверка утром', enabled: false })
      expect(second.nextRunAt).toBeNull()
      const applied = await applyScheduleChange(db, {
        reservationId: first.reservationId,
        workspaceId: who.workspaceId,
        taskId,
        now: monday,
      })
      expect(applied.action).toBe('paused')
      expect([applied.schedule.name, applied.schedule.enabled]).toEqual(['Проверка утром', false])

      // A deletion gives an open update of the task way.
      const update = await reserveScheduleChange(db, {
        ...turn,
        turnNo: 2,
        change: { kind: 'update', scheduleId: task.id, enabled: true },
      })
      const deletion = await reserveScheduleChange(db, {
        ...turn,
        turnNo: 2,
        change: { kind: 'delete', scheduleId: task.id },
      })
      const open = await pendingScheduleChanges(db, taskId, 2)
      expect(open.map((row) => row.id)).toEqual([deletion.reservationId])
      expect(
        (await db.scheduleReservation.findUniqueOrThrow({ where: { id: update.reservationId } }))
          .outcome,
      ).toBe('refused')
      const deleted = await applyScheduleChange(db, {
        reservationId: deletion.reservationId,
        workspaceId: who.workspaceId,
        taskId,
        now: monday,
      })
      expect(deleted.action).toBe('deleted')
      expect(deleted.schedule.deletedAt).toEqual(monday)
    })

    it('checks everything again at the end of the turn, and refuses what no longer holds', async () => {
      const who = await owner()
      const taskId = await chat(who)
      const reserved = await reserveScheduleChange(db, {
        workspaceId: who.workspaceId,
        taskId,
        turnNo: 1,
        now: monday,
        change: create(),
      })
      await db.member.updateMany({
        where: { userId: who.userId, workspaceId: who.workspaceId },
        data: { role: 'member' },
      })
      expect(
        await codeOf(
          applyScheduleChange(db, {
            reservationId: reserved.reservationId,
            workspaceId: who.workspaceId,
            taskId,
            now: monday,
          }),
        ),
      ).toBe('SCHEDULE_FORBIDDEN')
      expect(
        await refuseScheduleChanges(db, {
          taskId,
          reservationIds: [reserved.reservationId],
          outcome: 'refused',
        }),
      ).toEqual([
        {
          id: reserved.reservationId,
          kind: 'create',
          scheduleId: null,
          name: 'Заявки за сутки',
        },
      ])
      // Never twice.
      expect(await refuseScheduleChanges(db, { taskId, turnNo: 1, outcome: 'failed' })).toEqual([])
    })

    it('refuses the changes of a failed pass and finds the ones of a turn that is over', async () => {
      const who = await owner()
      const running = await chat(who, { status: 'running' })
      const done = await chat(who, { status: 'awaiting_user' })
      const turn = (taskId: string) => ({
        workspaceId: who.workspaceId,
        taskId,
        turnNo: 1,
        now: monday,
      })
      const live = await reserveScheduleChange(db, { ...turn(running), change: create() })
      const left = await reserveScheduleChange(db, {
        ...turn(done),
        change: create({ triggers: [{ kind: 'daily', time: '12:00' }] }),
      })
      const stale = await staleScheduleReservations(db, {
        before: new Date(Date.now() + minutes(1)),
      })
      const ids = stale.map((row) => row.id)
      expect(ids).toContain(left.reservationId)
      expect(ids).not.toContain(live.reservationId)
      // However long it runs, the turn's own reservation waits — unless asked of any age.
      expect(
        (
          await staleScheduleReservations(db, {
            before: new Date(Date.now() + minutes(1)),
            anyBefore: new Date(Date.now() + minutes(1)),
          })
        ).map((row) => row.id),
      ).toContain(live.reservationId)
      const failed = await refuseScheduleChanges(db, {
        taskId: running,
        turnNo: 1,
        outcome: 'failed',
      })
      expect(failed.map((row) => row.id)).toEqual([live.reservationId])
      expect(
        (await db.scheduleReservation.findUniqueOrThrow({ where: { id: live.reservationId } }))
          .outcome,
      ).toBe('failed')
    })
  })
})
