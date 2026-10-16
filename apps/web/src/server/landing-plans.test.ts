import { Decimal } from 'decimal.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LANDING_PLANS_RETRY_MS,
  LANDING_PLANS_TTL_MS,
  type getLandingPlans as getLandingPlansType,
} from './landing-plans'

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@repo/db', () => ({ prisma: { plan: { findMany } } }))

const START = Date.parse('2026-10-02T09:00:00Z')
const quota = (price: string) => ({
  slug: 'start',
  name: 'Старт',
  kind: 'quota',
  price: new Decimal(price),
  creditsPerMonth: 20,
  tasksPerDay: 5,
  maxSites: 1,
  packCredits: null,
})
let getLandingPlans: typeof getLandingPlansType

beforeEach(async () => {
  findMany.mockReset()
  // The module keeps the answer in memory: every test starts with a fresh copy.
  vi.resetModules()
  ;({ getLandingPlans } = await import('./landing-plans'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('landing tariff data boundary', () => {
  it('reads active database terms and sends exact monetary strings to the client', async () => {
    findMany.mockResolvedValue([
      {
        slug: 'current-start',
        name: 'Текущий тариф',
        kind: 'quota',
        price: new Decimal('5001.25'),
        creditsPerMonth: 35,
        tasksPerDay: 6,
        maxSites: 2,
        packCredits: null,
      },
      {
        slug: 'current-pack',
        name: 'Дополнительный пакет',
        kind: 'pack',
        price: new Decimal('2030.10'),
        creditsPerMonth: null,
        tasksPerDay: null,
        maxSites: null,
        packCredits: 12,
      },
    ])

    const data = await getLandingPlans()

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, kind: { in: ['quota', 'pack'] } },
      }),
    )
    expect(data).toEqual({
      plans: [
        {
          slug: 'current-start',
          name: 'Текущий тариф',
          price: '5001.25',
          creditsPerMonth: 35,
          tasksPerDay: 6,
          maxSites: 2,
        },
      ],
      pack: { price: '2030.10', credits: 12 },
    })
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
  })

  it('keeps the landing available without inventing prices when the database fails', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    findMany.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(getLandingPlans()).resolves.toEqual({ plans: [], pack: null })
    expect(report).toHaveBeenCalledWith('landing plans unavailable: ECONNREFUSED')
  })

  it('answers the renders of a minute with one query and then reads the terms again', async () => {
    vi.useFakeTimers({ now: START })
    findMany.mockResolvedValueOnce([quota('4900')]).mockResolvedValueOnce([quota('5200')])

    // A burst of visitors shares the query that is already on its way.
    const burst = await Promise.all([getLandingPlans(), getLandingPlans(), getLandingPlans()])
    expect(burst.map((data) => data.plans[0]?.price)).toEqual(['4900.00', '4900.00', '4900.00'])
    vi.setSystemTime(START + LANDING_PLANS_TTL_MS - 1)
    expect((await getLandingPlans()).plans[0]?.price).toBe('4900.00')
    expect(findMany).toHaveBeenCalledTimes(1)

    vi.setSystemTime(START + LANDING_PLANS_TTL_MS)
    expect((await getLandingPlans()).plans[0]?.price).toBe('5200.00')
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('asks a failed database again only after a pause and never caches a price list for it', async () => {
    vi.useFakeTimers({ now: START })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    findMany.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue([quota('4900')])

    await expect(getLandingPlans()).resolves.toEqual({ plans: [], pack: null })
    vi.setSystemTime(START + LANDING_PLANS_RETRY_MS - 1)
    await expect(getLandingPlans()).resolves.toEqual({ plans: [], pack: null })
    expect(findMany).toHaveBeenCalledTimes(1)

    vi.setSystemTime(START + LANDING_PLANS_RETRY_MS)
    expect((await getLandingPlans()).plans[0]?.price).toBe('4900.00')
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('recovers after the database client itself throws', async () => {
    vi.useFakeTimers({ now: START })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    findMany
      .mockImplementationOnce(() => {
        throw new Error('DATABASE_URL is not set')
      })
      .mockResolvedValue([quota('4900')])

    await expect(getLandingPlans()).resolves.toEqual({ plans: [], pack: null })
    vi.setSystemTime(START + LANDING_PLANS_RETRY_MS)
    expect((await getLandingPlans()).plans[0]?.price).toBe('4900.00')
  })

  it('keeps one query in the connection pool while the database does not answer', async () => {
    vi.useFakeTimers({ now: START })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let answer!: (rows: unknown[]) => void
    findMany
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue([quota('4900')])

    const first = getLandingPlans()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(first).resolves.toEqual({ plans: [], pack: null })

    // The timeout gave the render its answer; the query itself still holds a connection.
    await vi.advanceTimersByTimeAsync(10 * LANDING_PLANS_RETRY_MS)
    await expect(getLandingPlans()).resolves.toEqual({ plans: [], pack: null })
    expect(findMany).toHaveBeenCalledTimes(1)

    answer([])
    await vi.advanceTimersByTimeAsync(LANDING_PLANS_RETRY_MS)
    expect((await getLandingPlans()).plans[0]?.price).toBe('4900.00')
    expect(findMany).toHaveBeenCalledTimes(2)
  })
})
