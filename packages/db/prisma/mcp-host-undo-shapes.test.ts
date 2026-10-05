// The host undo migration replaces four CHECKs (spec §11). Examples cannot show that nothing
// else moved, so this file takes every shape of a row over a small domain of each column the
// CHECKs of `mcp_calls` and `site_leases` read:
//  - every shape the previous constraints accepted is written as a real row before the
//    migration, and the migration is applied over them;
//  - a shape without a host owner is accepted after the migration exactly when it was before;
//  - a shape with a host owner is accepted exactly when it is the restore the plan describes.
// The definitions are read from the database, not copied from the migration files.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the host undo. */
const before = '20261003110000_task_events_policy_flagged_idx'
const change = '20261004100000_mcp_host_undo'
const at = '2026-10-04T12:00:00Z'
const later = '2026-10-04T12:01:00Z'
const hash = 'a'.repeat(64)
/** Every shape whose number divides by this is also written as a real row after the migration. */
const PROBE_EVERY = 53

describe.skipIf(!databaseUrl)('MCP host undo: every shape of a row', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
    undoTask: randomUUID(),
    turn: randomUUID(),
    driver: `test-${randomUUID().slice(0, 8)}`,
    assignment: randomUUID(),
    key: randomUUID(),
    own: randomUUID(),
    source: randomUUID(),
  }
  const callColumns = [
    'tool',
    'assignment_id',
    'credential_key_id',
    'request_hash',
    'lease_epoch',
    'write_started_at',
    'write_deadline_at',
    'applied_state_hash',
    'restores_snapshot_id',
    'object_ref',
    'snapshot_id',
    'result',
    'response',
    'finished_at',
    'receipt_purged_at',
  ]
  const hostColumns = ['host_task_id', 'host_operation']
  const leaseColumns = [
    'operation',
    'holder_task_id',
    'epoch',
    'expires_at',
    'held_for_operator',
    'inflight_marker',
  ]
  const facts: {
    oldCallChecks: string[]
    newCallChecks: string[]
    oldLeaseChecks: string[]
    newLeaseChecks: string[]
    rowsBefore: { calls: number; leases: number; digest: string }
    rowsAfter: { calls: number; leases: number; digest: string }
  } = {
    oldCallChecks: [],
    newCallChecks: [],
    oldLeaseChecks: [],
    newLeaseChecks: [],
    rowsBefore: { calls: 0, leases: 0, digest: '' },
    rowsAfter: { calls: 0, leases: 0, digest: '' },
  }

  const query = async <Row = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await schema.db.query(text, values)).rows as Row[]
  const count = async (text: string) => Number((await query<{ n: string }>(text))[0]!.n)

  /** The CHECKs of a table as PostgreSQL holds them: `name: (expression)`. */
  async function checks(table: string): Promise<Map<string, string>> {
    const rows = await query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
      [`"${schema.name}"."${table}"`],
    )
    return new Map(rows.map((row) => [row.conname, row.definition.replace(/^CHECK /, '')]))
  }
  /** A CHECK refuses a row only when its expression is false: unknown passes. */
  const accepts = (definitions: Map<string, string>) =>
    [...definitions.values()].map((expression) => `(${expression} IS NOT FALSE)`).join(' AND ')
  const values = (name: string, type: string, items: string[]) =>
    `(VALUES ${items.map((item, index) => `(${index === 0 ? `${item}::${type}` : item})`).join(', ')}) AS "v_${name}"("${name}")`

  /** The digest of every row of both tables, without the columns the migration adds. */
  const rows = async () => ({
    calls: await count('SELECT count(*) AS n FROM mcp_calls'),
    leases: await count('SELECT count(*) AS n FROM site_leases'),
    digest: (
      await query<{ digest: string }>(
        `SELECT md5(
           (SELECT string_agg(md5((to_jsonb(c) - 'host_task_id' - 'host_operation')::text), ''
              ORDER BY c.id) FROM mcp_calls c)
           || (SELECT string_agg(md5(to_jsonb(l)::text), '' ORDER BY l.site_id) FROM site_leases l)
         ) AS digest`,
      )
    )[0]!.digest,
  })

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'mcp_host_undo_shapes')
    await schema.migrate(before)
    await schema.db.query(
      `INSERT INTO workspaces (id, name, updated_at) VALUES ('${ids.workspace}', 'Synthetic', '${at}');
       INSERT INTO sites (id, workspace_id, name, url, stack, updated_at)
         VALUES ('${ids.site}', '${ids.workspace}', 'Synthetic', 'https://shapes.invalid', 'wordpress', '${at}');
       INSERT INTO tasks (id, workspace_id, site_id, updated_at)
         VALUES ('${ids.task}', '${ids.workspace}', '${ids.site}', '${at}');
       INSERT INTO tasks (id, workspace_id, site_id, reverts_task_id, billable, updated_at)
         VALUES ('${ids.undoTask}', '${ids.workspace}', '${ids.site}', '${ids.task}', false, '${at}');
       INSERT INTO agent_drivers (id, image, capabilities, updated_at)
         VALUES ('${ids.driver}', 'synthetic/agent:test', '{}', '${at}');
       INSERT INTO task_turns (id, task_id, turn_no, driver_id, image)
         VALUES ('${ids.turn}', '${ids.task}', 1, '${ids.driver}', 'synthetic/agent:test');
       INSERT INTO turn_assignments (id, task_id, site_id, session_id, turn_no, executor, plan,
           first_epoch, lease_epoch, deadline_at, updated_at)
         VALUES ('${ids.assignment}', '${ids.task}', '${ids.site}', 'synthetic-session', 1, 'local',
           '{}', 1, 1, '${later}', '${at}');
       INSERT INTO snapshots (id, site_id, task_id, object_ref, s3_key, expires_at) VALUES
         ('${ids.own}', '${ids.site}', '${ids.task}', 'post:42', 'snapshots/own.json', '${later}'),
         ('${ids.source}', '${ids.site}', '${ids.task}', 'post:42', 'snapshots/source.json', '${later}');`,
    )

    // Every combination of a small domain of each column a CHECK of `mcp_calls` reads; the two
    // columns of the host owner are part of a shape from the start and NULL in every old row.
    await schema.db.query(
      `CREATE UNLOGGED TABLE call_shapes AS
       SELECT row_number() OVER () AS shape_no, shapes.*,
         NULL::boolean AS old_ok, NULL::boolean AS new_ok FROM (SELECT * FROM
         ${values('tool', 'varchar(200)', [`'wp_rest'`, `'restore'`])}
         CROSS JOIN ${values('assignment_id', 'uuid', ['NULL', `'${ids.assignment}'`])}
         CROSS JOIN ${values('credential_key_id', 'uuid', ['NULL', `'${ids.key}'`])}
         CROSS JOIN ${values('request_hash', 'varchar(64)', ['NULL', `'${hash}'`, `'${'A'.repeat(64)}'`])}
         CROSS JOIN ${values('lease_epoch', 'integer', ['NULL', '0', '1'])}
         CROSS JOIN ${values('write_started_at', 'timestamptz', ['NULL', `'${at}'`])}
         CROSS JOIN ${values('write_deadline_at', 'timestamptz', ['NULL', `'${later}'`])}
         CROSS JOIN ${values('applied_state_hash', 'varchar(64)', ['NULL', `'${hash}'`])}
         CROSS JOIN ${values('restores_snapshot_id', 'uuid', ['NULL', `'${ids.source}'`, `'${ids.own}'`])}
         CROSS JOIN ${values('object_ref', 'varchar(1024)', ['NULL', `'post:42'`])}
         CROSS JOIN ${values('snapshot_id', 'uuid', ['NULL', `'${ids.own}'`])}
         CROSS JOIN ${values('result', '"McpCallResult"', ['NULL', `'ok'`, `'error'`, `'denied'`])}
         CROSS JOIN ${values('response', 'jsonb', ['NULL', `'{}'`])}
         CROSS JOIN ${values('finished_at', 'timestamptz', ['NULL', `'${later}'`])}
         CROSS JOIN ${values('receipt_purged_at', 'timestamptz', ['NULL', `'${later}'`])}
         CROSS JOIN ${values('host_task_id', 'uuid', ['NULL', `'${ids.undoTask}'`])}
         CROSS JOIN ${values('host_operation', '"LeaseOperation"', ['NULL', `'turn'`, `'deploy'`, `'revert'`])}
       ) AS shapes`,
    )
    // `inflight_marker`: whether the lease points at an unconfirmed content write.
    await schema.db.query(
      `CREATE UNLOGGED TABLE lease_shapes AS
       SELECT row_number() OVER () AS shape_no, shapes.*,
         NULL::uuid AS inflight_mcp_call_id, NULL::uuid AS site_id,
         NULL::boolean AS old_ok, NULL::boolean AS new_ok FROM (SELECT * FROM
         ${values('operation', '"LeaseOperation"', ['NULL', `'turn'`, `'deploy'`, `'revert'`])}
         CROSS JOIN ${values('holder_task_id', 'uuid', ['NULL', `'${ids.undoTask}'`])}
         CROSS JOIN ${values('epoch', 'integer', ['0', '1'])}
         CROSS JOIN ${values('expires_at', 'timestamptz', ['NULL', `'${later}'`])}
         CROSS JOIN ${values('held_for_operator', 'boolean', ['false', 'true'])}
         CROSS JOIN ${values('inflight_marker', 'boolean', ['false', 'true'])}
       ) AS shapes;
       UPDATE lease_shapes SET site_id = gen_random_uuid(),
         inflight_mcp_call_id = CASE WHEN inflight_marker THEN gen_random_uuid() END;`,
    )

    const oldCalls = await checks('mcp_calls')
    const oldLeases = await checks('site_leases')
    facts.oldCallChecks = [...oldCalls.keys()]
    facts.oldLeaseChecks = [...oldLeases.keys()]
    await schema.db.query(
      `UPDATE call_shapes SET old_ok = ${accepts(oldCalls)}
         WHERE host_task_id IS NULL AND host_operation IS NULL;
       UPDATE lease_shapes SET old_ok = ${accepts(oldLeases)};`,
    )
    // Real rows of every shape the previous constraints accepted. A shape taken for accepted
    // by mistake would stop here on the constraint itself.
    await schema.db.query(
      `INSERT INTO mcp_calls (id, turn_id, idempotency_key, ${callColumns.join(', ')})
       SELECT gen_random_uuid(), '${ids.turn}', 'shape-' || shape_no, ${callColumns.join(', ')}
       FROM call_shapes WHERE old_ok;
       -- One site and, where the lease points at a write, one unconfirmed write of its own.
       INSERT INTO sites (id, workspace_id, name, url, stack, updated_at)
         SELECT site_id, '${ids.workspace}', 'Synthetic', 'https://lease-' || shape_no || '.invalid',
           'wordpress', '${at}' FROM lease_shapes WHERE old_ok;
       INSERT INTO mcp_calls (id, turn_id, idempotency_key, tool, object_ref, snapshot_id,
           assignment_id, credential_key_id, request_hash, lease_epoch, write_started_at)
         SELECT inflight_mcp_call_id, '${ids.turn}', 'lease-' || shape_no, 'wp_rest', 'post:42',
           '${ids.own}', '${ids.assignment}', '${ids.key}', '${hash}', 1, '${at}'
         FROM lease_shapes WHERE old_ok AND inflight_marker;
       INSERT INTO site_leases (site_id, operation, holder_task_id, epoch, expires_at,
           held_for_operator, inflight_mcp_call_id, updated_at)
         SELECT site_id, operation, holder_task_id, epoch, expires_at, held_for_operator,
           inflight_mcp_call_id, '${at}' FROM lease_shapes WHERE old_ok;`,
    )
    facts.rowsBefore = await rows()

    // The migration validates every existing row: one rejected row would stop it here.
    await schema.migrate(change)
    facts.rowsAfter = await rows()
    const newCalls = await checks('mcp_calls')
    const newLeases = await checks('site_leases')
    facts.newCallChecks = [...newCalls.keys()]
    facts.newLeaseChecks = [...newLeases.keys()]
    await schema.db.query(
      `UPDATE call_shapes SET new_ok = ${accepts(newCalls)};
       UPDATE lease_shapes SET new_ok = ${accepts(newLeases)};`,
    )
  }, 120_000)

  afterAll(async () => {
    await schema?.drop()
  })

  it('reads the same set of CHECKs before and after: four replaced, none added or lost', () => {
    expect(facts.oldCallChecks).toEqual([
      'mcp_calls_content_deadline_check',
      'mcp_calls_content_proof_check',
      'mcp_calls_content_restore_check',
      'mcp_calls_managed_binding_check',
      'mcp_calls_managed_result_check',
      'mcp_calls_receipt_retention_check',
    ])
    expect(facts.newCallChecks).toEqual(facts.oldCallChecks)
    expect(facts.oldLeaseChecks).toEqual([
      'site_leases_epoch_check',
      'site_leases_mcp_barrier_check',
      'site_leases_state_check',
    ])
    expect(facts.newLeaseChecks).toEqual(facts.oldLeaseChecks)
  })

  it('is applied over a real row of every shape the previous constraints accepted', async () => {
    // Not vacuous: rows from before the journal, calls of the agent in every state, leases free,
    // held, expired and with a write barrier.
    const accepted = await count('SELECT count(*) AS n FROM call_shapes WHERE old_ok')
    const leases = await count('SELECT count(*) AS n FROM lease_shapes WHERE old_ok')
    expect(accepted).toBeGreaterThan(200)
    expect(leases).toBeGreaterThan(10)
    expect(
      await count(`SELECT count(*) AS n FROM call_shapes WHERE old_ok AND assignment_id IS NULL`),
    ).toBeGreaterThan(50)
    expect(
      await count(`SELECT count(*) AS n FROM lease_shapes WHERE old_ok AND inflight_marker`),
    ).toBeGreaterThan(0)
    expect(facts.rowsBefore.calls).toBe(
      accepted +
        (await count('SELECT count(*) AS n FROM lease_shapes WHERE old_ok AND inflight_marker')),
    )
    expect(facts.rowsBefore.leases).toBe(leases)
    // Every row is there after the migration, byte for byte, and has no host owner.
    expect(facts.rowsAfter).toEqual(facts.rowsBefore)
    expect(
      await count(
        `SELECT count(*) AS n FROM mcp_calls WHERE host_task_id IS NOT NULL OR host_operation IS NOT NULL`,
      ),
    ).toBe(0)
  })

  it('accepts a row without a host owner exactly when the previous constraints did', async () => {
    expect(
      await query(
        `SELECT shape_no, old_ok, new_ok FROM call_shapes
         WHERE host_task_id IS NULL AND host_operation IS NULL AND old_ok IS DISTINCT FROM new_ok
         LIMIT 5`,
      ),
    ).toEqual([])
    expect(
      await count(
        `SELECT count(*) AS n FROM call_shapes WHERE host_task_id IS NULL AND host_operation IS NULL`,
      ),
    ).toBe(221_184)
  })

  it('accepts a row with a host owner only as the restore of a lease holder', async () => {
    // Written from the plan, not from the migration: the holder and its operation — a turn or a
    // revert — no assignment and no key, a restore of another snapshot with its own snapshot,
    // an input hash, an epoch and an object; then the rules every managed call obeys.
    const restoreOfHost = `(
      host_task_id IS NOT NULL AND host_operation IS NOT NULL
      AND host_operation IN ('turn', 'revert')
      AND assignment_id IS NULL AND credential_key_id IS NULL
      AND tool = 'restore' AND restores_snapshot_id IS NOT NULL
      AND snapshot_id IS NOT NULL AND snapshot_id <> restores_snapshot_id
      AND request_hash IS NOT NULL AND request_hash = '${hash}'
      AND lease_epoch IS NOT NULL AND lease_epoch > 0 AND object_ref IS NOT NULL
      AND ((result IS NULL) = (finished_at IS NULL))
      AND (result IS NULL OR response IS NOT NULL)
      AND (result IS DISTINCT FROM 'ok' OR write_started_at IS NOT NULL)
      AND (applied_state_hash IS NULL OR (result IS NOT DISTINCT FROM 'ok' AND write_started_at IS NOT NULL))
      AND (write_deadline_at IS NULL OR write_started_at IS NOT NULL)
      AND (receipt_purged_at IS NULL OR result IS NOT NULL)
    )`
    const hostShapes = `(host_task_id IS NOT NULL OR host_operation IS NOT NULL)`
    expect(
      await query(
        `SELECT shape_no, new_ok, ${callColumns.join(', ')}, ${hostColumns.join(', ')}
         FROM call_shapes WHERE ${hostShapes} AND new_ok IS DISTINCT FROM ${restoreOfHost} LIMIT 5`,
      ),
    ).toEqual([])
    const acceptedHost = await count(
      `SELECT count(*) AS n FROM call_shapes WHERE ${hostShapes} AND new_ok`,
    )
    expect(acceptedHost).toBeGreaterThan(20)
    // The shapes the task names, each counted on its own: all refused.
    for (const forbidden of [
      // a host call that is not a restore
      `host_task_id IS NOT NULL AND (tool <> 'restore' OR restores_snapshot_id IS NULL)`,
      // with an assignment or a key
      `host_task_id IS NOT NULL AND (assignment_id IS NOT NULL OR credential_key_id IS NOT NULL)`,
      // an operation of a lease with no holder, and a holder with no operation
      `host_task_id IS NULL AND host_operation IS NOT NULL`,
      `host_task_id IS NOT NULL AND host_operation IS NULL`,
      // under a deploy
      `host_operation = 'deploy'`,
    ])
      expect(
        await count(`SELECT count(*) AS n FROM call_shapes WHERE (${forbidden}) AND new_ok`),
      ).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM call_shapes WHERE ${hostShapes}`)).toBe(1_548_288)
  })

  it('agrees with the constraints themselves on real rows of a sample of all shapes', async () => {
    // The two tests above evaluate the definitions; here the table decides, shape by shape.
    await schema.db.query(
      `CREATE TABLE shape_probe (tried integer NOT NULL, accepted integer NOT NULL, wrong integer NOT NULL);
       DO $$
       DECLARE shape record; ok boolean; tried integer := 0; accepted integer := 0; wrong integer := 0;
       BEGIN
         FOR shape IN SELECT * FROM call_shapes
           WHERE shape_no % ${PROBE_EVERY} = 0 OR ((host_task_id IS NOT NULL OR host_operation IS NOT NULL) AND new_ok)
         LOOP
           tried := tried + 1;
           BEGIN
             INSERT INTO mcp_calls (id, turn_id, idempotency_key, ${[...callColumns, ...hostColumns].join(', ')})
             VALUES (gen_random_uuid(), '${ids.turn}', 'probe-' || shape.shape_no,
               ${[...callColumns, ...hostColumns].map((column) => `shape.${column}`).join(', ')});
             ok := true;
             accepted := accepted + 1;
           EXCEPTION WHEN check_violation THEN ok := false;
           END;
           IF ok IS DISTINCT FROM shape.new_ok THEN wrong := wrong + 1; END IF;
         END LOOP;
         INSERT INTO shape_probe VALUES (tried, accepted, wrong);
       END $$;`,
    )
    const [probe] = await query<{ tried: number; accepted: number; wrong: number }>(
      'SELECT * FROM shape_probe',
    )
    expect(probe!.wrong).toBe(0)
    expect(probe!.tried).toBeGreaterThan(33_000)
    expect(probe!.accepted).toBeGreaterThan(20)
  }, 120_000)

  it('lets a lease point at an unconfirmed write under a turn or a revert, and under nothing else', async () => {
    // Exactly the previous leases, plus the write barrier of a held revert.
    const barrierOfRevert = `(inflight_marker AND holder_task_id IS NOT NULL
      AND operation IS NOT DISTINCT FROM 'revert' AND expires_at IS NOT NULL)`
    expect(
      await query(
        `SELECT shape_no, old_ok, new_ok, ${leaseColumns.join(', ')} FROM lease_shapes
         WHERE new_ok IS DISTINCT FROM (old_ok OR ${barrierOfRevert})`,
      ),
    ).toEqual([])
    expect(await count(`SELECT count(*) AS n FROM lease_shapes WHERE ${barrierOfRevert}`)).toBe(4)
    expect(
      await count(
        `SELECT count(*) AS n FROM lease_shapes WHERE inflight_marker AND new_ok
           AND operation IS DISTINCT FROM 'turn' AND operation IS DISTINCT FROM 'revert'`,
      ),
    ).toBe(0)
    // The table itself: a pending write under a deploy and on a free site is refused, under a
    // revert it is taken.
    const pending = (operation: string | null) =>
      schema.db.query(
        `UPDATE site_leases SET operation = $1::"LeaseOperation",
           holder_task_id = CASE WHEN $1::text IS NULL THEN NULL ELSE '${ids.undoTask}'::uuid END,
           expires_at = CASE WHEN $1::text IS NULL THEN NULL ELSE '${later}'::timestamptz END,
           held_for_operator = false
         WHERE site_id = (SELECT site_id FROM lease_shapes
           WHERE old_ok AND inflight_marker ORDER BY shape_no LIMIT 1)`,
        [operation],
      )
    for (const operation of ['deploy', null])
      await expect(pending(operation)).rejects.toMatchObject({
        code: '23514',
        constraint: 'site_leases_mcp_barrier_check',
      })
    expect((await pending('revert')).rowCount).toBe(1)
    expect((await pending('turn')).rowCount).toBe(1)
  })
})
