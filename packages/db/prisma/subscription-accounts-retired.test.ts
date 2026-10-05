// A retired subscription account keeps its row for the history that references it, but must
// not reserve its label or provider account for ever: the same subscription returns to the pool
// as a new row. Runs the real migrations in a disposable schema over rows written before the
// change.
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const before = '20261001130000_mcp_content_retention'
const change = '20261002100000_subscription_accounts_retired_identity'
const at = new Date('2026-10-02T12:00:00Z')
const UNIQUE_VIOLATION = '23505'

describe.skipIf(!databaseUrl)('retired subscription accounts release their identity', () => {
  let schema: MigratedSchema
  const provider = randomUUID()
  const otherProvider = randomUUID()
  const driver = `test-${randomUUID().slice(0, 8)}`
  const legacy = { active: randomUUID(), retired: randomUUID() }
  let legacyRows: Record<string, unknown>[]
  let migratedRows: Record<string, unknown>[]

  async function account(values: Record<string, unknown> = {}) {
    const id = randomUUID()
    const credential = randomUUID()
    await schema.db.query(
      `INSERT INTO credential_refs (id, kind, vault_path, updated_at)
       VALUES ($1, 'subscription', $2, $3)`,
      [credential, `subs/synthetic/${id}`, at],
    )
    const row = {
      id,
      provider_id: provider,
      driver_id: driver,
      label: `Synthetic ${id}`,
      credential_ref_id: credential,
      plan: 'synthetic',
      max_concurrent_turns: 1,
      max_concurrent_requests: 2,
      updated_at: at,
      ...values,
    }
    const columns = Object.keys(row)
    await schema.db.query(
      `INSERT INTO subscription_accounts (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    )
    return row.id
  }

  const retire = (id: string) =>
    schema.db.query(`UPDATE subscription_accounts SET status = 'retired' WHERE id = $1`, [id])

  const rows = async () =>
    (await schema.db.query('SELECT * FROM subscription_accounts ORDER BY id')).rows

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'retired_accounts')
    await schema.migrate(before)
    for (const id of [provider, otherProvider])
      await schema.db.query(
        `INSERT INTO llm_providers (id, slug, name, kind, updated_at)
         VALUES ($1, $2, 'Synthetic subscription', 'subscription', $3)`,
        [id, id, at],
      )
    await schema.db.query(
      `INSERT INTO agent_drivers (id, image, capabilities, updated_at)
       VALUES ($1, 'synthetic/agent:test', '{}', $2)`,
      [driver, at],
    )
    // Written under the unconditional indexes: the migration must keep both as they are.
    await account({ id: legacy.active, label: 'Legacy active', external_account_id: 'legacy-a' })
    await account({ id: legacy.retired, label: 'Legacy retired', external_account_id: 'legacy-r' })
    await retire(legacy.retired)
    legacyRows = await rows()
    await schema.migrate(change)
    migratedRows = await rows()
    await schema.migrate()
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

  it('keeps the accounts written before the migration unchanged', async () => {
    expect(migratedRows).toEqual(legacyRows)
    // A later migration may add columns of its own: only the ones of these rows are compared.
    const columns = Object.keys(legacyRows[0]!)
    expect(
      (await rows()).map((row) =>
        Object.fromEntries(columns.map((column) => [column, row[column]])),
      ),
    ).toEqual(legacyRows)
  })

  it('admits the same label and provider account again once the earlier row is retired', async () => {
    const identity = { label: 'Legacy retired', external_account_id: 'legacy-r' }
    const again = await account(identity)
    expect(
      (
        await schema.db.query(
          `SELECT id, status FROM subscription_accounts WHERE label = $1 ORDER BY status`,
          [identity.label],
        )
      ).rows,
    ).toEqual([
      { id: again, status: 'active' },
      { id: legacy.retired, status: 'retired' },
    ])
    // The history may hold any number of retired rows of one subscription.
    await retire(again)
    await account(identity)
  })

  it.each([
    ['label', { label: 'Legacy active' }, 'subscription_accounts_label_key'],
    ['provider account', { external_account_id: 'legacy-a' }, 'subscription_accounts_external_key'],
  ])('still refuses a second account with the %s of one in the pool', async (_, twin, index) => {
    await expect(account(twin)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: index,
    })
  })

  it('reserves the identity of a banned account: only retirement releases it', async () => {
    await schema.db.query(`UPDATE subscription_accounts SET status = 'banned' WHERE id = $1`, [
      legacy.active,
    ])
    await expect(account({ label: 'Legacy active' })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'subscription_accounts_label_key',
    })
    await schema.db.query('ROLLBACK')
    await schema.db.query('BEGIN')
    await schema.db.query(`UPDATE subscription_accounts SET status = 'banned' WHERE id = $1`, [
      legacy.active,
    ])
    await expect(account({ external_account_id: 'legacy-a' })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'subscription_accounts_external_key',
    })
  })

  it('refuses to bring a retired account back beside its successor', async () => {
    await account({ label: 'Legacy retired', external_account_id: 'legacy-r' })
    await expect(
      schema.db.query(`UPDATE subscription_accounts SET status = 'active' WHERE id = $1`, [
        legacy.retired,
      ]),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
  })

  it('scopes the provider account to its provider and leaves accounts without one alone', async () => {
    await account({ provider_id: otherProvider, external_account_id: 'legacy-a' })
    await account({ external_account_id: null })
    await account({ external_account_id: null })
  })
})
