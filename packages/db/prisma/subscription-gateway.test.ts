// Exercise the real migration in disposable schemas, never the database's public schema.
// DATABASE_URL is explicit and optional; no local .env or existing application rows are used.
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const databaseUrl = process.env.DATABASE_URL
const migrationName = '20260929130000_subscription_gateway'
const migrations = new URL('./migrations/', import.meta.url)
const at = new Date('2026-09-30T12:00:00Z')
const expires = new Date('2026-09-30T12:10:00Z')
const validUntil = new Date('2026-09-30T12:15:00Z')
type Values = Record<string, unknown>

function insert(db: Client, table: string, values: Values) {
  const columns = Object.keys(values)
  return db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`,
    Object.values(values),
  )
}

function update(db: Client, table: string, id: string, values: Values) {
  const columns = Object.keys(values)
  return db.query(
    `UPDATE "${table}" SET ${columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')}
     WHERE id = $1 RETURNING *`,
    [id, ...Object.values(values)],
  )
}

async function precedingMigrations(db: Client) {
  const names = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort()
  for (const name of names) {
    await db.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'))
  }
}

function gatewayMigration() {
  return readFile(new URL(`${migrationName}/migration.sql`, migrations), 'utf8')
}

async function createLegacyFixture(db: Client) {
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
    turn: randomUUID(),
    driver: `test-${randomUUID().slice(0, 8)}`,
    credential: randomUUID(),
    provider: randomUUID(),
    model: randomUUID(),
    otherModel: randomUUID(),
    price: randomUUID(),
    otherPrice: randomUUID(),
  }
  await insert(db, 'workspaces', { id: ids.workspace, name: 'Synthetic workspace', updated_at: at })
  await insert(db, 'sites', {
    id: ids.site,
    workspace_id: ids.workspace,
    name: 'Synthetic site',
    url: 'https://site.invalid',
    stack: 'wordpress',
    updated_at: at,
  })
  await insert(db, 'tasks', {
    id: ids.task,
    workspace_id: ids.workspace,
    site_id: ids.site,
    model_class: 'service',
    updated_at: at,
  })
  await insert(db, 'agent_drivers', {
    id: ids.driver,
    image: 'synthetic/agent:test',
    capabilities: {},
    updated_at: at,
  })
  await insert(db, 'credential_refs', {
    id: ids.credential,
    kind: 'subscription',
    vault_path: 'subs/synthetic/test',
    updated_at: at,
  })
  await insert(db, 'llm_providers', {
    id: ids.provider,
    slug: 'synthetic-provider',
    name: 'Synthetic subscription',
    kind: 'subscription',
    updated_at: at,
  })
  for (const [id, priceId] of [
    [ids.model, ids.price],
    [ids.otherModel, ids.otherPrice],
  ] as const) {
    await insert(db, 'llm_models', {
      id,
      provider_id: ids.provider,
      slug: id,
      name: 'Historical model',
      model_class: 'service',
      enabled: false,
      updated_at: at,
    })
    await insert(db, 'llm_model_prices', {
      id: priceId,
      model_id: id,
      effective_from: at,
      input_per_1m: '123.456789',
      cache_read_per_1m: '0.000000',
      output_per_1m: '456.789012',
      vat_rate: '0.2200',
      source_url: 'https://prices.invalid/synthetic',
    })
  }
  await insert(db, 'task_turns', {
    id: ids.turn,
    task_id: ids.task,
    turn_no: 1,
    driver_id: ids.driver,
    image: 'synthetic/agent:test',
    model_id: ids.model,
    litellm_key_hash: 'f'.repeat(64),
  })
  return ids
}

type Fixture = Awaited<ReturnType<typeof createLegacyFixture>>

function legacyUsage(ids: Fixture): Values {
  return {
    id: randomUUID(),
    gateway_call_id: 'legacy-call-not-a-uuid',
    task_id: ids.task,
    turn_id: ids.turn,
    driver_id: ids.driver,
    model_id: ids.model,
    price_id: ids.price,
    input_uncached_tokens: 100,
    output_tokens: 20,
    cost_rub: '0.0214814591',
    occurred_at: at,
  }
}

async function foreignKeys(db: Client, schema: string) {
  return (
    await db.query<{ name: string; definition: string }>(
      `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.contype = 'f' ORDER BY c.conname`,
      [schema],
    )
  ).rows
}

describe.skipIf(!databaseUrl)('subscription gateway migration guard', () => {
  it.each(['subscription_accounts', 'token_usage'] as const)(
    'refuses a nonempty legacy %s atomically, preserving the rows and old schema',
    async (table) => {
      const db = new Client({ connectionString: databaseUrl })
      const schema = `gateway_guard_${randomUUID().replaceAll('-', '')}`
      let connected = false
      let created = false
      try {
        await db.connect()
        connected = true
        await db.query(`CREATE SCHEMA "${schema}"`)
        created = true
        await db.query(`SET search_path TO "${schema}"`)
        await precedingMigrations(db)
        const ids = await createLegacyFixture(db)
        if (table === 'subscription_accounts') {
          await insert(db, table, {
            id: randomUUID(),
            provider_id: ids.provider,
            label: 'Legacy account without driver',
            credential_ref_id: ids.credential,
            limits: { preserved: true },
            updated_at: at,
          })
        } else {
          await insert(db, table, legacyUsage(ids))
        }
        const before = (await db.query(`SELECT * FROM "${table}"`)).rows
        const oldFks = await foreignKeys(db, schema)
        await expect(db.query(await gatewayMigration())).rejects.toMatchObject({
          code: 'P0001',
          message: `${table} is not empty`,
        })
        // The migration has its own transaction. Clear its aborted state before inspecting.
        await db.query('ROLLBACK')
        expect((await db.query(`SELECT * FROM "${table}"`)).rows).toEqual(before)
        expect(await foreignKeys(db, schema)).toEqual(oldFks)
        expect((await db.query(`SELECT to_regclass('llm_keys') AS keys`)).rows).toEqual([
          { keys: null },
        ])
        expect(
          (
            await db.query(
              `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'workspaces' AND column_name = 'data_class'`,
              [schema],
            )
          ).rows,
        ).toEqual([])
        expect(
          (
            await db.query(
              `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1 AND t.typname = 'LlmCallState'`,
              [schema],
            )
          ).rows,
        ).toEqual([])
      } finally {
        if (connected) {
          try {
            await db.query('ROLLBACK')
            if (created) await db.query(`DROP SCHEMA "${schema}" CASCADE`)
          } finally {
            await db.end()
          }
        }
      }
    },
    30_000,
  )
})

describe.skipIf(!databaseUrl)('subscription gateway PostgreSQL constraints', () => {
  const db = new Client({ connectionString: databaseUrl })
  const schema = `gateway_constraints_${randomUUID().replaceAll('-', '')}`
  let connected = false
  let created = false
  let ids: Fixture
  let oldFks: Awaited<ReturnType<typeof foreignKeys>>
  let oldRows: Awaited<ReturnType<typeof preservedRows>>
  let accountId: string
  let keyId: string
  let callId: string

  async function preservedRows() {
    return {
      providers: (await db.query('SELECT * FROM llm_providers ORDER BY id')).rows,
      models: (await db.query('SELECT * FROM llm_models ORDER BY id')).rows,
      prices: (await db.query('SELECT * FROM llm_model_prices ORDER BY id')).rows,
      tasks: (await db.query('SELECT * FROM tasks ORDER BY id')).rows,
      turns: (await db.query('SELECT * FROM task_turns ORDER BY id')).rows,
    }
  }

  function account(extra: Values = {}) {
    return insert(db, 'subscription_accounts', {
      id: randomUUID(),
      provider_id: ids.provider,
      driver_id: ids.driver,
      label: 'Synthetic account',
      credential_ref_id: ids.credential,
      plan: 'synthetic',
      max_concurrent_turns: 1,
      max_concurrent_requests: 2,
      updated_at: at,
      ...extra,
    })
  }

  function key(extra: Values = {}) {
    return insert(db, 'llm_keys', {
      id: randomUUID(),
      key_hash: 'a'.repeat(64),
      task_id: ids.task,
      task_attempt: 1,
      session_id: 'synthetic-session',
      turn_no: 1,
      first_epoch: 1,
      driver_id: ids.driver,
      model_id: ids.model,
      subscription_account_id: accountId,
      budget_rub: '135.0000000000',
      issued_at: at,
      expires_at: expires,
      valid_until: validUntil,
      ...extra,
    })
  }

  function call(extra: Values = {}) {
    return insert(db, 'llm_calls', {
      id: randomUUID(),
      key_id: keyId,
      subscription_account_id: accountId,
      model_id: ids.model,
      route: '/synthetic/responses',
      reserved_rub: '10.1234567890',
      request_bytes: 100,
      started_at: at,
      ...extra,
    })
  }

  function usage(extra: Values = {}) {
    return insert(db, 'token_usage', {
      ...legacyUsage(ids),
      gateway_call_id: callId,
      turn_id: null,
      key_id: keyId,
      subscription_account_id: accountId,
      task_attempt: 1,
      ...extra,
    })
  }

  function binding(extra: Values = {}) {
    return insert(db, 'task_account_bindings', {
      task_id: ids.task,
      driver_id: ids.driver,
      subscription_account_id: accountId,
      ...extra,
    })
  }

  function clearance(extra: Values = {}) {
    return insert(db, 'cross_border_clearances', {
      id: randomUUID(),
      provider_id: ids.provider,
      countries: 'US,KZ',
      notice22_ref: 'synthetic-22',
      notice22_date: '2026-09-01',
      recipients_assessed_on: '2026-09-02',
      notice12_ref: 'synthetic-12',
      notice12_received_on: '2026-09-03',
      transfer_allowed_from: '2026-09-30',
      documents: 'synthetic-documents-v1',
      recorded_by: 'synthetic-operator',
      ...extra,
    })
  }

  function check(query: Promise<unknown>, constraint?: string) {
    return expect(query).rejects.toMatchObject({
      code: '23514',
      ...(constraint ? { constraint } : {}),
    })
  }

  beforeAll(async () => {
    await db.connect()
    connected = true
    await db.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await db.query(`SET search_path TO "${schema}"`)
    await precedingMigrations(db)
    ids = await createLegacyFixture(db)
    oldFks = await foreignKeys(db, schema)
    oldRows = await preservedRows()
    await db.query(await gatewayMigration())
  }, 30_000)

  beforeEach(async () => {
    await db.query('BEGIN')
    accountId = randomUUID()
    keyId = randomUUID()
    callId = randomUUID()
    await account({ id: accountId })
    await key({ id: keyId })
    await call({ id: callId })
  })

  afterEach(async () => {
    if (connected) await db.query('ROLLBACK')
  })

  afterAll(async () => {
    if (!connected) return
    try {
      await db.query('ROLLBACK')
      if (created) await db.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await db.end()
    }
  })

  it('preserves existing catalog prices, service-class tasks and old turn columns', async () => {
    expect(await preservedRows()).toEqual(oldRows)
    expect(
      (await db.query(`SELECT enum_range(NULL::"ModelClass")::text[] AS classes`)).rows,
    ).toEqual([{ classes: ['light', 'standard', 'heavy', 'service'] }])
    expect((await db.query('SELECT limits FROM subscription_accounts')).rows).toEqual([
      { limits: {} },
    ])
  })

  it('preserves every legacy FK except the replaced price/model relation', async () => {
    const current = await foreignKeys(db, schema)
    for (const fk of oldFks.filter(({ name }) => name !== 'token_usage_price_id_fkey')) {
      expect(current).toContainEqual(fk)
    }
    expect(current.map(({ name }) => name)).not.toContain('token_usage_price_id_fkey')
    expect(current).toContainEqual({
      name: 'token_usage_price_id_model_id_fkey',
      definition:
        'FOREIGN KEY (price_id, model_id) REFERENCES llm_model_prices(id, model_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    })
  })

  it('marks existing and newly created workspaces client unless synthetic is explicit', async () => {
    expect(
      (await db.query('SELECT data_class FROM workspaces WHERE id = $1', [ids.workspace])).rows,
    ).toEqual([{ data_class: 'client' }])
    expect(
      (
        await insert(db, 'workspaces', {
          id: randomUUID(),
          name: 'Default workspace',
          updated_at: at,
        })
      ).rows[0],
    ).toMatchObject({ data_class: 'client' })
    expect(
      (
        await insert(db, 'workspaces', {
          id: randomUUID(),
          name: 'Synthetic workspace',
          updated_at: at,
          data_class: 'synthetic',
        })
      ).rows[0],
    ).toMatchObject({ data_class: 'synthetic' })
  })

  describe('subscription account state', () => {
    it('starts with active/ok state, empty windows/identity and zero counters', async () => {
      expect(
        (await db.query('SELECT * FROM subscription_accounts WHERE id = $1', [accountId])).rows[0],
      ).toMatchObject({
        status: 'active',
        health: 'ok',
        enabled: false,
        limit_windows: [],
        client_identity: {},
        credential_version: 0,
        refresh_failures: 0,
        usage_missing_streak: 0,
        headroom_pct: null,
      })
    })

    it('requires an explicit shell for every account', async () => {
      await expect(
        update(db, 'subscription_accounts', accountId, { driver_id: null }),
      ).rejects.toMatchObject({ code: '23502', column: 'driver_id' })
    })

    it.each([
      { max_concurrent_turns: 1, max_concurrent_requests: 1 },
      { max_concurrent_turns: 8, max_concurrent_requests: 16 },
    ])('accepts inclusive concurrency boundaries %j', async (values) => {
      expect((await update(db, 'subscription_accounts', accountId, values)).rows[0]).toMatchObject(
        values,
      )
    })

    it.each([
      { max_concurrent_turns: 0 },
      { max_concurrent_turns: 9 },
      { max_concurrent_requests: 0 },
      { max_concurrent_requests: 17 },
    ])('rejects unsupported concurrency %j', async (values) => {
      await check(
        update(db, 'subscription_accounts', accountId, values),
        'subscription_accounts_concurrency_check',
      )
    })

    it.each([null, '0.00', '100.00'])('accepts headroom %s', async (headroom) => {
      expect(
        (await update(db, 'subscription_accounts', accountId, { headroom_pct: headroom })).rows[0],
      ).toMatchObject({ headroom_pct: headroom })
    })

    it.each(['-0.01', '100.01'])('rejects headroom %s', async (headroom) => {
      await check(
        update(db, 'subscription_accounts', accountId, { headroom_pct: headroom }),
        'subscription_accounts_headroom_check',
      )
    })

    it.each([
      { limit_windows: '{}' },
      { limit_windows: 'null' },
      { client_identity: '[]' },
      { client_identity: 'null' },
    ])('rejects non-array windows or non-object identity %j', async (values) => {
      await check(
        update(db, 'subscription_accounts', accountId, values),
        'subscription_accounts_json_check',
      )
    })

    it.each(['credential_version', 'refresh_failures', 'usage_missing_streak'] as const)(
      'rejects a negative %s',
      async (column) => {
        await check(
          update(db, 'subscription_accounts', accountId, { [column]: -1 }),
          'subscription_accounts_numbers_check',
        )
      },
    )

    it('rejects a retired account that remains enabled', async () => {
      await check(
        update(db, 'subscription_accounts', accountId, { status: 'retired', enabled: true }),
        'subscription_accounts_retired_check',
      )
    })

    it('accepts retiring an account together with disabling it', async () => {
      expect(
        (
          await update(db, 'subscription_accounts', accountId, {
            status: 'retired',
            enabled: false,
          })
        ).rows[0],
      ).toMatchObject({ status: 'retired', enabled: false })
    })

    it('forbids two accounts with the same operator label', async () => {
      const credential = randomUUID()
      await insert(db, 'credential_refs', {
        id: credential,
        kind: 'subscription',
        vault_path: 'subs/synthetic/another',
        updated_at: at,
      })
      await expect(account({ credential_ref_id: credential })).rejects.toMatchObject({
        code: '23505',
        constraint: 'subscription_accounts_label_key',
      })
    })

    it('forbids duplicate external identities within a provider', async () => {
      await update(db, 'subscription_accounts', accountId, {
        external_account_id: 'synthetic-external',
      })
      const credential = randomUUID()
      await insert(db, 'credential_refs', {
        id: credential,
        kind: 'subscription',
        vault_path: 'subs/synthetic/another',
        updated_at: at,
      })
      await expect(
        account({
          label: 'Another account',
          credential_ref_id: credential,
          external_account_id: 'synthetic-external',
        }),
      ).rejects.toMatchObject({ code: '23505', constraint: 'subscription_accounts_external_key' })
    })
  })

  describe('turn key and binding', () => {
    it.each(['0.0100000000', '750.0000000000'])('accepts positive budget %s', async (budget) => {
      expect((await update(db, 'llm_keys', keyId, { budget_rub: budget })).rows[0]).toMatchObject({
        budget_rub: budget,
      })
    })

    it.each(['0', '-0.0000000001', '750.0000000001'])('rejects budget %s', async (budget) => {
      await check(update(db, 'llm_keys', keyId, { budget_rub: budget }))
    })

    it.each(['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])(
      'rejects an invalid key hash %s',
      async (hash) => {
        await check(update(db, 'llm_keys', keyId, { key_hash: hash }))
      },
    )

    it.each(['task_attempt', 'turn_no', 'first_epoch'] as const)(
      'rejects zero %s',
      async (column) => {
        await check(update(db, 'llm_keys', keyId, { [column]: 0 }))
      },
    )

    it.each([
      { expires_at: at },
      { expires_at: new Date('2026-09-30T11:59:59Z') },
      { valid_until: new Date('2026-09-30T12:09:59Z') },
    ])('rejects invalid expiry ordering %j', async (values) => {
      await check(update(db, 'llm_keys', keyId, values))
    })

    it('allows valid_until to equal expires_at', async () => {
      expect((await update(db, 'llm_keys', keyId, { valid_until: expires })).rows[0]).toMatchObject(
        { valid_until: expires },
      )
    })

    it.each([
      { revoked_at: expires },
      { usage_closed_at: expires },
      { last_refusal: 'budget_exhausted' },
      { last_refusal_at: expires },
    ])('rejects incomplete lifecycle/refusal state %j', async (values) => {
      await check(update(db, 'llm_keys', keyId, values))
    })

    it('records a refusal, revokes and closes accounting in the required order', async () => {
      await update(db, 'llm_keys', keyId, {
        last_refusal: 'budget_exhausted',
        last_refusal_at: expires,
      })
      await update(db, 'llm_keys', keyId, { revoke_requested_at: expires })
      await update(db, 'llm_keys', keyId, { revoked_at: expires })
      expect(
        (await update(db, 'llm_keys', keyId, { usage_closed_at: validUntil })).rows[0],
      ).toMatchObject({ revoked_at: expires, usage_closed_at: validUntil })
    })

    it('deduplicates a task/turn/first_epoch even when the key hash is different', async () => {
      await expect(key({ key_hash: 'b'.repeat(64) })).rejects.toMatchObject({ code: '23505' })
    })

    it('forbids reusing a key hash for another epoch', async () => {
      await expect(key({ first_epoch: 2 })).rejects.toMatchObject({ code: '23505' })
    })

    it('allows a new key after a new first epoch', async () => {
      expect((await key({ first_epoch: 2, key_hash: 'b'.repeat(64) })).rows[0]).toMatchObject({
        task_id: ids.task,
        first_epoch: 2,
      })
    })

    it('starts a binding at zero rebinds and allows only one binding per task', async () => {
      expect((await binding()).rows[0]).toMatchObject({ rebinds: 0 })
      await expect(binding()).rejects.toMatchObject({
        code: '23505',
        constraint: 'task_account_bindings_pkey',
      })
    })

    it('rejects a negative rebind count', async () => {
      await check(binding({ rebinds: -1 }))
    })
  })

  describe('call reservations', () => {
    it('starts open without a finish time or response bytes', async () => {
      expect(
        (await db.query('SELECT * FROM llm_calls WHERE id = $1', [callId])).rows[0],
      ).toMatchObject({ state: 'open', finished_at: null, response_bytes: '0' })
    })

    it.each(['completed', 'failed', 'aborted', 'lost'])(
      'requires a finish time for state %s',
      async (state) => {
        await check(update(db, 'llm_calls', callId, { state }))
      },
    )

    it.each(['completed', 'failed', 'aborted', 'lost'])(
      'accepts terminal state %s with a finish time',
      async (state) => {
        expect(
          (await update(db, 'llm_calls', callId, { state, finished_at: expires })).rows[0],
        ).toMatchObject({ state, finished_at: expires })
      },
    )

    it('forbids an open call with a finish time', async () => {
      await check(update(db, 'llm_calls', callId, { finished_at: expires }))
    })

    it.each([{ reserved_rub: '-0.0000000001' }, { request_bytes: -1 }, { response_bytes: '-1' }])(
      'rejects negative call accounting %j',
      async (values) => {
        await check(update(db, 'llm_calls', callId, values))
      },
    )

    it('preserves ten fractional digits and bigint response byte counts', async () => {
      expect(
        (await update(db, 'llm_calls', callId, { response_bytes: '4294967296' })).rows[0],
      ).toMatchObject({ reserved_rub: '10.1234567890', response_bytes: '4294967296' })
    })

    it('requires a UUID call identifier', async () => {
      await expect(call({ id: 'not-a-uuid' })).rejects.toMatchObject({ code: '22P02' })
    })
  })

  describe('immutable usage facts', () => {
    it('allows usage before task_turns is inserted and defaults to measured/billable', async () => {
      expect((await usage()).rows[0]).toMatchObject({
        turn_id: null,
        gateway_call_id: callId,
        estimated: false,
        estimate_reason: null,
        billable: true,
        cost_rub: '0.0214814591',
      })
    })

    it('stores only one usage fact for a gateway call', async () => {
      await usage()
      await expect(usage()).rejects.toMatchObject({
        code: '23505',
        constraint: 'token_usage_gateway_call_id_key',
      })
    })

    it('requires a UUID gateway call identifier', async () => {
      await expect(usage({ gateway_call_id: 'legacy-not-a-uuid' })).rejects.toMatchObject({
        code: '22P02',
      })
    })

    it('rejects a price that belongs to another existing model', async () => {
      await expect(usage({ price_id: ids.otherPrice })).rejects.toMatchObject({
        code: '23503',
        constraint: 'token_usage_price_id_model_id_fkey',
      })
    })

    it.each([
      'input_uncached_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
    ] as const)('preserves the legacy nonnegative %s constraint', async (column) => {
      await check(usage({ [column]: -1 }), 'token_usage_tokens_check')
    })

    it('rejects negative output tokens', async () => {
      // Negative output violates both the legacy count CHECK and reasoning <= output.
      await check(usage({ output_tokens: -1 }))
    })

    it('rejects negative cost without rounding it to zero', async () => {
      await check(usage({ cost_rub: '-0.0000000001' }), 'token_usage_cost_check')
    })

    it('rejects reasoning tokens exceeding output tokens', async () => {
      await check(usage({ reasoning_tokens: 21 }), 'token_usage_reasoning_check')
    })

    it('accepts zero-cost usage and reasoning tokens included in output', async () => {
      expect((await usage({ reasoning_tokens: 20, cost_rub: '0' })).rows[0]).toMatchObject({
        output_tokens: 20,
        reasoning_tokens: 20,
        cost_rub: '0.0000000000',
      })
    })

    it('rejects a zero task attempt', async () => {
      await check(usage({ task_attempt: 0 }), 'token_usage_attempt_check')
    })

    it.each([
      ['aborted_client', true],
      ['aborted_platform', false],
      ['lost', false],
      ['no_usage', true],
      ['invalid_usage', true],
    ] as const)('accepts estimated %s with billable=%s', async (reason, billable) => {
      expect(
        (await usage({ estimated: true, estimate_reason: reason, billable })).rows[0],
      ).toMatchObject({ estimated: true, estimate_reason: reason, billable })
    })

    it.each([
      { estimated: true },
      { estimated: false, estimate_reason: 'no_usage' },
      { estimated: true, estimate_reason: 'invented' },
      { billable: false },
      { estimated: true, estimate_reason: 'aborted_platform', billable: true },
      { estimated: true, estimate_reason: 'lost', billable: true },
      { estimated: true, estimate_reason: 'aborted_client', billable: false },
      { estimated: true, estimate_reason: 'no_usage', billable: false },
      { estimated: true, estimate_reason: 'invalid_usage', billable: false },
    ])('rejects contradictory estimation/billing %j', async (values) => {
      await check(usage(values), 'token_usage_estimate_check')
    })
  })

  describe('retained relations', () => {
    it.each([
      ['gateway_call_id', 'token_usage_gateway_call_id_fkey'],
      ['key_id', 'token_usage_key_id_fkey'],
      ['subscription_account_id', 'token_usage_account_fkey'],
    ] as const)('rejects a usage row with missing %s', async (column, constraint) => {
      await expect(usage({ [column]: randomUUID() })).rejects.toMatchObject({
        code: '23503',
        constraint,
      })
    })

    it('retains a completed call referenced by usage', async () => {
      await update(db, 'llm_calls', callId, { state: 'completed', finished_at: expires })
      await usage()
      await expect(db.query('DELETE FROM llm_calls WHERE id = $1', [callId])).rejects.toMatchObject(
        {
          code: '23503',
          constraint: 'token_usage_gateway_call_id_fkey',
        },
      )
    })

    it('retains the price referenced by usage', async () => {
      await usage()
      await expect(
        db.query('DELETE FROM llm_model_prices WHERE id = $1', [ids.price]),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'token_usage_price_id_model_id_fkey',
      })
    })

    it('does not cascade a price to another model after usage has been stored', async () => {
      await usage()
      await expect(
        update(db, 'llm_model_prices', ids.price, {
          model_id: ids.otherModel,
          effective_from: new Date('2026-10-01T00:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'token_usage_price_id_model_id_fkey' })
    })

    it('retains a turn key while a call references it', async () => {
      await expect(db.query('DELETE FROM llm_keys WHERE id = $1', [keyId])).rejects.toMatchObject({
        code: '23503',
      })
    })

    it('retains an account bound to a task even when no key or call remains', async () => {
      await binding()
      await db.query('DELETE FROM llm_calls WHERE id = $1', [callId])
      await db.query('DELETE FROM llm_keys WHERE id = $1', [keyId])
      await expect(
        db.query('DELETE FROM subscription_accounts WHERE id = $1', [accountId]),
      ).rejects.toMatchObject({ code: '23503' })
    })
  })

  describe('cross-border clearance records', () => {
    it('accepts an ordered record and defaults it to active', async () => {
      expect((await clearance()).rows[0]).toMatchObject({ countries: 'US,KZ', revoked_at: null })
    })

    it.each(['', 'us', 'USA', 'US,', 'US, KZ'])(
      'rejects malformed country list %s',
      async (countries) => {
        await check(clearance({ countries }))
      },
    )

    it.each([
      { recipients_assessed_on: '2026-09-04' },
      { notice22_date: '2026-09-04' },
      { transfer_allowed_from: '2026-09-02' },
    ])('rejects impossible clearance date ordering %j', async (values) => {
      await check(clearance(values))
    })

    it('requires an existing provider', async () => {
      await expect(clearance({ provider_id: randomUUID() })).rejects.toMatchObject({
        code: '23503',
      })
    })
  })
})
