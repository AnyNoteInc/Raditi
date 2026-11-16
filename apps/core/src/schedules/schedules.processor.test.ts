import { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  SCHEDULE_SCHEDULER_RETRY_MS,
  SCHEDULE_TICK_EVERY_MS,
  SCHEDULE_TICK_SCHEDULER_ID,
  ScheduleScheduler,
} from './schedule-scheduler.ts'
import { SchedulesProcessor } from './schedules.processor.ts'

const RUN = '01900000-0000-7000-8000-000000000001'
const job = (name: string, data: unknown = {}, attemptsMade = 0, attempts?: number) =>
  ({ name, data, id: '1', attemptsMade, opts: attempts === undefined ? {} : { attempts } }) as Job

beforeAll(() => {
  Logger.overrideLogger(false)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SchedulesProcessor (docs/plan/82-scheduled-tasks.md, Зп19–Зп21)', () => {
  const stand = () => {
    const tick = { run: vi.fn(async () => ({ claimed: 0, started: 0, stale: 0 })) }
    const start = { run: vi.fn(async () => 'started' as const) }
    return { tick, start, processor: new SchedulesProcessor(tick, start) }
  }

  it('ticks on a tick, and starts the run its job names with the attempt it is', async () => {
    const s = stand()
    await s.processor.process(job('schedule.tick'))
    expect(s.tick.run).toHaveBeenCalledOnce()
    await s.processor.process(job('schedule.start', { runId: RUN }, 3, 8))
    expect(s.start.run).toHaveBeenCalledWith(
      { runId: RUN },
      { made: 3, max: 8 },
      expect.any(AbortSignal),
    )
    // A job left without its attempts counts the queue's own.
    await s.processor.process(job('schedule.start', { runId: RUN }, 0))
    expect(s.start.run).toHaveBeenLastCalledWith(
      { runId: RUN },
      { made: 0, max: 8 },
      expect.any(AbortSignal),
    )
  })

  it('fails at once a job it cannot do later either', async () => {
    const s = stand()
    await expect(s.processor.process(job('schedule.other'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    for (const data of [{ runId: 'nope' }, { runId: RUN, words: 'x' }, {}])
      await expect(s.processor.process(job('schedule.start', data))).rejects.toBeInstanceOf(
        UnrecoverableError,
      )
    expect(s.start.run).not.toHaveBeenCalled()
  })

  it('tells the running tick and start to stop when the worker closes', async () => {
    const s = stand()
    let signal: AbortSignal | undefined
    s.tick.run.mockImplementation(async (given?: AbortSignal) => {
      signal = given
      return { claimed: 0, started: 0, stale: 0 }
    })
    await s.processor.process(job('schedule.tick'))
    expect(signal?.aborted).toBe(false)
    s.processor.onClosing()
    expect(signal?.aborted).toBe(true)
  })
})

describe('ScheduleScheduler', () => {
  it('registers one tick a minute with a single attempt', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => ({}) as never) }
    const scheduler = new ScheduleScheduler(queue, true)
    expect(await scheduler.register()).toBe(true)
    expect(SCHEDULE_TICK_EVERY_MS).toBe(60_000)
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULE_TICK_SCHEDULER_ID,
      { every: 60_000 },
      {
        name: 'schedule.tick',
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 3600 } },
      },
    )
    scheduler.onModuleDestroy()
  })

  it('registers nothing without background work', () => {
    const queue = { upsertJobScheduler: vi.fn() }
    new ScheduleScheduler(queue, false).onApplicationBootstrap()
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
  })

  it('tries a registration Redis refused again later, and never once it stops', async () => {
    vi.useFakeTimers()
    const queue = {
      upsertJobScheduler: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({}),
    }
    const scheduler = new ScheduleScheduler(queue, true)
    expect(await scheduler.register()).toBe(false)
    await vi.advanceTimersByTimeAsync(SCHEDULE_SCHEDULER_RETRY_MS)
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2)
    scheduler.onModuleDestroy()
    expect(await scheduler.register()).toBe(false)
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2)
  })
})
