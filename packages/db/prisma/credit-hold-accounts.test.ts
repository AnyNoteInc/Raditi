// Reserves in credits in the database (docs/plan/37-billing-plan.md, «Что меняется в базе»;
// spec §16): the migration credit_hold_accounts gives the unique key of a reserve its account,
// adds the moment of placing and the table of the sites whose gift is claimed. Runs the real
// migrations in disposable schemas over reserves written before them.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the reserves by account. */
const before = '20261011100000_credit_rates'
const migration = '20261011120000_credit_hold_accounts'
const at = new Date('2026-10-11T09:00:00Z')
const end = new Date('2026-11-11T09:00:00Z')
const FOREIGN_KEY_VIOLATION = '23503'
const NOT_NULL_VIOLATION = '23502'
const UNIQUE_VIOLATION = '23505'
type Values = Record<string, unknown>

const migrationSql = () =>
  readFile(new URL(`./migrations/${migration}/migration.sql`, import.meta.url), 'utf8')

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

  async function workspace() {
    const id = randomUUID()
    await insert('workspaces', { id, name: 'Synthetic workspace', updated_at: at })
    return id
  }

  return {
    insert,
    workspace,

    /** A workspace with its three credit accounts and a task on a site of its own. */
    async funded() {
      const workspaceId = await workspace()
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
        tariff: await account('credit_tariff'),
        gift: await account('credit_gift'),
        pack: await account('credit_pack'),
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
      return { workspaceId, accounts, task }
    },

    async hold(accountId: string, unit: string, taskId: string, values: Values = {}) {
      const id = randomUUID()
      await insert('credit_holds', {
        id,
        account_id: accountId,
        unit,
        task_id: taskId,
        amount: '5.00',
        expires_at: end,
        ...values,
      })
      return id
    },

    claim: (hostKey: string, workspaceId: string) =>
      insert('gift_site_claims', { host_key: hostKey, workspace_id: workspaceId }),

    holds: async () =>
      (await target.db.query(`SELECT * FROM credit_holds ORDER BY id`)).rows as Values[],
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

const refused = (act: () => Promise<unknown>, code: string, constraint?: string) =>
  expect(act()).rejects.toMatchObject(constraint ? { code, constraint } : { code })

describe.skipIf(!databaseUrl)('the migration of reserves by account', () => {
  let schema: MigratedSchema
  let rows: ReturnType<typeof rowsOf>
  let holdsBefore: Values[]
  let indexesBefore: Record<string, string>

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'credit_hold_accounts')
    await schema.migrate(before)
    rows = rowsOf(schema)
    // Reserves of the old shape, one per attempt: an active one stamped inside its period, one
    // stamped with the last millisecond of a period that ended, and a settled one.
    const { accounts, task } = await rows.funded()
    await rows.hold(accounts.tariff, 'credit_tariff', await task(), {
      created_at: new Date('2026-10-04T12:00:00.000Z'),
    })
    await rows.hold(accounts.tariff, 'credit_tariff', await task(), {
      created_at: new Date('2026-10-18T08:59:59.999Z'),
    })
    await rows.hold(accounts.pack, 'credit_pack', await task(), {
      status: 'captured',
      created_at: new Date('2026-09-20T07:30:00.000Z'),
      settled_at: new Date('2026-09-20T07:50:00.000Z'),
    })
    holdsBefore = await rows.holds()
    indexesBefore = await indexesOf(schema, 'credit_holds')
    await schema.migrate(migration)
  }, 60_000)

  afterAll(async () => {
    await schema?.drop()
  })

  it('gives every reserve written before it the moment it was counted by, and changes nothing else', async () => {
    expect(holdsBefore).toHaveLength(3)
    expect(await rows.holds()).toEqual(
      holdsBefore.map((row) => ({ ...row, placed_at: row.created_at })),
    )
  })

  it('replaces the unique key of an attempt by the key of an attempt and an account', async () => {
    expect(indexesBefore.credit_holds_task_id_attempt_key).toBe(
      'CREATE UNIQUE INDEX credit_holds_task_id_attempt_key ON credit_holds USING btree (task_id, attempt)',
    )
    const indexes = await indexesOf(schema, 'credit_holds')
    expect(indexes.credit_holds_task_id_attempt_key).toBeUndefined()
    expect(indexes.credit_holds_task_id_attempt_account_id_key).toBe(
      'CREATE UNIQUE INDEX credit_holds_task_id_attempt_account_id_key ON credit_holds USING btree (task_id, attempt, account_id)',
    )
    // The count of the day reads the reserves of an account by the moment of placing.
    expect(indexes.credit_holds_account_id_placed_at_idx).toBe(
      'CREATE INDEX credit_holds_account_id_placed_at_idx ON credit_holds USING btree (account_id, placed_at)',
    )
    expect(Object.keys(indexes).sort()).toEqual(
      [
        ...Object.keys(indexesBefore).filter((name) => name !== 'credit_holds_task_id_attempt_key'),
        'credit_holds_account_id_placed_at_idx',
        'credit_holds_task_id_attempt_account_id_key',
      ].sort(),
    )
  })

  it('accepts the rows of one attempt on the three accounts, one row per account', async () => {
    const { accounts, task } = await rows.funded()
    const taskId = await task()
    await rows.hold(accounts.tariff, 'credit_tariff', taskId)
    await rows.hold(accounts.gift, 'credit_gift', taskId)
    await rows.hold(accounts.pack, 'credit_pack', taskId)
    await refused(
      () => rows.hold(accounts.gift, 'credit_gift', taskId),
      UNIQUE_VIOLATION,
      'credit_holds_task_id_attempt_account_id_key',
    )
    // The next attempt of the task has rows of its own on the same accounts.
    await rows.hold(accounts.tariff, 'credit_tariff', taskId, { attempt: 2 })
    await rows.hold(accounts.gift, 'credit_gift', taskId, { attempt: 2 })
    await refused(
      () => rows.hold(accounts.tariff, 'credit_tariff', taskId, { attempt: 2 }),
      UNIQUE_VIOLATION,
      'credit_holds_task_id_attempt_account_id_key',
    )
  })

  it('stamps a new reserve with the moment it is written unless the moment is given', async () => {
    const { accounts, task } = await rows.funded()
    const stamped = await rows.hold(accounts.tariff, 'credit_tariff', await task())
    const given = await rows.hold(accounts.tariff, 'credit_tariff', await task(), {
      created_at: new Date('2026-10-18T08:59:59.999Z'),
      placed_at: new Date('2026-10-18T09:02:00.000Z'),
    })
    const byId = new Map((await rows.holds()).map((row) => [row.id, row]))
    expect(byId.get(stamped)?.placed_at).toEqual(byId.get(stamped)?.created_at)
    expect(byId.get(stamped)?.placed_at).toBeInstanceOf(Date)
    // The two stamps are told apart: the period by one, the day by the other.
    expect(byId.get(given)).toMatchObject({
      created_at: new Date('2026-10-18T08:59:59.999Z'),
      placed_at: new Date('2026-10-18T09:02:00.000Z'),
    })
    await refused(
      async () => rows.hold(accounts.tariff, 'credit_tariff', await task(), { placed_at: null }),
      NOT_NULL_VIOLATION,
    )
  })

  it('keeps one claim of a gift per site, whichever workspace asks next', async () => {
    const first = await rows.workspace()
    const second = await rows.workspace()
    await rows.claim('example.ru', first)
    await refused(() => rows.claim('example.ru', second), UNIQUE_VIOLATION, 'gift_site_claims_pkey')
    await refused(() => rows.claim('example.ru', first), UNIQUE_VIOLATION, 'gift_site_claims_pkey')
    // What a reserve does: the row of the first claim stays as it is.
    const kept = await schema.db.query(
      `INSERT INTO gift_site_claims (host_key, workspace_id) VALUES ($1, $2)
       ON CONFLICT (host_key) DO NOTHING`,
      ['example.ru', second],
    )
    expect(kept.rowCount).toBe(0)
    const claims = await schema.db.query(
      `SELECT workspace_id, created_at FROM gift_site_claims WHERE host_key = $1`,
      ['example.ru'],
    )
    expect(claims.rows).toEqual([{ workspace_id: first, created_at: expect.any(Date) }])
    // A workspace may claim several sites; the port keeps local sites apart.
    await rows.claim('localhost:8080', first)
    await rows.claim('localhost:8081', second)
  })

  it('ties a claim to a workspace that exists and keeps that workspace', async () => {
    await refused(
      () => rows.claim('nobody.example.ru', randomUUID()),
      FOREIGN_KEY_VIOLATION,
      'gift_site_claims_workspace_id_fkey',
    )
    const workspaceId = await rows.workspace()
    await rows.claim('kept.example.ru', workspaceId)
    await refused(
      () => schema.db.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]),
      FOREIGN_KEY_VIOLATION,
      'gift_site_claims_workspace_id_fkey',
    )
    const indexes = await indexesOf(schema, 'gift_site_claims')
    expect(indexes.gift_site_claims_workspace_id_idx).toBe(
      'CREATE INDEX gift_site_claims_workspace_id_idx ON gift_site_claims USING btree (workspace_id)',
    )
  })

  it('applies as a whole or not at all, also when it is sent statement by statement', async () => {
    const scratch = await createMigratedSchema(databaseUrl ?? '', 'credit_hold_accounts_split')
    try {
      await scratch.migrate(before)
      const scratchRows = rowsOf(scratch)
      const { accounts, task } = await scratchRows.funded()
      await scratchRows.hold(accounts.tariff, 'credit_tariff', await task())
      const previous = await indexesOf(scratch, 'credit_holds')

      // A table of that name stands in the way of the last statements: everything before them
      // — the key that was dropped, the column that was added — is taken back with them.
      await scratch.db.query(`CREATE TABLE gift_site_claims (host_key text)`)
      const run = async () => {
        for (const statement of statementsOf(await migrationSql()))
          await scratch.db.query(statement)
      }
      await expect(run()).rejects.toMatchObject({ code: '42P07' })
      // What the end of the connection does to a transaction that is still open.
      await scratch.db.query('ROLLBACK')
      expect(await indexesOf(scratch, 'credit_holds')).toEqual(previous)
      expect(Object.keys((await scratchRows.holds())[0] ?? {})).not.toContain('placed_at')

      // Without the obstacle the same statements apply.
      await scratch.db.query(`DROP TABLE gift_site_claims`)
      await run()
      const [hold] = await scratchRows.holds()
      expect(hold?.placed_at).toEqual(hold?.created_at)
      expect(await indexesOf(scratch, 'gift_site_claims')).toHaveProperty('gift_site_claims_pkey')
    } finally {
      await scratch.drop()
    }
  }, 60_000)
})
