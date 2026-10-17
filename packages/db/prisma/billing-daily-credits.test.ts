// The daily limit in credits in the database (decision of 17.10.2026; docs/plan/37-billing-plan.md,
// «Дневной лимит в кредитах»; spec §16): the migration billing_daily_credits gives the three
// tariffs their credits of a day — 50, 100 and 300 — where every published term they come from
// still holds, adds what a reserve row paid (`credit_holds.charged`) with its check and the index
// that finds the charges of a day, and stops — changing nothing — where a reserve of credits was
// already charged, since what each of its rows paid is recorded nowhere. Runs the real migrations
// in disposable schemas over rows written as the code before it wrote them.
//
// `prisma migrate deploy` sends the file as one query; a client that splits a file sends its
// statements one by one. The suite sends it both ways.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the credits of a day. */
const before = '20261011120000_credit_hold_accounts'
const migration = '20261017100000_billing_daily_credits'
const at = new Date('2026-10-11T09:00:00Z')
const end = new Date('2026-11-11T09:00:00Z')
/** RAISE EXCEPTION of a DO block. */
const RAISE_EXCEPTION = 'P0001'
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

/** The first word of a statement after its comments. */
const verbOf = (statement: string) => statement.replace(/^(--.*\n)+/, '').split(/\s/)[0]

/** The plans as the seed wrote them before the credits of a day. */
const seededBefore = (): Values[] =>
  [
    ['start', 'Старт', 'quota', '4900.00', 300, 5, null, 1, 10],
    ['business', 'Бизнес', 'quota', '12900.00', 800, 10, null, 3, 20],
    ['agency', 'Агентство', 'quota', '39900.00', 2500, 30, null, 15, 30],
    ['pack', 'Пакет из 100 кредитов', 'pack', '1990.00', null, null, 100, null, 40],
    ['payg', 'Оплата за действие', 'payg', '0.00', null, null, null, 1, 50],
  ].map(([slug, name, kind, price, perMonth, perDay, packCredits, maxSites, sortOrder]) => ({
    id: randomUUID(),
    slug,
    name,
    kind,
    price,
    credits_per_month: perMonth,
    tasks_per_day: perDay,
    pack_credits: packCredits,
    max_sites: maxSites,
    is_active: true,
    sort_order: sortOrder,
    created_at: at,
    updated_at: at,
  }))

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

  return {
    insert,

    /** A workspace with an account of each unit and a task on a site of its own. */
    async funded() {
      const workspaceId = randomUUID()
      await insert('workspaces', { id: workspaceId, name: 'Synthetic workspace', updated_at: at })
      const account = async (unit: string) => {
        const id = randomUUID()
        await insert('billing_accounts', {
          id,
          workspace_id: workspaceId,
          unit,
          balance: '300.00',
          updated_at: at,
        })
        return id
      }
      const accounts = {
        credit_tariff: await account('credit_tariff'),
        credit_gift: await account('credit_gift'),
        credit_pack: await account('credit_pack'),
        rub: await account('rub'),
      }
      const siteId = randomUUID()
      await insert('sites', {
        id: siteId,
        workspace_id: workspaceId,
        name: 'Synthetic site',
        url: `https://${siteId}.invalid`,
        stack: 'wordpress',
        updated_at: at,
      })
      const task = async () => {
        const id = randomUUID()
        await insert('tasks', { id, workspace_id: workspaceId, site_id: siteId, updated_at: at })
        return id
      }
      return { accounts, task }
    },

    async hold(accountId: string, unit: string, taskId: string, values: Values = {}) {
      const id = randomUUID()
      await insert('credit_holds', {
        id,
        account_id: accountId,
        unit,
        task_id: taskId,
        amount: '45.00',
        expires_at: end,
        ...values,
      })
      return id
    },

    plans: async () =>
      (await target.db.query('SELECT * FROM plans ORDER BY sort_order, id')).rows as Values[],
    holds: async () =>
      (await target.db.query('SELECT * FROM credit_holds ORDER BY id')).rows as Values[],
    columns: async (table: string) =>
      (
        await target.db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
          [target.name, table],
        )
      ).rows.map((row: Values) => row.column_name as string),
  }
}

/** The indexes of a table of a schema as the catalogue prints them, by name. */
const indexesOf = async (target: MigratedSchema, table: string) =>
  Object.fromEntries(
    (
      await target.db.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
        [target.name, table],
      )
    ).rows.map((row: Values) => [
      row.indexname,
      String(row.indexdef).replaceAll(`${target.name}.`, ''),
    ]),
  ) as Record<string, string>

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

describe.skipIf(!databaseUrl)('the migration of the credits of a day', () => {
  describe('on a database seeded and used before it', () => {
    let schema: MigratedSchema
    let rows: ReturnType<typeof rowsOf>
    const plansBefore = seededBefore()
    let holdsBefore: Values[]
    let plansAfter: Values[]
    let appliedAt: Date

    beforeAll(async () => {
      schema = await schemaWith('daily_credits_seeded', plansBefore)
      rows = rowsOf(schema)
      // Reserves the code before it could leave: an active one on each account of credits, a
      // released and an expired one, and a charged hold of the rouble wallet.
      const { accounts, task } = await rows.funded()
      const taskId = await task()
      for (const unit of ['credit_tariff', 'credit_gift', 'credit_pack'] as const)
        await rows.hold(accounts[unit], unit, taskId)
      await rows.hold(accounts.credit_tariff, 'credit_tariff', await task(), {
        status: 'released',
        settled_at: at,
      })
      await rows.hold(accounts.credit_pack, 'credit_pack', await task(), {
        status: 'expired',
        settled_at: end,
      })
      await rows.hold(accounts.rub, 'rub', await task(), {
        amount: '600.00',
        status: 'captured',
        settled_at: at,
      })
      holdsBefore = await rows.holds()
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
    const stampedByMigration = (plan: Values) =>
      (plan.updated_at as Date).getTime() >= appliedAt.getTime() - 60_000

    it.each([
      ['start', 50],
      ['business', 100],
      ['agency', 300],
    ])('gives the tariff «%s» %i credits a day and changes no other term', (slug, credits) => {
      const was = plansBefore.find((plan) => plan.slug === slug) ?? {}
      const now = planAfter(was.id)
      expect(unstamped(now)).toEqual({ ...unstamped(was), credits_per_day: credits })
      expect(stampedByMigration(now)).toBe(true)
    })

    it('gives the pack and pay-per-action no day, and leaves them to the stamp', () => {
      for (const slug of ['pack', 'payg']) {
        const was = plansBefore.find((plan) => plan.slug === slug) ?? {}
        expect(planAfter(was.id)).toEqual({ ...was, credits_per_day: null })
      }
      expect(plansAfter).toHaveLength(plansBefore.length)
    })

    it('gives every reserve written before it no charge, and changes nothing else', async () => {
      expect(holdsBefore).toHaveLength(6)
      expect(await rows.holds()).toEqual(holdsBefore.map((row) => ({ ...row, charged: null })))
    })

    it('adds the index that finds the charges of a day', async () => {
      const indexes = await indexesOf(schema, 'credit_holds')
      expect(indexes.credit_holds_account_id_settled_at_idx).toBe(
        'CREATE INDEX credit_holds_account_id_settled_at_idx ON credit_holds USING btree (account_id, settled_at)',
      )
    })

    it('checks the day of a plan and what a row of credits paid', async () => {
      const [start] = plansBefore
      const refused = (sql: string, params: unknown[], constraint: string) =>
        expect(schema.db.query(sql, params)).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint,
        })
      await refused(
        'UPDATE plans SET credits_per_day = 301 WHERE id = $1',
        [start?.id],
        'plans_day_within_month_check',
      )
      await refused(
        'UPDATE plans SET credits_per_day = 0 WHERE id = $1',
        [start?.id],
        'plans_credits_per_day_check',
      )
      const { accounts, task } = await rows.funded()
      // Captured without what it paid, and an active row with a charge.
      await refused(
        `INSERT INTO credit_holds (id, account_id, unit, task_id, amount, status, expires_at)
         VALUES ($1, $2, 'credit_tariff', $3, 45, 'captured', $4)`,
        [randomUUID(), accounts.credit_tariff, await task(), end],
        'credit_holds_charged_check',
      )
      await refused(
        `INSERT INTO credit_holds (id, account_id, unit, task_id, amount, charged, expires_at)
         VALUES ($1, $2, 'credit_gift', $3, 45, 0, $4)`,
        [randomUUID(), accounts.credit_gift, await task(), end],
        'credit_holds_charged_check',
      )
      await rows.hold(accounts.credit_pack, 'credit_pack', await task(), {
        status: 'captured',
        settled_at: at,
        charged: '17.00',
      })
    })

    // The rule of the seed: plan terms are what customers buy, and a term that differs from the
    // stored one fails the seed. The migration ran first, so the seed finds its own numbers.
    it('lets the seed run after it without a plan created, changed or refused', async () => {
      await schema.migrate()
      const db = schemaClient(databaseUrl ?? '', schema)
      try {
        const report = await seedReferenceData(db)
        expect([report.created.plans, report.updated.plans]).toEqual([0, 0])
        const plans = await db.plan.findMany({ orderBy: { sortOrder: 'asc' } })
        expect(plans.map((plan) => [plan.slug, plan.creditsPerDay])).toEqual([
          ['start', 50],
          ['business', 100],
          ['agency', 300],
          ['pack', null],
          ['payg', null],
        ])
      } finally {
        await db.$disconnect()
      }
    }, 60_000)
  })

  it('creates no plan in a new database: the seed writes the day there', async () => {
    const schema = await schemaWith('daily_credits_empty', [])
    try {
      await schema.migrate(migration)
      expect(await rowsOf(schema).plans()).toEqual([])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('gives a day only where every published term it comes from still holds', async () => {
    const [start, business, agency, pack, payg] = seededBefore() as [
      Values,
      Values,
      Values,
      Values,
      Values,
    ]
    const plans = [
      // The month changed by hand, to less than the day would be: no day, and no failed check.
      { ...start, credits_per_month: 40 },
      // The tasks of a day changed by hand.
      { ...business, tasks_per_day: 12 },
      agency,
      pack,
      payg,
      // The same terms under another slug are another plan.
      { ...agency, id: randomUUID(), slug: 'agency-2025', sort_order: 60 },
      // A plan is told by its kind as well as by its slug.
      {
        ...start,
        id: randomUUID(),
        slug: 'start-pack',
        sort_order: 70,
        kind: 'pack',
        pack_credits: 10,
      },
    ]
    const schema = await schemaWith('daily_credits_mixed', plans)
    try {
      await schema.migrate(migration)
      const after = await rowsOf(schema).plans()
      expect(after.map(unstamped)).toEqual(
        plans.map((plan) => ({
          ...unstamped(plan),
          credits_per_day: plan.id === agency.id ? 300 : null,
        })),
      )
      // Only the plan it changed is stamped.
      expect(
        after
          .filter((plan) => (plan.updated_at as Date).getTime() !== at.getTime())
          .map((plan) => plan.id),
      ).toEqual([agency.id])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  /** A database seeded before the migration, with one reserve of `unit` that a charge captured. */
  async function withCharge(prefix: string, unit: 'credit_tariff' | 'credit_gift' | 'credit_pack') {
    const plans = seededBefore()
    const schema = await schemaWith(prefix, plans)
    try {
      const rows = rowsOf(schema)
      const { accounts, task } = await rows.funded()
      await rows.hold(accounts[unit], unit, await task(), { status: 'captured', settled_at: at })
      // A second, active one: only the charged rows are counted.
      await rows.hold(accounts.credit_tariff, 'credit_tariff', await task())
    } catch (error) {
      await schema.drop()
      throw error
    }
    return { schema, rows: rowsOf(schema) }
  }

  const stopMessage =
    'credit_holds holds charged reserves of credits (1 rows): what each row paid is not recorded. Only test runs write them: delete those test tasks with their billing rows, or recreate this database'

  // What `prisma migrate deploy` does with the file. The stop stands before the file's BEGIN:
  // raised inside its transaction, the exception would leave the session in an aborted
  // transaction block, and whoever applied the migration would get «current transaction is
  // aborted» in place of the reason.
  it.each(['credit_tariff', 'credit_gift', 'credit_pack'] as const)(
    'stops on a charged reserve of %s with its reason and leaves nothing open, sent as one query',
    async (unit) => {
      const { schema, rows } = await withCharge(`daily_credits_stop_${unit}`, unit)
      try {
        const plans = await rows.plans()
        const holds = await rows.holds()
        const indexes = await indexesOf(schema, 'credit_holds')
        await expect(schema.db.query(await migrationSql())).rejects.toMatchObject({
          code: RAISE_EXCEPTION,
          message: stopMessage,
        })
        // No ROLLBACK is sent: the next statement of the session runs at once.
        expect(await rows.plans()).toEqual(plans)
        expect(await rows.holds()).toEqual(holds)
        expect(await indexesOf(schema, 'credit_holds')).toEqual(indexes)
        expect(await rows.columns('plans')).not.toContain('credits_per_day')
        expect(await rows.columns('credit_holds')).not.toContain('charged')
      } finally {
        await schema.drop()
      }
    },
    60_000,
  )

  it('goes through once the charged rows are gone', async () => {
    const { schema, rows } = await withCharge('daily_credits_cleaned', 'credit_tariff')
    try {
      await expect(schema.db.query(await migrationSql())).rejects.toMatchObject({
        code: RAISE_EXCEPTION,
      })
      await schema.db.query(`DELETE FROM credit_holds WHERE status = 'captured'`)
      await schema.migrate(migration)
      expect((await rows.plans()).map((plan) => plan.credits_per_day)).toEqual([
        50,
        100,
        300,
        null,
        null,
      ])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('changes nothing when it stops, sent statement by statement', async () => {
    const { schema, rows } = await withCharge('daily_credits_statements', 'credit_pack')
    try {
      const plans = await rows.plans()
      const statements = statementsOf(await migrationSql())
      // The stop comes first, before the transaction of the changes is opened.
      expect(statements.map(verbOf)).toEqual([
        'DO',
        'BEGIN;',
        'ALTER',
        'UPDATE',
        'UPDATE',
        'UPDATE',
        'ALTER',
        'ALTER',
        'ALTER',
        'CREATE',
        'COMMIT;',
      ])
      const sent: string[] = []
      const run = async () => {
        for (const statement of statements) {
          sent.push(statement)
          await schema.db.query(statement)
        }
      }
      await expect(run()).rejects.toMatchObject({ code: RAISE_EXCEPTION, message: stopMessage })
      expect(sent).toHaveLength(1)
      expect(await rows.plans()).toEqual(plans)
      expect(await rows.columns('credit_holds')).not.toContain('charged')
    } finally {
      await schema.drop()
    }
  }, 60_000)

  // The changes themselves are one transaction, however the file is sent: a failure at the last
  // statement takes back the day of the plans and both columns.
  it('takes every change back when one of them fails, sent statement by statement', async () => {
    const schema = await schemaWith('daily_credits_atomic', seededBefore())
    try {
      const rows = rowsOf(schema)
      const plans = await rows.plans()
      // An index of that name stands in the way of the last statement.
      await schema.db.query(
        `CREATE INDEX credit_holds_account_id_settled_at_idx ON credit_holds (settled_at)`,
      )
      const run = async () => {
        for (const statement of statementsOf(await migrationSql())) await schema.db.query(statement)
      }
      await expect(run()).rejects.toMatchObject({ code: '42P07' })
      // What the end of the connection does to a transaction that is still open.
      await schema.db.query('ROLLBACK')
      expect(await rows.plans()).toEqual(plans)
      expect(await rows.columns('plans')).not.toContain('credits_per_day')
      expect(await rows.columns('credit_holds')).not.toContain('charged')
    } finally {
      await schema.drop()
    }
  }, 60_000)
})
