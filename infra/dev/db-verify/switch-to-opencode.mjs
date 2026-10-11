// The switch of the product to OpenCode through the real Prisma commands, on a database that
// still holds an account and an unfinished task of an earlier shell: each stop of the migration,
// what an operator does about it by hand, and the deploy that follows. The commands of the
// removed providers are gone after the removal, so the way out is SQL; the two scripts below
// are that SQL, and docs/plan/48-removal.md quotes them.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const switchMigration = '20261011090000_switch_to_opencode'

/**
 * psql script, variable `account`: takes one subscription account of a removed provider out of
 * the pool. Run it after the provider's console has revoked what the account held and the
 * secret under credential_refs.vault_path is destroyed in Vault with the admin token.
 */
export const retireAccountByHand = `\\set ON_ERROR_STOP on
-- Out of the pool, committed at once: no new turn key from here on, the keys already issued
-- stop, and the sweeper of core removes their secrets from Vault.
BEGIN;
SELECT set_config('raditi.account', :'account', true);
DO $$
DECLARE
  account uuid := current_setting('raditi.account')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM subscription_accounts a JOIN llm_providers p ON p.id = a.provider_id
     WHERE a.id = account AND p.slug IN ('openai-chatgpt', 'kimi-code')
  ) THEN
    RAISE EXCEPTION 'No account % of openai-chatgpt or kimi-code', account;
  END IF;
  UPDATE subscription_accounts
     SET enabled = false,
         retire_requested_at = coalesce(retire_requested_at, clock_timestamp()),
         updated_at = clock_timestamp()
   WHERE id = account;
  UPDATE llm_keys SET revoke_requested_at = coalesce(revoke_requested_at, clock_timestamp())
   WHERE subscription_account_id = account AND revoked_at IS NULL;
END $$;
COMMIT;
-- Retired, once no provider call of the account is in flight. The status is the operator's
-- word that the provider no longer accepts the credential.
BEGIN;
SELECT set_config('raditi.account', :'account', true);
DO $$
DECLARE
  account uuid := current_setting('raditi.account')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM llm_calls WHERE subscription_account_id = account AND state = 'open') THEN
    RAISE EXCEPTION 'A provider call of account % is still open: let the role llm close it, then run this again', account;
  END IF;
  UPDATE subscription_accounts
     SET status = 'retired',
         credentials_revoked_at = coalesce(credentials_revoked_at, clock_timestamp()),
         updated_at = clock_timestamp()
   WHERE id = account;
END $$;
COMMIT;
`

/**
 * psql script, variable `task`: cancels one task that a removed shell left unfinished. Run it
 * with no container of the task alive: the roles core and runner stopped, or the 20 minutes of
 * its turn over. A task in deploying or verifying is not cancelled here: no shell takes part
 * in a deployment, let it end.
 */
export const cancelTaskByHand = `\\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('raditi.task', :'task', true);
DO $$
DECLARE
  task uuid := current_setting('raditi.task')::uuid;
  cancelled integer;
BEGIN
  UPDATE turn_assignments
     SET outcome = 'lost', finished_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE task_id = task AND finished_at IS NULL;
  UPDATE task_turns SET status = 'cancelled', finished_at = clock_timestamp()
   WHERE task_id = task AND status IN ('pending', 'running');
  UPDATE tasks
     SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = task
     AND status IN ('queued', 'preparing', 'running', 'awaiting_user', 'awaiting_approval');
  GET DIAGNOSTICS cancelled = ROW_COUNT;
  IF cancelled = 0 AND NOT EXISTS (
    SELECT 1 FROM tasks WHERE id = task AND status IN ('done', 'failed', 'rolled_back', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Task % is missing, or is being deployed and cannot be cancelled', task;
  END IF;
END $$;
COMMIT;
`

/** What the seeds give a new database: one shell switched on, its catalogue for the operator. */
export const newDatabaseCatalogue = {
  drivers: [{ id: 'opencode', enabled: true }],
  providers: [{ slug: 'zai-coding', enabled: false }],
  models: ['glm-5.3-heavy', 'glm-5.3-light', 'glm-5.3-standard'].map((slug) => ({
    provider: 'zai-coding',
    slug,
    enabled: false,
  })),
}

/** Every driver, provider and profile of the database with its switch. */
export async function catalogue(client) {
  return {
    drivers: (await client.query('SELECT id, enabled FROM agent_drivers ORDER BY id')).rows,
    providers: (await client.query('SELECT slug, enabled FROM llm_providers ORDER BY slug')).rows,
    models: (
      await client.query(
        `SELECT p.slug AS provider, m.slug, m.enabled FROM llm_models m
           JOIN llm_providers p ON p.id = m.provider_id ORDER BY p.slug, m.slug`,
      )
    ).rows,
  }
}

/** The tables a seed run reported, as `{ table: [created, updated] }`. */
export function seedReport(output) {
  return Object.fromEntries(
    [...output.matchAll(/^\[seed\] (\w+): \+(\d+) created, (\d+) updated$/gm)].map(
      ([, table, created, updated]) => [table, [Number(created), Number(updated)]],
    ),
  )
}

/**
 * `client` — a connected pg client of the database, migrated up to the migration before the
 * switch and otherwise empty. `psql(script, variables)` runs a psql script, `deploy()` is
 * `prisma migrate deploy` with every migration and resolves with the exit code and the output,
 * `resolve()` is `prisma migrate resolve --rolled-back` of the switch, `seed()` runs the seeds
 * and resolves with their output.
 */
export async function verifySwitchToOpencode({ client, psql, deploy, resolve, seed, passed }) {
  const id = {
    provider: randomUUID(),
    credential: randomUUID(),
    account: randomUUID(),
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
  }
  // What an installation of the earlier shells held: a driver and a provider with a profile
  // switched on, an account with a credential, a task whose turn was never closed. The row of
  // the new shell is there as the seeds of that time left it, switched off.
  await client.query(
    `INSERT INTO agent_drivers (id, image, capabilities, enabled, updated_at) VALUES
       ('codex', 'raditi/agent-codex', '{}', true, clock_timestamp()),
       ('opencode', 'raditi/agent-opencode', $1, false, clock_timestamp())`,
    [{ resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false }],
  )
  await client.query(
    `INSERT INTO llm_providers (id, slug, name, kind, enabled, updated_at)
     VALUES ($1, 'openai-chatgpt', 'ChatGPT', 'subscription', true, clock_timestamp())`,
    [id.provider],
  )
  await client.query(
    `INSERT INTO llm_models (id, provider_id, slug, name, model_class, enabled, updated_at)
     VALUES ($1, $2, 'gpt-6-sol-standard', 'GPT-6 Sol · standard', 'standard', true,
             clock_timestamp())`,
    [randomUUID(), id.provider],
  )
  await client.query(
    `INSERT INTO credential_refs (id, kind, vault_path, key_version, updated_at)
     VALUES ($1, 'subscription', $2, 1, clock_timestamp())`,
    [id.credential, `subs/openai-chatgpt/${id.account}`],
  )
  await client.query(
    `INSERT INTO subscription_accounts
       (id, provider_id, driver_id, label, credential_ref_id, plan, max_concurrent_turns,
        max_concurrent_requests, credential_version, enabled, updated_at)
     VALUES ($1, $2, 'codex', 'Synthetic earlier account', $3, 'synthetic', 1, 2, 1, true,
             clock_timestamp())`,
    [id.account, id.provider, id.credential],
  )
  await client.query(
    `INSERT INTO workspaces (id, name, updated_at) VALUES ($1, 'Synthetic', clock_timestamp())`,
    [id.workspace],
  )
  await client.query(
    `INSERT INTO sites (id, workspace_id, name, url, stack, updated_at)
     VALUES ($1, $2, 'Synthetic', 'https://switch.example.test', 'wordpress', clock_timestamp())`,
    [id.site, id.workspace],
  )
  await client.query(
    `INSERT INTO tasks (id, workspace_id, site_id, status, turn_no, updated_at)
     VALUES ($1, $2, $3, 'running', 1, clock_timestamp())`,
    [id.task, id.workspace, id.site],
  )
  await client.query(
    `INSERT INTO task_turns (id, task_id, turn_no, status, driver_id, image)
     VALUES ($1, $2, 1, 'running', 'codex', 'registry.invalid/raditi/codex')`,
    [randomUUID(), id.task],
  )
  await client.query(
    `INSERT INTO turn_assignments
       (id, task_id, site_id, session_id, turn_no, executor, plan, first_epoch, lease_epoch,
        deadline_at, updated_at)
     VALUES ($1, $2, $3, 'synthetic', 1, 'local', '{"driverId":"codex"}', 1, 1,
             clock_timestamp(), clock_timestamp())`,
    [randomUUID(), id.task, id.site],
  )

  const state = async () => ({
    drivers: (await client.query('SELECT id, enabled FROM agent_drivers ORDER BY id')).rows,
    providers: (await client.query('SELECT slug, enabled FROM llm_providers ORDER BY slug')).rows,
    accounts: (
      await client.query(
        `SELECT status::text, enabled, retire_requested_at IS NOT NULL AS retiring,
                credentials_revoked_at IS NOT NULL AS revoked, updated_at
           FROM subscription_accounts`,
      )
    ).rows,
    tasks: (await client.query('SELECT status::text, finished_at, updated_at FROM tasks')).rows,
    turns: (await client.query('SELECT status::text, finished_at FROM task_turns')).rows,
    assignments: (
      await client.query('SELECT outcome::text, finished_at, updated_at FROM turn_assignments')
    ).rows,
  })
  const history = async () =>
    (
      await client.query(
        `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back,
                coalesce(logs, '') AS logs
           FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
        [switchMigration],
      )
    ).rows
  /** The deploy stops with `message`, leaves the rows as they were and records the failure. */
  const stopped = async (message, attempts) => {
    const before = await state()
    const refused = await deploy()
    assert.notEqual(refused.code, 0, 'The migration must stop')
    // The operator reads the output of Prisma and nothing else.
    assert.match(refused.output, /Database error code: P0001/)
    assert.match(refused.output, message)
    assert.match(refused.output, /\(docs\/plan\/48-removal\.md\)/)
    assert.match(
      refused.output,
      new RegExp(`run "prisma migrate resolve --rolled-back ${switchMigration}" and deploy again`),
    )
    assert.deepEqual(await state(), before, 'A stop must change nothing')
    const recorded = await history()
    assert.equal(recorded.length, attempts)
    assert.deepEqual(
      recorded.map(({ finished, rolled_back: rolledBack }) => ({ finished, rolledBack })).at(-1),
      { finished: false, rolledBack: false },
    )
    assert.match(recorded.at(-1).logs, message)
    // Until the operator resolves the failure Prisma applies nothing.
    const blocked = await deploy()
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.output, /P3009/)
    assert.deepEqual(await state(), before)
  }

  await stopped(
    new RegExp(`1 subscription account\\(s\\) of openai-chatgpt or kimi-code[^\\n]*${id.account}`),
    1,
  )
  passed('switch to OpenCode: prisma migrate deploy stops on an account that holds a credential')
  await psql(retireAccountByHand, { account: id.account })
  assert.deepEqual(
    (await state()).accounts.map(({ updated_at: _updated, ...account }) => account),
    [{ status: 'retired', enabled: false, retiring: true, revoked: true }],
  )
  await resolve()
  await stopped(new RegExp(`1 unfinished task\\(s\\)[^\\n]*${id.task}`), 2)
  passed('switch to OpenCode: after the account is retired by hand it stops on an unfinished task')
  await psql(cancelTaskByHand, { task: id.task })
  await resolve()
  const applied = await deploy()
  assert.equal(applied.code, 0, applied.output)
  const after = await state()
  assert.deepEqual(after.drivers, [
    { id: 'codex', enabled: false },
    { id: 'opencode', enabled: true },
  ])
  assert.deepEqual(after.providers, [{ slug: 'openai-chatgpt', enabled: false }])
  assert.deepEqual(
    after.tasks.map((task) => task.status),
    ['cancelled'],
  )
  assert.deepEqual(
    after.turns.map((turn) => turn.status),
    ['cancelled'],
  )
  assert.deepEqual(
    after.assignments.map((assignment) => assignment.outcome),
    ['lost'],
  )
  assert.deepEqual(
    (await history()).map(({ finished, rolled_back: rolledBack }) => ({ finished, rolledBack })),
    [
      { finished: false, rolledBack: true },
      { finished: false, rolledBack: true },
      { finished: true, rolledBack: false },
    ],
  )
  passed('switch to OpenCode: after the task is cancelled by hand the migration applies')

  // The seeds meet the database the switch left. They no longer know the earlier shells: the
  // history rows are neither created anew nor completed nor switched back on, the catalogue
  // of a new database appears beside them, and a second run writes nothing.
  const earlier = {
    drivers: [{ id: 'codex', enabled: false }],
    providers: [{ slug: 'openai-chatgpt', enabled: false }],
    models: [{ provider: 'openai-chatgpt', slug: 'gpt-6-sol-standard', enabled: false }],
  }
  const rows = async () =>
    (
      await client.query(
        `SELECT 'driver' AS kind, to_jsonb(d)::text AS row FROM agent_drivers d WHERE d.id = 'codex'
         UNION ALL SELECT 'provider', to_jsonb(p)::text FROM llm_providers p WHERE p.slug = 'openai-chatgpt'
         UNION ALL SELECT 'model', to_jsonb(m)::text FROM llm_models m
           JOIN llm_providers p ON p.id = m.provider_id WHERE p.slug = 'openai-chatgpt'
         UNION ALL SELECT 'account', to_jsonb(a)::text FROM subscription_accounts a
         ORDER BY 1, 2`,
      )
    ).rows
  const beforeSeeds = await rows()
  assert.equal(beforeSeeds.length, 4)
  assert.deepEqual(await catalogue(client), {
    drivers: [...earlier.drivers, ...newDatabaseCatalogue.drivers],
    providers: earlier.providers,
    models: earlier.models,
  })
  const report = seedReport(await seed())
  assert.deepEqual(
    { drivers: report.agent_drivers, providers: report.llm_providers, models: report.llm_models },
    { drivers: [0, 0], providers: [1, 0], models: [3, 0] },
  )
  const seeded = await catalogue(client)
  assert.deepEqual(seeded, {
    drivers: [...earlier.drivers, ...newDatabaseCatalogue.drivers],
    providers: [...earlier.providers, ...newDatabaseCatalogue.providers],
    models: [...earlier.models, ...newDatabaseCatalogue.models],
  })
  assert.deepEqual(await rows(), beforeSeeds, 'The seeds must leave the history rows alone')
  const rerun = seedReport(await seed())
  assert.ok(Object.keys(rerun).length >= 5, 'The seed must report its tables')
  for (const [table, counts] of Object.entries(rerun)) assert.deepEqual(counts, [0, 0], table)
  assert.deepEqual(await catalogue(client), seeded)
  assert.deepEqual(await rows(), beforeSeeds)
  passed(
    'switch to OpenCode: the seeds add the new catalogue beside the history and a rerun changes nothing',
  )

  // The suites that follow start from empty tables: the rows of this scenario and of its seeds.
  await client.query('DELETE FROM tasks WHERE id = $1', [id.task])
  await client.query('DELETE FROM sites WHERE id = $1', [id.site])
  await client.query('DELETE FROM workspaces WHERE id = $1', [id.workspace])
  await client.query('DELETE FROM subscription_accounts WHERE id = $1', [id.account])
  await client.query('DELETE FROM credential_refs WHERE id = $1', [id.credential])
  for (const table of ['llm_models', 'llm_providers', 'agent_drivers', 'pricing_rules', 'plans'])
    await client.query(`DELETE FROM ${table}`)
  return 4
}
