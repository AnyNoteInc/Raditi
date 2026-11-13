// The new pricing of 06.11.2026 in the database (docs/plan/63-new-pricing.md, decisions Ц1–Ц6
// and Ц15): the migration billing_pricing_2026_11 gives «Старт», «Бизнес» and «Агентство» their
// new price and credits of a month — 1 990 ₽ and 150, 6 990 ₽ and 600, 19 990 ₽ and 2 000 —
// without a limit of a day, and the pack of 100 credits its new price, 1 490 ₽, where every term
// it changes still holds the value published before. It touches nothing else: a subscription
// keeps its plan by id, an order its amount, an account its credits. Runs the real migrations
// in disposable schemas over rows written as the code before it wrote them.
//
// `prisma migrate deploy` sends the file as one query; a client that splits a file sends its
// statements one by one. The suite sends it both ways.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'
import { planSeeds } from './seed/data.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the new pricing. */
const before = '20261031120000_task_turn_undone'
const migration = '20261106100000_billing_pricing_2026_11'
const at = new Date('2026-10-20T09:00:00Z')
const periodStart = new Date('2026-10-20T09:00:00Z')
const periodEnd = new Date('2026-11-20T09:00:00Z')
const CHECK_VIOLATION = '23514'
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

/**
 * The plans as the seed and the migrations before wrote them: the terms published from
 * 17.10.2026 to 06.11.2026. `tasks_per_day` is what a database seeded before the day keeps.
 */
const seededBefore = (): Values[] =>
  [
    ['start', 'Старт', 'quota', '4900.00', 300, 5, 50, null, 1, 10],
    ['business', 'Бизнес', 'quota', '12900.00', 800, 10, 100, null, 3, 20],
    ['agency', 'Агентство', 'quota', '39900.00', 2500, 30, 300, null, 15, 30],
    ['pack', 'Пакет из 100 кредитов', 'pack', '1990.00', null, null, null, 100, null, 40],
    ['payg', 'Оплата за действие', 'payg', '0.00', null, null, null, null, 1, 50],
  ].map(
    ([slug, name, kind, price, perMonth, tasksPerDay, perDay, packCredits, maxSites, order]) => ({
      id: randomUUID(),
      slug,
      name,
      kind,
      price,
      credits_per_month: perMonth,
      tasks_per_day: tasksPerDay,
      credits_per_day: perDay,
      pack_credits: packCredits,
      max_sites: maxSites,
      is_active: true,
      sort_order: order,
      created_at: at,
      updated_at: at,
    }),
  )

/** The new terms of each plan the migration changes, by slug. */
const newTerms: Record<string, Values> = {
  start: { price: '1990.00', credits_per_month: 150, credits_per_day: null },
  business: { price: '6990.00', credits_per_month: 600, credits_per_day: null },
  agency: { price: '19990.00', credits_per_month: 2000, credits_per_day: null },
  pack: { price: '1490.00' },
}

/** Rows of one schema: every helper writes with autocommit. */
function rowsOf(target: MigratedSchema) {
  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await target.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }
  const all = async (table: string) =>
    (await target.db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows as Values[]

  return {
    insert,

    /**
     * A workspace on «Старт» as the code before the migration left it: a live subscription, the
     * paid order of its period at the old price, the tariff account with the credits it granted
     * and the grant in the journal, and a pack bought at the old price.
     */
    async subscribed(plans: Values[]) {
      const planOf = (slug: string) => plans.find((plan) => plan.slug === slug)?.id
      const workspaceId = randomUUID()
      await insert('workspaces', { id: workspaceId, name: 'Synthetic workspace', updated_at: at })
      const subscriptionId = randomUUID()
      await insert('subscriptions', {
        id: subscriptionId,
        workspace_id: workspaceId,
        plan_id: planOf('start'),
        current_period_start: periodStart,
        current_period_end: periodEnd,
        period_anchor: periodStart,
        updated_at: at,
      })
      const order = async (kind: string, planSlug: string, amount: string, values: Values) => {
        const id = randomUUID()
        await insert('orders', {
          id,
          workspace_id: workspaceId,
          kind,
          plan_id: planOf(planSlug),
          amount,
          status: 'paid',
          yookassa_payment_id: `payment-synthetic-${id}`,
          idempotence_key: randomUUID(),
          paid_at: periodStart,
          updated_at: at,
          ...values,
        })
        return id
      }
      const tariffOrder = await order('subscription', 'start', '4900.00', {
        subscription_id: subscriptionId,
        period_start: periodStart,
        period_end: periodEnd,
      })
      const packOrder = await order('pack', 'pack', '1990.00', {})
      const account = async (unit: string, balance: string, orderId: string) => {
        const id = randomUUID()
        await insert('billing_accounts', {
          id,
          workspace_id: workspaceId,
          unit,
          balance,
          updated_at: at,
        })
        await insert('credit_ledger', {
          id: randomUUID(),
          account_id: id,
          unit,
          kind: 'grant',
          amount: balance,
          balance_after: balance,
          order_id: orderId,
          idempotency_key: `order:${orderId}:grant`,
        })
      }
      await account('credit_tariff', '300.00', tariffOrder)
      await account('credit_pack', '100.00', packOrder)
    },

    plans: () => all('plans'),
    /** Every row of the tables a customer's money and credits live in. */
    billing: async () => ({
      subscriptions: await all('subscriptions'),
      orders: await all('orders'),
      billing_accounts: await all('billing_accounts'),
      credit_ledger: await all('credit_ledger'),
    }),
  }
}

/** Rows in the order `ORDER BY id` returns them: a uuid compares as its lowercase text. */
const byId = (a: Values, b: Values) => (String(a.id) < String(b.id) ? -1 : 1)

/** A plan without the stamp of its last change, which a migration that touches it moves. */
const unstamped = ({ updated_at: _, ...plan }: Values) => plan

/** A schema with the migrations up to the one before, and the given plans in it. */
async function schemaWith(prefix: string, plans: Values[]): Promise<MigratedSchema> {
  const schema = await createMigratedSchema(databaseUrl ?? '', prefix)
  try {
    await schema.migrate(before)
    for (const plan of plans) await rowsOf(schema).insert('plans', plan)
  } catch (error) {
    await schema.drop()
    throw error
  }
  return schema
}

describe.skipIf(!databaseUrl)('the migration of the pricing of 06.11.2026', () => {
  describe('on a database seeded and used before it', () => {
    let schema: MigratedSchema
    let rows: ReturnType<typeof rowsOf>
    const plansBefore = seededBefore()
    let billingBefore: Awaited<ReturnType<ReturnType<typeof rowsOf>['billing']>>
    let plansAfter: Values[]
    let appliedAt: Date

    beforeAll(async () => {
      schema = await schemaWith('pricing_2026_11_seeded', plansBefore)
      rows = rowsOf(schema)
      await rows.subscribed(plansBefore)
      billingBefore = await rows.billing()
      appliedAt = new Date()
      await schema.migrate(migration)
      plansAfter = await rows.plans()
    }, 60_000)

    afterAll(async () => {
      await schema?.drop()
    })

    const planAfter = (id: unknown) => {
      const plan = plansAfter.find((candidate) => candidate.id === id)
      if (!plan) throw new Error('The plan is gone')
      return plan
    }
    const planBefore = (slug: string) => {
      const plan = plansBefore.find((candidate) => candidate.slug === slug)
      if (!plan) throw new Error(`No plan ${slug} was seeded`)
      return plan
    }
    const stampedByMigration = (plan: Values) =>
      (plan.updated_at as Date).getTime() >= appliedAt.getTime() - 60_000

    it.each([
      ['start', '1990.00', 150],
      ['business', '6990.00', 600],
      ['agency', '19990.00', 2000],
    ])(
      'gives the tariff «%s» the price %s and %i credits a month, without a day',
      (slug, price, credits) => {
        const was = planBefore(slug)
        const now = planAfter(was.id)
        expect(unstamped(now)).toEqual({
          ...unstamped(was),
          price,
          credits_per_month: credits,
          credits_per_day: null,
        })
        expect(stampedByMigration(now)).toBe(true)
      },
    )

    it('gives the pack of 100 credits the price 1490.00 and changes no other term', () => {
      const was = planBefore('pack')
      const now = planAfter(was.id)
      expect(unstamped(now)).toEqual({ ...unstamped(was), price: '1490.00' })
      expect(stampedByMigration(now)).toBe(true)
    })

    it('leaves pay-per-action as it was, to the stamp of its last change', () => {
      const was = planBefore('payg')
      expect(planAfter(was.id)).toEqual(was)
      expect(plansAfter).toHaveLength(plansBefore.length)
    })

    // A subscription renews on the terms its plan has at the renewal; what was paid and granted
    // stays as it was paid and granted.
    it('changes no subscription, order, account or journal entry', async () => {
      expect(billingBefore.orders.map((order) => order.amount).sort()).toEqual([
        '1990.00',
        '4900.00',
      ])
      expect(await rows.billing()).toEqual(billingBefore)
    })

    it('keeps the checks of the day of a plan, which hold with no day', async () => {
      const start = planBefore('start')
      await expect(
        schema.db.query('UPDATE plans SET credits_per_day = 151 WHERE id = $1', [start.id]),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'plans_day_within_month_check',
      })
      await expect(
        schema.db.query('UPDATE plans SET credits_per_day = 0 WHERE id = $1', [start.id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'plans_credits_per_day_check' })
    })

    // The rule of the seed: plan terms are what customers buy, and a term that differs from the
    // stored one fails the seed. The migration ran first, so the seed finds its own terms.
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
        // The same ids as before the migration: no plan was replaced by a new row.
        expect(plans.map((plan) => plan.id).sort()).toEqual(
          plansBefore.map((plan) => plan.id).sort(),
        )
      } finally {
        await db.$disconnect()
      }
    }, 60_000)
  })

  it('creates no plan in a new database: the seed writes the new terms there', async () => {
    const schema = await schemaWith('pricing_2026_11_empty', [])
    try {
      await schema.migrate(migration)
      expect(await rowsOf(schema).plans()).toEqual([])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  // A plan changed by hand is not the published one, whichever of the terms was changed.
  it.each<[string, string, Values]>([
    ['the price of a tariff', 'start', { price: '4500.00' }],
    ['the credits of the month of a tariff', 'business', { credits_per_month: 900 }],
    ['the credits of the day of a tariff', 'agency', { credits_per_day: 250 }],
    ['a tariff without its day', 'start', { credits_per_day: null }],
    ['the price of the pack', 'pack', { price: '1890.00' }],
    ['the credits of the pack', 'pack', { pack_credits: 120 }],
  ])(
    'leaves a plan alone when %s was changed by hand',
    async (_case, slug, change) => {
      const plans = seededBefore().map((plan) =>
        plan.slug === slug ? { ...plan, ...change } : plan,
      )
      const schema = await schemaWith('pricing_2026_11_by_hand', plans)
      try {
        await schema.migrate(migration)
        const after = await rowsOf(schema).plans()
        const expected = plans
          .map((plan) => ({
            ...unstamped(plan),
            ...(plan.slug === slug ? {} : newTerms[String(plan.slug)]),
          }))
          .sort(byId)
        expect(after.map(unstamped)).toEqual(expected)
        const changed = after.find((plan) => plan.slug === slug)
        expect(changed?.updated_at).toEqual(at)
      } finally {
        await schema.drop()
      }
    },
    60_000,
  )

  it('changes only the plans of the published slugs and kinds', async () => {
    const [start, business, agency, pack, payg] = seededBefore() as [
      Values,
      Values,
      Values,
      Values,
      Values,
    ]
    const plans = [
      start,
      business,
      // Seeded after the day, without the unused tasks of a day: still the published terms.
      { ...agency, tasks_per_day: null },
      pack,
      payg,
      // The same terms under another slug are another plan.
      { ...business, id: randomUUID(), slug: 'business-2025', sort_order: 60 },
      { ...pack, id: randomUUID(), slug: 'pack-archive', sort_order: 70 },
    ]
    const schema = await schemaWith('pricing_2026_11_slugs', plans)
    try {
      await schema.migrate(migration)
      const after = await rowsOf(schema).plans()
      const published = new Set([start.id, business.id, agency.id, pack.id])
      expect(after.map(unstamped)).toEqual(
        plans
          .map((plan) => ({
            ...unstamped(plan),
            ...(published.has(plan.id) ? newTerms[String(plan.slug)] : {}),
          }))
          .sort(byId),
      )
      // Only the plans it changed are stamped.
      expect(
        after
          .filter((plan) => (plan.updated_at as Date).getTime() !== at.getTime())
          .map((plan) => plan.id)
          .sort(),
      ).toEqual([...published].map(String).sort())
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('runs as one query and as statements one by one alike, with no stop before its changes', async () => {
    const statements = statementsOf(await migrationSql())
    expect(statements.map(verbOf)).toEqual([
      'BEGIN;',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'COMMIT;',
    ])
    for (const [prefix, send] of [
      [
        'pricing_2026_11_one_query',
        async (target: MigratedSchema) => {
          await target.db.query(await migrationSql())
        },
      ],
      [
        'pricing_2026_11_statements',
        async (target: MigratedSchema) => {
          for (const statement of statements) await target.db.query(statement)
        },
      ],
    ] as const) {
      const plans = seededBefore()
      const schema = await schemaWith(prefix, plans)
      try {
        await send(schema)
        const after = await rowsOf(schema).plans()
        expect(
          Object.fromEntries(
            after.map((plan) => [
              plan.slug,
              [plan.price, plan.credits_per_month, plan.credits_per_day, plan.pack_credits],
            ]),
          ),
        ).toEqual({
          start: ['1990.00', 150, null, null],
          business: ['6990.00', 600, null, null],
          agency: ['19990.00', 2000, null, null],
          pack: ['1490.00', null, null, 100],
          payg: ['0.00', null, null, null],
        })
      } finally {
        await schema.drop()
      }
    }
  }, 120_000)

  // The changes are one transaction, however the file is sent: a failure at the last statement
  // takes back the terms of the tariffs it already changed.
  it('takes every change back when one of them fails, sent statement by statement', async () => {
    const schema = await schemaWith('pricing_2026_11_atomic', seededBefore())
    try {
      const rows = rowsOf(schema)
      const plans = await rows.plans()
      // A check that the new price of the pack breaks stands in the way of the last statement.
      await schema.db.query(
        `ALTER TABLE plans ADD CONSTRAINT plans_test_pack_price_check
           CHECK (slug <> 'pack' OR price <> 1490.00)`,
      )
      const run = async () => {
        for (const statement of statementsOf(await migrationSql())) await schema.db.query(statement)
      }
      await expect(run()).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'plans_test_pack_price_check',
      })
      // What the end of the connection does to a transaction that is still open.
      await schema.db.query('ROLLBACK')
      expect(await rows.plans()).toEqual(plans)
    } finally {
      await schema.drop()
    }
  }, 60_000)
})
