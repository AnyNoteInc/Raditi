import type * as Billing from '@repo/billing'
import {
  chargeRenewals,
  endPeriods,
  renewalJobs,
  renewalOutcomes,
  sendRenewalNotices,
  settleStuckOrders,
  type RenewalDeps,
  type RenewalJob,
} from '@repo/billing'
import type { PrismaClient } from '@repo/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingConfig } from '../config/config.ts'
import { BILLING_QUEUE, BillingJobs, isRenewalJob } from './billing-jobs.ts'
import { FORBIDDEN_CHARGES_HINT } from './operator-cli.ts'

// The passes themselves are tested in @repo/billing, on PostgreSQL. Here: what the scheduler
// hands them and what it does with their results.
vi.mock('@repo/billing', async (importOriginal) => {
  const original = await importOriginal<typeof Billing>()
  const done = { counts: { failed: 0 }, complete: true }
  return {
    ...original,
    sendRenewalNotices: vi.fn(async () => done),
    chargeRenewals: vi.fn(async () => done),
    settleStuckOrders: vi.fn(async () => done),
    endPeriods: vi.fn(async () => ({ ...done, waitingForShop: 0 })),
  }
})

const passes = {
  notices: vi.mocked(sendRenewalNotices),
  charges: vi.mocked(chargeRenewals),
  stuck_orders: vi.mocked(settleStuckOrders),
  period_ends: vi.mocked(endPeriods),
}

const config: BillingConfig = {
  appUrl: 'https://raditi.example',
  renewalNoticeDays: 3,
  pastDueDays: 7,
  tickSeconds: 300,
}
const prisma = { marker: 'prisma' } as unknown as PrismaClient
const shop = { marker: 'shop' } as unknown as NonNullable<RenewalDeps['yookassa']>

/** The counts a pass returns: every outcome of the pass at zero, except the ones given. */
function counts(job: RenewalJob, done: Record<string, number> = {}) {
  const zero = Object.fromEntries(renewalOutcomes[job].map((outcome) => [outcome, 0]))
  return { ...zero, ...done } as never
}

function setup(yookassa: RenewalDeps['yookassa'] = shop) {
  const logger = { log: vi.fn(), warn: vi.fn() }
  const count = vi.fn()
  return { jobs: new BillingJobs({ prisma, yookassa, config, count, logger }), logger, count }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the billing queue', () => {
  it('is a queue of the domain, and its jobs are the four passes', () => {
    expect(BILLING_QUEUE).toBe('billing')
    expect(renewalJobs).toEqual(['notices', 'charges', 'stuck_orders', 'period_ends'])
    expect(renewalJobs.every(isRenewalJob)).toBe(true)
    expect(isRenewalJob('refunds')).toBe(false)
    expect(isRenewalJob('toString')).toBe(false)
  })
})

describe('BillingJobs', () => {
  it.each(renewalJobs)(
    'runs the pass %s with the database, the shop and the settings',
    async (job) => {
      const { jobs } = setup()
      const shutdown = new AbortController()

      await jobs.run(job, shutdown.signal)

      for (const [name, pass] of Object.entries(passes)) {
        expect(pass).toHaveBeenCalledTimes(name === job ? 1 : 0)
      }
      const [deps] = passes[job].mock.calls[0] ?? []
      expect(deps).toMatchObject({
        prisma,
        yookassa: shop,
        appUrl: 'https://raditi.example',
        settings: { noticeDays: 3, pastDueDays: 7 },
        signal: shutdown.signal,
      })
      // The system clock, and the batch sizes of the passes themselves.
      expect(deps).not.toHaveProperty('now')
      expect(deps?.settings).toEqual({ noticeDays: 3, pastDueDays: 7 })
    },
  )

  it('hands the passes no shop while payments are off', async () => {
    const { jobs } = setup(null)

    for (const job of renewalJobs) await jobs.run(job)

    for (const pass of Object.values(passes)) {
      expect(pass.mock.calls[0]?.[0].yookassa).toBeNull()
    }
  })

  it('refuses a job it does not know without running anything', async () => {
    const { jobs } = setup()

    await expect(jobs.run('refunds')).rejects.toThrow('Unknown billing job "refunds"')
    await expect(jobs.run('constructor')).rejects.toThrow(/Unknown billing job/)

    for (const pass of Object.values(passes)) expect(pass).not.toHaveBeenCalled()
  })

  it('counts the rows by outcome and says in one line what was done', async () => {
    const { jobs, logger, count } = setup()
    passes.charges.mockResolvedValueOnce({
      counts: counts('charges', { renewed: 2, declined: 1 }),
      complete: true,
    })

    await jobs.run('charges')

    expect(count.mock.calls).toEqual([
      ['charges', 'renewed', 2],
      ['charges', 'declined', 1],
    ])
    expect(logger.log.mock.calls).toEqual([['billing charges: renewed=2 declined=1']])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('stays silent on a tick with nothing due', async () => {
    const { jobs, logger, count } = setup()

    for (const job of renewalJobs) await jobs.run(job)

    expect(logger.log).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(count).not.toHaveBeenCalled()
  })

  it('counts the rows it passed by and does not log them', async () => {
    const { jobs, logger, count } = setup()
    // Another process had these rows.
    passes.charges.mockResolvedValueOnce({
      counts: counts('charges', { skipped: 7 }),
      complete: true,
    })
    passes.notices.mockResolvedValueOnce({
      counts: counts('notices', { skipped: 2, notified: 1 }),
      complete: true,
    })

    await jobs.run('charges')
    await jobs.run('notices')

    expect(count.mock.calls).toEqual([
      ['charges', 'skipped', 7],
      ['notices', 'notified', 1],
      ['notices', 'skipped', 2],
    ])
    expect(logger.log.mock.calls).toEqual([['billing notices: notified=1']])
  })

  it('says when a pass left due rows to the next tick', async () => {
    const { jobs, logger } = setup()
    passes.notices.mockResolvedValueOnce({
      counts: counts('notices', { notified: 1000 }),
      complete: false,
    })
    passes.stuck_orders.mockResolvedValueOnce({ counts: counts('stuck_orders'), complete: false })

    await jobs.run('notices')
    await jobs.run('stuck_orders')

    expect(logger.log.mock.calls).toEqual([
      ['billing notices: notified=1000 (more is due)'],
      ['billing stuck_orders: nothing done (more is due)'],
    ])
  })

  it('logs a row that could not be finished by its id, without what the error carried', async () => {
    const { jobs, logger, count } = setup()
    const secret = 'live_shop-secret-key'
    passes.stuck_orders.mockImplementationOnce(async (deps) => {
      deps.onError?.({
        job: 'stuck_orders',
        id: '0199a000-0000-7000-8000-0000000000e1',
        error: new Error(`timed out\n  at request ${'x'.repeat(500)} ${secret}`),
      })
      return { counts: counts('stuck_orders', { unanswered: 1 }), complete: true }
    })
    passes.charges.mockImplementationOnce(async (deps) => {
      deps.onError?.({
        job: 'charges',
        id: '0199a000-0000-7000-8000-0000000000e2',
        error: new Error('forbidden'),
      })
      return { counts: counts('charges', { failed: 1 }), complete: true }
    })

    await jobs.run('stuck_orders')
    await jobs.run('charges')

    const lines = logger.warn.mock.calls.map(([line]) => String(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(
      /^billing stuck_orders: order 0199a000-0000-7000-8000-0000000000e1 not finished: timed out at request x+$/,
    )
    // One line, clipped: a long message does not reach the log whole.
    expect(lines[0]).not.toContain('\n')
    expect(lines[0]).not.toContain(secret)
    expect(lines[1]).toBe(
      'billing charges: subscription 0199a000-0000-7000-8000-0000000000e2 not finished: forbidden',
    )
    expect(count.mock.calls).toEqual([
      ['stuck_orders', 'unanswered', 1],
      ['charges', 'failed', 1],
    ])
  })

  it('logs a charge the shop forbade in the two forms the hint of the operator quotes', async () => {
    const { jobs, logger } = setup()
    const subscription = '0199a000-0000-7000-8000-0000000000e2'
    const order = '0199a000-0000-7000-8000-0000000000e1'
    // As the client of ЮKassa words a 403: the code, then the description.
    const forbidden = new Error('forbidden: recurring payments are not allowed for the shop')
    // The first request of a charge is reported by the subscription…
    passes.charges.mockImplementationOnce(async (deps) => {
      deps.onError?.({ job: 'charges', id: subscription, error: forbidden })
      return { counts: counts('charges', { unanswered: 1 }), complete: true }
    })
    // …and every repeat of the next twelve hours by the order.
    passes.stuck_orders.mockImplementationOnce(async (deps) => {
      deps.onError?.({ job: 'stuck_orders', id: order, error: forbidden })
      return { counts: counts('stuck_orders', { unanswered: 1 }), complete: true }
    })

    await jobs.run('charges')
    await jobs.run('stuck_orders')

    // The hint names the ids by what they are and cuts each line after the code.
    const quoted = logger.warn.mock.calls.map(([line]) =>
      String(line)
        .replace(subscription, '<подписка>')
        .replace(order, '<заказ>')
        .replace(/(?<= not finished: forbidden).*$/, '…'),
    )
    expect(quoted).toEqual([
      'billing charges: subscription <подписка> not finished: forbidden…',
      'billing stuck_orders: order <заказ> not finished: forbidden…',
    ])
    // An operator searches the log by the order the list prints: most of the lines found, and
    // after a day the only ones left, are those of the repeats.
    for (const line of quoted) expect(FORBIDDEN_CHARGES_HINT).toContain(`«${line}»`)
  })

  it('warns once per tick about tariffs that wait for the shop', async () => {
    const { jobs, logger } = setup(null)
    passes.period_ends.mockResolvedValueOnce({
      counts: counts('period_ends', { cancelled: 1 }),
      complete: true,
      waitingForShop: 3,
    })

    await jobs.run('period_ends')
    await jobs.run('period_ends')

    expect(logger.warn.mock.calls).toEqual([
      [
        'billing period_ends: 3 subscriptions with auto-renewal are past the end of their period ' +
          'while payments are off; they stay active',
      ],
    ])
    expect(logger.log.mock.calls).toEqual([['billing period_ends: cancelled=1']])
  })

  it('rejects when the pass itself could not run, and counts nothing', async () => {
    const { jobs, logger, count } = setup()
    passes.period_ends.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))

    await expect(jobs.run('period_ends')).rejects.toThrow('connect ECONNREFUSED')

    expect(count).not.toHaveBeenCalled()
    expect(logger.log).not.toHaveBeenCalled()
  })

  it('runs the passes by its own clock when it is given one', async () => {
    const now = () => new Date('2021-04-10T09:00:00.000Z')
    const logger = { log: vi.fn(), warn: vi.fn() }
    const jobs = new BillingJobs({ prisma, yookassa: shop, config, logger, now })

    await jobs.run('notices')

    expect(passes.notices.mock.calls[0]?.[0].now).toBe(now)
  })
})
