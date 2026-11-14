// The tariffs of 13.11.2026 in the database (docs/plan/72-pricing-api-margin.md, ЦА1–ЦА5): the
// migration billing_pricing_api_margin gives «Старт» 200 credits a month and a week of 73, and
// «Бизнес» 9 990 ₽, 1 000 credits and a week of 350, where every term it changes
// still holds the value of 06.11.2026. It touches nothing else: «Агентство», the pack, a
// subscription, an order, an account. Runs the real migrations in disposable schemas.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'
import { planSeeds } from './seed/data.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before these terms. */
const before = '20261113150000_weekly_limits_only'
const migration = '20261113160000_billing_pricing_api_margin'
const at = new Date('2026-11-10T09:00:00Z')
type Values = Record<string, unknown>

const migrationSql = () =>
  readFile(new URL(`./migrations/${migration}/migration.sql`, import.meta.url), 'utf8')

/**
 * The statements of a migration file one by one; the body of a DO block, which has semicolons
 * of its own, stays one statement.
 */
function statementsOf(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inBody = false
  for (const line of sql.split('\n')) {
    current += `${line}\n`
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody
    if (inBody || !/;[ \t]*$/.test(line)) continue
    statements.push(current.trim())
    current = ''
  }
  return statements
}

/** The first word of a statement after its comments and the blank lines between them. */
const verbOf = (statement: string) => statement.replace(/^(?:--.*\n|\n)+/, '').split(/\s/)[0]

/** The plans as the seed wrote them after weekly_limits_only: the terms of 06.11.2026, weeks only. */
const seededBefore = (): Values[] =>
  [
    ['start', 'Старт', 'quota', '1990.00', 150, null, 55, null, 1, 10],
    ['business', 'Бизнес', 'quota', '6990.00', 600, null, 210, null, 3, 20],
    ['agency', 'Агентство', 'quota', '19990.00', 2000, null, 700, null, 15, 30],
    ['pack', 'Пакет из 100 кредитов', 'pack', '1490.00', null, null, null, 100, null, 40],
    ['payg', 'Оплата за действие', 'payg', '0.00', null, null, null, null, 1, 50],
  ].map(([slug, name, kind, price, perMonth, per5h, perWeek, packCredits, maxSites, order]) => ({
    id: randomUUID(),
    slug,
    name,
    kind,
    price,
    credits_per_month: perMonth,
    tasks_per_day: null,
    credits_per_day: null,
    credits_per_5h: per5h,
    credits_per_week: perWeek,
    pack_credits: packCredits,
    max_sites: maxSites,
    is_active: true,
    sort_order: order,
    created_at: at,
    updated_at: at,
  }))

/** The new terms of each plan the migration changes, by slug. */
const newTerms: Record<string, Values> = {
  start: { credits_per_month: 200, credits_per_week: 73 },
  business: {
    price: '9990.00',
    credits_per_month: 1000,
    credits_per_week: 350,
  },
}

async function insert(target: MigratedSchema, table: string, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}
const all = async (target: MigratedSchema, table: string) =>
  (await target.db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows as Values[]
const unstamped = ({ updated_at: _, ...plan }: Values) => plan
const byId = (a: Values, b: Values) => (String(a.id) < String(b.id) ? -1 : 1)
const expectedAfter = (plans: Values[], changed: Set<unknown>) =>
  plans
    .map((plan) => ({
      ...unstamped(plan),
      ...(changed.has(plan.id) ? newTerms[String(plan.slug)] : {}),
    }))
    .sort(byId)

async function schemaWith(prefix: string, plans: Values[]): Promise<MigratedSchema> {
  const schema = await createMigratedSchema(databaseUrl ?? '', prefix)
  try {
    await schema.migrate(before)
    for (const plan of plans) await insert(schema, 'plans', plan)
  } catch (error) {
    await schema.drop()
    throw error
  }
  return schema
}

describe.skipIf(!databaseUrl)('the migration of the tariffs of 13.11.2026', () => {
  describe('on a database seeded and used before it', () => {
    let schema: MigratedSchema
    const plansBefore = seededBefore()
    let subscriptionsBefore: Values[]
    let ordersBefore: Values[]

    beforeAll(async () => {
      schema = await schemaWith('pricing_api_margin_seeded', plansBefore)
      const business = plansBefore.find((plan) => plan.slug === 'business')?.id
      const workspaceId = randomUUID()
      await insert(schema, 'workspaces', {
        id: workspaceId,
        name: 'Synthetic workspace',
        updated_at: at,
      })
      const subscriptionId = randomUUID()
      await insert(schema, 'subscriptions', {
        id: subscriptionId,
        workspace_id: workspaceId,
        plan_id: business,
        current_period_start: at,
        current_period_end: new Date('2026-12-10T09:00:00Z'),
        period_anchor: at,
        updated_at: at,
      })
      const orderId = randomUUID()
      await insert(schema, 'orders', {
        id: orderId,
        workspace_id: workspaceId,
        kind: 'subscription',
        plan_id: business,
        amount: '6990.00',
        status: 'paid',
        yookassa_payment_id: `payment-synthetic-${orderId}`,
        idempotence_key: randomUUID(),
        paid_at: at,
        updated_at: at,
        subscription_id: subscriptionId,
        period_start: at,
        period_end: new Date('2026-12-10T09:00:00Z'),
      })
      subscriptionsBefore = await all(schema, 'subscriptions')
      ordersBefore = await all(schema, 'orders')
      await schema.migrate(migration)
    }, 60_000)

    afterAll(async () => {
      await schema?.drop()
    })

    it('gives «Старт» and «Бизнес» their new terms and leaves the other plans alone', async () => {
      const changed = new Set(
        plansBefore.filter((plan) => String(plan.slug) in newTerms).map((plan) => plan.id),
      )
      const after = await all(schema, 'plans')
      expect(after.map(unstamped)).toEqual(expectedAfter(plansBefore, changed))
      expect(
        after
          .filter((plan) => (plan.updated_at as Date).getTime() !== at.getTime())
          .map((plan) => plan.id)
          .sort(),
      ).toEqual([...changed].map(String).sort())
    })

    // A subscription renews on the terms its plan has at the renewal; what was paid stays.
    it('changes no subscription and no order', async () => {
      expect(await all(schema, 'subscriptions')).toEqual(subscriptionsBefore)
      expect(await all(schema, 'orders')).toEqual(ordersBefore)
    })

    it('lets the seed run after it without a plan created, changed or refused', async () => {
      await schema.migrate()
      const db = schemaClient(databaseUrl ?? '', schema)
      try {
        const report = await seedReferenceData(db)
        expect([report.created.plans, report.updated.plans]).toEqual([0, 0])
        const plans = await db.plan.findMany({ orderBy: { sortOrder: 'asc' } })
        expect(
          plans.map((plan) => ({
            slug: plan.slug,
            name: plan.name,
            kind: plan.kind,
            price: plan.price.toFixed(2),
            creditsPerMonth: plan.creditsPerMonth,
            creditsPerDay: plan.creditsPerDay,
            creditsPer5h: plan.creditsPer5h,
            creditsPerWeek: plan.creditsPerWeek,
            packCredits: plan.packCredits,
            maxSites: plan.maxSites,
            sortOrder: plan.sortOrder,
          })),
        ).toEqual(planSeeds.map((plan) => ({ ...plan })))
      } finally {
        await db.$disconnect()
      }
    }, 60_000)
  })

  it('creates no plan in a new database: the seed writes the new terms there', async () => {
    const schema = await schemaWith('pricing_api_margin_empty', [])
    try {
      await schema.migrate(migration)
      expect(await all(schema, 'plans')).toEqual([])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it.each<[string, string, Values]>([
    ['the price of «Старт»', 'start', { price: '1890.00' }],
    ['the credits of «Старт»', 'start', { credits_per_month: 160 }],
    ['the window of a week of «Старт»', 'start', { credits_per_week: 60 }],
    ['the price of «Бизнес»', 'business', { price: '7490.00' }],
    ['a window of 5 hours of «Бизнес»', 'business', { credits_per_5h: 80 }],
  ])(
    'leaves a plan alone when %s was changed by hand',
    async (_case, slug, change) => {
      const plans = seededBefore().map((plan) =>
        plan.slug === slug ? { ...plan, ...change } : plan,
      )
      const schema = await schemaWith('pricing_api_margin_by_hand', plans)
      try {
        await schema.migrate(migration)
        const changed = new Set(
          plans
            .filter((plan) => String(plan.slug) in newTerms && plan.slug !== slug)
            .map((plan) => plan.id),
        )
        expect((await all(schema, 'plans')).map(unstamped)).toEqual(expectedAfter(plans, changed))
      } finally {
        await schema.drop()
      }
    },
    60_000,
  )

  it('runs as one query and as statements one by one alike', async () => {
    const statements = statementsOf(await migrationSql())
    expect(statements.map(verbOf)).toEqual(['BEGIN;', 'UPDATE', 'UPDATE', 'COMMIT;'])
    for (const [prefix, send] of [
      [
        'pricing_api_margin_one_query',
        async (target: MigratedSchema) => {
          await target.db.query(await migrationSql())
        },
      ],
      [
        'pricing_api_margin_statements',
        async (target: MigratedSchema) => {
          for (const statement of statements) await target.db.query(statement)
        },
      ],
    ] as const) {
      const plans = seededBefore()
      const schema = await schemaWith(prefix, plans)
      try {
        await send(schema)
        const changed = new Set(
          plans.filter((plan) => String(plan.slug) in newTerms).map((plan) => plan.id),
        )
        expect((await all(schema, 'plans')).map(unstamped)).toEqual(expectedAfter(plans, changed))
      } finally {
        await schema.drop()
      }
    }
  }, 120_000)
})
