// The content journal's database invariants (spec §11): the MCP token hash of a turn key, the
// managed call and its proof, snapshot payloads, the unconfirmed-write barrier on a site lease
// and the retention marks. Runs the real migrations in a disposable schema over rows written
// before them, then one accepted and one rejected case per CHECK.
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the per-turn MCP token and the content journal. */
const before = '20260930140000_user_last_name'
/** The last migration of the journal: later ones may add columns of their own. */
const journal = '20261001130000_mcp_content_retention'
const at = new Date('2026-10-01T12:00:00Z')
const later = new Date('2026-10-01T12:01:00Z')
const expires = new Date('2026-10-08T12:00:00Z')
const hash = 'a'.repeat(64)
type Values = Record<string, unknown>

describe.skipIf(!databaseUrl)('MCP content journal constraints', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    freeSite: randomUUID(),
    task: randomUUID(),
    turn: randomUUID(),
    driver: `test-${randomUUID().slice(0, 8)}`,
    provider: randomUUID(),
    model: randomUUID(),
    credential: randomUUID(),
    account: randomUUID(),
    key: randomUUID(),
    assignment: randomUUID(),
    snapshot: randomUUID(),
    finishedCall: randomUUID(),
    inflightCall: randomUUID(),
    failedCall: randomUUID(),
  }
  /** Table and sort column of each kind of row the journal migrations alter. */
  const sources = {
    calls: ['mcp_calls', 'id'],
    snapshots: ['snapshots', 'id'],
    leases: ['site_leases', 'site_id'],
    keys: ['llm_keys', 'id'],
    tasks: ['tasks', 'id'],
  } as const
  type Tables = Record<keyof typeof sources, Values[]>
  let legacy: Tables
  let journaled: Tables

  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
    return values
  }

  function update(table: string, key: string, id: string, values: Values) {
    const columns = Object.keys(values)
    return schema.db.query(
      `UPDATE "${table}" SET ${columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')}
       WHERE "${key}" = $1`,
      [id, ...Object.values(values)],
    )
  }

  const select = async (table: string, order: string) =>
    (await schema.db.query(`SELECT * FROM "${table}" ORDER BY "${order}"`)).rows as Values[]

  function rejected(query: Promise<unknown>, constraint: string) {
    return expect(query).rejects.toMatchObject({ code: '23514', constraint })
  }

  const snapshot = (extra: Values = {}) => {
    const id = randomUUID()
    return insert('snapshots', {
      id,
      site_id: ids.site,
      task_id: ids.task,
      object_ref: 'post:42',
      s3_key: `snapshots/${id}`,
      expires_at: expires,
      ...extra,
    })
  }

  /** A call the content journal admitted: bound to its assignment, key, input and snapshot. */
  const managed = (extra: Values = {}) =>
    insert('mcp_calls', {
      id: randomUUID(),
      turn_id: ids.turn,
      tool: 'wp_rest',
      idempotency_key: randomUUID(),
      object_ref: 'post:42',
      snapshot_id: ids.snapshot,
      assignment_id: ids.assignment,
      credential_key_id: ids.key,
      request_hash: hash,
      lease_epoch: 1,
      ...extra,
    })

  const written = { write_started_at: at, result: 'ok', response: '{}', finished_at: later }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'mcp_content')
    await schema.migrate(before)
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic', updated_at: at })
    for (const id of [ids.site, ids.freeSite])
      await insert('sites', {
        id,
        workspace_id: ids.workspace,
        name: 'Synthetic site',
        url: `https://${id}.invalid`,
        stack: 'wordpress',
        updated_at: at,
      })
    await insert('tasks', {
      id: ids.task,
      workspace_id: ids.workspace,
      site_id: ids.site,
      updated_at: at,
    })
    await insert('agent_drivers', {
      id: ids.driver,
      image: 'synthetic/agent:test',
      capabilities: '{}',
      updated_at: at,
    })
    await insert('task_turns', {
      id: ids.turn,
      task_id: ids.task,
      turn_no: 1,
      driver_id: ids.driver,
      image: 'synthetic/agent:test',
    })
    await insert('llm_providers', {
      id: ids.provider,
      slug: ids.provider,
      name: 'Synthetic subscription',
      kind: 'subscription',
      updated_at: at,
    })
    await insert('llm_models', {
      id: ids.model,
      provider_id: ids.provider,
      slug: 'synthetic',
      name: 'Synthetic model',
      model_class: 'light',
      updated_at: at,
    })
    await insert('credential_refs', {
      id: ids.credential,
      kind: 'subscription',
      vault_path: `subs/synthetic/${ids.account}`,
      updated_at: at,
    })
    await insert('subscription_accounts', {
      id: ids.account,
      provider_id: ids.provider,
      driver_id: ids.driver,
      label: 'Synthetic account',
      credential_ref_id: ids.credential,
      plan: 'synthetic',
      max_concurrent_turns: 1,
      max_concurrent_requests: 2,
      updated_at: at,
    })
    // Rows as the code before the journal wrote them.
    await insert('llm_keys', {
      id: ids.key,
      key_hash: 'f'.repeat(64),
      task_id: ids.task,
      task_attempt: 1,
      session_id: 'synthetic-session',
      turn_no: 1,
      first_epoch: 1,
      driver_id: ids.driver,
      model_id: ids.model,
      subscription_account_id: ids.account,
      budget_rub: '135.0000000000',
      issued_at: at,
      expires_at: later,
      valid_until: later,
    })
    await insert('turn_assignments', {
      id: ids.assignment,
      task_id: ids.task,
      site_id: ids.site,
      session_id: 'synthetic-session',
      turn_no: 1,
      executor: 'local',
      plan: '{}',
      first_epoch: 1,
      lease_epoch: 1,
      deadline_at: later,
      updated_at: at,
    })
    await insert('snapshots', {
      id: ids.snapshot,
      site_id: ids.site,
      task_id: ids.task,
      object_ref: 'post:42',
      s3_key: 'snapshots/legacy',
      expires_at: expires,
    })
    const call = { turn_id: ids.turn, tool: 'wp_rest', created_at: at }
    await insert('mcp_calls', {
      ...call,
      id: ids.finishedCall,
      idempotency_key: 'legacy-finished',
      object_ref: 'post:42',
      snapshot_id: ids.snapshot,
      result: 'ok',
      response: '{"id":42}',
      finished_at: later,
    })
    await insert('mcp_calls', { ...call, id: ids.inflightCall, idempotency_key: 'legacy-inflight' })
    // No response and no finish time: the old code required neither.
    await insert('mcp_calls', {
      ...call,
      id: ids.failedCall,
      idempotency_key: 'legacy-failed',
      result: 'error',
      error: 'Synthetic failure',
    })
    await insert('site_leases', {
      site_id: ids.site,
      operation: 'deploy',
      holder_task_id: ids.task,
      epoch: 1,
      acquired_at: at,
      expires_at: later,
      updated_at: at,
    })
    await insert('site_leases', { site_id: ids.freeSite, epoch: 3, updated_at: at })
    const tables = async (): Promise<Tables> => ({
      calls: await select(...sources.calls),
      snapshots: await select(...sources.snapshots),
      leases: await select(...sources.leases),
      keys: await select(...sources.keys),
      tasks: await select(...sources.tasks),
    })
    legacy = await tables()
    await schema.migrate(journal)
    journaled = await tables()
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

  describe('rows written before the journal', () => {
    const added = {
      calls: {
        assignment_id: null,
        credential_key_id: null,
        request_hash: null,
        lease_epoch: null,
        write_started_at: null,
        write_deadline_at: null,
        applied_state_hash: null,
        restores_snapshot_id: null,
        receipt_purged_at: null,
      },
      snapshots: {
        payload_sha256: null,
        size_bytes: null,
        purge_requested_at: null,
        purged_at: null,
      },
      leases: { inflight_mcp_call_id: null },
      keys: { mcp_token_hash: null },
      tasks: {
        content_accessed_at: null,
        content_retired_at: null,
        content_masks_purged_at: null,
      },
    }

    it('survive the journal migrations unchanged, with the new columns empty', () => {
      expect(journaled.calls.map(({ journal_no: _, ...row }) => row)).toEqual(
        legacy.calls.map((row) => ({ ...row, ...added.calls })),
      )
      // Every old call receives its own admission number.
      expect(new Set(journaled.calls.map((row) => row.journal_no)).size).toBe(legacy.calls.length)
      for (const table of ['snapshots', 'leases', 'keys', 'tasks'] as const)
        expect(journaled[table]).toEqual(legacy[table].map((row) => ({ ...row, ...added[table] })))
    })

    it('keep those columns through every later migration', async () => {
      // A later migration may add columns of its own: only the journal's ones are compared.
      for (const [table, rows] of Object.entries(journaled) as [keyof Tables, Values[]][]) {
        const [name, order] = sources[table]
        const columns = Object.keys(rows[0]!)
        expect(
          (await select(name, order)).map((row) =>
            Object.fromEntries(columns.map((column) => [column, row[column]])),
          ),
        ).toEqual(rows)
      }
    })

    it('are never taken for managed calls: a legacy row cannot carry journal fields', async () => {
      for (const values of [
        { request_hash: hash },
        { credential_key_id: ids.key },
        { lease_epoch: 1 },
        { write_started_at: at },
      ])
        await schema.db.query('SAVEPOINT legacy').then(async () => {
          await rejected(
            update('mcp_calls', 'id', ids.inflightCall, values),
            'mcp_calls_managed_binding_check',
          )
          await schema.db.query('ROLLBACK TO SAVEPOINT legacy')
        })
    })
  })

  describe('llm_keys_mcp_hash_check', () => {
    it('accepts a lowercase SHA-256 and a key without MCP access', async () => {
      await update('llm_keys', 'id', ids.key, { mcp_token_hash: 'b'.repeat(64) })
      await update('llm_keys', 'id', ids.key, { mcp_token_hash: null })
    })

    it.each(['B'.repeat(64), 'b'.repeat(63), 'b'.repeat(63) + 'g', ''])(
      'rejects the hash %j',
      async (value) => {
        await rejected(
          update('llm_keys', 'id', ids.key, { mcp_token_hash: value }),
          'llm_keys_mcp_hash_check',
        )
      },
    )
  })

  describe('mcp_calls_managed_binding_check', () => {
    it('accepts a call bound to its assignment, key, input, epoch and snapshot', async () => {
      await managed()
    })

    it.each([
      { credential_key_id: null },
      { request_hash: null },
      { request_hash: 'A'.repeat(64) },
      { request_hash: 'a'.repeat(63) },
      { lease_epoch: null },
      { lease_epoch: 0 },
      { snapshot_id: null },
      { object_ref: null },
    ])('rejects a managed call with %j', async (values) => {
      await rejected(managed(values), 'mcp_calls_managed_binding_check')
    })
  })

  describe('mcp_calls_managed_result_check', () => {
    it.each([
      ['in flight', {}],
      ['in flight after its write started', { write_started_at: at }],
      ['written', written],
      ['refused before any write', { result: 'denied', response: '{}', finished_at: later }],
      ['failed before any write', { result: 'error', response: '{}', finished_at: later }],
    ])('accepts a managed call %s', async (_, values) => {
      await managed(values)
    })

    it.each([
      ['a result without its finish time', { ...written, finished_at: null }],
      ['a finish time without a result', { finished_at: later }],
      ['a successful write that never started', { ...written, write_started_at: null }],
      ['a result without a response to replay', { ...written, response: null }],
    ])('rejects %s', async (_, values) => {
      await rejected(managed(values), 'mcp_calls_managed_result_check')
    })
  })

  describe('mcp_calls_content_proof_check', () => {
    it('accepts the applied state of a finished successful write', async () => {
      await managed({ ...written, applied_state_hash: hash })
    })

    it.each([
      // SQL CHECK accepts UNKNOWN: the first version let this one through.
      ['an unfinished call', { write_started_at: at, applied_state_hash: hash }],
      ['a failed call', { ...written, result: 'error', applied_state_hash: hash }],
      ['a write that never started', { ...written, write_started_at: null }],
      ['a malformed hash', { ...written, applied_state_hash: 'A'.repeat(64) }],
    ])('rejects a proof of %s', async (_, values) => {
      await rejected(
        managed({ applied_state_hash: hash, ...values }),
        'mcp_calls_content_proof_check',
      )
    })
  })

  describe('mcp_calls_content_restore_check', () => {
    it('accepts a managed restore of another snapshot', async () => {
      const source = await snapshot()
      await managed({ tool: 'restore', restores_snapshot_id: source.id })
    })

    it('rejects a restore source on another tool, on a legacy call and on its own snapshot', async () => {
      const source = await snapshot()
      await schema.db.query('SAVEPOINT restore')
      for (const query of [
        () => managed({ restores_snapshot_id: source.id }),
        () =>
          update('mcp_calls', 'id', ids.finishedCall, {
            tool: 'restore',
            restores_snapshot_id: source.id,
          }),
        () => managed({ tool: 'restore', restores_snapshot_id: ids.snapshot }),
      ]) {
        await rejected(query(), 'mcp_calls_content_restore_check')
        await schema.db.query('ROLLBACK TO SAVEPOINT restore')
      }
    })
  })

  describe('mcp_calls_content_deadline_check', () => {
    it('accepts a deadline after the start of the write', async () => {
      await managed({ write_started_at: at, write_deadline_at: later })
    })

    it.each([
      ['without a started write', { write_deadline_at: later }],
      ['at the start itself', { write_started_at: at, write_deadline_at: at }],
      ['before the start', { write_started_at: later, write_deadline_at: at }],
    ])('rejects a deadline %s', async (_, values) => {
      await rejected(managed(values), 'mcp_calls_content_deadline_check')
    })
  })

  describe('mcp_calls_receipt_retention_check', () => {
    it('accepts a purged receipt of a finished call', async () => {
      await managed({ ...written, receipt_purged_at: later })
      await update('mcp_calls', 'id', ids.finishedCall, { receipt_purged_at: later })
    })

    it('rejects a purged receipt of a call that is still in flight', async () => {
      await schema.db.query('SAVEPOINT receipt')
      await rejected(
        managed({ write_started_at: at, receipt_purged_at: later }),
        'mcp_calls_receipt_retention_check',
      )
      await schema.db.query('ROLLBACK TO SAVEPOINT receipt')
      await rejected(
        update('mcp_calls', 'id', ids.inflightCall, { receipt_purged_at: later }),
        'mcp_calls_receipt_retention_check',
      )
    })
  })

  describe('snapshots_payload_check', () => {
    it.each([1, 65_536])('accepts a hashed payload of %d bytes', async (size) => {
      await snapshot({ payload_sha256: hash, size_bytes: size })
    })

    it.each([
      { payload_sha256: hash },
      { size_bytes: 1 },
      { payload_sha256: hash, size_bytes: 0 },
      { payload_sha256: hash, size_bytes: 65_537 },
      { payload_sha256: 'A'.repeat(64), size_bytes: 1 },
    ])('rejects the payload %j', async (values) => {
      await rejected(snapshot(values), 'snapshots_payload_check')
    })
  })

  describe('snapshots_content_retention_check', () => {
    it('accepts a purge requested at the expiry and confirmed after it', async () => {
      await snapshot({ purge_requested_at: expires })
      await snapshot({ purge_requested_at: expires, purged_at: expires })
    })

    it.each([
      ['requested before the expiry', { purge_requested_at: later }],
      ['confirmed without a request', { purged_at: expires }],
    ])('rejects a purge %s', async (_, values) => {
      await rejected(snapshot(values), 'snapshots_content_retention_check')
    })
  })

  describe('tasks_content_retention_check', () => {
    it('accepts a retired content context, with or without purged masks', async () => {
      await update('tasks', 'id', ids.task, { content_retired_at: later })
      await update('tasks', 'id', ids.task, { content_masks_purged_at: later })
    })

    it('rejects purged masks of a context that is not retired', async () => {
      await rejected(
        update('tasks', 'id', ids.task, { content_masks_purged_at: later }),
        'tasks_content_retention_check',
      )
    })
  })

  describe('site_leases_mcp_barrier_check', () => {
    it('accepts an unconfirmed write on a site held for a turn', async () => {
      const call = await managed({ write_started_at: at })
      await update('site_leases', 'site_id', ids.site, {
        operation: 'turn',
        inflight_mcp_call_id: call.id,
      })
    })

    it('rejects an unconfirmed write on a site held for a deploy', async () => {
      const call = await managed({ write_started_at: at })
      await rejected(
        update('site_leases', 'site_id', ids.site, { inflight_mcp_call_id: call.id }),
        'site_leases_mcp_barrier_check',
      )
    })

    it('rejects an unconfirmed write on a free site', async () => {
      const call = await managed({ write_started_at: at })
      await rejected(
        update('site_leases', 'site_id', ids.freeSite, { inflight_mcp_call_id: call.id }),
        'site_leases_mcp_barrier_check',
      )
    })
  })
})
