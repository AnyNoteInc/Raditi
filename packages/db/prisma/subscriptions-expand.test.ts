// Run the expand migration over a populated legacy catalogue in a disposable private schema.
// DATABASE_URL is optional, as in constraints.test.ts; the public schema is never in search_path.
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const databaseUrl = process.env.DATABASE_URL
const migrationName = '20260929120000_subscriptions_expand'
const migrations = new URL('./migrations/', import.meta.url)

type ProviderRow = { id: string; kind: string; enabled: boolean }
type ModelRow = { provider_id: string; model_class: string; enabled: boolean }

describe.skipIf(!databaseUrl)('subscriptions expand migration', () => {
  const db = new Client({ connectionString: databaseUrl })
  const schema = `subscriptions_expand_${randomUUID().replaceAll('-', '')}`
  const providers = [
    { id: randomUUID(), kind: 'api', enabled: true },
    { id: randomUUID(), kind: 'api', enabled: false },
    { id: randomUUID(), kind: 'subscription', enabled: true },
    { id: randomUUID(), kind: 'subscription', enabled: false },
  ]
  let connected = false
  let schemaCreated = false
  let before: Awaited<ReturnType<typeof snapshot>>

  async function snapshot() {
    return {
      providers: (await db.query<ProviderRow>('SELECT * FROM llm_providers ORDER BY id')).rows,
      models: (await db.query<ModelRow>('SELECT * FROM llm_models ORDER BY id')).rows,
      prices: (await db.query('SELECT * FROM llm_model_prices ORDER BY id')).rows,
      foreignKeys: (
        await db.query(
          `SELECT c.conname, c.conrelid::regclass::text AS source,
                  c.confrelid::regclass::text AS target, pg_get_constraintdef(c.oid) AS definition
             FROM pg_constraint c
             JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = $1 AND c.contype = 'f'
            ORDER BY c.conname`,
          [schema],
        )
      ).rows,
    }
  }

  beforeAll(async () => {
    await db.connect()
    connected = true
    await db.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    // Session scope survives the BEGIN/COMMIT wrappers in the actual migration files.
    // Omitting public also makes a missing fixture table fail instead of touching real data.
    await db.query(`SET search_path TO "${schema}"`)
    const preceding = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort()
    for (const name of preceding) {
      await db.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'))
    }

    for (const provider of providers) {
      await db.query(
        `INSERT INTO llm_providers (id, slug, name, kind, enabled, updated_at)
         VALUES ($1, $2, 'Legacy provider', $3, $4, CURRENT_TIMESTAMP)`,
        [provider.id, provider.id, provider.kind, provider.enabled],
      )
      // Include active models on disabled providers and service models on subscriptions.
      for (const modelClass of ['light', 'standard', 'heavy', 'service']) {
        for (const enabled of [true, false]) {
          const modelId = randomUUID()
          await db.query(
            `INSERT INTO llm_models
               (id, provider_id, slug, name, provider_model_id, model_class, enabled, updated_at)
             VALUES ($1, $2, $3, 'Legacy model', 'upstream-model', $4, $5, CURRENT_TIMESTAMP)`,
            [modelId, provider.id, modelId, modelClass, enabled],
          )
          await db.query(
            `INSERT INTO llm_model_prices
               (id, model_id, effective_from, input_per_1m, cache_read_per_1m,
                cache_write_per_1m, output_per_1m, vat_rate, source_url)
             VALUES
               ($1, $2, '2026-01-01T00:00:00Z', '123.456789', '4.567890', NULL,
                '234.567890', '0.2200', 'https://prices.example/old'),
               ($3, $2, '2026-06-01T00:00:00Z', '456.789012', NULL, '12.345678',
                '567.890123', '0.2200', 'https://prices.example/new')`,
            [randomUUID(), modelId, randomUUID()],
          )
        }
      }
    }

    before = await snapshot()
    await db.query(await readFile(new URL(`${migrationName}/migration.sql`, migrations), 'utf8'))
  }, 30_000)

  beforeEach(async () => {
    await db.query('BEGIN')
  })
  afterEach(async () => {
    if (connected) await db.query('ROLLBACK')
  })
  afterAll(async () => {
    if (!connected) return
    try {
      if (schemaCreated) {
        // A failed migration can leave its transaction aborted; clear it before cleanup.
        await db.query('ROLLBACK')
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      }
    } finally {
      await db.end()
    }
  })

  it('disables API and service models while preserving subscription states, history and FKs', async () => {
    const after = await snapshot()
    expect(after.providers).toEqual(
      before.providers.map((provider) => ({
        ...provider,
        enabled: provider.kind === 'api' ? false : provider.enabled,
      })),
    )
    const apiIds = new Set(
      before.providers.filter((row) => row.kind === 'api').map((row) => row.id),
    )
    expect(after.models).toEqual(
      before.models.map((model) => ({
        ...model,
        enabled:
          apiIds.has(model.provider_id) || model.model_class === 'service' ? false : model.enabled,
        reserve_output_tokens: 32000,
      })),
    )
    expect(after.prices).toEqual(before.prices)
    expect(before.prices).toHaveLength(64)
    expect(after.foreignKeys).toEqual(before.foreignKeys)
    expect(before.foreignKeys.length).toBeGreaterThan(0)
    expect(
      (await db.query(`SELECT enum_range(NULL::"ModelClass")::text[] AS classes`)).rows,
    ).toEqual([{ classes: ['light', 'standard', 'heavy', 'service'] }])
  })

  function insertModel(reserve?: number | null) {
    const hasReserve = reserve !== undefined
    return db.query<{ reserve_output_tokens: number }>(
      `INSERT INTO llm_models
         (id, provider_id, slug, name, model_class, updated_at${hasReserve ? ', reserve_output_tokens' : ''})
       VALUES ($1, $2, 'new-model', 'New model', 'light', CURRENT_TIMESTAMP${hasReserve ? ', $3' : ''})
       RETURNING reserve_output_tokens`,
      hasReserve ? [randomUUID(), providers[2]!.id, reserve] : [randomUUID(), providers[2]!.id],
    )
  }

  it('defaults a new model to 32000 when an older writer omits the reserve', async () => {
    expect((await insertModel()).rows).toEqual([{ reserve_output_tokens: 32000 }])
  })

  it.each([1024, 131072])('accepts the inclusive reserve boundary %i', async (reserve) => {
    expect((await insertModel(reserve)).rows).toEqual([{ reserve_output_tokens: reserve }])
  })

  it.each([1023, 131073])('rejects reserve %i outside the supported range', async (reserve) => {
    await expect(insertModel(reserve)).rejects.toMatchObject({
      code: '23514',
      constraint: 'llm_models_reserve_output_tokens_check',
    })
  })

  it('rejects an explicit null reserve', async () => {
    await expect(insertModel(null)).rejects.toMatchObject({
      code: '23502',
      column: 'reserve_output_tokens',
    })
  })
})
