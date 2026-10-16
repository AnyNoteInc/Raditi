// The numbers of the credits model in a database that was seeded before them
// (docs/plan/37-billing-plan.md, «Числа» and «Что меняется в базе»; spec §17): the migration
// billing_credit_amounts gives the three tariffs ten times their credits and the pack a hundred
// under the slug 'pack', touches nothing else, and stops — changing nothing — where credits
// were already granted, set aside or charged. Runs the real migrations in disposable schemas
// over plans written as the seed wrote them before the change.
//
// How the file reaches the database decides what a stop looks like. `prisma migrate deploy`
// sent it as one query when that was checked on PostgreSQL's log (10.10.2026); a client that
// splits a file sends its statements one by one. The suite sends it both ways.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'
import { planSeeds } from './seed/data.ts'

const databaseUrl = process.env.DATABASE_URL
/** The rename of the units: the last migration before the numbers. */
const units = '20261010130000_billing_credit_units'
const amounts = '20261010180000_billing_credit_amounts'
const at = new Date('2026-10-04T12:00:00Z')
/** RAISE EXCEPTION of a DO block. */
const RAISE_EXCEPTION = 'P0001'
type Values = Record<string, unknown>

const migrationSql = (name: string) =>
  readFile(new URL(`./migrations/${name}/migration.sql`, import.meta.url), 'utf8')

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

/** The plans as the seed wrote them before the numbers of credits changed. */
const seededBefore = (packName = 'Пакет из 10 кредитов'): Values[] =>
  [
    ['start', 'Старт', 'quota', '4900.00', 30, 5, null, 1, 10],
    ['business', 'Бизнес', 'quota', '12900.00', 80, 10, null, 3, 20],
    ['agency', 'Агентство', 'quota', '39900.00', 250, 30, null, 15, 30],
    ['pack-10', packName, 'pack', '1990.00', null, null, 10, null, 40],
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

async function insertInto(target: MigratedSchema, table: string, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}

/** Every column of every plan; a row is told by its id, which no migration changes. */
const plansOf = async (target: MigratedSchema) =>
  (await target.db.query('SELECT * FROM plans ORDER BY sort_order, id')).rows as Values[]

/** The rows as PostgreSQL returns them: the price is a string, the rest is what was written. */
const stored = (rows: Values[]) => rows.map((row) => ({ ...row }))

/** A plan without the stamp of its last change, which a migration that touches it moves. */
const unstamped = ({ updated_at: _, ...plan }: Values) => plan

/** A schema with the migrations up to the rename of the units, and the given plans in it. */
async function schemaWith(prefix: string, plans: Values[]): Promise<MigratedSchema> {
  const schema = await createMigratedSchema(databaseUrl ?? '', prefix)
  try {
    await schema.migrate(units)
    for (const plan of plans) await insertInto(schema, 'plans', plan)
  } catch (error) {
    await schema.drop()
    throw error
  }
  return schema
}

describe.skipIf(!databaseUrl)('the migration of the numbers of credits', () => {
  describe('on a database seeded before it', () => {
    let schema: MigratedSchema
    const before = seededBefore()
    let after: Values[]
    let appliedAt: Date

    beforeAll(async () => {
      schema = await schemaWith('credit_amounts_seeded', before)
      expect(await plansOf(schema)).toEqual(stored(before))
      appliedAt = new Date()
      await schema.migrate(amounts)
      after = await plansOf(schema)
    }, 60_000)

    afterAll(async () => {
      await schema?.drop()
    })

    const planBefore = (slug: string) => {
      const plan = before.find((candidate) => candidate.slug === slug)
      if (!plan) throw new Error(`No plan ${slug} was seeded`)
      return plan
    }
    const planAfter = (id: unknown) => {
      const plan = after.find((candidate) => candidate.id === id)
      if (!plan) throw new Error('The plan is gone')
      return plan
    }
    /** The migration stamps a plan it changes with the time of the change. */
    const stampedByMigration = (plan: Values) =>
      (plan.updated_at as Date).getTime() >= appliedAt.getTime() - 60_000

    it.each([
      ['start', 300],
      ['business', 800],
      ['agency', 2500],
    ])('gives the tariff «%s» %i credits a month and changes no other term', (slug, credits) => {
      const was = planBefore(slug)
      const now = planAfter(was.id)
      expect(unstamped(now)).toEqual({ ...unstamped(was), credits_per_month: credits })
      expect(stampedByMigration(now)).toBe(true)
    })

    it('turns the pack into «Пакет из 100 кредитов» under the slug without a number', () => {
      const was = planBefore('pack-10')
      const now = planAfter(was.id)
      expect(unstamped(now)).toEqual({
        ...unstamped(was),
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        pack_credits: 100,
      })
      expect(stampedByMigration(now)).toBe(true)
      expect(after.filter((plan) => plan.kind === 'pack')).toHaveLength(1)
    })

    it('leaves the plan without credits as it was, to the stamp of its last change', () => {
      const was = planBefore('payg')
      expect(planAfter(was.id)).toEqual(stored([was])[0])
      expect(after).toHaveLength(before.length)
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
        expect(
          plans.map(({ slug, name, kind, price, creditsPerMonth, tasksPerDay, ...plan }) => ({
            slug,
            name,
            kind,
            price: price.toFixed(2),
            creditsPerMonth,
            tasksPerDay,
            packCredits: plan.packCredits,
            maxSites: plan.maxSites,
            sortOrder: plan.sortOrder,
          })),
        ).toEqual(planSeeds.map((plan) => ({ ...plan })))
        // The same ids as before the migration: no plan was replaced by a new row.
        expect(plans.map((plan) => plan.id).sort()).toEqual(before.map((plan) => plan.id).sort())
      } finally {
        await db.$disconnect()
      }
    }, 60_000)
  })

  it('creates no plan in a new database: the seed writes the numbers there', async () => {
    const schema = await schemaWith('credit_amounts_empty', [])
    try {
      await schema.migrate(amounts)
      expect(await plansOf(schema)).toEqual([])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('multiplies only the terms published before, and is not stopped by a wallet in roubles', async () => {
    const [start, business, agency, pack, payg] = seededBefore('Пакет из 10 правок') as [
      Values,
      Values,
      Values,
      Values,
      Values,
    ]
    const plans = [
      // A term changed by hand is not the published one: it is not multiplied.
      { ...start, credits_per_month: 45 },
      // Already at the new number.
      { ...business, credits_per_month: 800 },
      agency,
      // The pack under the name of a database seeded before the unit became the credit.
      pack,
      payg,
      // The same numbers under another slug are another plan.
      { ...start, id: randomUUID(), slug: 'start-2025', sort_order: 60 },
      { ...pack, id: randomUUID(), slug: 'pack-archive', sort_order: 70 },
      // A tariff is told by its kind as well as by its slug.
      { ...agency, id: randomUUID(), slug: 'agency-old', credits_per_month: 250, sort_order: 80 },
    ]
    const schema = await schemaWith('credit_amounts_mixed', plans)
    try {
      const workspaceId = randomUUID()
      const accountId = randomUUID()
      await insertInto(schema, 'workspaces', {
        id: workspaceId,
        name: 'Synthetic workspace',
        updated_at: at,
      })
      await insertInto(schema, 'billing_accounts', {
        id: accountId,
        workspace_id: workspaceId,
        unit: 'rub',
        balance: '500.00',
        updated_at: at,
      })
      await insertInto(schema, 'credit_ledger', {
        id: randomUUID(),
        account_id: accountId,
        unit: 'rub',
        kind: 'topup',
        amount: '500.00',
        balance_after: '500.00',
        idempotency_key: `order:${randomUUID()}:topup`,
      })
      const wallet = (await schema.db.query('SELECT * FROM billing_accounts')).rows as Values[]

      await schema.migrate(amounts)

      const after = await plansOf(schema)
      const changed = new Map<unknown, Values>([
        [agency.id, { credits_per_month: 2500 }],
        [pack.id, { slug: 'pack', name: 'Пакет из 100 кредитов', pack_credits: 100 }],
      ])
      expect(after.map(unstamped)).toEqual(
        stored(plans).map((plan) => ({ ...unstamped(plan), ...changed.get(plan.id) })),
      )
      // Only the plans it changed are stamped.
      expect(
        after
          .filter((plan) => (plan.updated_at as Date).getTime() !== at.getTime())
          .map((plan) => plan.id),
      ).toEqual([agency.id, pack.id])
      expect((await schema.db.query('SELECT * FROM billing_accounts')).rows).toEqual(wallet)
    } finally {
      await schema.drop()
    }
  }, 60_000)

  describe('on a database where credits were already granted, set aside or charged', () => {
    let schema: MigratedSchema
    const before = seededBefore()
    let sql: string

    beforeAll(async () => {
      schema = await schemaWith('credit_amounts_stop', before)
      sql = await migrationSql(amounts)
    }, 60_000)

    // Every case writes its billing rows inside a transaction and takes them back: the next
    // one starts from the seeded plans alone.
    beforeEach(async () => {
      await schema.db.query('BEGIN')
    })

    afterEach(async () => {
      await schema.db.query('ROLLBACK')
      expect(await plansOf(schema)).toEqual(stored(before))
    })

    afterAll(async () => {
      await schema?.drop()
    })

    async function account(unit: string) {
      const workspaceId = randomUUID()
      const id = randomUUID()
      await insertInto(schema, 'workspaces', {
        id: workspaceId,
        name: 'Synthetic workspace',
        updated_at: at,
      })
      await insertInto(schema, 'billing_accounts', {
        id,
        workspace_id: workspaceId,
        unit,
        updated_at: at,
      })
      return id
    }

    /** The foreign keys of a table are dropped: the case writes a row no account stands behind. */
    async function withoutForeignKeys(table: string) {
      const keys = (
        await schema.db.query(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = $1::regclass AND contype = 'f' ORDER BY conname`,
          [`"${schema.name}"."${table}"`],
        )
      ).rows as { conname: string }[]
      expect(keys.length).toBeGreaterThan(0)
      await schema.db.query(
        `ALTER TABLE "${table}" ${keys.map((key) => `DROP CONSTRAINT "${key.conname}"`).join(', ')}`,
      )
    }

    /** The file as one query inside the transaction of the case: its own BEGIN is not reached. */
    const refusedWith = async (message: RegExp) => {
      await expect(schema.db.query(sql)).rejects.toMatchObject({
        code: RAISE_EXCEPTION,
        message: expect.stringMatching(message),
      })
    }

    it.each(['credit_tariff', 'credit_pack'])(
      'stops on an account of the unit %s, even an empty one',
      async (unit) => {
        await account(unit)
        await refusedWith(/^billing_accounts holds credit accounts: .*recreate this database$/)
      },
    )

    // An account always stands behind a reserve and a journal entry (a composite foreign key),
    // so the first check alone stops every real database. The other two are asked about by
    // themselves here, in a state the constraints forbid: each must be a check of its own.
    it.each(['credit_tariff', 'credit_pack'])('stops on a reserve of the unit %s', async (unit) => {
      await withoutForeignKeys('credit_holds')
      await insertInto(schema, 'credit_holds', {
        id: randomUUID(),
        account_id: randomUUID(),
        unit,
        task_id: randomUUID(),
        amount: '1.00',
        expires_at: at,
      })
      await refusedWith(/^credit_holds holds reserves of credits: .*recreate this database$/)
    })

    it.each(['credit_tariff', 'credit_pack'])(
      'stops on a journal entry of the unit %s',
      async (unit) => {
        await withoutForeignKeys('credit_ledger')
        await insertInto(schema, 'credit_ledger', {
          id: randomUUID(),
          account_id: randomUUID(),
          unit,
          kind: 'grant',
          amount: '30.00',
          balance_after: '30.00',
          idempotency_key: `order:${randomUUID()}:grant`,
        })
        await refusedWith(/^credit_ledger holds entries in credits: .*recreate this database$/)
      },
    )

    it('goes through once the rows are gone', async () => {
      const id = await account('credit_tariff')
      await refusedWith(/^billing_accounts holds credit accounts/)
      await schema.db.query('ROLLBACK')
      await schema.db.query('BEGIN')
      expect(
        (await schema.db.query('SELECT 1 FROM billing_accounts WHERE id = $1', [id])).rows,
      ).toEqual([])
      // Without its own BEGIN and COMMIT, so that the case can take the numbers back.
      for (const statement of statementsOf(sql).filter(
        (statement) => !/^(BEGIN|COMMIT);$/.test(statement.replace(/^(--.*\n)+/, '')),
      )) {
        await schema.db.query(statement)
      }
      expect((await plansOf(schema)).map((plan) => plan.credits_per_month)).toEqual([
        300,
        800,
        2500,
        null,
        null,
      ])
    })
  })

  /** A database seeded before the numbers, with one pack account that holds ten credits. */
  async function withPurchase(prefix: string) {
    const before = seededBefore()
    const schema = await schemaWith(prefix, before)
    try {
      const workspaceId = randomUUID()
      await insertInto(schema, 'workspaces', {
        id: workspaceId,
        name: 'Synthetic workspace',
        updated_at: at,
      })
      await insertInto(schema, 'billing_accounts', {
        id: randomUUID(),
        workspace_id: workspaceId,
        unit: 'credit_pack',
        balance: '10.00',
        updated_at: at,
      })
    } catch (error) {
      await schema.drop()
      throw error
    }
    return { schema, before }
  }

  // What `prisma migrate deploy` does with the file. The stop stands before the file's BEGIN:
  // raised inside its transaction, the exception would leave the session in an aborted
  // transaction block, and whoever applied the migration — Prisma records the failure with one
  // more statement — would get «current transaction is aborted» in place of the reason.
  it('stops with its reason and leaves nothing open, sent as one query', async () => {
    const { schema, before } = await withPurchase('credit_amounts_one_query')
    try {
      await expect(schema.db.query(await migrationSql(amounts))).rejects.toMatchObject({
        code: RAISE_EXCEPTION,
        message:
          'billing_accounts holds credit accounts: plan terms are multiplied by ten, balances are not; recreate this database',
      })
      // No ROLLBACK is sent: the next statement of the session runs at once.
      expect(await plansOf(schema)).toEqual(stored(before))
      expect((await schema.db.query('SELECT balance FROM billing_accounts')).rows).toEqual([
        { balance: '10.00' },
      ])
    } finally {
      await schema.drop()
    }
  }, 60_000)

  it('changes no plan when it stops, sent statement by statement', async () => {
    const { schema, before } = await withPurchase('credit_amounts_statements')
    try {
      const statements = statementsOf(await migrationSql(amounts))
      // The stop comes first, before the transaction of the changes is opened.
      expect(
        statements.map((statement) => statement.replace(/^(--.*\n)+/, '').split(/\s/)[0]),
      ).toEqual(['DO', 'BEGIN;', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'COMMIT;'])
      const sent: string[] = []
      const run = async () => {
        for (const statement of statements) {
          sent.push(statement)
          await schema.db.query(statement)
        }
      }
      await expect(run()).rejects.toMatchObject({
        code: RAISE_EXCEPTION,
        message: expect.stringMatching(/^billing_accounts holds credit accounts/),
      })
      // Nothing after the stop was sent, and nothing is open.
      expect(sent).toHaveLength(1)
      expect(await plansOf(schema)).toEqual(stored(before))
    } finally {
      await schema.drop()
    }
  }, 60_000)

  // The changes themselves are one transaction, however the file is sent: a failure in the
  // middle takes back the plans that were already multiplied.
  it('takes every change back when one of them fails, sent statement by statement', async () => {
    const before = seededBefore()
    const schema = await schemaWith('credit_amounts_atomic', [
      ...before,
      // The slug the pack is renamed to is taken: the last change fails on the unique slug.
      { ...before[3], id: randomUUID(), slug: 'pack', sort_order: 60 },
    ])
    try {
      const seeded = await plansOf(schema)
      const run = async () => {
        for (const statement of statementsOf(await migrationSql(amounts))) {
          await schema.db.query(statement)
        }
      }
      await expect(run()).rejects.toMatchObject({ code: '23505', constraint: 'plans_slug_key' })
      // What the end of the connection does to a transaction that is still open.
      await schema.db.query('ROLLBACK')
      expect(await plansOf(schema)).toEqual(seeded)
    } finally {
      await schema.drop()
    }
  }, 60_000)
})
