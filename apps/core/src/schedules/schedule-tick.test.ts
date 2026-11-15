import { Logger } from '@nestjs/common'
import { DomainError } from '@repo/domain'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { SCHEDULE_TICK_BATCH, SCHEDULE_TICK_ROUNDS, ScheduleTick } from './schedule-tick.ts'

// The claim and its SQL are @repo/db's own (claimDueSchedule, tested on PostgreSQL there and in
// schedule-tick.integration.test.ts); here only how the tick walks the rows.
const helpers = vi.hoisted(() => ({
  claimDueSchedule: vi.fn(),
  dueScheduleIds: vi.fn(),
  recordRunOutcome: vi.fn(),
  stalePendingRuns: vi.fn(),
}))
vi.mock('@repo/db', () => helpers)

const NOW = new Date('2026-11-16T09:00:30.000Z')
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, '0')}`
const claim = (patch: Record<string, unknown> = {}) => ({
  dueAt: NOW,
  startRunId: id(900),
  missedRunId: null,
  missedCount: 0,
  busyRunId: null,
  nextRunAt: new Date(NOW.getTime() + 86_400_000),
  completed: false,
  ...patch,
})

beforeAll(() => {
  Logger.overrideLogger(false)
})
beforeEach(() => {
  for (const fn of Object.values(helpers)) fn.mockReset()
  helpers.dueScheduleIds.mockResolvedValue([])
  helpers.stalePendingRuns.mockResolvedValue([])
})

function stand() {
  const tx = { tx: true }
  const db = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) }
  const notify = { afterRun: vi.fn(async () => 'sent' as const) }
  const tick = new ScheduleTick({ db: db as never, notify, now: () => NOW })
  return { db, tx, notify, tick }
}

describe('ScheduleTick (docs/plan/82-scheduled-tasks.md, Зп14, Зп19–Зп21)', () => {
  it('claims each due task in a transaction of its own, and tells a missed run', async () => {
    const s = stand()
    helpers.dueScheduleIds.mockResolvedValueOnce([id(1), id(2), id(3)])
    helpers.claimDueSchedule
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(claim({ startRunId: null, missedRunId: id(901), missedCount: 3 }))
      // Another tick holds the third: nothing.
      .mockResolvedValueOnce(null)
    expect(await s.tick.run()).toEqual({ claimed: 2, started: 1, stale: 0 })
    expect(s.db.$transaction).toHaveBeenCalledTimes(3)
    expect(helpers.claimDueSchedule.mock.calls.map(([tx, task, now]) => [tx, task, now])).toEqual([
      [s.tx, id(1), NOW],
      [s.tx, id(2), NOW],
      [s.tx, id(3), NOW],
    ])
    expect(helpers.dueScheduleIds).toHaveBeenCalledWith(s.db, NOW, SCHEDULE_TICK_BATCH)
    // A run that started is told by its chat; a moment skipped while one goes on, by the list.
    expect(s.notify.afterRun.mock.calls).toEqual([[id(901)]])
  })

  it('goes on after a task that throws, and reads more while a whole batch came', async () => {
    const s = stand()
    const full = Array.from({ length: SCHEDULE_TICK_BATCH }, (_, n) => id(n + 1))
    helpers.dueScheduleIds.mockResolvedValueOnce(full).mockResolvedValueOnce([id(500)])
    helpers.claimDueSchedule.mockImplementation(async (_tx: unknown, task: string) => {
      if (task === id(1)) throw new DomainError('BAD_REQUEST', 'unreadable', 400)
      return claim()
    })
    const result = await s.tick.run()
    expect(result.claimed).toBe(SCHEDULE_TICK_BATCH)
    expect(helpers.dueScheduleIds).toHaveBeenCalledTimes(2)
  })

  it('stops when a read brings only tasks it has met, and never reads more than its rounds', async () => {
    const s = stand()
    const held = Array.from({ length: SCHEDULE_TICK_BATCH }, (_, n) => id(n + 1))
    helpers.dueScheduleIds.mockResolvedValue(held)
    helpers.claimDueSchedule.mockResolvedValue(null)
    await s.tick.run()
    expect(helpers.dueScheduleIds).toHaveBeenCalledTimes(2)
    expect(helpers.claimDueSchedule).toHaveBeenCalledTimes(SCHEDULE_TICK_BATCH)
    expect(SCHEDULE_TICK_ROUNDS).toBeGreaterThan(1)
  })

  it('closes the runs web never answered in 75 minutes as a fault of the platform, and tells them', async () => {
    const s = stand()
    helpers.stalePendingRuns.mockResolvedValue([
      { id: id(1), scheduledTaskId: id(10), trigger: 'schedule', dueAt: NOW, attempts: 8 },
      { id: id(2), scheduledTaskId: id(11), trigger: 'schedule', dueAt: NOW, attempts: 2 },
    ])
    helpers.recordRunOutcome
      .mockResolvedValueOnce({ recorded: true, paused: null })
      // Web answered in the meantime.
      .mockResolvedValueOnce({ recorded: false, paused: null })
    expect(await s.tick.run()).toEqual({ claimed: 0, started: 0, stale: 1 })
    expect(helpers.stalePendingRuns).toHaveBeenCalledWith(
      s.db,
      new Date(NOW.getTime() - 75 * 60_000),
      SCHEDULE_TICK_BATCH,
    )
    expect(helpers.recordRunOutcome).toHaveBeenCalledWith(
      s.db,
      id(1),
      { status: 'refused', reason: 'platform' },
      NOW,
    )
    expect(s.notify.afterRun.mock.calls).toEqual([[id(1), { recorded: true, paused: null }]])
  })

  it('stops between tasks when the worker closes', async () => {
    const s = stand()
    const controller = new AbortController()
    helpers.dueScheduleIds.mockResolvedValueOnce([id(1), id(2)])
    helpers.claimDueSchedule.mockImplementation(async () => {
      controller.abort()
      return claim()
    })
    expect(await s.tick.run(controller.signal)).toEqual({ claimed: 1, started: 1, stale: 0 })
    expect(helpers.stalePendingRuns).not.toHaveBeenCalled()
  })
})
