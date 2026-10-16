// The site connection wizard in the database (spec §12; docs/plan/39-site-connection-wizard.md):
// where a site's files and database are, the two stages that follow «Добавить сайт» and the
// database access among the kinds of site access. Runs the real migrations in a disposable schema
// over sites and credential references written before the change, then accepted and rejected
// rows for every hand-written CHECK. `public` is never touched.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectionTlsModes,
  databaseEngines,
  databaseSchemaLimits,
  databaseStructureSchema,
  importSkipReasons,
  provisioningErrorCodes,
  provisioningStages,
  provisioningStageStatuses,
  provisioningStageSummarySchema,
  siteSourceKinds,
  type DatabaseStructure,
} from '@repo/domain'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the wizard. */
const before = '20261004120000_billing_subscriptions'
const kind = '20261004200000_credential_kind_db'
const change = '20261004200100_site_connection'
const at = new Date('2026-10-04T12:00:00Z')
const later = new Date('2026-10-04T12:01:00Z')
const hostKey = `ssh-ed25519 SHA256:${'A'.repeat(43)}`
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const UNSAFE_NEW_ENUM_VALUE = '55P04'
type Values = Record<string, unknown>

const migrationSql = (name: string) =>
  readFile(new URL(`./migrations/${name}/migration.sql`, import.meta.url), 'utf8')

const bytes = (text: string) => Buffer.byteLength(text)

/** A document of `length` bytes in the text form PostgreSQL keeps for jsonb: `{"k": "…"}`. */
const paddedObject = (length: number, fill = 'x') =>
  JSON.stringify({ k: fill.repeat((length - bytes('{"k": ""}')) / bytes(fill)) })

const newTables = [
  'site_code_sources',
  'site_database_schemas',
  'site_databases',
  'site_provisioning_stages',
]
const newTypes = [
  'ConnectionTls',
  'DatabaseEngine',
  'ProvisioningStage',
  'ProvisioningStageStatus',
  'SiteSourceKind',
]

/** What the migration adds or replaces, as the catalog shows it. */
async function shape(target: MigratedSchema) {
  const rows = async (text: string, values: unknown[] = [target.name]) =>
    (await target.db.query(text, values)).rows as Values[]
  return {
    scope: await rows(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE connamespace = $1::regnamespace AND conname = 'credential_refs_site_scope_check'`,
    ),
    tables: await rows(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name COLLATE "C"`,
      [target.name, newTables],
    ),
    types: await rows(
      `SELECT typname FROM pg_type
       WHERE typnamespace = $1::regnamespace AND typname = ANY($2::text[])
       ORDER BY typname COLLATE "C"`,
      [target.name, newTypes],
    ),
    columns: await rows(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'sites'
         AND column_name IN ('description', 'healthcheck_url') ORDER BY column_name COLLATE "C"`,
    ),
  }
}

describe.skipIf(!databaseUrl)('site connection migrations', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    /** Written before the change, with the columns of that time only. */
    legacySite: randomUUID(),
    legacyActiveSite: randomUUID(),
    /** Connected through the wizard. */
    site: randomUUID(),
    /** A site without a single reference. */
    bareSite: randomUUID(),
    ftpRef: randomUUID(),
    sshRef: randomUUID(),
    gitRef: randomUUID(),
    dbRef: randomUUID(),
  }
  const sources = { sites: 'sites', credentials: 'credential_refs' } as const
  type Tables = Record<keyof typeof sources, Values[]>
  let legacy: Tables
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

  const select = async (table: string) =>
    (await schema.db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows as Values[]

  function rejected(query: Promise<unknown>, constraint: string, code = CHECK_VIOLATION) {
    return expect(query).rejects.toMatchObject({ code, constraint })
  }

  const site = (id: string, extra: Values = {}) =>
    insert('sites', {
      id,
      workspace_id: ids.workspace,
      name: 'Synthetic site',
      url: `https://${id}.invalid`,
      stack: 'wordpress',
      updated_at: at,
      ...extra,
    })

  /** A reference to a site access, at the path its reader follows. */
  const reference = (accessKind: string, extra: Values = {}) =>
    insert('credential_refs', {
      id: randomUUID(),
      workspace_id: ids.workspace,
      site_id: ids.site,
      kind: accessKind,
      vault_path: `kv/sites/${randomUUID()}/${accessKind}`,
      updated_at: at,
      ...extra,
    })

  const source = { site_id: ids.site, host: 'files.example.ru', updated_at: at }
  const ftp = (extra: Values = {}) =>
    insert('site_code_sources', {
      ...source,
      kind: 'ftp',
      port: 21,
      root_path: '/public_html',
      tls: 'verified',
      credential_ref_id: ids.ftpRef,
      ...extra,
    })
  const sftp = (extra: Values = {}) =>
    insert('site_code_sources', {
      ...source,
      kind: 'sftp',
      port: 22,
      root_path: '/var/www/site',
      host_key: hostKey,
      credential_ref_id: ids.sshRef,
      ...extra,
    })
  const git = (extra: Values = {}) =>
    insert('site_code_sources', {
      ...source,
      kind: 'git',
      host: 'git.example.ru',
      port: 443,
      repository_url: 'https://git.example.ru/owner/site',
      branch: 'main',
      credential_ref_id: ids.gitRef,
      ...extra,
    })
  const database = (extra: Values = {}) =>
    insert('site_databases', {
      site_id: ids.site,
      engine: 'mysql',
      host: 'db.example.ru',
      port: 3306,
      database_name: 'site',
      tls: 'verified',
      credential_ref_id: ids.dbRef,
      updated_at: at,
      ...extra,
    })
  const stage = (extra: Values = {}) =>
    insert('site_provisioning_stages', {
      site_id: ids.site,
      stage: 'code_import',
      updated_at: at,
      ...extra,
    })
  const failed = { status: 'failed', error_code: 'timed_out', finished_at: later }
  const structure = (extra: Values = {}) =>
    insert('site_database_schemas', {
      site_id: ids.site,
      engine: 'mysql',
      tables_count: 0,
      columns_count: 0,
      schema: '{"v": 1, "engine": "mysql", "tables": [], "truncated": false}',
      updated_at: at,
      ...extra,
    })

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'site_connection')
    await schema.migrate(before)
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic', updated_at: at })
    // Sites of the one-screen form: none of them knows a description or a check address.
    await site(ids.legacySite, { created_at: at })
    await site(ids.legacyActiveSite, {
      status: 'active',
      drift_policy: 'freeze',
      operator_review: false,
      created_at: at,
    })
    // Every kind of reference that existed before the change.
    for (const accessKind of ['ssh', 'ftp', 'wp', 'browser', 'git'])
      await reference(accessKind, { site_id: ids.legacySite, key_version: 3, created_at: at })
    // A git access of a workspace, not of one site (P8): the old CHECK accepted it.
    await reference('git', {
      site_id: null,
      vault_path: `kv/git/${ids.workspace}`,
      created_at: at,
    })
    for (const platformKind of ['llm_provider', 'subscription'])
      await reference(platformKind, {
        workspace_id: null,
        site_id: null,
        vault_path: `kv/platform/${platformKind}/${randomUUID()}`,
        created_at: at,
      })
    const tables = async (): Promise<Tables> => ({
      sites: await select(sources.sites),
      credentials: await select(sources.credentials),
    })
    legacy = await tables()
    await schema.migrate(kind)
    await schema.migrate(change)
    migrated = await tables()
    await schema.migrate()
    // What the wizard writes first: the site and one reference per access.
    await site(ids.site)
    await site(ids.bareSite)
    await reference('ftp', { id: ids.ftpRef })
    await reference('ssh', { id: ids.sshRef })
    await reference('git', { id: ids.gitRef })
    await reference('db', { id: ids.dbRef })
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

  describe('rows written before the wizard', () => {
    it('survive both migrations: sites gain two empty columns, references are untouched', () => {
      expect(legacy.sites).toHaveLength(2)
      expect(legacy.credentials).toHaveLength(8)
      expect(migrated.sites).toEqual(
        legacy.sites.map((row) => ({ ...row, description: null, healthcheck_url: null })),
      )
      expect(migrated.credentials).toEqual(legacy.credentials)
      // The git access without a site is among them.
      expect(migrated.credentials.filter((row) => row.site_id === null)).toHaveLength(3)
    })

    it('keep their columns through every later migration', async () => {
      // A later migration may add columns of its own: only the ones of these rows are compared.
      for (const [table, rows] of Object.entries(migrated) as [keyof Tables, Values[]][]) {
        const columns = Object.keys(rows[0]!)
        const kept = new Set(rows.map((row) => row.id))
        expect(
          (await select(sources[table]))
            .filter((row) => kept.has(row.id))
            .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))),
        ).toEqual(rows)
      }
    })

    it('still pass their checks when they are written again', async () => {
      for (const row of migrated.credentials)
        await update('credential_refs', 'id', row.id as string, { key_version: 4 })
      for (const row of migrated.sites)
        await update('sites', 'id', row.id as string, { name: 'Synthetic rewrite' })
    })
  })

  describe('the migrations as Prisma applies them', () => {
    it('cannot be merged: the CHECK names an enum value that must be committed first', async () => {
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'site_connection_enum')
      try {
        await scratch.migrate(before)
        await scratch.db.query('BEGIN')
        await scratch.db.query(await migrationSql(kind))
        // The file's own BEGIN only warns inside an open transaction; its last CHECK names the
        // value that is not committed yet.
        await expect(scratch.db.query(await migrationSql(change))).rejects.toMatchObject({
          code: UNSAFE_NEW_ENUM_VALUE,
        })
      } finally {
        await scratch.drop()
      }
    }, 30_000)

    it('is one transaction: a failure in the middle leaves nothing of it behind', async () => {
      // `prisma migrate deploy` sends a migration statement by statement, each in its own
      // implicit transaction (seen in the PostgreSQL statement log). Only the file's own
      // BEGIN and COMMIT keep the DROP of the site-scope CHECK together with its ADD, and
      // the new tables together with their constraints.
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'site_connection_atomic')
      try {
        await scratch.migrate(kind)
        const previous = await shape(scratch)
        expect(previous.scope).toHaveLength(1)
        expect(previous.scope[0]!.definition).not.toContain("'db'")
        expect(previous).toMatchObject({ tables: [], types: [], columns: [] })
        const statements = (await migrationSql(change))
          .split(/;[ \t]*$/m)
          .map((statement) => statement.trim())
          .filter(Boolean)
        expect(statements[0]).toMatch(/BEGIN$/)
        expect(statements.at(-1)).toBe('COMMIT')
        // Every statement up to the last ADD, the DROP of the old CHECK among them, and a
        // failure where that ADD would stand.
        const lastAdd = statements.map((text) => /ADD CONSTRAINT/.test(text)).lastIndexOf(true)
        expect(statements[lastAdd - 1]).toMatch(
          /DROP CONSTRAINT "credential_refs_site_scope_check"$/,
        )
        for (const statement of statements.slice(0, lastAdd)) await scratch.db.query(statement)
        await expect(scratch.db.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
        // What the end of the connection does to a transaction that is still open.
        await scratch.db.query('ROLLBACK')
        expect(await shape(scratch)).toEqual(previous)
        // And the whole file after that: the migration can simply be applied again.
        await scratch.migrate(change)
        const applied = await shape(scratch)
        expect(applied.scope[0]!.definition).toContain("'db'")
        expect(applied.tables.map((row) => row.table_name)).toEqual(newTables)
        expect(applied.types.map((row) => row.typname)).toEqual(newTypes)
        expect(applied.columns).toHaveLength(2)
      } finally {
        await scratch.drop()
      }
    }, 30_000)

    it.each([
      ['SiteSourceKind', siteSourceKinds],
      ['DatabaseEngine', databaseEngines],
      ['ConnectionTls', connectionTlsModes],
      ['ProvisioningStage', provisioningStages],
      ['ProvisioningStageStatus', provisioningStageStatuses],
      // The new value is the last one, as ALTER TYPE … ADD VALUE puts it.
      [
        'CredentialKind',
        ['ssh', 'ftp', 'wp', 'browser', 'git', 'llm_provider', 'subscription', 'db'],
      ],
    ])('create the type %s with the values of the domain, in its order', async (type, values) => {
      const { rows } = await schema.db.query(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typnamespace = $1::regnamespace AND t.typname = $2 ORDER BY e.enumsortorder`,
        [schema.name, type],
      )
      expect(rows.map((row: Values) => row.enumlabel)).toEqual([...values])
    })

    it('index the unfinished stages by the time of their last change', async () => {
      const { rows } = await schema.db.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
        [schema.name, 'site_provisioning_stages_unfinished_idx'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toMatch(/\(updated_at\) WHERE \(finished_at IS NULL\)$/)
    })

    it('serve from that index only a statement that names finished_at IS NULL', async () => {
      // PostgreSQL does not derive the predicate of a partial index from the CHECK that ties
      // the status to finished_at: a sweep that asks for the status alone reads every row, the
      // finished stages of every site among them.
      const index = 'site_provisioning_stages_unfinished_idx'
      const plan = async (where: string) => {
        const { rows } = await schema.db.query(
          `EXPLAIN (FORMAT JSON)
           SELECT site_id, stage, attempt FROM site_provisioning_stages WHERE ${where}`,
        )
        return JSON.stringify(rows)
      }
      const silent = `status = 'running' AND heartbeat_at < now() - interval '2 minutes'`
      const waiting = `status = 'queued' AND updated_at < now() - interval '5 minutes'`
      // Leaves the planner the index wherever the index may be used at all.
      await schema.db.query('SET LOCAL enable_seqscan = off')

      expect(await plan(`finished_at IS NULL AND enqueues < 5 AND ${silent}`)).toContain(index)
      expect(await plan(`finished_at IS NULL AND ${waiting}`)).toContain(index)
      expect(await plan(waiting)).not.toContain(index)
    })
  })

  describe('sites', () => {
    it.each([
      ['no description and no check address', {}],
      ['a description of 2000 characters', { description: 'я'.repeat(2000) }],
      ['a check address over https', { healthcheck_url: 'https://example.ru/health' }],
      ['a check address over http', { healthcheck_url: 'http://example.ru/' }],
      [
        'a check address of 1024 characters',
        { healthcheck_url: `https://x.ru/${'a'.repeat(1011)}` },
      ],
    ])('accept %s', async (_, values) => {
      await site(randomUUID(), values)
    })

    it.each([
      ['another scheme', 'ftp://example.ru/health'],
      ['no scheme', 'example.ru/health'],
      ['a scheme without an address form', 'https:example.ru'],
      ['an empty text', ''],
      ['a space before the scheme', ' https://example.ru/'],
      // The transport stores the canonical form of URL, whose scheme is lower case.
      ['a scheme in upper case', 'HTTPS://example.ru/'],
    ])('reject a check address with %s', async (_, url) => {
      await rejected(site(randomUUID(), { healthcheck_url: url }), 'sites_healthcheck_url_check')
    })

    it('reject a description of 2001 characters', async () => {
      await expect(site(randomUUID(), { description: 'я'.repeat(2001) })).rejects.toMatchObject({
        code: '22001',
      })
    })

    it('reject a check address of 1025 characters: the stored form of a shorter typed one', async () => {
      // URL writes a Cyrillic letter as six characters, so the canonical form that is stored can
      // outgrow the column while the typed address is far inside the limit of the form.
      const typed = `https://x.ru/${'я'.repeat(168)}aaaa`
      const stored = new URL(typed).href
      expect([typed.length, stored.length]).toEqual([185, 1025])
      await expect(site(randomUUID(), { healthcheck_url: stored })).rejects.toMatchObject({
        code: '22001',
      })
    })
  })

  describe('site_code_sources', () => {
    it.each([
      ['an FTP server', ftp],
      ['an SFTP server', sftp],
      ['a repository', git],
    ])('accepts %s', async (_, row) => {
      await row()
    })

    it('accepts a repository without a branch: the remote default is imported', async () => {
      await git({ branch: null })
    })

    it('holds one source per site', async () => {
      await ftp()
      await rejected(sftp(), 'site_code_sources_pkey', UNIQUE_VIOLATION)
    })

    describe('site_code_sources_port_check', () => {
      it.each([1, 65535])('accepts the port %i', async (port) => {
        await ftp({ port })
      })

      it.each([0, -1, 65536])('rejects the port %i', async (port) => {
        await rejected(ftp({ port }), 'site_code_sources_port_check')
      })
    })

    describe('site_code_sources_shape_check', () => {
      it.each([
        ['a repository without an address', () => git({ repository_url: null })],
        [
          'a repository over http',
          () => git({ repository_url: 'http://git.example.ru/owner/site' }),
        ],
        [
          'a repository over ssh',
          () => git({ repository_url: 'ssh://git@git.example.ru/owner/site' }),
        ],
        ['a repository with a folder', () => git({ root_path: '/' })],
        ['an FTP server without a folder', () => ftp({ root_path: null })],
        [
          'an FTP server with a repository address',
          () => ftp({ repository_url: 'https://git.example.ru/owner/site' }),
        ],
        ['an FTP server with a branch', () => ftp({ branch: 'main' })],
        ['an SFTP server without a folder', () => sftp({ root_path: null })],
        ['an SFTP server with a branch', () => sftp({ branch: 'main' })],
      ])('rejects %s', async (_, row) => {
        await rejected(row(), 'site_code_sources_shape_check')
      })
    })

    describe('site_code_sources_tls_check', () => {
      it.each(connectionTlsModes)('accepts an FTP server with the protection %s', async (tls) => {
        await ftp({ tls })
      })

      it.each([
        ['an FTP server without a protection mode', () => ftp({ tls: null })],
        ['an SFTP server with one', () => sftp({ tls: 'verified' })],
        ['a repository with one', () => git({ tls: 'verified' })],
      ])('rejects %s', async (_, row) => {
        await rejected(row(), 'site_code_sources_tls_check')
      })
    })

    describe('site_code_sources_host_key_check', () => {
      it.each([
        ['an SFTP server without the key the user saw', () => sftp({ host_key: null })],
        ['an FTP server with a host key', () => ftp({ host_key: hostKey })],
        ['a repository with a host key', () => git({ host_key: hostKey })],
      ])('rejects %s', async (_, row) => {
        await rejected(row(), 'site_code_sources_host_key_check')
      })
    })
  })

  describe('site_databases', () => {
    it.each(databaseEngines)('accepts a %s database', async (engine) => {
      await database({ engine })
    })

    it.each(connectionTlsModes)('accepts the protection %s', async (tls) => {
      await database({ tls })
    })

    it('holds one database per site', async () => {
      await database()
      await rejected(database({ engine: 'postgres' }), 'site_databases_pkey', UNIQUE_VIOLATION)
    })

    it.each([1, 65535])('accepts the port %i', async (port) => {
      await database({ port })
    })

    it.each([0, -1, 65536])('rejects the port %i', async (port) => {
      await rejected(database({ port }), 'site_databases_port_check')
    })
  })

  describe('site_provisioning_stages', () => {
    it('starts a stage queued, at its first attempt and first event, held by nobody', async () => {
      await schema.db.query(
        `INSERT INTO "site_provisioning_stages" ("site_id", "stage", "updated_at")
         VALUES ($1, 'database_schema', $2)`,
        [ids.site, at],
      )
      const { rows } = await schema.db.query(
        `SELECT * FROM "site_provisioning_stages" WHERE "site_id" = $1`,
        [ids.site],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        stage: 'database_schema',
        status: 'queued',
        attempt: 1,
        enqueues: 1,
        lease_epoch: 0,
        heartbeat_at: null,
        error_code: null,
        summary: null,
        started_at: null,
        finished_at: null,
      })
    })

    it('holds one row per stage of a site', async () => {
      for (const name of provisioningStages) await stage({ stage: name })
      await rejected(stage(), 'site_provisioning_stages_pkey', UNIQUE_VIOLATION)
    })

    describe('site_provisioning_stages_counters_check', () => {
      it('accepts a later attempt, a later event and a held lease', async () => {
        await stage({ attempt: 7, enqueues: 5, lease_epoch: 12 })
      })

      it.each([
        ['a zero attempt', { attempt: 0 }],
        ['a zero count of events', { enqueues: 0 }],
        ['a negative lease epoch', { lease_epoch: -1 }],
      ])('rejects %s', async (_, values) => {
        await rejected(stage(values), 'site_provisioning_stages_counters_check')
      })
    })

    describe('site_provisioning_stages_finished_check', () => {
      it.each([
        ['queued', { status: 'queued' }],
        ['running', { status: 'running', started_at: at, heartbeat_at: at, lease_epoch: 1 }],
        ['succeeded', { status: 'succeeded', started_at: at, finished_at: later }],
        ['failed', { ...failed, started_at: at }],
      ])('accepts a stage %s', async (_, values) => {
        await stage(values)
      })

      it.each([
        ['a succeeded stage without its finish time', { status: 'succeeded' }],
        ['a failed stage without its finish time', { ...failed, finished_at: null }],
        ['a queued stage with a finish time', { status: 'queued', finished_at: later }],
        ['a running stage with a finish time', { status: 'running', finished_at: later }],
      ])('rejects %s', async (_, values) => {
        await rejected(stage(values), 'site_provisioning_stages_finished_check')
      })

      it('lets a failed stage return to the queue only with its finish time cleared', async () => {
        await stage(failed)
        const requeued = { status: 'queued', attempt: 2, error_code: null }
        await schema.db.query('SAVEPOINT requeue')
        await expect(
          update('site_provisioning_stages', 'site_id', ids.site, requeued),
        ).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint: 'site_provisioning_stages_finished_check',
        })
        await schema.db.query('ROLLBACK TO SAVEPOINT requeue')
        await update('site_provisioning_stages', 'site_id', ids.site, {
          ...requeued,
          finished_at: null,
        })
      })
    })

    describe('site_provisioning_stages_error_check', () => {
      it.each([
        ['a failed stage without a code', { ...failed, error_code: null }],
        [
          'a succeeded stage with a code',
          { status: 'succeeded', finished_at: later, error_code: 'internal' },
        ],
        ['a queued stage with a code', { status: 'queued', error_code: 'internal' }],
        ['a running stage with a code', { status: 'running', error_code: 'internal' }],
      ])('rejects %s', async (_, values) => {
        await rejected(stage(values), 'site_provisioning_stages_error_check')
      })
    })

    describe('site_provisioning_stages_error_code_check', () => {
      it.each(provisioningErrorCodes)('accepts the code %s of the domain', async (code) => {
        await stage({ ...failed, error_code: code })
      })

      it.each([
        ['one letter', 'a'],
        ['an upper-case letter', 'Internal'],
        ['a hyphen', 'timed-out'],
        ['a digit', 'error_1'],
        ['a leading underscore', '_internal'],
        ['a message', 'connect ECONNREFUSED 10.0.0.1:21'],
        ['a path', 'wp-content/uploads'],
        ['an empty text', ''],
      ])('rejects a code with %s', async (_, code) => {
        await rejected(
          stage({ ...failed, error_code: code }),
          'site_provisioning_stages_error_code_check',
        )
      })
    })

    describe('site_provisioning_stages_summary_check', () => {
      // Every counter the domain knows, each at the largest whole number.
      const most = Number.MAX_SAFE_INTEGER
      const largest = provisioningStageSummarySchema.parse({
        files: most,
        bytes: most,
        skipped: Object.fromEntries(importSkipReasons.map((reason) => [reason, most])),
        tables: most,
        columns: most,
        truncated: true,
        recheck: true,
      })

      it.each([
        ['no summary', null],
        ['an empty object', '{}'],
        ['the largest summary of the domain', JSON.stringify(largest)],
        ['an object of 2048 bytes', paddedObject(2048)],
      ])('accepts %s', async (_, summary) => {
        await stage({ summary })
      })

      it.each([
        ['a list', '[]'],
        ['a text', '"imported"'],
        ['a number', '12'],
        ['a JSON null', 'null'],
        ['an object of 2049 bytes', paddedObject(2049)],
        // Bytes, not characters: 1020 Cyrillic letters are 2040 bytes.
        ['an object of 1029 characters in 2049 bytes', paddedObject(2049, 'я')],
      ])('rejects %s', async (_, summary) => {
        await rejected(stage({ summary }), 'site_provisioning_stages_summary_check')
      })

      it('survives the statement that queues a failed stage again', async () => {
        await stage({
          ...failed,
          started_at: at,
          heartbeat_at: at,
          lease_epoch: 3,
          summary: '{"files": 12, "bytes": 3400}',
        })
        // The statement of a retry (docs/plan/39-site-connection-wizard.md): it passes every
        // check of the row and does not name the summary.
        await schema.db.query(
          `UPDATE "site_provisioning_stages"
           SET "status" = 'queued', "attempt" = "attempt" + 1, "enqueues" = 1, "error_code" = NULL,
               "started_at" = NULL, "finished_at" = NULL, "heartbeat_at" = NULL, "updated_at" = now()
           WHERE "site_id" = $1 AND "stage" = 'code_import' AND "status" = 'failed'`,
          [ids.site],
        )
        const { rows } = await schema.db.query(
          `SELECT "status", "attempt", "enqueues", "lease_epoch", "summary"
           FROM "site_provisioning_stages" WHERE "site_id" = $1`,
          [ids.site],
        )
        expect(rows).toEqual([
          {
            status: 'queued',
            attempt: 2,
            enqueues: 1,
            lease_epoch: 3,
            summary: { files: 12, bytes: 3400 },
          },
        ])
      })
    })
  })

  describe('site_database_schemas', () => {
    it('holds one structure per site', async () => {
      await structure()
      await rejected(structure(), 'site_database_schemas_pkey', UNIQUE_VIOLATION)
    })

    describe('site_database_schemas_counts_check', () => {
      it('accepts an empty database and a counted one', async () => {
        await structure()
        await update('site_database_schemas', 'site_id', ids.site, {
          tables_count: 12,
          columns_count: 148,
          server_version: '8.4.2',
        })
      })

      it.each([
        ['a negative count of tables', { tables_count: -1 }],
        ['a negative count of columns', { columns_count: -1 }],
      ])('rejects %s', async (_, values) => {
        await rejected(structure(values), 'site_database_schemas_counts_check')
      })
    })

    describe('site_database_schemas_schema_check', () => {
      const limit = databaseSchemaLimits.storedBytes

      it('accepts a document of exactly 2 MiB', async () => {
        expect(limit).toBe(2_097_152)
        await structure({ schema: paddedObject(limit) })
      })

      it.each([
        ['a list', '[]'],
        ['a text', '"tables"'],
        ['a JSON null', 'null'],
        ['a document one byte over 2 MiB', paddedObject(limit + 1)],
      ])('rejects %s', async (_, document) => {
        await rejected(structure({ schema: document }), 'site_database_schemas_schema_check')
      })

      it('measures the text PostgreSQL keeps, which is longer than JSON.stringify', async () => {
        // jsonb is written back with a space after every colon and comma. A worker that cuts the
        // structure down to the limit by JSON.stringify alone still gets this refusal: it has to
        // count the separators too, or ask PostgreSQL for octet_length($1::jsonb::text).
        const table = (index: number): DatabaseStructure['tables'][number] => ({
          schema: null,
          name: `wp_table_${index}`,
          kind: 'table',
          columns: Array.from({ length: 20 }, (_, column) => ({
            name: `column_${column}`,
            type: 'varchar(255)',
            nullable: false,
            hasDefault: false,
            generated: false,
            autoIncrement: false,
          })),
          primaryKey: ['column_0'],
          indexes: [],
          foreignKeys: [],
        })
        const document: DatabaseStructure = {
          v: 1,
          engine: 'mysql',
          tables: Array.from({ length: databaseSchemaLimits.tables }, (_, index) => table(index)),
          truncated: true,
        }
        while (bytes(JSON.stringify(document)) > limit) document.tables.pop()
        const serialized = JSON.stringify(databaseStructureSchema.parse(document))
        expect(bytes(serialized)).toBeLessThanOrEqual(limit)
        // No text of this document holds a colon or a comma: every one is a separator.
        const separators = serialized.match(/[:,]/g)?.length ?? 0
        const { rows } = await schema.db.query('SELECT octet_length($1::jsonb::text) AS stored', [
          serialized,
        ])
        expect(rows[0].stored).toBe(bytes(serialized) + separators)
        expect(rows[0].stored).toBeGreaterThan(limit)
        await rejected(structure({ schema: serialized }), 'site_database_schemas_schema_check')
      })
    })
  })

  describe('credential_refs_site_scope_check', () => {
    it('accepts the database access of a site', async () => {
      await reference('db')
    })

    it.each(['ssh', 'ftp', 'wp', 'browser', 'db'])(
      'rejects the %s access without a site',
      async (accessKind) => {
        await rejected(reference(accessKind, { site_id: null }), 'credential_refs_site_scope_check')
      },
    )

    it('still accepts a git access without a site', async () => {
      await reference('git', { site_id: null })
    })

    it('still requires the workspace of a site access', async () => {
      await rejected(
        reference('db', { workspace_id: null }),
        'credential_refs_site_workspace_check',
      )
    })
  })

  describe('foreign keys', () => {
    it.each([
      ['site_code_sources_site_id_fkey', () => ftp({ site_id: randomUUID() })],
      ['site_code_sources_credential_ref_id_fkey', () => ftp({ credential_ref_id: randomUUID() })],
      ['site_databases_site_id_fkey', () => database({ site_id: randomUUID() })],
      [
        'site_databases_credential_ref_id_fkey',
        () => database({ credential_ref_id: randomUUID() }),
      ],
      ['site_provisioning_stages_site_id_fkey', () => stage({ site_id: randomUUID() })],
      ['site_database_schemas_site_id_fkey', () => structure({ site_id: randomUUID() })],
    ])('%s names an existing row', async (constraint, row) => {
      await rejected(row(), constraint, FOREIGN_KEY_VIOLATION)
    })

    it.each([
      ['site_code_sources_credential_ref_id_fkey', ftp, ids.ftpRef],
      ['site_databases_credential_ref_id_fkey', database, ids.dbRef],
    ])('%s keeps a reference that a connection points at', async (constraint, row, id) => {
      await row()
      await rejected(
        schema.db.query('DELETE FROM "credential_refs" WHERE "id" = $1', [id]),
        constraint,
        FOREIGN_KEY_VIOLATION,
      )
    })

    it.each([
      ['site_provisioning_stages_site_id_fkey', stage],
      ['site_database_schemas_site_id_fkey', structure],
      // The reference belongs to another site: nothing but these keys holds the deleted one.
      ['site_code_sources_site_id_fkey', ftp],
      ['site_databases_site_id_fkey', database],
    ])('%s keeps a site that has such a row', async (constraint, row) => {
      await row({ site_id: ids.bareSite })
      await rejected(
        schema.db.query('DELETE FROM "sites" WHERE "id" = $1', [ids.bareSite]),
        constraint,
        FOREIGN_KEY_VIOLATION,
      )
    })
  })
})
