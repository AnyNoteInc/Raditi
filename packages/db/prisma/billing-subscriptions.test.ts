// What subscriptions through ЮKassa need from the database (docs/plan/37-billing-plan.md,
// «Модель данных»; spec §16, §17): a second credit account in whole numbers, one live
// subscription per workspace with the anchor of its periods, the period and the refund of an
// order. Runs the real migrations in a disposable schema over billing rows written before the
// change, then accepted and rejected cases for every new constraint.
//
// The rows are written under the names the database had then — the units 'edit' and
// 'edit_pack', the plan columns edits_per_month, edits_per_day and pack_edits — and the suite
// ends at the migration that renames them to credits (billing_credit_units): it proves that a
// database of the old names comes out with the new ones and nothing else changed. It applies no
// later migration: those of the credits model that change billing data refuse a database with
// billing rows, and each has a test of its own.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { liveSubscriptionStatuses, subscriptionStatuses } from '@repo/domain'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before billing. */
const before = '20261004100000_mcp_host_undo'
const unit = '20261004110000_billing_edit_pack_unit'
const change = '20261004120000_billing_subscriptions'
/** The rename of the units, of three plan columns and of the three whole-number checks. */
const credits = '20261010130000_billing_credit_units'
const at = new Date('2026-10-04T12:00:00Z')
const start = new Date('2026-09-10T06:30:00Z')
const end = new Date('2026-10-10T06:30:00Z')
const CHECK_VIOLATION = '23514'
const INVALID_TEXT_REPRESENTATION = '22P02'
const UNDEFINED_COLUMN = '42703'
const DUPLICATE_COLUMN = '42701'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const NOT_NULL_VIOLATION = '23502'
const UNSAFE_NEW_ENUM_VALUE = '55P04'
type Values = Record<string, unknown>

const migrationSql = (name: string) =>
  readFile(new URL(`./migrations/${name}/migration.sql`, import.meta.url), 'utf8')

/** The whole-number checks as they were named before the rename of the units. */
const wholeChecks = [
  'billing_accounts_edit_whole_check',
  'credit_holds_edit_whole_check',
  'credit_ledger_edit_whole_check',
]
const creditChecks = [
  'billing_accounts_credit_whole_check',
  'credit_holds_credit_whole_check',
  'credit_ledger_credit_whole_check',
]
/** The checks of "plans" that name the renamed columns; their own names stay. */
const planChecks = ['plans_kind_fields_check', 'plans_limits_check']
const unitRenames = { edit: 'credit_tariff', edit_pack: 'credit_pack' } as const
const columnRenames = {
  edits_per_month: 'credits_per_month',
  edits_per_day: 'tasks_per_day',
  pack_edits: 'pack_credits',
} as const
/** A unit as the rename leaves it; `rub` and every other value stay. */
const renamedUnit = (value: unknown) =>
  typeof value === 'string' && value in unitRenames
    ? unitRenames[value as keyof typeof unitRenames]
    : value
const subscriptionColumns = {
  period_anchor: 'timestamp(6) with time zone',
  next_plan_id: 'uuid',
  past_due_since: 'timestamp(6) with time zone',
  renewal_notice_period_end: 'timestamp(6) with time zone',
  payment_method_type: 'character varying(32)',
  payment_method_card_type: 'character varying(32)',
  payment_method_last4: 'character varying(4)',
  pending_payment_method_id: 'character varying(64)',
}
const orderColumns = {
  period_start: 'timestamp(6) with time zone',
  period_end: 'timestamp(6) with time zone',
  failure_reason: 'character varying(64)',
  yookassa_refund_id: 'character varying(64)',
  refunded_amount: 'numeric(12,2)',
}

describe.skipIf(!databaseUrl)('billing subscriptions migrations', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    plan: randomUUID(),
    otherPlan: randomUUID(),
    pack: randomUUID(),
    site: randomUUID(),
    tariffTask: randomUUID(),
    rubTask: randomUUID(),
    active: randomUUID(),
    cancelled: randomUUID(),
    tariffAccount: randomUUID(),
    rubAccount: randomUUID(),
  }
  const sources = {
    subscriptions: 'subscriptions',
    orders: 'orders',
    accounts: 'billing_accounts',
    holds: 'credit_holds',
    ledger: 'credit_ledger',
  } as const
  type Tables = Record<keyof typeof sources, Values[]>
  let legacy: Tables
  let migrated: Tables
  let anchored: Values[]
  /** The catalogue as the last migration before the rename left it, and the plans it held. */
  let named: { units: unknown[]; checks: Values[]; plans: Values[] }

  async function insertInto(target: MigratedSchema, table: string, values: Values) {
    const columns = Object.keys(values)
    await target.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }

  const insert = (table: string, values: Values) => insertInto(schema, table, values)

  function update(table: string, id: string, values: Values) {
    const columns = Object.keys(values)
    return schema.db.query(
      `UPDATE "${table}" SET ${columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')}
       WHERE id = $1`,
      [id, ...Object.values(values)],
    )
  }

  const select = async (table: string) =>
    (await schema.db.query(`SELECT * FROM "${table}" ORDER BY id`)).rows as Values[]

  const tables = async (): Promise<Tables> => ({
    subscriptions: await select(sources.subscriptions),
    orders: await select(sources.orders),
    accounts: await select(sources.accounts),
    holds: await select(sources.holds),
    ledger: await select(sources.ledger),
  })

  /**
   * A statement that must fail, inside a savepoint: PostgreSQL aborts the transaction of a
   * failed statement, and the test goes on after it.
   */
  async function refused(act: () => Promise<unknown>, code: string, constraint?: string) {
    await schema.db.query('SAVEPOINT refused')
    await expect(act()).rejects.toMatchObject(constraint ? { code, constraint } : { code })
    await schema.db.query('ROLLBACK TO SAVEPOINT refused')
  }

  async function workspace() {
    const id = randomUUID()
    await insert('workspaces', { id, name: 'Synthetic workspace', updated_at: at })
    return id
  }

  /** A plan under the column names of the database before the rename of the units. */
  const legacyPlanRow = (id: string, values: Values = {}) => ({
    id,
    slug: `test-${id}`,
    name: 'Synthetic plan',
    kind: 'quota',
    price: '4900.00',
    edits_per_month: 30,
    max_sites: 1,
    updated_at: at,
    ...values,
  })

  /** The same plan as it is written after the rename. */
  const planRow = (id: string) => {
    const { edits_per_month: creditsPerMonth, ...row } = legacyPlanRow(id)
    return { ...row, credits_per_month: creditsPerMonth }
  }

  /** A subscription as it is written after the change; `workspace_id` is always given. */
  async function subscription(values: Values) {
    const id = randomUUID()
    await insert('subscriptions', {
      id,
      plan_id: ids.plan,
      current_period_start: start,
      current_period_end: end,
      period_anchor: start,
      updated_at: at,
      ...values,
    })
    return id
  }

  /** A pending subscription order of 4900 ₽ unless `values` say otherwise. */
  async function order(values: Values = {}) {
    const id = randomUUID()
    await insert('orders', {
      id,
      workspace_id: ids.workspace,
      kind: 'subscription',
      plan_id: ids.plan,
      amount: '4900.00',
      idempotence_key: randomUUID(),
      updated_at: at,
      ...values,
    })
    return id
  }

  async function account(workspaceId: string, accountUnit: string, values: Values = {}) {
    const id = randomUUID()
    await insert('billing_accounts', {
      id,
      workspace_id: workspaceId,
      unit: accountUnit,
      updated_at: at,
      ...values,
    })
    return id
  }

  async function task() {
    const id = randomUUID()
    await insert('tasks', {
      id,
      workspace_id: ids.workspace,
      site_id: ids.site,
      updated_at: at,
    })
    return id
  }

  const hold = async (accountId: string, holdUnit: string, amount: string) =>
    insert('credit_holds', {
      id: randomUUID(),
      account_id: accountId,
      unit: holdUnit,
      task_id: await task(),
      amount,
      expires_at: end,
    })

  const entry = (accountId: string, entryUnit: string, values: Values = {}) =>
    insert('credit_ledger', {
      id: randomUUID(),
      account_id: accountId,
      unit: entryUnit,
      kind: 'grant',
      amount: '10.00',
      balance_after: '10.00',
      idempotency_key: `test:${randomUUID()}`,
      ...values,
    })

  /** Checks and columns the change replaces or adds, as the catalogue of a schema shows them. */
  async function shape(target: MigratedSchema) {
    const checks = await target.db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE connamespace = $1::regnamespace AND conname = ANY($2::text[]) ORDER BY conname`,
      [target.name, wholeChecks],
    )
    const columns = await target.db.query(
      `SELECT c.relname AS "table", a.attname AS "column",
         format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2::text[])
         AND a.attname = ANY($3::text[]) AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`,
      [
        target.name,
        ['subscriptions', 'orders'],
        [...Object.keys(subscriptionColumns), ...Object.keys(orderColumns)],
      ],
    )
    return { checks: checks.rows as Values[], columns: columns.rows as Values[] }
  }

  /** The labels of the unit type of a schema, in the order of the type. */
  const unitLabels = async (target: MigratedSchema = schema): Promise<unknown[]> =>
    (
      await target.db.query(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typnamespace = $1::regnamespace AND t.typname = 'BillingUnit'
         ORDER BY e.enumsortorder`,
        [target.name],
      )
    ).rows.map((row: Values) => row.enumlabel)

  /** The stored definitions of the checks that name a unit or a renamed plan column. */
  const storedChecks = async () =>
    (
      await schema.db.query(
        `SELECT conname, conrelid::regclass::text AS "table", pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE connamespace = $1::regnamespace AND conname = ANY($2::text[]) ORDER BY conname`,
        [schema.name, [...wholeChecks, ...creditChecks, ...planChecks]],
      )
    ).rows as Values[]

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'billing_subscriptions')
    await schema.migrate(before)
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic workspace', updated_at: at })
    await insert('plans', legacyPlanRow(ids.plan))
    await insert('plans', legacyPlanRow(ids.otherPlan, { price: '12900.00', edits_per_month: 80 }))
    await insert(
      'plans',
      legacyPlanRow(ids.pack, {
        kind: 'pack',
        price: '1990.00',
        edits_per_month: null,
        max_sites: null,
        pack_edits: 10,
      }),
    )
    await insert('sites', {
      id: ids.site,
      workspace_id: ids.workspace,
      name: 'Synthetic site',
      url: `https://${ids.site}.invalid`,
      stack: 'wordpress',
      updated_at: at,
    })
    for (const id of [ids.tariffTask, ids.rubTask])
      await insert('tasks', {
        id,
        workspace_id: ids.workspace,
        site_id: ids.site,
        updated_at: at,
      })
    // Written before the change: no anchor, no index of live subscriptions. The period start
    // carries microseconds, which a round trip through a JavaScript Date would lose.
    await schema.db.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_id, status, current_period_start, current_period_end,
          payment_method_id, payment_method_title, updated_at)
       VALUES ($1, $2, $3, 'active', '2026-09-10 09:30:00.123456+03',
               '2026-10-10 09:30:00.123456+03', 'pm-synthetic', 'Bank card *4444', $4)`,
      [ids.active, ids.workspace, ids.plan, at],
    )
    await insert('subscriptions', {
      id: ids.cancelled,
      workspace_id: ids.workspace,
      plan_id: ids.otherPlan,
      status: 'cancelled',
      current_period_start: new Date('2026-07-01T09:00:00Z'),
      current_period_end: new Date('2026-08-01T09:00:00Z'),
      cancel_at_period_end: true,
      cancelled_at: new Date('2026-07-15T09:00:00Z'),
      updated_at: at,
    })
    await insert('billing_accounts', {
      id: ids.tariffAccount,
      workspace_id: ids.workspace,
      unit: 'edit',
      balance: '30.00',
      held: '1.00',
      updated_at: at,
    })
    await insert('billing_accounts', {
      id: ids.rubAccount,
      workspace_id: ids.workspace,
      unit: 'rub',
      balance: '1000.50',
      held: '300.00',
      updated_at: at,
    })
    await insert('credit_holds', {
      id: randomUUID(),
      account_id: ids.tariffAccount,
      unit: 'edit',
      task_id: ids.tariffTask,
      amount: '1.00',
      expires_at: end,
    })
    await insert('credit_holds', {
      id: randomUUID(),
      account_id: ids.rubAccount,
      unit: 'rub',
      task_id: ids.rubTask,
      amount: '300.00',
      expires_at: end,
    })
    const paid = randomUUID()
    const topup = randomUUID()
    await insert('orders', {
      id: paid,
      workspace_id: ids.workspace,
      kind: 'subscription',
      plan_id: ids.plan,
      subscription_id: ids.active,
      amount: '4900.00',
      status: 'paid',
      yookassa_payment_id: 'payment-synthetic-paid',
      idempotence_key: randomUUID(),
      save_payment_method: true,
      paid_at: start,
      updated_at: at,
    })
    await insert('orders', {
      id: topup,
      workspace_id: ids.workspace,
      kind: 'topup',
      amount: '1000.50',
      status: 'paid',
      idempotence_key: randomUUID(),
      paid_at: start,
      updated_at: at,
    })
    // One unfinished subscription order: the new index has to build over it.
    await insert('orders', {
      id: randomUUID(),
      workspace_id: ids.workspace,
      kind: 'subscription',
      plan_id: ids.otherPlan,
      amount: '12900.00',
      idempotence_key: randomUUID(),
      updated_at: at,
    })
    await insert('credit_ledger', {
      id: randomUUID(),
      account_id: ids.tariffAccount,
      unit: 'edit',
      kind: 'grant',
      amount: '30.00',
      balance_after: '30.00',
      order_id: paid,
      idempotency_key: `order:${paid}:grant`,
    })
    await insert('credit_ledger', {
      id: randomUUID(),
      account_id: ids.rubAccount,
      unit: 'rub',
      kind: 'topup',
      amount: '1000.50',
      balance_after: '1000.50',
      order_id: topup,
      idempotency_key: `order:${topup}:topup`,
    })
    legacy = await tables()
    await schema.migrate(change)
    migrated = await tables()
    anchored = (
      await schema.db.query(
        `SELECT status, period_anchor = current_period_start AS anchored
         FROM subscriptions ORDER BY status`,
      )
    ).rows as Values[]
    named = {
      units: await unitLabels(),
      checks: await storedChecks(),
      plans: (await schema.db.query('SELECT * FROM plans ORDER BY id')).rows as Values[],
    }
    await schema.migrate(credits)
  }, 30_000)

  beforeEach(async () => {
    await schema.db.query('BEGIN')
  })

  afterEach(async () => {
    await schema.db.query('ROLLBACK')
  })

  afterAll(async () => {
    await schema?.drop()
  })

  describe('billing rows written before the change', () => {
    it('survive it: a subscription takes its period start as the anchor, the rest is NULL', () => {
      expect(legacy.subscriptions).toHaveLength(2)
      expect(legacy.orders).toHaveLength(3)
      expect(anchored).toEqual([
        { status: 'active', anchored: true },
        { status: 'cancelled', anchored: true },
      ])
      const empty = (columns: object) =>
        Object.fromEntries(Object.keys(columns).map((column) => [column, null]))
      expect(migrated.subscriptions).toEqual(
        legacy.subscriptions.map((row) => ({
          ...row,
          ...empty(subscriptionColumns),
          period_anchor: row.current_period_start,
        })),
      )
      expect(migrated.orders).toEqual(
        legacy.orders.map((row) => ({ ...row, ...empty(orderColumns) })),
      )
      for (const table of ['accounts', 'holds', 'ledger'] as const)
        expect(migrated[table]).toEqual(legacy[table])
    })

    it('keep their columns through every later migration up to the rename of the units', async () => {
      // A later migration may add columns of its own: only the ones of these rows are compared.
      // The rename changes one thing in them: the unit of an account, a hold and an entry reads
      // by its new label.
      for (const [table, rows] of Object.entries(migrated) as [keyof Tables, Values[]][]) {
        const columns = Object.keys(rows[0]!)
        expect(
          (await select(sources[table])).map((row) =>
            Object.fromEntries(columns.map((column) => [column, row[column]])),
          ),
        ).toEqual(
          rows.map((row) => ('unit' in row ? { ...row, unit: renamedUnit(row.unit) } : row)),
        )
      }
      // These rows were written before 'edit_pack' existed: they hold the one renamed unit of
      // that time, which was there to be renamed, and the wallet's, which stayed. Rows of both
      // renamed units cross the rename in a case of their own below.
      expect(migrated.accounts.map((row) => row.unit).sort()).toEqual(['edit', 'rub'])
      expect((await select(sources.accounts)).map((row) => row.unit).sort()).toEqual([
        'credit_tariff',
        'rub',
      ])
    })

    it('still pass their checks when they are written again', async () => {
      for (const [table, rows] of Object.entries(legacy) as [keyof Tables, Values[]][])
        for (const row of rows)
          await schema.db.query(`UPDATE "${sources[table]}" SET id = id WHERE id = $1`, [row.id])
    })
  })

  describe('the migrations as Prisma applies them', () => {
    it('add exactly the planned columns, the anchor alone being required', async () => {
      const expected = (table: string, columns: Record<string, string>) =>
        Object.entries(columns).map(([column, type]) => ({
          table,
          column,
          type,
          required: column === 'period_anchor',
        }))
      expect((await shape(schema)).columns).toEqual([
        ...expected('orders', orderColumns),
        ...expected('subscriptions', subscriptionColumns),
      ])
    })

    it('add edit_pack after the existing units of the database type, and the rename keeps the order', async () => {
      expect(named.units).toEqual(['edit', 'rub', 'edit_pack'])
      expect(await unitLabels()).toEqual(['credit_tariff', 'rub', 'credit_pack'])
    })

    it('keep the two partial unique indexes as they were written', async () => {
      const { rows } = await schema.db.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname`,
        [
          schema.name,
          ['subscriptions_workspace_live_key', 'orders_workspace_pending_subscription_key'],
        ],
      )
      const status = (value: string) => `'${value}'::"SubscriptionStatus"`
      expect(rows).toEqual([
        {
          indexname: 'orders_workspace_pending_subscription_key',
          indexdef:
            `CREATE UNIQUE INDEX orders_workspace_pending_subscription_key ` +
            `ON ${schema.name}.orders USING btree (workspace_id) ` +
            `WHERE ((kind = 'subscription'::"OrderKind") AND (status = 'pending'::"OrderStatus"))`,
        },
        {
          indexname: 'subscriptions_workspace_live_key',
          // The statuses the domain calls live, in its order.
          indexdef:
            `CREATE UNIQUE INDEX subscriptions_workspace_live_key ` +
            `ON ${schema.name}.subscriptions USING btree (workspace_id) ` +
            `WHERE (status = ANY (ARRAY[${liveSubscriptionStatuses.map(status).join(', ')}]))`,
        },
      ])
    })

    it('need the new unit committed first: one transaction for both is refused', async () => {
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'billing_unit_alone')
      try {
        await scratch.migrate(before)
        await scratch.db.query('BEGIN')
        await scratch.db.query(await migrationSql(unit))
        // The file's own BEGIN only warns inside an open transaction; its first CHECK names
        // the value that is not committed yet.
        await expect(scratch.db.query(await migrationSql(change))).rejects.toMatchObject({
          code: UNSAFE_NEW_ENUM_VALUE,
        })
      } finally {
        await scratch.drop()
      }
    }, 30_000)

    it('stop on two live subscriptions of one workspace and change nothing', async () => {
      // `prisma migrate deploy` sends a migration statement by statement, each in its own
      // implicit transaction. The index of live subscriptions comes after the replaced checks
      // and the new columns: only the file's own BEGIN and COMMIT take them back together.
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'billing_atomic')
      try {
        await scratch.migrate(unit)
        const workspaceId = randomUUID()
        await insertInto(scratch, 'workspaces', {
          id: workspaceId,
          name: 'Synthetic workspace',
          updated_at: at,
        })
        await insertInto(scratch, 'plans', legacyPlanRow(ids.plan))
        for (const status of ['active', 'past_due'])
          await insertInto(scratch, 'subscriptions', {
            id: randomUUID(),
            workspace_id: workspaceId,
            plan_id: ids.plan,
            status,
            current_period_start: start,
            current_period_end: end,
            updated_at: at,
          })
        const previous = await shape(scratch)
        expect(previous.checks.map((row) => row.conname)).toEqual(wholeChecks)
        expect(previous.columns).toEqual([])
        const statements = (await migrationSql(change))
          .split(/;[ \t]*$/m)
          .map((statement) => statement.trim())
          .filter(Boolean)
        const run = async () => {
          for (const statement of statements) await scratch.db.query(statement)
        }
        await expect(run()).rejects.toMatchObject({
          code: UNIQUE_VIOLATION,
          constraint: 'subscriptions_workspace_live_key',
        })
        // What the end of the connection does to a transaction that is still open.
        await scratch.db.query('ROLLBACK')
        expect(await shape(scratch)).toEqual(previous)
      } finally {
        await scratch.drop()
      }
    }, 30_000)
  })

  describe('the rename of the units to credits', () => {
    const mapped = (definition: unknown) =>
      Object.entries({ ...unitRenames, ...columnRenames }).reduce(
        (text, [from, to]) => text.replaceAll(new RegExp(`\\b${from}\\b`, 'g'), to),
        String(definition),
      )

    it('renames the three whole-number checks and their stored expressions follow the labels', async () => {
      const before = named.checks.filter((row) => wholeChecks.includes(String(row.conname)))
      expect(before.map((row) => row.conname)).toEqual(wholeChecks)
      for (const row of before) expect(row.definition).toMatch(/'edit'.*'edit_pack'/)
      const after = (await storedChecks()).filter(
        (row) => !planChecks.includes(String(row.conname)),
      )
      // No check is left under an old name, and none was dropped and created anew: each is the
      // expression it was, on its table, with the labels read by their new names.
      expect(after).toEqual(
        before.map((row, index) => ({
          conname: creditChecks[index],
          table: row.table,
          definition: mapped(row.definition),
        })),
      )
      for (const row of after) {
        expect(row.definition).toMatch(/'credit_tariff'.*'credit_pack'/)
        expect(row.definition).not.toMatch(/'edit/)
      }
    })

    it('renames the three plan columns, and the two checks of plans follow them', async () => {
      const { rows: columns } = await schema.db.query(
        `SELECT a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS required
         FROM pg_attribute a
         WHERE a.attrelid = 'plans'::regclass AND NOT a.attisdropped
           AND a.attname = ANY($1::text[])
         ORDER BY a.attnum`,
        [[...Object.keys(columnRenames), ...Object.values(columnRenames)]],
      )
      expect(columns).toEqual(
        Object.values(columnRenames).map((column) => ({
          column,
          type: 'integer',
          required: false,
        })),
      )
      const before = named.checks.filter((row) => planChecks.includes(String(row.conname)))
      expect(before.map((row) => row.conname)).toEqual(planChecks)
      for (const row of before) expect(row.definition).toMatch(/edits_per_month/)
      const after = (await storedChecks()).filter((row) => planChecks.includes(String(row.conname)))
      expect(after).toEqual(before.map((row) => ({ ...row, definition: mapped(row.definition) })))
      for (const row of after)
        expect(row.definition).not.toMatch(/\b(edits_per_month|edits_per_day|pack_edits)\b/)
    })

    it('keeps every plan with its numbers under the new column names', async () => {
      expect(
        named.plans.map((row) => [row.edits_per_month, row.edits_per_day, row.pack_edits]),
      ).toEqual(
        expect.arrayContaining([
          [30, null, null],
          [80, null, null],
          [null, null, 10],
        ]),
      )
      expect((await schema.db.query('SELECT * FROM plans ORDER BY id')).rows).toEqual(
        named.plans.map(
          ({ edits_per_month: month, edits_per_day: day, pack_edits: pack, ...row }) => ({
            ...row,
            credits_per_month: month,
            tasks_per_day: day,
            pack_credits: pack,
          }),
        ),
      )
    })

    it('leaves no way to write an old label or an old column', async () => {
      const workspaceId = await workspace()
      for (const old of Object.keys(unitRenames))
        await refused(() => account(workspaceId, old), INVALID_TEXT_REPRESENTATION)
      for (const old of Object.keys(columnRenames))
        await refused(
          () => schema.db.query(`UPDATE plans SET "${old}" = 1 WHERE id = $1`, [ids.plan]),
          UNDEFINED_COLUMN,
        )
    })

    it('still holds the plans to their checks under the new column names', async () => {
      const id = randomUUID()
      await refused(
        () => insert('plans', { ...planRow(id), credits_per_month: null }),
        CHECK_VIOLATION,
        'plans_kind_fields_check',
      )
      await refused(
        () => insert('plans', { ...planRow(id), kind: 'pack', pack_credits: null }),
        CHECK_VIOLATION,
        'plans_kind_fields_check',
      )
      for (const column of Object.values(columnRenames))
        await refused(
          () => insert('plans', { ...planRow(id), [column]: 0 }),
          CHECK_VIOLATION,
          'plans_limits_check',
        )
      await insert('plans', { ...planRow(id), tasks_per_day: 5 })
    })

    it('carries an account, a hold and an entry of every unit across, their label alone renamed', async () => {
      // The legacy rows of the suite were written before 'edit_pack' existed. Here rows of all
      // three units stand in the database the moment the rename is applied — the purchased
      // unit among them, under its old label.
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'billing_credit_units_rows')
      try {
        await scratch.migrate(change)
        const workspaceId = randomUUID()
        const siteId = randomUUID()
        await insertInto(scratch, 'workspaces', {
          id: workspaceId,
          name: 'Synthetic workspace',
          updated_at: at,
        })
        await insertInto(scratch, 'sites', {
          id: siteId,
          workspace_id: workspaceId,
          name: 'Synthetic site',
          url: `https://${siteId}.invalid`,
          stack: 'wordpress',
          updated_at: at,
        })
        for (const [old, balance, held] of [
          ['edit', '30.00', '1.00'],
          ['edit_pack', '10.00', '2.00'],
          ['rub', '1000.50', '300.25'],
        ] as const) {
          const accountId = randomUUID()
          const taskId = randomUUID()
          await insertInto(scratch, 'billing_accounts', {
            id: accountId,
            workspace_id: workspaceId,
            unit: old,
            balance,
            held,
            updated_at: at,
          })
          await insertInto(scratch, 'tasks', {
            id: taskId,
            workspace_id: workspaceId,
            site_id: siteId,
            updated_at: at,
          })
          await insertInto(scratch, 'credit_holds', {
            id: randomUUID(),
            account_id: accountId,
            unit: old,
            task_id: taskId,
            amount: held,
            expires_at: end,
          })
          await insertInto(scratch, 'credit_ledger', {
            id: randomUUID(),
            account_id: accountId,
            unit: old,
            kind: 'grant',
            amount: balance,
            balance_after: balance,
            idempotency_key: `test:${randomUUID()}`,
          })
        }
        const billingRows = async () => {
          const rows: Record<string, Values[]> = {}
          for (const table of [sources.accounts, sources.holds, sources.ledger])
            rows[table] = (await scratch.db.query(`SELECT * FROM "${table}" ORDER BY id`))
              .rows as Values[]
          return rows
        }
        const units = (rows: Values[]) => rows.map((row) => row.unit).sort()
        const written = await billingRows()
        for (const rows of Object.values(written))
          expect(units(rows)).toEqual(['edit', 'edit_pack', 'rub'])

        await scratch.migrate(credits)

        const renamed = await billingRows()
        for (const rows of Object.values(renamed))
          expect(units(rows)).toEqual(['credit_pack', 'credit_tariff', 'rub'])
        // Every column of every row is what it was, the unit read by its new label.
        expect(renamed).toEqual(
          Object.fromEntries(
            Object.entries(written).map(([table, rows]) => [
              table,
              rows.map((row) => ({ ...row, unit: renamedUnit(row.unit) })),
            ]),
          ),
        )
      } finally {
        await scratch.drop()
      }
    }, 30_000)

    it('applies as one transaction: a statement that fails leaves every old name in place', async () => {
      // `prisma migrate deploy` sends the file statement by statement. A column that already
      // has the new name stops the third rename — after both labels were renamed.
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'billing_credit_units_atomic')
      try {
        await scratch.migrate(change)
        await scratch.db.query('ALTER TABLE plans ADD COLUMN credits_per_month integer')
        const catalogue = async () => ({
          units: await unitLabels(scratch),
          checks: (await shape(scratch)).checks,
        })
        const previous = await catalogue()
        expect(previous.units).toEqual(['edit', 'rub', 'edit_pack'])
        const statements = (await migrationSql(credits))
          .split(/;[ \t]*$/m)
          .map((statement) => statement.trim())
          .filter(Boolean)
        const run = async () => {
          for (const statement of statements) await scratch.db.query(statement)
        }
        await expect(run()).rejects.toMatchObject({ code: DUPLICATE_COLUMN })
        // What the end of the connection does to a transaction that is still open.
        await scratch.db.query('ROLLBACK')
        expect(await catalogue()).toEqual(previous)
      } finally {
        await scratch.drop()
      }
    }, 30_000)
  })

  describe('credit accounts', () => {
    it('accepts purchased credits next to the tariff credits and the wallet of one workspace', async () => {
      const workspaceId = await workspace()
      await account(workspaceId, 'credit_tariff', { balance: '30.00', held: '1.00' })
      await account(workspaceId, 'credit_pack', { balance: '10.00', held: '2.00' })
      await account(workspaceId, 'rub', { balance: '1000.50', held: '300.25' })
      // Still one account per unit.
      await refused(
        () => account(workspaceId, 'credit_pack'),
        UNIQUE_VIOLATION,
        'billing_accounts_workspace_id_unit_key',
      )
    })

    it.each(['credit_tariff', 'credit_pack'])(
      'rejects a fractional balance or hold of %s',
      async (name) => {
        const workspaceId = await workspace()
        for (const values of [{ balance: '1.50' }, { balance: '2.00', held: '0.50' }])
          await refused(
            () => account(workspaceId, name, values),
            CHECK_VIOLATION,
            'billing_accounts_credit_whole_check',
          )
        const id = await account(workspaceId, name, { balance: '2.00' })
        await refused(
          () => update('billing_accounts', id, { balance: '1.99' }),
          CHECK_VIOLATION,
          'billing_accounts_credit_whole_check',
        )
      },
    )

    it.each(['credit_tariff', 'credit_pack'])('reserves %s in whole credits only', async (name) => {
      const id = await account(await workspace(), name, { balance: '10.00' })
      await hold(id, name, '1.00')
      await refused(
        () => hold(id, name, '0.50'),
        CHECK_VIOLATION,
        'credit_holds_credit_whole_check',
      )
    })

    it.each(['credit_tariff', 'credit_pack'])('moves %s in whole credits only', async (name) => {
      const id = await account(await workspace(), name)
      await entry(id, name)
      for (const values of [{ amount: '0.50' }, { amount: '1.00', balance_after: '10.50' }])
        await refused(
          () => entry(id, name, values),
          CHECK_VIOLATION,
          'credit_ledger_credit_whole_check',
        )
    })

    it('keeps kopecks in roubles', async () => {
      const id = await account(await workspace(), 'rub', { balance: '100.50', held: '0.25' })
      await hold(id, 'rub', '0.25')
      await entry(id, 'rub', { amount: '0.50', balance_after: '100.50' })
    })

    it('rejects a hold or an entry that names the other credit account', async () => {
      const workspaceId = await workspace()
      const tariff = await account(workspaceId, 'credit_tariff', { balance: '10.00' })
      const pack = await account(workspaceId, 'credit_pack', { balance: '10.00' })
      await refused(
        () => hold(tariff, 'credit_pack', '1.00'),
        FOREIGN_KEY_VIOLATION,
        'credit_holds_account_id_unit_fkey',
      )
      await refused(
        () => entry(pack, 'credit_tariff'),
        FOREIGN_KEY_VIOLATION,
        'credit_ledger_account_id_unit_fkey',
      )
    })
  })

  describe('subscriptions', () => {
    describe.each(liveSubscriptionStatuses)(
      'next to a %s subscription of the workspace',
      (first) => {
        it.each(subscriptionStatuses)(
          'a second one in %s is refused exactly when the domain calls it live',
          async (second) => {
            const workspaceId = await workspace()
            await subscription({ workspace_id: workspaceId, status: first })
            const another = () => subscription({ workspace_id: workspaceId, status: second })
            if (liveSubscriptionStatuses.includes(second))
              await refused(another, UNIQUE_VIOLATION, 'subscriptions_workspace_live_key')
            else await another()
          },
        )
      },
    )

    it('accepts a live subscription after any number of ended ones', async () => {
      const workspaceId = await workspace()
      for (const status of ['cancelled', 'expired', 'cancelled', 'expired'])
        await subscription({ workspace_id: workspaceId, status })
      const live = await subscription({ workspace_id: workspaceId, status: 'active' })
      // The ended one cannot come back while another is live; it can once that one has ended.
      const ended = await subscription({ workspace_id: workspaceId, status: 'expired' })
      await refused(
        () => update('subscriptions', ended, { status: 'active' }),
        UNIQUE_VIOLATION,
        'subscriptions_workspace_live_key',
      )
      await update('subscriptions', live, { status: 'cancelled' })
      await update('subscriptions', ended, { status: 'active' })
    })

    it('lets a subscription move between the live statuses', async () => {
      const id = await subscription({ workspace_id: await workspace(), status: 'active' })
      await update('subscriptions', id, { status: 'past_due', past_due_since: at })
      await update('subscriptions', id, { status: 'active', past_due_since: null })
    })

    it('gives every workspace its own live subscription', async () => {
      await subscription({ workspace_id: await workspace(), status: 'active' })
      await subscription({ workspace_id: await workspace(), status: 'active' })
    })

    it.each([
      ['ends at its start', start],
      ['ends before its start', new Date(start.getTime() - 1)],
    ])('rejects a period that %s', async (_, periodEnd) => {
      const workspaceId = await workspace()
      await refused(
        () => subscription({ workspace_id: workspaceId, current_period_end: periodEnd }),
        CHECK_VIOLATION,
        'subscriptions_period_check',
      )
      // An ended subscription keeps the rule too.
      const id = await subscription({ workspace_id: workspaceId, status: 'expired' })
      await refused(
        () => update('subscriptions', id, { current_period_start: end }),
        CHECK_VIOLATION,
        'subscriptions_period_check',
      )
    })

    it('requires the anchor of the periods', async () => {
      const workspaceId = await workspace()
      await expect(
        subscription({ workspace_id: workspaceId, period_anchor: null }),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION, column: 'period_anchor' })
    })

    it('schedules a plan that exists and keeps it from deletion', async () => {
      const workspaceId = await workspace()
      await refused(
        () => subscription({ workspace_id: workspaceId, next_plan_id: randomUUID() }),
        FOREIGN_KEY_VIOLATION,
        'subscriptions_next_plan_id_fkey',
      )
      const scheduled = randomUUID()
      await insert('plans', planRow(scheduled))
      const id = await subscription({ workspace_id: workspaceId, next_plan_id: scheduled })
      await refused(
        () => schema.db.query('DELETE FROM plans WHERE id = $1', [scheduled]),
        FOREIGN_KEY_VIOLATION,
        'subscriptions_next_plan_id_fkey',
      )
      // The change is cancelled: nothing holds the plan any more.
      await update('subscriptions', id, { next_plan_id: null })
      await schema.db.query('DELETE FROM plans WHERE id = $1', [scheduled])
    })

    it('stores how the saved payment method is shown and the one being bound', async () => {
      const id = await subscription({
        workspace_id: await workspace(),
        payment_method_id: 'pm-synthetic',
        payment_method_type: 'bank_card',
        payment_method_card_type: 'Mir',
        payment_method_last4: '4444',
        pending_payment_method_id: 'pm-synthetic-next',
        renewal_notice_period_end: end,
      })
      const { rows } = await schema.db.query(
        `SELECT payment_method_type, payment_method_card_type, payment_method_last4,
           pending_payment_method_id, renewal_notice_period_end, past_due_since, next_plan_id
         FROM subscriptions WHERE id = $1`,
        [id],
      )
      expect(rows).toEqual([
        {
          payment_method_type: 'bank_card',
          payment_method_card_type: 'Mir',
          payment_method_last4: '4444',
          pending_payment_method_id: 'pm-synthetic-next',
          renewal_notice_period_end: end,
          past_due_since: null,
          next_plan_id: null,
        },
      ])
    })
  })

  describe('orders', () => {
    it('accepts the paid period of a subscription order and a pack order without one', async () => {
      const workspaceId = await workspace()
      await order({ workspace_id: workspaceId, period_start: start, period_end: end })
      await order({ workspace_id: workspaceId, kind: 'pack', plan_id: ids.pack, amount: '1990.00' })
    })

    it.each([
      ['a start without an end', { period_start: start }],
      ['an end without a start', { period_end: end }],
      ['an end at the start', { period_start: start, period_end: start }],
      ['an end before the start', { period_start: end, period_end: start }],
    ])('rejects a period with %s', async (_, period) => {
      const workspaceId = await workspace()
      await refused(
        () => order({ workspace_id: workspaceId, ...period }),
        CHECK_VIOLATION,
        'orders_period_check',
      )
    })

    it.each(['0.01', '4899.99', '4900.00'])(
      'accepts a refund of %s ₽ of 4900 ₽',
      async (refund) => {
        await order({
          workspace_id: await workspace(),
          status: 'refunded',
          refunded_amount: refund,
          refunded_at: at,
          yookassa_refund_id: `refund-${randomUUID()}`,
        })
      },
    )

    it.each(['4900.01', '0.00', '-1.00'])('rejects a refund of %s ₽ of 4900 ₽', async (refund) => {
      const workspaceId = await workspace()
      await refused(
        () => order({ workspace_id: workspaceId, status: 'refunded', refunded_amount: refund }),
        CHECK_VIOLATION,
        'orders_refunded_amount_check',
      )
    })

    it('records a ЮKassa refund on one order only', async () => {
      const workspaceId = await workspace()
      const refund = `refund-${randomUUID()}`
      const paid = { workspace_id: workspaceId, status: 'paid' }
      await order({ ...paid, yookassa_refund_id: refund })
      await refused(
        () => order({ ...paid, yookassa_refund_id: refund }),
        UNIQUE_VIOLATION,
        'orders_yookassa_refund_id_key',
      )
      // Orders without a refund do not collide.
      await order(paid)
      await order(paid)
    })

    it('refuses a second pending subscription order of the workspace', async () => {
      const workspaceId = await workspace()
      const pending = await order({ workspace_id: workspaceId })
      const second = () => order({ workspace_id: workspaceId, plan_id: ids.otherPlan })
      await refused(second, UNIQUE_VIOLATION, 'orders_workspace_pending_subscription_key')
      // Finished subscription orders and unfinished orders of another kind stand next to it.
      for (const status of ['paid', 'failed', 'refunded', 'cancelled'])
        await order({ workspace_id: workspaceId, status })
      await order({ workspace_id: workspaceId, kind: 'pack', plan_id: ids.pack })
      await order({ workspace_id: workspaceId, kind: 'pack', plan_id: ids.pack })
      await order({ workspace_id: workspaceId, kind: 'topup', plan_id: null })
      // Another workspace has its own unfinished order.
      await order({ workspace_id: await workspace() })
      // Once the first one is finished, the next checkout may start, and it cannot be reopened.
      await update('orders', pending, { status: 'failed', failure_reason: 'card_expired' })
      await second()
      await refused(
        () => update('orders', pending, { status: 'pending' }),
        UNIQUE_VIOLATION,
        'orders_workspace_pending_subscription_key',
      )
    })
  })
})
