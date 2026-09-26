import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from '../../src/client.ts'
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.ts'
import { changedFields, seedReferenceData, seededTables } from './apply.ts'
import { llmModelSeeds, planSeeds, type PlanSeed, type ReferenceData } from './data.ts'

describe('changedFields', () => {
  it('compares decimals by value and JSON structurally', () => {
    const stored = {
      price: new Prisma.Decimal('725.900000'),
      capabilities: { mcp: true, resume: true },
      name: 'Старт',
    }
    expect(
      changedFields(stored, {
        price: '725.9',
        capabilities: { resume: true, mcp: true },
        name: 'Старт',
      }),
    ).toBeNull()
    expect(changedFields(stored, { price: '725.91', name: 'Бизнес' })).toEqual({
      price: '725.91',
      name: 'Бизнес',
    })
  })

  it('treats NULL and a value as different', () => {
    expect(changedFields({ cacheReadPer1m: null }, { cacheReadPer1m: '50' })).toEqual({
      cacheReadPer1m: '50',
    })
    expect(
      changedFields({ cacheReadPer1m: new Prisma.Decimal(50) }, { cacheReadPer1m: null }),
    ).toEqual({
      cacheReadPer1m: null,
    })
  })
})

// Needs a migrated PostgreSQL: runs when DATABASE_URL is set (CI migrates and seeds first).
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('seedReferenceData on PostgreSQL', () => {
  let db: PrismaClient
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it('is idempotent: a rerun creates and updates nothing', async () => {
    await seedReferenceData(db)
    const counts = async () =>
      Promise.all([
        db.plan.count(),
        db.pricingRule.count(),
        db.agentDriver.count(),
        db.llmProvider.count(),
        db.llmModel.count(),
        db.llmModelPrice.count(),
      ])
    const before = await counts()

    const rerun = await seedReferenceData(db)

    expect(await counts()).toEqual(before)
    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    expect(rerun).toEqual({ created: zero, updated: zero })
  })

  it('stores money and prices exactly', async () => {
    const plans = await db.plan.findMany({ where: { slug: { in: planSeeds.map((p) => p.slug) } } })
    for (const seed of planSeeds) {
      expect(plans.find((p) => p.slug === seed.slug)?.price.toFixed(2)).toBe(seed.price)
    }

    const kimi = llmModelSeeds.find((m) => m.slug === 'kimi-k2.6')
    const price = await db.llmModelPrice.findFirstOrThrow({
      where: { model: { slug: 'kimi-k2.6', provider: { slug: 'cloudru' } } },
    })
    expect(price.inputPer1m.toFixed(6)).toBe('175.680000')
    expect(price.outputPer1m.toFixed(6)).toBe('725.900000')
    expect(price.cacheReadPer1m).toBeNull()
    expect(price.vatRate.toFixed(4)).toBe(kimi?.price.vatRate)
  })
})

describe.skipIf(!databaseUrl)('seedReferenceData plan terms on PostgreSQL', () => {
  let db: PrismaClient
  const slugs: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.plan.deleteMany({ where: { slug: { in: slugs } } })
    await db.$disconnect()
  })

  /** A committed plan with a unique slug, removed after the suite. */
  const testPlan = (): PlanSeed => {
    const slug = `test-${randomUUID().slice(0, 8)}`
    slugs.push(slug)
    return {
      slug,
      name: 'Тест',
      kind: 'quota',
      price: '4900.00',
      editsPerMonth: 30,
      editsPerDay: 5,
      packEdits: null,
      maxSites: 1,
      sortOrder: 990,
    }
  }

  const onlyPlans = (...plans: PlanSeed[]): ReferenceData => ({
    plans,
    pricingRules: [],
    agentDrivers: [],
    llmProviders: [],
    llmModels: [],
  })

  const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
  const plansOnly = (n: number) => ({ ...zero, plans: n })

  it('creates a missing plan and leaves an identical one alone', async () => {
    const plan = testPlan()
    expect(await seedReferenceData(db, onlyPlans(plan))).toEqual({
      created: plansOnly(1),
      updated: zero,
    })
    expect(await seedReferenceData(db, onlyPlans(plan))).toEqual({ created: zero, updated: zero })
  })

  it('follows the seed for the name and order', async () => {
    const plan = testPlan()
    await seedReferenceData(db, onlyPlans(plan))

    const report = await seedReferenceData(
      db,
      onlyPlans({ ...plan, name: 'Тест 2', sortOrder: 991 }),
    )

    expect(report.updated).toEqual(plansOnly(1))
    const stored = await db.plan.findUniqueOrThrow({ where: { slug: plan.slug } })
    expect([stored.name, stored.sortOrder]).toEqual(['Тест 2', 991])
  })

  it.each([
    ['price', { price: '5900.00' }, /price: stored 4900, seed 5900\.00/],
    ['monthly quota', { editsPerMonth: 40 }, /editsPerMonth: stored 30, seed 40/],
    ['daily quota', { editsPerDay: null }, /editsPerDay: stored 5, seed null/],
    ['site limit', { maxSites: 3 }, /maxSites: stored 1, seed 3/],
    ['kind', { kind: 'pack', packEdits: 10 }, /kind: stored quota, seed pack/],
  ] satisfies [string, Partial<PlanSeed>, RegExp][])(
    'fails and rolls back everything when the stored %s differs',
    async (_, change, message) => {
      const plan = testPlan()
      await seedReferenceData(db, onlyPlans(plan))
      const created = testPlan()

      // The new plan comes first: the failure must roll its insert back as well.
      await expect(
        seedReferenceData(db, onlyPlans(created, { ...plan, name: 'Не сохранится', ...change })),
      ).rejects.toThrow(message)

      const stored = await db.plan.findUniqueOrThrow({ where: { slug: plan.slug } })
      expect(stored.price.toFixed(2)).toBe('4900.00')
      expect([stored.name, stored.kind, stored.editsPerMonth, stored.editsPerDay]).toEqual([
        'Тест',
        'quota',
        30,
        5,
      ])
      expect(await db.plan.findUnique({ where: { slug: created.slug } })).toBeNull()
    },
  )
})
