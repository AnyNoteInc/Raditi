// The third credit account in the database (docs/plan/37-billing-plan.md, «Порядок счетов и
// правило списания» and «Что меняется в базе»; spec §16): the migration
// billing_credit_gift_unit adds the unit 'credit_gift' after the labels the type already has,
// and billing_credit_gift_checks re-creates the three whole-number checks for the three credit
// units. Runs the real migrations in disposable schemas over accounts, reserves and entries
// written before them, then accepted and rejected cases for every unit.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the gift unit. */
const before = '20261010180000_billing_credit_amounts'
const unit = '20261010210000_billing_credit_gift_unit'
const checks = '20261010210100_billing_credit_gift_checks'
const at = new Date('2026-10-10T12:00:00Z')
const end = new Date('2026-11-10T12:00:00Z')
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const UNSAFE_NEW_ENUM_VALUE = '55P04'
type Values = Record<string, unknown>

const creditUnits = ['credit_tariff', 'credit_gift', 'credit_pack'] as const
const wholeChecks = [
  'billing_accounts_credit_whole_check',
  'credit_holds_credit_whole_check',
  'credit_ledger_credit_whole_check',
]
const billingTables = ['billing_accounts', 'credit_holds', 'credit_ledger'] as const

const migrationSql = (name: string) =>
  readFile(new URL(`./migrations/${name}/migration.sql`, import.meta.url), 'utf8')

/** The statements of a migration file one by one, as a client that splits a file sends them. */
const statementsOf = (sql: string) =>
  sql
    .split(/;[ \t]*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean)

/** Rows of one schema: every helper writes with autocommit, so a refused row leaves nothing. */
function rowsOf(target: MigratedSchema) {
  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await target.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }
  let siteId: string | undefined
  let taskWorkspaceId: string | undefined

  async function workspace() {
    const id = randomUUID()
    await insert('workspaces', { id, name: 'Synthetic workspace', updated_at: at })
    return id
  }

  /** A task of a workspace and a site made for the tasks of this schema. */
  async function task() {
    if (siteId === undefined || taskWorkspaceId === undefined) {
      taskWorkspaceId = await workspace()
      siteId = randomUUID()
      await insert('sites', {
        id: siteId,
        workspace_id: taskWorkspaceId,
        name: 'Synthetic site',
        url: `https://${siteId}.invalid`,
        stack: 'wordpress',
        updated_at: at,
      })
    }
    const id = randomUUID()
    await insert('tasks', {
      id,
      workspace_id: taskWorkspaceId,
      site_id: siteId,
      updated_at: at,
    })
    return id
  }

  return {
    workspace,

    async account(workspaceId: string, accountUnit: string, values: Values = {}) {
      const id = randomUUID()
      await insert('billing_accounts', {
        id,
        workspace_id: workspaceId,
        unit: accountUnit,
        updated_at: at,
        ...values,
      })
      return id
    },

    async hold(accountId: string, holdUnit: string, amount: string) {
      await insert('credit_holds', {
        id: randomUUID(),
        account_id: accountId,
        unit: holdUnit,
        task_id: await task(),
        amount,
        expires_at: end,
      })
    },

    entry: (accountId: string, entryUnit: string, values: Values = {}) =>
      insert('credit_ledger', {
        id: randomUUID(),
        account_id: accountId,
        unit: entryUnit,
        kind: 'grant',
        amount: '10.00',
        balance_after: '10.00',
        idempotency_key: `test:${randomUUID()}`,
        ...values,
      }),

    update: (table: string, id: string, values: Values) => {
      const columns = Object.keys(values)
      return target.db.query(
        `UPDATE "${table}" SET ${columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')}
         WHERE id = $1`,
        [id, ...Object.values(values)],
      )
    },

    /** Every billing row of the schema, as PostgreSQL returns it. */
    async billingRows() {
      const rows: Record<string, Values[]> = {}
      for (const table of billingTables)
        rows[table] = (await target.db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows
      return rows
    },
  }
}

/** The labels of the unit type of a schema, in the order of the type. */
const unitLabels = async (target: MigratedSchema): Promise<unknown[]> =>
  (
    await target.db.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typnamespace = $1::regnamespace AND t.typname = 'BillingUnit'
       ORDER BY e.enumsortorder`,
      [target.name],
    )
  ).rows.map((row: Values) => row.enumlabel)

/** The three whole-number checks of a schema as the catalogue stores them. */
const storedChecks = async (target: MigratedSchema) =>
  (
    await target.db.query(
      `SELECT conname, conrelid::regclass::text AS "table", pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace AND conname LIKE '%whole_check' ORDER BY conname`,
      [target.name],
    )
  ).rows as Values[]

const refused = (act: () => Promise<unknown>, code: string, constraint?: string) =>
  expect(act()).rejects.toMatchObject(constraint ? { code, constraint } : { code })

describe.skipIf(!databaseUrl)('the migrations of the gift account', () => {
  let schema: MigratedSchema
  let rows: ReturnType<typeof rowsOf>
  let labelsBefore: unknown[]
  let checksBefore: Values[]
  let rowsBefore: Record<string, Values[]>
  let labelsBetween: unknown[]

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'credit_gift')
    await schema.migrate(before)
    rows = rowsOf(schema)
    // Accounts of the two credit units and a wallet, each with a reserve and an entry, written
    // before the third unit exists.
    const workspaceId = await rows.workspace()
    for (const [name, balance, held, amount] of [
      ['credit_tariff', '300.00', '45.00', '45.00'],
      ['credit_pack', '100.00', '20.00', '20.00'],
      ['rub', '1000.50', '300.25', '300.25'],
    ] as const) {
      const id = await rows.account(workspaceId, name, { balance, held })
      await rows.hold(id, name, amount)
      await rows.entry(id, name, { amount: balance, balance_after: balance })
    }
    labelsBefore = await unitLabels(schema)
    checksBefore = await storedChecks(schema)
    rowsBefore = await rows.billingRows()
    await schema.migrate(unit)
    labelsBetween = await unitLabels(schema)
    await schema.migrate(checks)
  }, 60_000)

  afterAll(async () => {
    await schema?.drop()
  })

  it('add credit_gift after the units the type already has and rename none', () => {
    expect(labelsBefore).toEqual(['credit_tariff', 'rub', 'credit_pack'])
    expect(labelsBetween).toEqual(['credit_tariff', 'rub', 'credit_pack', 'credit_gift'])
  })

  it('re-create the three whole-number checks under their names for the three credit units', async () => {
    expect(checksBefore.map((row) => row.conname)).toEqual(wholeChecks)
    for (const row of checksBefore) {
      expect(row.definition).toMatch(/'credit_tariff'.*'credit_pack'/)
      expect(row.definition).not.toMatch(/credit_gift/)
    }
    // Each is the expression it was, on its table, with the gift unit between the other two.
    expect(await storedChecks(schema)).toEqual(
      checksBefore.map((row) => ({
        ...row,
        definition: String(row.definition).replace(
          `'credit_tariff'::"BillingUnit", `,
          `'credit_tariff'::"BillingUnit", 'credit_gift'::"BillingUnit", `,
        ),
      })),
    )
    for (const row of await storedChecks(schema))
      expect(row.definition).toMatch(/'credit_tariff'.*'credit_gift'.*'credit_pack'/)
  })

  it('change no account, reserve or entry written before them', async () => {
    expect(await rows.billingRows()).toEqual(rowsBefore)
    expect(rowsBefore.billing_accounts).toHaveLength(3)
    expect(rowsBefore.credit_holds).toHaveLength(3)
    expect(rowsBefore.credit_ledger).toHaveLength(3)
  })

  it('accept the three credit accounts and the wallet of one workspace, one account per unit', async () => {
    const workspaceId = await rows.workspace()
    await rows.account(workspaceId, 'credit_tariff', { balance: '300.00', held: '45.00' })
    await rows.account(workspaceId, 'credit_gift', { balance: '35.00', held: '35.00' })
    await rows.account(workspaceId, 'credit_pack', { balance: '100.00', held: '2.00' })
    await rows.account(workspaceId, 'rub', { balance: '1000.50', held: '300.25' })
    await refused(
      () => rows.account(workspaceId, 'credit_gift'),
      UNIQUE_VIOLATION,
      'billing_accounts_workspace_id_unit_key',
    )
  })

  it.each(creditUnits)('reject a fractional balance or hold of %s', async (name) => {
    const workspaceId = await rows.workspace()
    for (const values of [{ balance: '1.50' }, { balance: '2.00', held: '0.50' }])
      await refused(
        () => rows.account(workspaceId, name, values),
        CHECK_VIOLATION,
        'billing_accounts_credit_whole_check',
      )
    const id = await rows.account(workspaceId, name, { balance: '2.00' })
    await refused(
      () => rows.update('billing_accounts', id, { balance: '1.99' }),
      CHECK_VIOLATION,
      'billing_accounts_credit_whole_check',
    )
  })

  it.each(creditUnits)('reserve %s in whole credits only', async (name) => {
    const id = await rows.account(await rows.workspace(), name, { balance: '10.00' })
    await rows.hold(id, name, '1.00')
    await refused(
      () => rows.hold(id, name, '0.50'),
      CHECK_VIOLATION,
      'credit_holds_credit_whole_check',
    )
  })

  it.each(creditUnits)('move %s in whole credits only', async (name) => {
    const id = await rows.account(await rows.workspace(), name)
    await rows.entry(id, name)
    for (const values of [{ amount: '0.50' }, { amount: '1.00', balance_after: '10.50' }])
      await refused(
        () => rows.entry(id, name, values),
        CHECK_VIOLATION,
        'credit_ledger_credit_whole_check',
      )
  })

  it('keep kopecks in roubles', async () => {
    const id = await rows.account(await rows.workspace(), 'rub', {
      balance: '100.50',
      held: '0.25',
    })
    await rows.hold(id, 'rub', '0.25')
    await rows.entry(id, 'rub', { amount: '0.50', balance_after: '100.50' })
  })

  it('reject a reserve or an entry of the gift account under the unit of another account', async () => {
    const workspaceId = await rows.workspace()
    const gift = await rows.account(workspaceId, 'credit_gift', { balance: '35.00' })
    const pack = await rows.account(workspaceId, 'credit_pack', { balance: '100.00' })
    for (const other of ['credit_tariff', 'credit_pack', 'rub']) {
      await refused(
        () => rows.hold(gift, other, '1.00'),
        FOREIGN_KEY_VIOLATION,
        'credit_holds_account_id_unit_fkey',
      )
      await refused(
        () => rows.entry(gift, other),
        FOREIGN_KEY_VIOLATION,
        'credit_ledger_account_id_unit_fkey',
      )
    }
    await refused(
      () => rows.entry(pack, 'credit_gift'),
      FOREIGN_KEY_VIOLATION,
      'credit_ledger_account_id_unit_fkey',
    )
  })

  it('accept a grant on the gift account that no order paid for', async () => {
    const id = await rows.account(await rows.workspace(), 'credit_gift', { balance: '35.00' })
    await rows.entry(id, 'credit_gift', {
      amount: '35.00',
      balance_after: '35.00',
      order_id: null,
      idempotency_key: `user:${randomUUID()}:signup-gift`,
    })
  })

  it('need the new unit committed first: one transaction for both is refused', async () => {
    const scratch = await createMigratedSchema(databaseUrl ?? '', 'credit_gift_alone')
    try {
      await scratch.migrate(before)
      await scratch.db.query('BEGIN')
      await scratch.db.query(await migrationSql(unit))
      // The file's own BEGIN only warns inside an open transaction; its first CHECK names the
      // value that is not committed yet.
      await refused(async () => scratch.db.query(await migrationSql(checks)), UNSAFE_NEW_ENUM_VALUE)
    } finally {
      await scratch.drop()
    }
  }, 30_000)

  describe('between the two', () => {
    let scratch: MigratedSchema
    let scratchRows: ReturnType<typeof rowsOf>

    beforeAll(async () => {
      scratch = await createMigratedSchema(databaseUrl ?? '', 'credit_gift_between')
      await scratch.migrate(unit)
      scratchRows = rowsOf(scratch)
    }, 60_000)

    afterAll(async () => {
      await scratch?.drop()
    })

    it('the checks do not name the gift unit yet, and replace each other only together', async () => {
      // What the second migration is for: until it runs a gift account may hold a fraction.
      const id = await scratchRows.account(await scratchRows.workspace(), 'credit_gift', {
        balance: '1.50',
      })
      const previous = await storedChecks(scratch)
      expect(previous.map((row) => row.conname)).toEqual(wholeChecks)

      // That row fails the first new check. Sent as one query, the file changes nothing.
      await refused(async () => scratch.db.query(await migrationSql(checks)), CHECK_VIOLATION)
      await scratch.db.query('ROLLBACK')
      expect(await storedChecks(scratch)).toEqual(previous)

      // Sent statement by statement, a later statement fails after an earlier one succeeded:
      // only the file's own BEGIN and COMMIT take the replaced check back.
      await scratchRows.update('billing_accounts', id, { balance: '2.00' })
      const fraction = await scratchRows.account(await scratchRows.workspace(), 'credit_gift')
      await scratchRows.entry(fraction, 'credit_gift', { amount: '0.50', balance_after: '0.00' })
      const run = async () => {
        for (const statement of statementsOf(await migrationSql(checks)))
          await scratch.db.query(statement)
      }
      await refused(run, CHECK_VIOLATION)
      // What the end of the connection does to a transaction that is still open.
      await scratch.db.query('ROLLBACK')
      expect(await storedChecks(scratch)).toEqual(previous)

      // Without the fraction the migration applies, and the fraction is refused from then on.
      await scratch.db.query(`DELETE FROM credit_ledger WHERE account_id = $1`, [fraction])
      await scratch.migrate(checks)
      await refused(
        () => scratchRows.update('billing_accounts', id, { balance: '1.50' }),
        CHECK_VIOLATION,
        'billing_accounts_credit_whole_check',
      )
    }, 30_000)
  })
})
