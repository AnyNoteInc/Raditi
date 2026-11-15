import { Logger } from '@nestjs/common'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { pausedBy, SCHEDULE_REPEAT_NOTICE_MS, ScheduleNotify } from './schedule-notify.ts'

const TASK = '01900000-0000-7000-8000-000000000010'
const RUN = '01900000-0000-7000-8000-000000000011'
const USER = '01900000-0000-7000-8000-000000000012'
const NOW = new Date('2026-11-16T09:01:00.000Z')

beforeAll(() => {
  Logger.overrideLogger(false)
})

type Run = {
  status: string
  reason: string | null
  trigger: string
  task?: Partial<{
    enabled: boolean
    pausedReason: string | null
    refusalStreak: number
    lastRefusalReason: string | null
    deletedAt: Date | null
  }>
}

function stand(run: Run, history: { last?: unknown; missed?: number; started?: number } = {}) {
  const task = {
    id: TASK,
    name: 'Проверка сайта',
    createdById: USER,
    deletedAt: null,
    enabled: true,
    pausedReason: null,
    refusalStreak: 1,
    lastRefusalReason: run.reason,
    ...run.task,
  }
  const db = {
    scheduledRun: {
      findUnique: vi.fn(async () => ({
        id: RUN,
        status: run.status,
        reason: run.reason,
        trigger: run.trigger,
        scheduledTask: task,
      })),
      count: vi.fn(async () => history.started ?? 0),
    },
    scheduledTask: {
      findUnique: vi.fn(async () => task),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    chatNotification: {
      count: vi.fn(async () => history.missed ?? 0),
      findFirst: vi.fn(async () => history.last ?? null),
    },
  }
  const delivery = { deliver: vi.fn(async () => 'sent' as const) }
  const notify = new ScheduleNotify({ db: db as never, delivery, now: () => NOW })
  return { db, delivery, notify }
}

describe('ScheduleNotify (docs/plan/82-scheduled-tasks.md, Зп22, Зп38, Зп39)', () => {
  it('tells a refused run «не запустилась» with its reason, opening the page of the task', async () => {
    const s = stand({ status: 'refused', reason: 'no_credits', trigger: 'schedule' })
    expect(await s.notify.afterRun(RUN)).toBe('sent')
    expect(s.delivery.deliver).toHaveBeenCalledWith({
      userId: USER,
      kind: 'not_started',
      chat: null,
      schedule: { id: TASK, runId: RUN },
      path: `/scheduled/${TASK}`,
      letter: true,
      telegram: {
        text: 'Запланированная задача не запустилась — «Проверка сайта»: не хватило кредитов.',
        button: 'Открыть задачу',
      },
    })
    expect(s.db.scheduledTask.updateMany).toHaveBeenCalledWith({
      where: { id: TASK },
      data: { lastNotifiedAt: NOW },
    })
  })

  it('says nothing of «Запустить сейчас»: its refusal is in the cabinet (Зп24)', async () => {
    const s = stand({ status: 'refused', reason: 'no_credits', trigger: 'manual' })
    expect(await s.notify.afterRun(RUN)).toBe('none')
    expect(s.delivery.deliver).not.toHaveBeenCalled()
  })

  it('tells the same reason once until the task starts again, or a day later (Зп39)', async () => {
    const last = {
      createdAt: new Date(NOW.getTime() - 60_000),
      scheduledRun: { reason: 'no_credits' },
    }
    const repeated = stand(
      { status: 'refused', reason: 'no_credits', trigger: 'schedule' },
      { last },
    )
    expect(await repeated.notify.afterRun(RUN)).toBe('repeated')
    expect(repeated.delivery.deliver).not.toHaveBeenCalled()

    const another = stand(
      { status: 'refused', reason: 'weekly_limit', trigger: 'schedule' },
      { last },
    )
    expect(await another.notify.afterRun(RUN)).toBe('sent')
    const started = stand(
      { status: 'refused', reason: 'no_credits', trigger: 'schedule' },
      { last, started: 1 },
    )
    expect(await started.notify.afterRun(RUN)).toBe('sent')
    const dayLater = stand(
      { status: 'refused', reason: 'no_credits', trigger: 'schedule' },
      {
        last: {
          createdAt: new Date(NOW.getTime() - SCHEDULE_REPEAT_NOTICE_MS),
          scheduledRun: { reason: 'no_credits' },
        },
      },
    )
    expect(await dayLater.notify.afterRun(RUN)).toBe('sent')
  })

  it('tells the third refusal in a row as the one notice of the pause (Зп22)', async () => {
    const s = stand({
      status: 'refused',
      reason: 'no_credits',
      trigger: 'schedule',
      task: { enabled: false, pausedReason: 'refused', refusalStreak: 3 },
    })
    expect(await s.notify.afterRun(RUN)).toBe('sent')
    expect(s.delivery.deliver).toHaveBeenCalledOnce()
    expect(s.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'paused',
        telegram: {
          text: 'Запланированная задача приостановлена — «Проверка сайта»: не хватило кредитов.',
          button: 'Открыть задачу',
        },
      }),
    )
  })

  it('takes the pause core recorded, and says nothing of a project the client deleted', async () => {
    const recorded = stand({ status: 'refused', reason: 'member_gone', trigger: 'schedule' })
    expect(await recorded.notify.afterRun(RUN, { paused: 'member_gone' })).toBe('sent')
    expect(recorded.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paused' }),
    )
    const gone = stand({ status: 'refused', reason: 'project_gone', trigger: 'schedule' })
    expect(await gone.notify.afterRun(RUN, { paused: 'project_gone' })).toBe('none')
    expect(gone.delivery.deliver).not.toHaveBeenCalled()
  })

  it('says nothing of a deleted project whatever the run was refused for (Зп22)', async () => {
    // «Один раз» that had completed: its refusal for the deletion pauses nothing.
    const completed = stand({
      status: 'refused',
      reason: 'project_gone',
      trigger: 'schedule',
      task: { enabled: false, pausedReason: 'completed' },
    })
    expect(await completed.notify.afterRun(RUN)).toBe('none')
    expect(completed.delivery.deliver).not.toHaveBeenCalled()
    // A start that raced the deletion and was refused for the platform after the task stopped.
    const raced = stand({
      status: 'refused',
      reason: 'platform',
      trigger: 'schedule',
      task: { enabled: false, pausedReason: 'project_gone' },
    })
    expect(await raced.notify.afterRun(RUN)).toBe('none')
    expect(raced.delivery.deliver).not.toHaveBeenCalled()
  })

  it('tells a missed run once a day, never one skipped while the last still went on', async () => {
    const missed = stand({ status: 'skipped', reason: 'missed', trigger: 'schedule' })
    expect(await missed.notify.afterRun(RUN)).toBe('sent')
    expect(missed.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'missed',
        letter: false,
        telegram: {
          text: 'Запланированная задача пропустила запуск — «Проверка сайта».',
          button: 'Открыть задачу',
        },
      }),
    )
    const again = stand({ status: 'skipped', reason: 'missed', trigger: 'schedule' }, { missed: 1 })
    expect(await again.notify.afterRun(RUN)).toBe('repeated')
    const busy = stand({ status: 'skipped', reason: 'previous_running', trigger: 'schedule' })
    expect(await busy.notify.afterRun(RUN)).toBe('none')
    expect(busy.delivery.deliver).not.toHaveBeenCalled()
  })

  it('tells a pause by the gate of a chat in its own words, and never throws', async () => {
    const s = stand({ status: 'started', reason: null, trigger: 'schedule' })
    expect(await s.notify.paused({ scheduleId: TASK, runId: RUN, reason: 'not_accepted' })).toBe(
      'sent',
    )
    expect(s.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'paused',
        letter: true,
        telegram: expect.objectContaining({
          text: 'Запланированная задача приостановлена — «Проверка сайта»: задачи пока не принимаются.',
        }),
      }),
    )
    s.delivery.deliver.mockRejectedValueOnce(new Error('database away'))
    expect(await s.notify.paused({ scheduleId: TASK, runId: RUN, reason: 'not_accepted' })).toBe(
      'none',
    )
  })
})

describe('pausedBy', () => {
  const task = {
    enabled: false,
    pausedReason: 'refused',
    refusalStreak: 3,
    lastRefusalReason: 'no_credits',
  }
  it('reads the pause of a refusal from the task as recordRunOutcome left it', () => {
    expect(pausedBy(task, 'no_credits')).toBe('refused')
    expect(pausedBy({ ...task, refusalStreak: 2 }, 'no_credits')).toBeNull()
    expect(pausedBy({ ...task, enabled: true, pausedReason: null }, 'no_credits')).toBeNull()
    expect(pausedBy({ ...task, pausedReason: 'member_gone' }, 'member_gone')).toBe('member_gone')
    // A refusal of the platform is no reason of the client: it pauses nothing.
    expect(pausedBy({ ...task, lastRefusalReason: 'platform' }, 'platform')).toBeNull()
  })
})
