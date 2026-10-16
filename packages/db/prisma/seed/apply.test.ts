import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.ts'
import { createMigratedSchema, schemaClient, type MigratedSchema } from '../migrated-schema.ts'
import { changedFields, seedReferenceData, seededTables } from './apply.ts'
import {
  agentDriverSeeds,
  llmModelSeeds,
  llmProviderSeeds,
  planSeeds,
  pricingRuleSeeds,
  type PlanSeed,
  type ReferenceData,
} from './data.ts'

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

// Needs a PostgreSQL: runs when DATABASE_URL is set. The real seed commits its rows, so every
// suite below works in a schema this file migrates and drops — never in the tables of the
// database it was given, which may be a developer's own.
const databaseUrl = process.env.DATABASE_URL
let schema: MigratedSchema

beforeAll(async () => {
  if (!databaseUrl) return
  schema = await createMigratedSchema(databaseUrl, 'seed_test')
  await schema.migrate()
}, 60_000)

afterAll(async () => {
  await schema?.drop()
})

const seedClient = () => schemaClient(databaseUrl ?? '', schema)

describe.skipIf(!databaseUrl)('seedReferenceData on PostgreSQL', () => {
  let db: PrismaClient
  beforeAll(() => {
    db = seedClient()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it('seeds only the schema created for this file, starting from an empty catalogue', async () => {
    expect(await db.$queryRaw`SELECT current_schema()::text AS schema`).toEqual([
      { schema: schema.name },
    ])
    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    expect(await seedReferenceData(db)).toEqual({
      created: {
        plans: planSeeds.length,
        pricing_rules: pricingRuleSeeds.length,
        agent_drivers: agentDriverSeeds.length,
        llm_providers: llmProviderSeeds.length,
        llm_models: llmModelSeeds.length,
      },
      updated: zero,
    })
    // Seen through a connection of its own: the committed rows are in the disposable schema.
    expect((await schema.db.query('SELECT count(*)::int AS plans FROM plans')).rows).toEqual([
      { plans: planSeeds.length },
    ])
  })

  const catalogue = () =>
    db.llmProvider.findMany({
      orderBy: { id: 'asc' },
      include: {
        models: {
          orderBy: { id: 'asc' },
          include: { prices: { orderBy: { effectiveFrom: 'asc' } } },
        },
      },
    })

  it('creates or updates nothing on rerun, including the subscription catalogue', async () => {
    await seedReferenceData(db)
    const originalCatalogue = await catalogue()
    const counts = async () =>
      Promise.all([
        db.plan.count(),
        db.pricingRule.count(),
        db.agentDriver.count(),
        db.llmProvider.count(),
        db.llmModel.count(),
        db.llmModelPrice.count(),
        db.creditRate.count(),
      ])
    const before = await counts()
    // The accounting rates of the models and the credit rate are approved by the owner and
    // written by `billing:rates`: the seed writes neither, not even a placeholder.
    expect(before.slice(-2)).toEqual([0, 0])

    const rerun = await seedReferenceData(db)

    expect(await counts()).toEqual(before)
    expect(await catalogue()).toEqual(originalCatalogue)
    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    expect(rerun).toEqual({ created: zero, updated: zero })
  })

  it('stores tariff and PAYG money exactly without seeding a service class', async () => {
    await seedReferenceData(db)
    const plans = await db.plan.findMany({ where: { slug: { in: planSeeds.map((p) => p.slug) } } })
    for (const seed of planSeeds) {
      expect(plans.find((p) => p.slug === seed.slug)?.price.toFixed(2)).toBe(seed.price)
    }

    const payg = await db.plan.findUniqueOrThrow({ where: { slug: 'payg' } })
    const rules = await db.pricingRule.findMany({ where: { planId: payg.id } })
    for (const seed of pricingRuleSeeds) {
      const rule = rules.find(
        (candidate) =>
          candidate.modelClass === seed.modelClass &&
          candidate.effectiveFrom.getTime() === seed.effectiveFrom.getTime(),
      )
      expect(rule?.markup.toFixed(4)).toBe(seed.markup)
      expect(rule?.feePerAction.toFixed(2)).toBe(seed.feePerAction)
      expect(rule?.minCharge.toFixed(2)).toBe(seed.minCharge)
      expect(rule?.holdAmount.toFixed(2)).toBe(seed.holdAmount)
    }
  })

  it.each([
    'Пакет 10 правок',
    // What a database seeded before the unit became the credit holds.
    'Пакет из 10 правок',
    // And before the pack held a hundred.
    'Пакет из 10 кредитов',
  ])('renames the pack stored as «%s» and leaves its terms alone', async (earlier) => {
    await seedReferenceData(db)
    const stored = await db.plan.update({
      where: { slug: 'pack' },
      data: { name: earlier },
    })

    const report = await seedReferenceData(db)

    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    expect(report).toEqual({ created: zero, updated: { ...zero, plans: 1 } })
    const renamed = await db.plan.findUniqueOrThrow({ where: { slug: 'pack' } })
    expect(renamed).toEqual({
      ...stored,
      name: 'Пакет из 100 кредитов',
      updatedAt: renamed.updatedAt,
    })
    expect(await seedReferenceData(db)).toEqual({ created: zero, updated: zero })
  })

  it('preserves disabled API/service rows, operator model settings and every historical price on repeated seeds', async () => {
    await seedReferenceData(db)
    const providerIds: string[] = []
    try {
      // Synthetic history only: these are test amounts, not subscription accounting rates.
      const prices = [
        {
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          inputPer1m: '123.456789',
          cacheReadPer1m: null,
          cacheWritePer1m: null,
          outputPer1m: '234.567891',
          vatRate: '0.2200',
          sourceUrl: 'https://example.invalid/old-test-rate',
        },
        {
          effectiveFrom: new Date('2026-02-01T00:00:00Z'),
          inputPer1m: '345.678912',
          cacheReadPer1m: '12.345678',
          cacheWritePer1m: '23.456789',
          outputPer1m: '456.789123',
          vatRate: '0.2200',
          sourceUrl: 'https://example.invalid/new-test-rate',
        },
      ]
      for (const kind of ['api', 'subscription'] as const) {
        const provider = await db.llmProvider.create({
          data: {
            slug: `seed-history-${randomUUID()}`,
            name: `Operator ${kind} catalogue`,
            kind,
            enabled: kind === 'subscription',
            models: {
              create: [
                {
                  slug: 'operator-model',
                  name: 'Operator model name',
                  providerModelId: 'operator-confirmed-model-id',
                  modelClass: 'heavy',
                  enabled: kind === 'subscription',
                  prices: { create: prices },
                },
                {
                  slug: 'archived-service-model',
                  name: 'Archived service model',
                  providerModelId: 'archived-provider-model-id',
                  modelClass: 'service',
                  enabled: false,
                  prices: { create: prices },
                },
              ],
            },
          },
        })
        providerIds.push(provider.id)
      }
      const before = await catalogue()
      const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
      for (let run = 0; run < 2; run += 1) {
        expect(await seedReferenceData(db)).toEqual({ created: zero, updated: zero })
        // Compare names, flags, ids, classes, amounts and timestamps, not just row counts.
        expect(await catalogue()).toEqual(before)
      }
    } finally {
      await db.llmModelPrice.deleteMany({ where: { model: { providerId: { in: providerIds } } } })
      await db.llmModel.deleteMany({ where: { providerId: { in: providerIds } } })
      await db.llmProvider.deleteMany({ where: { id: { in: providerIds } } })
    }
  })
})

describe.skipIf(!databaseUrl)('subscription catalogue seeds on PostgreSQL', () => {
  let db: PrismaClient
  const slugs: string[] = []
  beforeAll(() => {
    db = seedClient()
  })
  afterAll(async () => {
    await db.llmModelPrice.deleteMany({ where: { model: { provider: { slug: { in: slugs } } } } })
    await db.llmModel.deleteMany({ where: { provider: { slug: { in: slugs } } } })
    await db.llmProvider.deleteMany({ where: { slug: { in: slugs } } })
    await db.$disconnect()
  })

  const fixture = (): ReferenceData => {
    const suffix = randomUUID().slice(0, 8)
    const slug = (original: string) => `seed-b6-${original}-${suffix}`
    const providers = llmProviderSeeds.map((provider) => ({
      ...provider,
      slug: slug(provider.slug),
    }))
    slugs.push(...providers.map((provider) => provider.slug))
    return {
      plans: [],
      pricingRules: [],
      agentDrivers: [],
      llmProviders: providers,
      llmModels: llmModelSeeds.map((model) => ({
        ...model,
        providerSlug: slug(model.providerSlug),
      })),
    }
  }

  const snapshot = (data: ReferenceData) =>
    db.llmProvider.findMany({
      where: { slug: { in: data.llmProviders.map((provider) => provider.slug) } },
      orderBy: { slug: 'asc' },
      include: {
        models: {
          orderBy: { slug: 'asc' },
          include: { prices: { orderBy: { effectiveFrom: 'asc' } } },
        },
      },
    })
  const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))

  it('creates only disabled subscription defaults and no prices, then leaves them unchanged', async () => {
    const data = fixture()
    expect(await seedReferenceData(db, data)).toEqual({
      created: {
        ...zero,
        llm_providers: llmProviderSeeds.length,
        llm_models: llmModelSeeds.length,
      },
      updated: zero,
    })
    const stored = await snapshot(data)
    expect(stored).toHaveLength(llmProviderSeeds.length)
    for (const provider of stored) {
      expect(provider).toMatchObject(
        data.llmProviders.find((seed) => seed.slug === provider.slug) ?? {},
      )
      const expectedModels = data.llmModels.filter((model) => model.providerSlug === provider.slug)
      expect(provider.models).toHaveLength(expectedModels.length)
      for (const { providerSlug: _, ...model } of expectedModels) {
        expect(provider.models.find((row) => row.slug === model.slug)).toMatchObject({
          ...model,
          prices: [],
        })
      }
    }
    expect(await seedReferenceData(db, data)).toEqual({ created: zero, updated: zero })
    expect(await snapshot(data)).toEqual(stored)
  })

  it('preserves operator changes and historical prices even on matching seed keys', async () => {
    const data = fixture()
    await seedReferenceData(db, data)
    const original = await snapshot(data)
    for (const provider of original) {
      await db.llmProvider.update({
        where: { id: provider.id },
        data: { name: 'Operator backend name', enabled: true },
      })
      for (const [index, model] of provider.models.entries()) {
        await db.llmModel.update({
          where: { id: model.id },
          data: {
            name: 'Operator profile name',
            providerModelId: 'operator-confirmed-id',
            modelClass: index === 0 ? 'service' : 'heavy',
            reserveOutputTokens: 65_536,
            enabled: index !== 0,
            prices: {
              // Synthetic fixture rates, never part of the reference data.
              create: [
                {
                  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
                  inputPer1m: '123.456789',
                  cacheReadPer1m: null,
                  cacheWritePer1m: '0.000000',
                  outputPer1m: '234.567891',
                  vatRate: '0.2200',
                  sourceUrl: 'https://example.invalid/test-rate-old',
                },
                {
                  effectiveFrom: new Date('2026-02-01T00:00:00Z'),
                  inputPer1m: '345.678912',
                  cacheReadPer1m: '12.345678',
                  cacheWritePer1m: null,
                  outputPer1m: '456.789123',
                  vatRate: '0.2200',
                  sourceUrl: 'https://example.invalid/test-rate-new',
                },
              ],
            },
          },
        })
      }
    }
    const configured = await snapshot(data)
    for (let run = 0; run < 2; run += 1) {
      expect(await seedReferenceData(db, data)).toEqual({ created: zero, updated: zero })
      expect(await snapshot(data)).toEqual(configured)
    }
  })

  it('refuses an API provider slug collision without rewriting history or leaving partial rows', async () => {
    const data = fixture()
    const collision = data.llmProviders.at(-1)
    if (!collision) throw new Error('Missing provider fixture')
    await db.llmProvider.create({
      data: { ...collision, name: 'Historical API provider', kind: 'api' },
    })
    const before = await snapshot(data)

    await expect(seedReferenceData(db, data)).rejects.toThrow('is not a subscription')

    expect(await snapshot(data)).toEqual(before)
  })
})

describe.skipIf(!databaseUrl)('seedReferenceData plan terms on PostgreSQL', () => {
  let db: PrismaClient
  const slugs: string[] = []
  beforeAll(() => {
    db = seedClient()
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
      creditsPerMonth: 30,
      tasksPerDay: 5,
      packCredits: null,
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
    ['monthly quota', { creditsPerMonth: 40 }, /creditsPerMonth: stored 30, seed 40/],
    ['daily quota', { tasksPerDay: null }, /tasksPerDay: stored 5, seed null/],
    ['site limit', { maxSites: 3 }, /maxSites: stored 1, seed 3/],
    ['kind', { kind: 'pack', packCredits: 10 }, /kind: stored quota, seed pack/],
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
      expect([stored.name, stored.kind, stored.creditsPerMonth, stored.tasksPerDay]).toEqual([
        'Тест',
        'quota',
        30,
        5,
      ])
      expect(await db.plan.findUnique({ where: { slug: created.slug } })).toBeNull()
    },
  )
})
