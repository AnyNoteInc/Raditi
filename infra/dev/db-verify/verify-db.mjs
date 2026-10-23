// Disposable local PostgreSQL: real migrations, one application user and database-backed tests.
// Never loads repository .env or accepts an external DATABASE_URL.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { run, testTimeoutMs } from './command.mjs'
import { leftovers } from './leftovers.mjs'
import {
  catalogue,
  newDatabaseCatalogue,
  seedReport,
  switchMigration,
  verifySwitchToOpencode,
} from './switch-to-opencode.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const { Client } = createRequire(join(root, 'packages/db/package.json'))('pg')
const image =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const ownership = randomBytes(16).toString('hex')
const name = `raditi-db-verify-${ownership}`
const label = 'io.raditi.db-local-verification'
const passwords = Object.fromEntries(
  ['superuser', 'raditi'].map((role) => [role, randomBytes(24).toString('hex')]),
)
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME', 'TMPDIR'].includes(key) || key.startsWith('DOCKER_'),
  ),
)
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let directory
let started = false
let stage = 'preflight'
let checks = 0

const redact = (text) =>
  Object.values(passwords).reduce(
    (result, password) => result.replaceAll(password, '[redacted]'),
    text,
  )

// Docker calls and Prisma commands are short; the test suites bring their own limit.
function command(
  program,
  args,
  { input, env = {}, allowFailure = false, cleanup = false, timeoutMs } = {},
) {
  return run(program, args, {
    cwd: root,
    env: { ...baseEnv, ...env },
    input,
    stage,
    timeoutMs: timeoutMs ?? (program === 'docker' ? 30_000 : 180_000),
    // Cleanup still runs after an interrupt.
    signal: cleanup ? undefined : controller.signal,
    allowFailure,
    redact,
  })
}
const docker = (args, options) => command('docker', args, options)
const bootstrap = async (allowFailure = false) =>
  docker(['exec', '-i', name, 'sh', '-s'], {
    input: await readFile(join(root, 'infra/app/postgres/init-roles.sh')),
    allowFailure,
  })
const passed = (message) => console.log(`PASS ${message}`)

const legacyRoles = ['raditi_app', 'raditi_web', 'raditi_core', 'raditi_llm', 'postgres_exporter']
const identifier = (value) => `"${value.replaceAll('"', '""')}"`
const superuser = (sql, allowFailure = false) =>
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'raditi', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    allowFailure,
  })
const devBootstrap = async (allowFailure = false) =>
  superuser(await readFile(join(root, 'infra/dev/postgres-init.sql')), allowFailure)

async function withDatabase(connectionString, action) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  })
  await client.connect()
  try {
    return await action(client)
  } finally {
    await client.end()
  }
}

async function verifySingleUser(connectionString, afterRerun) {
  await withDatabase(connectionString, async (client) => {
    const {
      rows: [attributes],
    } = await client.query(
      `SELECT current_user AS username, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    )
    assert.deepEqual(attributes, {
      username: 'raditi',
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    })
    const owners = await client.query(
      `SELECT pg_get_userbyid(datdba) AS database_owner,
         (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner
       FROM pg_database WHERE datname = current_database()`,
    )
    assert.deepEqual(owners.rows, [{ database_owner: 'raditi', schema_owner: 'raditi' }])
    const legacy = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [
      legacyRoles,
    ])
    assert.deepEqual(legacy.rows, [], 'Legacy application and exporter roles must be removed')
    checks += 3

    const { rows: tables } = await client.query(
      `SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
         (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 1) AS first_column
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
    assert.ok(tables.some((table) => table.table_name === 'llm_keys'))
    assert.ok(tables.some((table) => table.table_name === '_prisma_migrations'))
    for (const { table_name: table, owner, first_column: column } of tables) {
      assert.equal(owner, 'raditi', `${table} must belong to the shared application user`)
      const target = `public.${identifier(table)}`
      for (const sql of [
        `SELECT * FROM ${target} LIMIT 0`,
        `INSERT INTO ${target} SELECT * FROM ${target} WHERE false`,
        `UPDATE ${target} SET ${identifier(column)} = ${identifier(column)} WHERE false`,
        `DELETE FROM ${target} WHERE false`,
      ]) {
        await client.query(sql)
        checks += 1
      }
    }
    // Exercise real DDL and CRUD, not only privileges or empty updates.
    await client.query('BEGIN')
    try {
      await client.query(
        'CREATE TABLE public.verify_shared_user (id integer PRIMARY KEY, value text NOT NULL)',
      )
      await client.query("INSERT INTO public.verify_shared_user VALUES (1, 'before')")
      const updated = await client.query(
        "UPDATE public.verify_shared_user SET value = 'after' WHERE id = 1 RETURNING value",
      )
      assert.deepEqual(updated.rows, [{ value: 'after' }])
      const removed = await client.query('DELETE FROM public.verify_shared_user RETURNING id')
      assert.deepEqual(removed.rows, [{ id: 1 }])
      await client.query('ALTER TABLE public.verify_shared_user ADD COLUMN extra integer')
      await client.query('DROP TABLE public.verify_shared_user')
      checks += 6
    } finally {
      await client.query('ROLLBACK')
    }
  })
  passed(
    `shared raditi owner and table access ${afterRerun ? 'after bootstrap rerun' : 'immediately after migration'}`,
  )
}

async function verifyLegacyUpgrade(connectionString, cleanupRoles, variant) {
  // Entire fixture lives in this script's labelled, disposable database. Legacy roles own no
  // production data, but do have memberships, table/column grants and default privileges.
  await superuser(`
    CREATE ROLE raditi_app NOLOGIN;
    CREATE ROLE raditi_web LOGIN IN ROLE raditi_app;
    CREATE ROLE raditi_core LOGIN IN ROLE raditi_app;
    CREATE ROLE raditi_llm LOGIN;
    CREATE ROLE postgres_exporter LOGIN;
    GRANT pg_monitor TO postgres_exporter;
    GRANT CONNECT ON DATABASE raditi TO raditi_app, raditi_llm, postgres_exporter;
    GRANT USAGE ON SCHEMA public TO raditi_app, raditi_llm, postgres_exporter;
    ALTER DEFAULT PRIVILEGES FOR ROLE raditi IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO raditi_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE raditi IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO raditi_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE raditi_core IN SCHEMA public
      GRANT SELECT ON TABLES TO raditi_llm;
    SET ROLE raditi;
    CREATE TABLE public.verify_legacy_data (id integer PRIMARY KEY, value text NOT NULL);
    INSERT INTO public.verify_legacy_data VALUES (1, 'preserve this row');
    RESET ROLE;
    GRANT SELECT ON public.verify_legacy_data TO raditi_llm, postgres_exporter;
    GRANT UPDATE (value) ON public.verify_legacy_data TO raditi_core;
    CREATE TABLE public.verify_legacy_owned (value text NOT NULL);
    INSERT INTO public.verify_legacy_owned VALUES ('must survive refused cleanup');
    ALTER TABLE public.verify_legacy_owned OWNER TO raditi_llm;
  `)
  const dump = `/tmp/verify-legacy-${variant}.dump`
  await docker([
    'exec',
    name,
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'raditi',
    '--format=custom',
    '--table=public.verify_legacy_data',
    '--file',
    dump,
  ])
  const contents = await docker(['exec', name, 'pg_restore', '--list', dump])
  assert.match(
    contents.output,
    /ACL.*verify_legacy_data/,
    'The old dump must contain legacy grants',
  )
  const assertPreserved = async () =>
    withDatabase(connectionString, async (client) => {
      const remaining = await client.query(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
        [legacyRoles],
      )
      assert.deepEqual(
        remaining.rows.map((row) => row.rolname),
        [...legacyRoles].sort(),
      )
      const preserved = await client.query('SELECT value FROM public.verify_legacy_data')
      assert.deepEqual(preserved.rows, [{ value: 'preserve this row' }])
    })
  const refused = await cleanupRoles(true)
  assert.notEqual(refused.code, 0, 'Unexpected legacy ownership must stop bootstrap')
  assert.match(refused.output, /owns objects/)
  await assertPreserved()
  // Inspect through postgres: raditi intentionally has no grant on the foreign-owned object.
  const preserved = await superuser('SELECT value FROM public.verify_legacy_owned;')
  assert.match(preserved.output, /must survive refused cleanup/)
  await superuser('DROP TABLE public.verify_legacy_owned;')
  passed(`${variant}: legacy-owned data refuses cleanup without losing roles or rows`)

  // CONNECT grants on another database have pg_shdepend.dbid = 0. They must also
  // prevent DROP OWNED from silently changing another database's privileges.
  await superuser(`
    CREATE DATABASE verify_legacy_foreign;
    REVOKE ALL ON DATABASE verify_legacy_foreign FROM PUBLIC;
    GRANT CONNECT ON DATABASE verify_legacy_foreign TO raditi_llm;
  `)
  const foreign = await cleanupRoles(true)
  assert.notEqual(foreign.code, 0, 'Cross-database privileges must stop bootstrap')
  assert.match(foreign.output, /dependencies in another database/)
  await assertPreserved()
  await withDatabase(connectionString, async (client) => {
    const grant = await client.query(`
      SELECT has_database_privilege('raditi_llm', 'verify_legacy_foreign', 'CONNECT') AS allowed
    `)
    assert.deepEqual(grant.rows, [{ allowed: true }])
  })
  await superuser('DROP DATABASE verify_legacy_foreign;')
  passed(`${variant}: cross-database grant refuses cleanup without changing roles or privileges`)

  await cleanupRoles()
  await withDatabase(connectionString, async (client) => {
    const remaining = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [
      legacyRoles,
    ])
    assert.deepEqual(remaining.rows, [])
    const preserved = await client.query('SELECT value FROM public.verify_legacy_data')
    assert.deepEqual(preserved.rows, [{ value: 'preserve this row' }])
    await client.query('DROP TABLE public.verify_legacy_data')
  })
  // A pre-upgrade dump still contains the removed roles. Ignore its ACL entries,
  // retaining the original owner raditi and restoring the actual saved row.
  await docker([
    'exec',
    name,
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    'raditi',
    '--no-acl',
    '--exit-on-error',
    dump,
  ])
  await withDatabase(connectionString, async (client) => {
    const restored = await client.query('SELECT value FROM public.verify_legacy_data')
    assert.deepEqual(restored.rows, [{ value: 'preserve this row' }])
    const owner = await client.query(
      "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'verify_legacy_data'",
    )
    assert.deepEqual(owner.rows, [{ tableowner: 'raditi' }])
    await client.query('DROP TABLE public.verify_legacy_data')
  })
  await docker(['exec', name, 'rm', dump])
  await cleanupRoles()
  await cleanupRoles()
  checks += 13
  passed(
    `${variant}: legacy roles removed; data and owner restored from old dump with --no-acl; cleanup is repeatable`,
  )
}

async function verifyDatabaseRestore(connectionString) {
  const history = await withDatabase(connectionString, async (client) => {
    await client.query('CREATE TABLE public.verify_restore_marker (value text NOT NULL)')
    await client.query("INSERT INTO public.verify_restore_marker VALUES ('before backup')")
    return (await client.query('SELECT * FROM public._prisma_migrations ORDER BY id')).rows
  })
  assert.ok(history.length > 0, 'The full dump must include applied migration history')
  const dump = '/tmp/verify-full-database.dump'
  await docker([
    'exec',
    name,
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'raditi',
    '--format=custom',
    '--create',
    '--file',
    dump,
  ])
  await withDatabase(connectionString, async (client) => {
    await client.query("UPDATE public.verify_restore_marker SET value = 'after backup'")
    await client.query('CREATE TABLE public.verify_restore_later (value text)')
  })
  // Restore through the maintenance database because --create replaces raditi itself.
  await docker([
    'exec',
    name,
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '--clean',
    '--if-exists',
    '--create',
    '--no-acl',
    '--exit-on-error',
    dump,
  ])
  await withDatabase(connectionString, async (client) => {
    const defaults = await client.query(
      "SELECT has_database_privilege('public', current_database(), 'CONNECT') AS allowed",
    )
    assert.deepEqual(defaults.rows, [{ allowed: true }], '--no-acl restores default PUBLIC access')
  })
  await bootstrap()
  await withDatabase(connectionString, async (client) => {
    const access = await client.query(`
      SELECT pg_get_userbyid(datdba) AS database_owner,
        has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner,
        (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'verify_restore_marker') AS table_owner
      FROM pg_database WHERE datname = current_database()
    `)
    assert.deepEqual(access.rows, [
      {
        database_owner: 'raditi',
        public_connect: false,
        schema_owner: 'raditi',
        table_owner: 'raditi',
      },
    ])
    assert.deepEqual((await client.query('SELECT value FROM public.verify_restore_marker')).rows, [
      { value: 'before backup' },
    ])
    assert.deepEqual(
      (await client.query('SELECT * FROM public._prisma_migrations ORDER BY id')).rows,
      history,
    )
    assert.deepEqual(
      (await client.query("SELECT to_regclass('public.verify_restore_later') IS NULL AS removed"))
        .rows,
      [{ removed: true }],
    )
    await client.query('DROP TABLE public.verify_restore_marker')
  })
  await docker(['exec', name, 'rm', dump])
  checks += 6
  passed(
    'full --create --no-acl restore plus bootstrap preserves data, ownership and migration history; PUBLIC access closed',
  )
}

async function main() {
  if (process.argv.slice(2).filter((arg) => arg !== '--').length) {
    throw new Error('This fixture accepts no arguments or external database URL')
  }
  const testLimitMs = testTimeoutMs(process.env)
  const context = await docker([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
  ])
  const endpoint = baseEnv.DOCKER_CONTEXT
    ? JSON.parse(context.output)
    : (baseEnv.DOCKER_HOST ?? JSON.parse(context.output))
  assert.match(
    endpoint,
    /^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\][^\s?#]+)$/,
    'A local Docker socket is required; remote endpoints are refused',
  )
  await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  directory = await mkdtemp(join(tmpdir(), 'raditi-db-verify-'))
  const config = join(directory, 'prisma.config.ts')
  const migrations = join(root, 'packages/db/prisma/migrations')
  const setMigrations = (path) =>
    writeFile(
      config,
      `export default { schema: ${JSON.stringify(join(root, 'packages/db/prisma/schema.prisma'))},
      migrations: { path: ${JSON.stringify(path)} }, datasource: { url: process.env.DATABASE_URL } }\n`,
    )
  await setMigrations(migrations)
  const envFile = join(directory, 'postgres.env')
  await writeFile(envFile, `POSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${passwords.superuser}\n`, {
    mode: 0o600,
  })
  stage = 'starting isolated PostgreSQL'
  // Docker may create the container before its client is interrupted or reports a failure.
  started = true
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--label',
    `${label}=${ownership}`,
    '--tmpfs',
    '/var/lib/postgresql/data:rw',
    '-p',
    '127.0.0.1::5432',
    '--env-file',
    envFile,
    image,
  ])
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await docker(
      ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'raditi'],
      {
        allowFailure: true,
      },
    )
    if (probe.code === 0) {
      ready = true
      break
    }
    await sleep(500, undefined, { signal: controller.signal })
  }
  assert.equal(ready, true, 'PostgreSQL did not become ready')
  await docker(['exec', '-i', name, 'sh', '-s'], {
    input: `set -eu\numask 077\nmkdir -p /run/raditi\n${Object.entries(passwords)
      .map(
        ([role, password]) =>
          `printf '%s' '${password}' > /run/raditi/${role === 'raditi' ? 'password' : `${role}-password`}`,
      )
      .join('\n')}\n`,
  })
  stage = 'bootstrap before migrations'
  await bootstrap()
  const binding = (await docker(['port', name, '5432/tcp'])).output
  assert.match(binding, /^127\.0\.0\.1:\d+$/)
  const databaseUrl = `postgresql://raditi:${passwords.raditi}@${binding}/raditi`
  const env = { DATABASE_URL: databaseUrl, NODE_ENV: 'test', CI: '1', RADITI_GATEWAY_DB_TESTS: '1' }
  const prisma = async (args, options = {}) =>
    command('pnpm', ['--filter', '@repo/db', 'exec', 'prisma', ...args, '--config', config], {
      env,
      ...options,
    })
  const seed = async () =>
    (await command('pnpm', ['--filter', '@repo/db', 'exec', 'node', 'prisma/seed.ts'], { env }))
      .output
  stage = 'migrations'
  await prisma(['validate'])
  await prisma(['generate'])
  // Exercise the documented upgrade order too: bootstrap against the old B3 schema,
  // before the account state columns and gateway tables exist.
  const earlier = join(directory, 'earlier-migrations')
  await mkdir(earlier)
  for (const entry of await readdir(migrations)) {
    if (entry === 'migration_lock.toml' || entry < '20260929130000_subscription_gateway') {
      await cp(join(migrations, entry), join(earlier, entry), { recursive: true })
    }
  }
  await setMigrations(earlier)
  await prisma(['migrate', 'deploy'])
  stage = 'upgrade from legacy roles on the pre-B6 schema'
  await verifyLegacyUpgrade(databaseUrl, bootstrap, 'app')
  await verifyLegacyUpgrade(databaseUrl, devBootstrap, 'dev')
  passed('bootstrap on the pre-B6 schema')
  // The switch to OpenCode meets a database of the earlier shells: the same commands an
  // operator runs, and after each stop the way out that needs none of the removed code.
  stage = 'switch to OpenCode on a database of the earlier shells'
  const beforeSwitch = join(directory, 'before-switch-migrations')
  await mkdir(beforeSwitch)
  for (const entry of await readdir(migrations)) {
    if (entry === 'migration_lock.toml' || entry < switchMigration) {
      await cp(join(migrations, entry), join(beforeSwitch, entry), { recursive: true })
    }
  }
  await setMigrations(beforeSwitch)
  await prisma(['migrate', 'deploy'])
  await setMigrations(migrations)
  checks += await withDatabase(databaseUrl, (client) =>
    verifySwitchToOpencode({
      client,
      // Maintenance of the database goes through the local socket as postgres.
      psql: (script, variables) =>
        docker(
          [
            'exec',
            '-i',
            name,
            'psql',
            '-U',
            'postgres',
            '-d',
            'raditi',
            ...Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`]),
          ],
          { input: script },
        ),
      deploy: () => prisma(['migrate', 'deploy'], { allowFailure: true }),
      resolve: () => prisma(['migrate', 'resolve', '--rolled-back', switchMigration]),
      seed,
      passed,
    }),
  )
  await prisma(['migrate', 'deploy'])
  passed('all migrations applied on empty local PostgreSQL')
  stage = 'shared user after migration'
  await verifySingleUser(databaseUrl, false)
  stage = 'bootstrap rerun'
  await bootstrap()
  await bootstrap()
  await verifySingleUser(databaseUrl, true)
  stage = 'full database dump and restore'
  await verifyDatabaseRestore(databaseUrl)
  stage = 'migration/schema consistency'
  const diff = await prisma([
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    join(root, 'packages/db/prisma/schema.prisma'),
    '--exit-code',
  ])
  passed(
    `Prisma schema matches applied migrations (${diff.output.includes('No difference') ? 'no difference' : 'exit 0'})`,
  )
  // One command per package: a suite that does not fit its limit is named by its stage.
  const suite = async (filter, title) => {
    stage = `${title} tests`
    const tests = await command('pnpm', ['--filter', filter, 'test'], {
      env,
      timeoutMs: testLimitMs,
    })
    console.log(
      tests.output
        .split('\n')
        .filter((line) => /Test Files|Tests\s|Duration/.test(line))
        .join('\n'),
    )
    passed(`${title} tests`)
  }
  // The tests of @repo/db may be given a developer's database: they seed and migrate only in
  // schemas they create and remove every row they write to `public`. Checked on the still
  // empty database, before the seed below.
  const assertUntouched = async (when) => {
    const left = await withDatabase(databaseUrl, leftovers)
    assert.deepEqual(
      left,
      { tables: [], schemas: [] },
      `Rows in public tables or other schemas ${when}: ${JSON.stringify(left)}`,
    )
  }
  stage = 'database before its tests'
  await assertUntouched('before the database tests')
  await suite('@repo/db', 'database')
  stage = 'database after its tests'
  await assertUntouched('left by the database tests')
  passed('database tests left no row in public and no schema behind')
  stage = 'reference data seed'
  // The integration tests of core read the seeded catalogue, as in CI after db:seed.
  assert.match(await seed(), /\[seed\] \w+: \+[1-9]\d* created, 0 updated/)
  // A new database: one shell and the catalogue of its backends, no row of an earlier shell or
  // provider.
  assert.deepEqual(await withDatabase(databaseUrl, catalogue), newDatabaseCatalogue)
  const reseeded = seedReport(await seed())
  assert.ok(Object.keys(reseeded).length >= 5, 'The seed must report its tables')
  for (const [table, counts] of Object.entries(reseeded)) assert.deepEqual(counts, [0, 0], table)
  assert.deepEqual(await withDatabase(databaseUrl, catalogue), newDatabaseCatalogue)
  passed(
    'reference data seeded: the catalogue of one shell and its two backends; a rerun changes nothing',
  )
  await suite('core', 'core')
  await suite('llm', 'llm')
  await suite('mcp', 'mcp')
  await suite('preview', 'preview')
  // Their PostgreSQL suites (billing accounts, the ledger and its read models; project and
  // profile writes; the avatar upload limit) skip themselves without DATABASE_URL, in
  // `pnpm gates` too: this is their only local run. They create and remove their own rows.
  await suite('@repo/billing', 'billing')
  await suite('@repo/trpc', 'trpc')
  await suite('web', 'web')
  passed(
    `${checks} shared-user and upgrade checks; database, core, llm, mcp, preview, billing, tRPC and web suites`,
  )
}

try {
  await main()
} catch (error) {
  console.error(`FAIL local database verification at ${stage}`)
  console.error(redact(error instanceof Error ? error.message : 'Unknown error'))
  process.exitCode = 1
} finally {
  if (started) {
    try {
      const actual = await docker(
        ['inspect', name, '--format', `{{index .Config.Labels "${label}"}}`],
        { cleanup: true, allowFailure: true },
      )
      if (actual.code === 0) {
        assert.equal(actual.output, ownership, 'Container ownership changed')
        await docker(['rm', '-fv', name], { cleanup: true })
      } else {
        assert.match(
          actual.output,
          /No such (object|container)/,
          'Could not inspect owned container',
        )
      }
      assert.equal(
        (await docker(['ps', '-aq', '--filter', `label=${label}=${ownership}`], { cleanup: true }))
          .output,
        '',
      )
      passed('owned PostgreSQL container and data removed')
    } catch {
      console.error(`FAIL cleanup of owned fixture ${name}`)
      process.exitCode = 1
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
