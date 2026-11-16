// More sites of pages on a tariff (the owner's request of 16.11.2026): the migration
// plans_page_sites_more gives «Старт» 20 sites instead of 2, «Бизнес» 100 instead of 10 and
// «Агентство» 200 instead of 20, where the plan still holds the number of plans_page_sites. It
// touches nothing else. Runs the real migrations in disposable schemas.
import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'
import { planSeeds } from './seed/data.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before these terms. */
const before = '20261117160000_project_ci'
const migration = '20261117170000_plans_page_sites_more'
const at = new Date('2026-11-15T09:00:00Z')
type Values = Record<string, unknown>

/** The plans as the seed wrote them before: the terms of 13.11.2026 with 2, 10 and 20 sites. */
const seededBefore = (): Values[] =>
  [
    ['start', 'Старт', 'quota', '1990.00', 200, 73, null, 2, false, 10],
    ['business', 'Бизнес', 'quota', '9990.00', 1000, 350, null, 10, true, 20],
    ['agency', 'Агентство', 'quota', '19990.00', 2000, 700, null, 20, true, 30],
    ['pack', 'Пакет из 100 кредитов', 'pack', '1490.00', null, null, 100, null, false, 40],
    ['payg', 'Оплата за действие', 'payg', '0.00', null, null, null, null, false, 50],
  ].map(([slug, name, kind, price, perMonth, perWeek, packCredits, sites, names, order]) => ({
    id: randomUUID(),
    slug,
    name,
    kind,
    price,
    credits_per_month: perMonth,
    tasks_per_day: null,
    credits_per_day: null,
    credits_per_5h: null,
    credits_per_week: perWeek,
    pack_credits: packCredits,
    page_sites: sites,
    page_custom_names: names,
    is_active: true,
    sort_order: order,
    created_at: at,
    updated_at: at,
  }))

const newSites: Record<string, number> = { start: 20, business: 100, agency: 200 }

async function insert(target: MigratedSchema, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "plans" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}
const plansOf = async (target: MigratedSchema) =>
  (await target.db.query(`SELECT * FROM "plans" ORDER BY id`)).rows as Values[]
const unstamped = ({ updated_at: _, ...plan }: Values) => plan
const expectedAfter = (plans: Values[], changed: Set<unknown>) =>
  plans
    .map((plan): Values => ({
      ...unstamped(plan),
      ...(changed.has(plan.id) ? { page_sites: newSites[String(plan.slug)] } : {}),
    }))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))

async function migrated(prefix: string, plans: Values[]): Promise<MigratedSchema> {
  const schema = await createMigratedSchema(databaseUrl ?? '', prefix)
  try {
    await schema.migrate(before)
    for (const plan of plans) await insert(schema, plan)
    await schema.migrate(migration)
  } catch (error) {
    await schema.drop()
    throw error
  }
  return schema
}

describe.skipIf(!databaseUrl)('the migration of the sites of pages of 16.11.2026', () => {
  it('gives the three tariffs 20, 100 and 200 sites and lets the seed run after it', async () => {
    const plans = seededBefore()
    const schema = await migrated('page_sites_more_seeded', plans)
    try {
      const changed = new Set(
        plans.filter((plan) => String(plan.slug) in newSites).map((plan) => plan.id),
      )
      const after = await plansOf(schema)
      expect(after.map(unstamped)).toEqual(expectedAfter(plans, changed))
      expect(
        after
          .filter((plan) => (plan.updated_at as Date).getTime() !== at.getTime())
          .map((plan) => plan.id)
          .sort(),
      ).toEqual([...changed].map(String).sort())

      await schema.migrate()
      const db = schemaClient(databaseUrl ?? '', schema)
      try {
        const report = await seedReferenceData(db)
        expect([report.created.plans, report.updated.plans]).toEqual([0, 0])
        const stored = await db.plan.findMany({ orderBy: { sortOrder: 'asc' } })
        expect(stored.map((plan) => [plan.slug, plan.pageSites])).toEqual(
          planSeeds.map((plan) => [plan.slug, plan.pageSites]),
        )
      } finally {
        await db.$disconnect()
      }
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('creates no plan in a new database: the seed writes the new numbers there', async () => {
    const schema = await migrated('page_sites_more_empty', [])
    try {
      expect(await plansOf(schema)).toEqual([])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('leaves a plan alone when its sites were changed by hand', async () => {
    const plans = seededBefore().map((plan) =>
      plan.slug === 'business' ? { ...plan, page_sites: 12 } : plan,
    )
    const schema = await migrated('page_sites_more_by_hand', plans)
    try {
      const changed = new Set(
        plans
          .filter((plan) => String(plan.slug) in newSites && plan.slug !== 'business')
          .map((plan) => plan.id),
      )
      expect((await plansOf(schema)).map(unstamped)).toEqual(expectedAfter(plans, changed))
    } finally {
      await schema.drop()
    }
  }, 60_000)
})
