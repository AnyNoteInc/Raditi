// The trusted host undo in the content journal (spec §11): a call without an assignment and a
// turn key, owned by the task that holds the site lease. Runs the real migrations in a
// disposable schema over rows the journal wrote before this change, then one accepted and one
// rejected case per replaced CHECK.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the host undo. */
const before = '20261003110000_task_events_policy_flagged_idx'
const change = '20261004100000_mcp_host_undo'
const at = new Date('2026-10-04T12:00:00Z')
const later = new Date('2026-10-04T12:01:00Z')
const expires = new Date('2026-10-11T12:00:00Z')
const hash = 'a'.repeat(64)
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
type Values = Record<string, unknown>

describe.skipIf(!databaseUrl)('MCP host undo constraints', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    deploySite: randomUUID(),
    freeSite: randomUUID(),
    task: randomUUID(),
    undoTask: randomUUID(),
    deployTask: randomUUID(),
    turn: randomUUID(),
    driver: `test-${randomUUID().slice(0, 8)}`,
    provider: randomUUID(),
    model: randomUUID(),
    credential: randomUUID(),
    account: randomUUID(),
    key: randomUUID(),
    assignment: randomUUID(),
    source: randomUUID(),
    legacyCall: randomUUID(),
    legacyFailedCall: randomUUID(),
    editCall: randomUUID(),
    restoreCall: randomUUID(),
    deniedCall: randomUUID(),
    writingCall: randomUUID(),
  }
  const sources = {
    calls: ['mcp_calls', 'id'],
    snapshots: ['snapshots', 'id'],
    leases: ['site_leases', 'site_id'],
    tasks: ['tasks', 'id'],
  } as const
  type Tables = Record<keyof typeof sources, Values[]>
  let journaled: Tables
  let migrated: Tables

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
    return expect(query).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint })
  }

  const snapshot = async (extra: Values = {}) => {
    const id = randomUUID()
    await insert('snapshots', {
      id,
      site_id: ids.site,
      task_id: ids.task,
      object_ref: 'post:42',
      s3_key: `snapshots/${ids.site}/${id}.json`,
      expires_at: expires,
      ...extra,
    })
    return id
  }

  /** A call of the agent, as the journal has written it since 01.10.2026. */
  const agent = async (extra: Values = {}) =>
    insert('mcp_calls', {
      id: randomUUID(),
      turn_id: ids.turn,
      tool: 'wp_rest',
      idempotency_key: randomUUID(),
      object_ref: 'post:42',
      snapshot_id: await snapshot(),
      assignment_id: ids.assignment,
      credential_key_id: ids.key,
      request_hash: hash,
      lease_epoch: 1,
      ...extra,
    })

  /** A restore of the trusted host: the holder of the lease and its operation, no key. */
  const host = async (extra: Values = {}) =>
    insert('mcp_calls', {
      id: randomUUID(),
      turn_id: ids.turn,
      tool: 'restore',
      idempotency_key: randomUUID(),
      object_ref: 'post:42',
      snapshot_id: await snapshot(),
      restores_snapshot_id: ids.source,
      host_task_id: ids.undoTask,
      host_operation: 'revert',
      request_hash: hash,
      lease_epoch: 2,
      ...extra,
    })

  const written = { write_started_at: at, result: 'ok', response: '{}', finished_at: later }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'mcp_host_undo')
    await schema.migrate(before)
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic', updated_at: at })
    for (const id of [ids.site, ids.deploySite, ids.freeSite])
      await insert('sites', {
        id,
        workspace_id: ids.workspace,
        name: 'Synthetic site',
        url: `https://${id}.invalid`,
        stack: 'wordpress',
        updated_at: at,
      })
    const task = { workspace_id: ids.workspace, updated_at: at }
    await insert('tasks', { ...task, id: ids.task, site_id: ids.site })
    await insert('tasks', {
      ...task,
      id: ids.undoTask,
      site_id: ids.site,
      reverts_task_id: ids.task,
      billable: false,
    })
    await insert('tasks', { ...task, id: ids.deployTask, site_id: ids.deploySite })
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
    await insert('llm_keys', {
      id: ids.key,
      key_hash: 'f'.repeat(64),
      mcp_token_hash: 'e'.repeat(64),
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
    // Every kind of row the journal held before the change.
    const legacy = { turn_id: ids.turn, tool: 'wp_rest', created_at: at }
    await insert('mcp_calls', {
      ...legacy,
      id: ids.legacyCall,
      idempotency_key: 'legacy-finished',
      result: 'ok',
      response: '{"id":42}',
      finished_at: later,
    })
    // No response and no finish time: the code before the journal required neither.
    await insert('mcp_calls', {
      ...legacy,
      id: ids.legacyFailedCall,
      idempotency_key: 'legacy-failed',
      result: 'error',
      error: 'Synthetic failure',
    })
    await insert('snapshots', {
      id: ids.source,
      site_id: ids.site,
      task_id: ids.task,
      object_ref: 'post:42',
      s3_key: `snapshots/${ids.site}/${ids.source}.json`,
      expires_at: expires,
      payload_sha256: hash,
      size_bytes: 512,
    })
    await agent({
      id: ids.editCall,
      snapshot_id: ids.source,
      created_at: at,
      ...written,
      applied_state_hash: 'b'.repeat(64),
      reverted_at: later,
    })
    await agent({
      id: ids.restoreCall,
      tool: 'restore',
      restores_snapshot_id: ids.source,
      created_at: at,
      ...written,
      applied_state_hash: 'c'.repeat(64),
    })
    await agent({
      id: ids.deniedCall,
      created_at: at,
      result: 'denied',
      response: '{"code":"SYNTHETIC"}',
      finished_at: later,
    })
    // An unconfirmed write: the barrier of the site lease points at it.
    await agent({
      id: ids.writingCall,
      created_at: at,
      write_started_at: at,
      write_deadline_at: later,
    })
    await insert('site_leases', {
      site_id: ids.site,
      operation: 'turn',
      holder_task_id: ids.task,
      epoch: 1,
      acquired_at: at,
      expires_at: later,
      held_for_operator: true,
      inflight_mcp_call_id: ids.writingCall,
      updated_at: at,
    })
    await insert('site_leases', {
      site_id: ids.deploySite,
      operation: 'deploy',
      holder_task_id: ids.deployTask,
      epoch: 4,
      acquired_at: at,
      expires_at: later,
      updated_at: at,
    })
    await insert('site_leases', { site_id: ids.freeSite, epoch: 3, updated_at: at })
    const tables = async (): Promise<Tables> => ({
      calls: await select(...sources.calls),
      snapshots: await select(...sources.snapshots),
      leases: await select(...sources.leases),
      tasks: await select(...sources.tasks),
    })
    journaled = await tables()
    await schema.migrate(change)
    migrated = await tables()
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

  describe('rows the journal wrote before the host undo', () => {
    it('survive the migration unchanged, with no host owner', () => {
      expect(journaled.calls).toHaveLength(6)
      expect(migrated.calls).toEqual(
        journaled.calls.map((row) => ({ ...row, host_task_id: null, host_operation: null })),
      )
      for (const table of ['snapshots', 'leases', 'tasks'] as const)
        expect(migrated[table]).toEqual(journaled[table])
    })

    it('keep their columns through every later migration', async () => {
      // A later migration may add columns of its own: only the ones of these rows are compared.
      for (const [table, rows] of Object.entries(migrated) as [keyof Tables, Values[]][]) {
        const [name, order] = sources[table]
        const columns = Object.keys(rows[0]!)
        expect(
          (await select(name, order)).map((row) =>
            Object.fromEntries(columns.map((column) => [column, row[column]])),
          ),
        ).toEqual(rows)
      }
    })

    it('still pass their checks when they are written again', async () => {
      for (const id of [ids.legacyCall, ids.legacyFailedCall, ids.editCall, ids.restoreCall])
        await update('mcp_calls', 'id', id, { error: 'Synthetic rewrite' })
      await update('site_leases', 'site_id', ids.site, { updated_at: later })
    })
  })

  describe('the migration as Prisma applies it', () => {
    const replaced = [
      'mcp_calls_managed_binding_check',
      'mcp_calls_managed_result_check',
      'mcp_calls_content_restore_check',
      'site_leases_mcp_barrier_check',
    ]

    it('is one transaction: a failure in the middle leaves the previous checks in place', async () => {
      // `prisma migrate deploy` sends a migration statement by statement, each in its own
      // implicit transaction (seen in the PostgreSQL statement log). Only the file's own
      // BEGIN and COMMIT keep a DROP together with its ADD.
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'mcp_host_undo_atomic')
      try {
        await scratch.migrate(before)
        const state = async () => ({
          checks: (
            await scratch.db.query(
              `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
               WHERE connamespace = $1::regnamespace AND conname = ANY($2::text[])
               ORDER BY conname`,
              [scratch.name, replaced],
            )
          ).rows as Values[],
          columns: (
            await scratch.db.query(
              `SELECT column_name FROM information_schema.columns
               WHERE table_schema = $1 AND table_name = 'mcp_calls'
                 AND column_name IN ('host_task_id', 'host_operation')`,
              [scratch.name],
            )
          ).rows as Values[],
        })
        const previous = await state()
        expect(previous.checks.map((row) => row.conname)).toEqual([...replaced].sort())
        const statements = (
          await readFile(new URL(`./migrations/${change}/migration.sql`, import.meta.url), 'utf8')
        )
          .split(/;[ \t]*$/m)
          .map((statement) => statement.trim())
          .filter(Boolean)
        // Every statement up to the last ADD, and a failure where that ADD would stand.
        const lastAdd = statements.map((text) => /ADD CONSTRAINT/.test(text)).lastIndexOf(true)
        expect(lastAdd).toBeGreaterThan(0)
        for (const statement of statements.slice(0, lastAdd)) await scratch.db.query(statement)
        await expect(scratch.db.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
        // What the end of the connection does to a transaction that is still open.
        await scratch.db.query('ROLLBACK')
        expect(await state()).toEqual(previous)
      } finally {
        await scratch.drop()
      }
    })
  })

  describe('mcp_calls_managed_binding_check', () => {
    it.each(['turn', 'revert'])(
      'accepts a host restore under a %s lease: a holder, an epoch, an input and a snapshot',
      async (operation) => {
        await host({ host_operation: operation })
      },
    )

    it('still accepts a call of the agent and a row from before the journal', async () => {
      await agent()
      await insert('mcp_calls', {
        id: randomUUID(),
        turn_id: ids.turn,
        tool: 'wp_rest',
        idempotency_key: randomUUID(),
      })
    })

    it.each([
      ['a turn key', { credential_key_id: ids.key }],
      ['no operation', { host_operation: null }],
      ['a deploy lease', { host_operation: 'deploy' }],
      ['no input hash', { request_hash: null }],
      ['a malformed input hash', { request_hash: 'A'.repeat(64) }],
      ['no epoch', { lease_epoch: null }],
      ['a zero epoch', { lease_epoch: 0 }],
      ['no object', { object_ref: null }],
    ])('rejects a host call with %s', async (_, values) => {
      await rejected(host(values), 'mcp_calls_managed_binding_check')
    })

    it('rejects a host call that is not a restore: the host never edits', async () => {
      await schema.db.query('SAVEPOINT edit')
      for (const values of [
        { tool: 'wp_rest', restores_snapshot_id: null },
        { restores_snapshot_id: null },
      ]) {
        await rejected(host(values), 'mcp_calls_managed_binding_check')
        await schema.db.query('ROLLBACK TO SAVEPOINT edit')
      }
    })

    it('rejects a call with two owners, and an operation without a holder', async () => {
      await schema.db.query('SAVEPOINT owners')
      for (const query of [
        () => host({ assignment_id: ids.assignment, credential_key_id: ids.key }),
        () => host({ assignment_id: ids.assignment }),
        () => agent({ host_task_id: ids.undoTask, host_operation: 'turn' }),
        () => agent({ host_operation: 'turn' }),
        () => update('mcp_calls', 'id', ids.legacyCall, { host_operation: 'revert' }),
      ]) {
        await rejected(query(), 'mcp_calls_managed_binding_check')
        await schema.db.query('ROLLBACK TO SAVEPOINT owners')
      }
    })

    it('names an existing task as the holder', async () => {
      await expect(host({ host_task_id: randomUUID() })).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
        constraint: 'mcp_calls_host_task_id_fkey',
      })
    })
  })

  describe('mcp_calls_managed_result_check', () => {
    it.each([
      ['in flight', {}],
      ['in flight after its write started', { write_started_at: at }],
      ['written', { ...written, applied_state_hash: hash }],
      ['stopped before any write', { result: 'error', response: '{}', finished_at: later }],
    ])('accepts a host call %s', async (_, values) => {
      await host(values)
    })

    it.each([
      ['a result without its finish time', { ...written, finished_at: null }],
      ['a finish time without a result', { finished_at: later }],
      ['a successful write that never started', { ...written, write_started_at: null }],
      ['a result without a response to replay', { ...written, response: null }],
    ])('rejects %s of a host call', async (_, values) => {
      await rejected(host(values), 'mcp_calls_managed_result_check')
    })

    it('rejects the same of an agent call, as before', async () => {
      await rejected(agent({ ...written, finished_at: null }), 'mcp_calls_managed_result_check')
    })
  })

  describe('mcp_calls_content_restore_check', () => {
    it('accepts a restore owned by an assignment or by the host', async () => {
      await agent({ tool: 'restore', restores_snapshot_id: ids.source })
      await host()
    })

    it('rejects a restore source without an owner, on another tool and on its own snapshot', async () => {
      await schema.db.query('SAVEPOINT restore')
      const own = await snapshot()
      for (const query of [
        () =>
          update('mcp_calls', 'id', ids.legacyCall, {
            tool: 'restore',
            restores_snapshot_id: ids.source,
          }),
        () => host({ host_task_id: null }),
        () => agent({ restores_snapshot_id: ids.source }),
        () => host({ snapshot_id: own, restores_snapshot_id: own }),
        // Without a snapshot of its own the comparison is unknown, which a CHECK would accept.
        () => host({ snapshot_id: null }),
      ]) {
        await rejected(query(), 'mcp_calls_content_restore_check')
        await schema.db.query('ROLLBACK TO SAVEPOINT restore')
      }
    })
  })

  describe('site_leases_mcp_barrier_check', () => {
    it('accepts an unconfirmed host write on a site held for a revert', async () => {
      const call = await host({ write_started_at: at, write_deadline_at: later })
      await update('site_leases', 'site_id', ids.site, {
        operation: 'revert',
        holder_task_id: ids.undoTask,
        epoch: 2,
        inflight_mcp_call_id: call.id,
      })
    })

    it('still accepts the barrier of a turn', async () => {
      expect(migrated.leases.find((row) => row.site_id === ids.site)).toMatchObject({
        operation: 'turn',
        inflight_mcp_call_id: ids.writingCall,
      })
      const call = await host({ host_operation: 'turn', write_started_at: at })
      await update('site_leases', 'site_id', ids.site, { inflight_mcp_call_id: call.id })
    })

    it('rejects an unconfirmed write on a site held for a deploy and on a free site', async () => {
      const call = await host({ write_started_at: at })
      await schema.db.query('SAVEPOINT barrier')
      for (const site of [ids.deploySite, ids.freeSite]) {
        await rejected(
          update('site_leases', 'site_id', site, { inflight_mcp_call_id: call.id }),
          'site_leases_mcp_barrier_check',
        )
        await schema.db.query('ROLLBACK TO SAVEPOINT barrier')
      }
    })
  })
})
