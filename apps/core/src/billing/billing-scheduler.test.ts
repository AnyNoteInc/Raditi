import { Logger } from '@nestjs/common'
import { renewalJobs } from '@repo/billing'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  BILLING_SCHEDULER_RETRY_MS,
  BillingScheduler,
  billingSchedulerId,
} from './billing-scheduler.ts'

const config = (tickSeconds = 300) => ({
  billing: { appUrl: 'https://raditi.example', renewalNoticeDays: 3, pastDueDays: 7, tickSeconds },
})

const schedulers: BillingScheduler[] = []

function setup({ background = true, tickSeconds = 300 } = {}) {
  const upsert = vi.fn((_id: string, _repeat: unknown, _template: unknown) =>
    Promise.resolve({ id: 'job' }),
  )
  const scheduler = new BillingScheduler(
    { upsertJobScheduler: upsert as never },
    config(tickSeconds),
    background,
  )
  schedulers.push(scheduler)
  return { scheduler, upsert }
}

beforeAll(() => {
  Logger.overrideLogger(false)
})
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.onModuleDestroy()
  vi.useRealTimers()
})

describe('BillingScheduler', () => {
  it('names one scheduler per pass', () => {
    expect(renewalJobs.map(billingSchedulerId)).toEqual([
      'billing.notices',
      'billing.charges',
      'billing.stuck_orders',
      'billing.period_ends',
    ])
  })

  it('registers nothing without background work: tests and tools have no Redis', async () => {
    const { scheduler, upsert } = setup({ background: false })

    scheduler.onApplicationBootstrap()
    await Promise.resolve()

    expect(upsert).not.toHaveBeenCalled()
  })

  it('upserts a scheduler per pass, every BILLING_TICK_SECONDS, with the pass as the job name', async () => {
    const { scheduler, upsert } = setup({ tickSeconds: 300 })

    scheduler.onApplicationBootstrap()
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(4))

    expect(upsert.mock.calls).toEqual([
      ['billing.notices', { every: 300_000 }, { name: 'notices' }],
      ['billing.charges', { every: 300_000 }, { name: 'charges' }],
      ['billing.stuck_orders', { every: 300_000 }, { name: 'stuck_orders' }],
      ['billing.period_ends', { every: 300_000 }, { name: 'period_ends' }],
    ])
  })

  it('takes the interval of the configuration, as a stand sets it', async () => {
    const { scheduler, upsert } = setup({ tickSeconds: 2 })

    expect(await scheduler.register()).toBe(true)

    expect(upsert.mock.calls.map(([, repeat]) => repeat)).toEqual(
      renewalJobs.map(() => ({ every: 2_000 })),
    )
  })

  it('does not hold the start of the application while Redis is away', async () => {
    const { scheduler, upsert } = setup()
    // BullMQ keeps a command until the connection is back: the upsert never settles.
    upsert.mockReturnValue(new Promise(() => {}))

    expect(scheduler.onApplicationBootstrap()).toBeUndefined()
    await Promise.resolve()

    expect(upsert).toHaveBeenCalledTimes(1)
    // Nor the stop: nothing waits for the upsert that is still held.
    expect(scheduler.onModuleDestroy()).toBeUndefined()
  })

  it('tries again later after a failed registration, and upserts all four again', async () => {
    vi.useFakeTimers()
    const { scheduler, upsert } = setup()
    upsert
      .mockResolvedValueOnce({ id: 'job' })
      .mockRejectedValueOnce(new Error('READONLY You cannot write against a read only replica'))

    expect(await scheduler.register()).toBe(false)
    expect(upsert).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(BILLING_SCHEDULER_RETRY_MS - 1)
    expect(upsert).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(upsert).toHaveBeenCalledTimes(6)
    expect(upsert.mock.calls.slice(2).map(([id]) => id)).toEqual(
      renewalJobs.map(billingSchedulerId),
    )

    // Registered: no further tries.
    await vi.advanceTimersByTimeAsync(10 * BILLING_SCHEDULER_RETRY_MS)
    expect(upsert).toHaveBeenCalledTimes(6)
  })

  it('stops trying when the application stops', async () => {
    vi.useFakeTimers()
    const { scheduler, upsert } = setup()
    upsert.mockRejectedValue(new Error('Connection is closed.'))

    expect(await scheduler.register()).toBe(false)
    scheduler.onModuleDestroy()
    await vi.advanceTimersByTimeAsync(10 * BILLING_SCHEDULER_RETRY_MS)

    expect(upsert).toHaveBeenCalledTimes(1)
    expect(await scheduler.register()).toBe(false)
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})
