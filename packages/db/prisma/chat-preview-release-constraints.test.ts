// Chat → preview → /release in the database (docs/plan/53-chat-preview-release.md, «Таблицы»):
// aliases, the installed version, the head of a dialog and its feed, previews, candidates,
// releases and client variables. Runs the real migrations in a disposable schema over rows
// written before the change, then accepted and rejected rows for the hand-written CHECKs.
// `public` is never touched.
import { randomUUID } from 'node:crypto'

import {
  ALIAS_PATTERN_SOURCE,
  jsonbTextBytes,
  refusedEnvVarNames,
  refusedEnvVarPrefixes,
  releaseStatuses,
  terminalReleaseStatuses,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the change. */
const before = '20261011120000_credit_hold_accounts'
const change = '20261017200000_chat_preview_release'
const at = new Date('2026-10-17T12:00:00Z')
const later = new Date('2026-10-17T12:01:00Z')
const hash = 'a'.repeat(64)
const sha = 'b'.repeat(40)
const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
type Values = Record<string, unknown>

describe.skipIf(!databaseUrl)('chat preview release constraints', () => {
  let schema: MigratedSchema
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    site: randomUUID(),
    otherSite: randomUUID(),
    tasks: Array.from({ length: 6 }, () => randomUUID()),
    environment: randomUUID(),
    deployment: randomUUID(),
    turn: randomUUID(),
    driver: `test-${randomUUID().slice(0, 8)}`,
    provider: randomUUID(),
    model: randomUUID(),
    credential: randomUUID(),
    account: randomUUID(),
    key: randomUUID(),
    assignment: randomUUID(),
    legacyCall: randomUUID(),
    agentCall: randomUUID(),
    source: randomUUID(),
  }
  const task = (index: number) => ids.tasks[index]!
  let before_: { sites: Values[]; tasks: Values[]; events: Values[]; calls: Values[] }

  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
    return values
  }

  const update = (table: string, key: string, id: string, values: Values) => {
    const columns = Object.keys(values)
    return schema.db.query(
      `UPDATE "${table}" SET ${columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')}
       WHERE "${key}" = $1`,
      [id, ...Object.values(values)],
    )
  }

  const select = async (table: string, order = 'id') =>
    (await schema.db.query(`SELECT * FROM "${table}" ORDER BY "${order}"`)).rows as Values[]

  /** A statement that must fail with `code` and `constraint`, leaving the test's transaction usable. */
  async function refuses(
    query: () => Promise<unknown>,
    constraint: string,
    code = CHECK_VIOLATION,
  ) {
    await schema.db.query('SAVEPOINT refused')
    try {
      await expect(query()).rejects.toMatchObject({ code, constraint })
    } finally {
      await schema.db.query('ROLLBACK TO SAVEPOINT refused')
    }
  }

  const preview = (extra: Values = {}) =>
    insert('preview_environments', {
      id: randomUUID(),
      site_id: ids.site,
      task_id: task(0),
      hostname: 'site-0f3a9c1b-chat-a1b2c3.localhost',
      expires_at: later,
      updated_at: at,
      ...extra,
    })

  const candidate = (extra: Values = {}) =>
    insert('task_candidates', {
      id: randomUUID(),
      task_id: task(0),
      revision: 1,
      turn_no: 1,
      base_sha: sha,
      base_tree: sha,
      head_sha: 'c'.repeat(40),
      db_plan_sha256: hash,
      proposed_bump: 'minor',
      proposed_version: 'v1.1.0',
      facts: '{}',
      ...extra,
    })

  const release = (candidateId: string, extra: Values = {}) =>
    insert('site_releases', {
      id: randomUUID(),
      site_id: ids.site,
      task_id: task(0),
      candidate_id: candidateId,
      candidate_revision: 1,
      attempt: 1,
      release_key: randomUUID().replaceAll('-', '').repeat(2),
      version: 'v1.1.0',
      tag: 'v1.1.0',
      bump: 'minor',
      main_before_sha: sha,
      committed_at: at,
      approved_at: at,
      updated_at: at,
      ...extra,
    })

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'chat_preview_release')
    await schema.migrate(before)
    await insert('users', {
      id: ids.user,
      name: 'Synthetic',
      email: `${ids.user}@example.invalid`,
      updated_at: at,
    })
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic', updated_at: at })
    for (const id of [ids.site, ids.otherSite])
      await insert('sites', {
        id,
        workspace_id: ids.workspace,
        name: 'Synthetic site',
        url: `https://${id}.invalid`,
        stack: 'wordpress',
        updated_at: at,
      })
    for (const [index, id] of ids.tasks.entries())
      await insert('tasks', {
        id,
        workspace_id: ids.workspace,
        site_id: index < 4 ? ids.site : ids.otherSite,
        status: index === 1 ? 'queued' : 'done',
        updated_at: at,
      })
    await insert('environments', {
      id: ids.environment,
      site_id: ids.site,
      host: 'synthetic.invalid',
      deploy_method: 'rsync',
      path: '/var/www',
      updated_at: at,
    })
    await insert('deployments', {
      id: ids.deployment,
      site_id: ids.site,
      environment_id: ids.environment,
      task_id: task(0),
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
      task_id: task(0),
      turn_no: 1,
      driver_id: ids.driver,
      image: 'synthetic/agent:test',
    })
    await insert('llm_providers', {
      id: ids.provider,
      slug: ids.provider,
      name: 'Synthetic',
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
      task_id: task(0),
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
      task_id: task(0),
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
      id: ids.source,
      site_id: ids.site,
      task_id: task(0),
      object_ref: 'post:42',
      s3_key: `snapshots/${ids.site}/${ids.source}.json`,
      expires_at: later,
    })
    await insert('mcp_calls', {
      id: ids.legacyCall,
      turn_id: ids.turn,
      tool: 'wp_rest',
      idempotency_key: 'legacy',
      result: 'ok',
      response: '{}',
      finished_at: later,
    })
    await insert('mcp_calls', {
      id: ids.agentCall,
      turn_id: ids.turn,
      tool: 'wp_rest',
      idempotency_key: 'agent',
      object_ref: 'post:42',
      snapshot_id: ids.source,
      assignment_id: ids.assignment,
      credential_key_id: ids.key,
      request_hash: hash,
      lease_epoch: 1,
    })
    for (const type of ['turn.lifecycle', 'turn.output', 'llm.policy_flagged'])
      await insert('task_events', { task_id: task(0), type, payload: '{}' })
    before_ = {
      sites: await select('sites'),
      tasks: await select('tasks'),
      events: await select('task_events'),
      calls: await select('mcp_calls'),
    }
    await schema.migrate(change)
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

  describe('rows written before the change', () => {
    it('get aliases of the pattern, unique across sites and within a site', async () => {
      const pattern = new RegExp(ALIAS_PATTERN_SOURCE)
      const sites = await select('sites')
      expect(sites.map((row) => row.alias)).toHaveLength(2)
      for (const row of sites) expect(row.alias).toMatch(/^[0-9a-f]{8}$/)
      expect(new Set(sites.map((row) => row.alias)).size).toBe(2)
      const tasks = await select('tasks')
      for (const row of tasks) {
        expect(row.alias).toMatch(/^[0-9a-f]{6}$/)
        expect(String(row.alias)).toMatch(pattern)
      }
      // The requirements of a task (20261022100000_browser_tasks) come later, with their defaults.
      expect(
        tasks.map(
          ({ alias: _a, title, mode, waiting, needs_repository, needs_browser, ...rest }) => ({
            ...rest,
            title,
            mode,
            waiting,
            needs: [needs_repository, needs_browser],
          }),
        ),
      ).toEqual(
        before_.tasks.map((row) => ({
          ...row,
          title: null,
          mode: 'work',
          waiting: null,
          needs: [true, false],
        })),
      )
      expect(
        sites.map(
          ({
            alias: _a,
            installed_version,
            installed_sha,
            installed_at,
            installed_release_id,
            agent_notes,
            deleted_at,
            ...rest
          }) => ({
            ...rest,
            installed: [installed_version, installed_sha, installed_at, installed_release_id],
            agent_notes,
            deleted_at,
          }),
        ),
      ).toEqual(
        // The mark of a deleted site (20261025100000_site_deleted) comes later, empty.
        before_.sites.map((row) => ({
          ...row,
          installed: [null, null, null, null],
          agent_notes: null,
          deleted_at: null,
        })),
      )
    })

    it('keep the journal hidden and its calls bound to the production site', async () => {
      expect(await select('task_events')).toEqual(before_.events)
      expect(await select('mcp_calls')).toEqual(
        before_.calls.map((row) => ({ ...row, preview_id: null, preview_write_epoch: null })),
      )
      for (const id of [ids.legacyCall, ids.agentCall])
        await update('mcp_calls', 'id', id, { error: 'Synthetic rewrite' })
    })

    it('keep a deploy with its environment and take the new methods of a deploy', async () => {
      expect((await select('deployments'))[0]).toMatchObject({
        environment_id: ids.environment,
        release_id: null,
        tag: null,
        version: null,
      })
      const methods = await schema.db.query(
        `SELECT unnest(enum_range(NULL::"DeployMethod"))::text AS method`,
      )
      expect(methods.rows.map((row: Values) => row.method)).toEqual([
        'rsync',
        'git_ftp',
        'docker',
        'sftp',
        'ftp',
      ])
    })
  })

  describe('the migration stops on a feed it would break', () => {
    it('before its transaction, with a message for the operator', async () => {
      const scratch = await createMigratedSchema(databaseUrl ?? '', 'chat_preview_release_guard')
      try {
        await scratch.migrate(before)
        const site = randomUUID()
        const workspace = randomUUID()
        const visible = randomUUID()
        await scratch.db.query(
          `INSERT INTO workspaces (id, name, updated_at) VALUES ($1, 'W', now())`,
          [workspace],
        )
        await scratch.db.query(
          `INSERT INTO sites (id, workspace_id, name, url, stack, updated_at) VALUES ($1, $2, 'S', 'https://s.invalid', 'wordpress', now())`,
          [site, workspace],
        )
        await scratch.db.query(
          `INSERT INTO tasks (id, workspace_id, site_id, updated_at) VALUES ($1, $2, $3, now())`,
          [visible, workspace, site],
        )
        await scratch.db.query(
          `INSERT INTO task_events (task_id, type, payload, client_visible) VALUES ($1, 'turn.output', '{}', true)`,
          [visible],
        )
        await expect(scratch.migrate(change)).rejects.toThrow(/client_visible does not match/)
        const columns = await scratch.db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'alias'`,
          [scratch.name],
        )
        expect(columns.rows).toEqual([])
      } finally {
        await scratch.drop()
      }
    })
  })

  describe('sites, tasks and the feed', () => {
    it('refuses an alias out of the pattern and a repeated one', async () => {
      await refuses(() => update('sites', 'id', ids.site, { alias: 'AB-12' }), 'sites_alias_check')
      const first = (await select('sites')).find((row) => row.id === ids.site)
      await refuses(
        () => update('sites', 'id', ids.otherSite, { alias: first!.alias }),
        'sites_alias_key',
        UNIQUE_VIOLATION,
      )
      await refuses(() => update('tasks', 'id', task(0), { alias: 'abc' }), 'tasks_alias_check')
      const second = (await select('tasks')).find((row) => row.id === task(1))
      await refuses(
        () => update('tasks', 'id', task(0), { alias: second!.alias }),
        'tasks_site_id_alias_key',
        UNIQUE_VIOLATION,
      )
      // Another site may use the same alias for its dialog.
      await update('tasks', 'id', task(4), { alias: second!.alias })
    })

    it('draws a free alias again when a new row takes one already in use', async () => {
      const [first] = (await select('sites')).filter((row) => row.id === ids.site)
      const site = randomUUID()
      await insert('sites', {
        id: site,
        workspace_id: ids.workspace,
        name: 'Synthetic site',
        url: `https://${site}.invalid`,
        stack: 'wordpress',
        alias: first!.alias,
        updated_at: at,
      })
      const drawn = (await select('sites')).find((row) => row.id === site)!.alias
      expect(drawn).not.toBe(first!.alias)
      expect(drawn).toMatch(/^[0-9a-f]{8}$/)

      const taken = (await select('tasks')).find((row) => row.id === task(1))!.alias
      const sameSite = randomUUID()
      const otherSite = randomUUID()
      await insert('tasks', {
        id: sameSite,
        workspace_id: ids.workspace,
        site_id: ids.site,
        alias: taken,
        updated_at: at,
      })
      await insert('tasks', {
        id: otherSite,
        workspace_id: ids.workspace,
        site_id: ids.otherSite,
        alias: taken,
        updated_at: at,
      })
      const tasks = await select('tasks')
      expect(tasks.find((row) => row.id === sameSite)!.alias).not.toBe(taken)
      expect(tasks.find((row) => row.id === sameSite)!.alias).toMatch(/^[0-9a-f]{6}$/)
      // Unique within a site only: another site keeps it.
      expect(tasks.find((row) => row.id === otherSite)!.alias).toBe(taken)
    })

    it('takes the installed version, its commit and time together', async () => {
      await update('sites', 'id', ids.site, {
        installed_version: 'v1.2.3',
        installed_sha: sha,
        installed_at: at,
      })
      await refuses(
        () => update('sites', 'id', ids.otherSite, { installed_version: 'v1.2.3' }),
        'sites_installed_check',
      )
      await refuses(
        () =>
          update('sites', 'id', ids.otherSite, {
            installed_version: '1.2.3',
            installed_sha: sha,
            installed_at: at,
          }),
        'sites_installed_check',
      )
    })

    it('keeps `waiting` to a queued task and the feed prefix to visible rows', async () => {
      await update('tasks', 'id', task(1), { waiting: 'site' })
      await refuses(
        () => update('tasks', 'id', task(0), { waiting: 'agents' }),
        'tasks_waiting_check',
      )
      await insert('task_events', {
        task_id: task(0),
        type: 'feed.request',
        payload: '{}',
        client_visible: true,
      })
      await refuses(
        () =>
          insert('task_events', {
            task_id: task(0),
            type: 'feed.result',
            payload: '{}',
            client_visible: false,
          }),
        'task_events_feed_visible_check',
      )
      await refuses(
        () =>
          insert('task_events', {
            task_id: task(0),
            type: 'turn.output',
            payload: '{}',
            client_visible: true,
          }),
        'task_events_feed_visible_check',
      )
    })
  })

  describe('previews', () => {
    it('take one preview per dialog at an exact preview host', async () => {
      const row = await preview()
      await refuses(
        () => preview({ hostname: 'site-0f3a9c1b-chat-zzzzzz.localhost' }),
        'preview_environments_task_id_key',
        UNIQUE_VIOLATION,
      )
      await refuses(
        () => preview({ task_id: task(1), hostname: row.hostname }),
        'preview_environments_hostname_key',
        UNIQUE_VIOLATION,
      )
      for (const hostname of [
        'evil.example',
        'site-ab-chat-cd.localhost',
        'site-0f3a9c1b-chat-a1b2c3',
      ])
        await refuses(
          () => preview({ task_id: task(1), hostname }),
          'preview_environments_hostname_check',
        )
    })

    it('name a reason exactly while unavailable and an error exactly while failed', async () => {
      await preview({ status: 'unavailable', unavailable_reason: 'no_database' })
      await refuses(
        () =>
          preview({
            task_id: task(1),
            hostname: 'site-aaaa-chat-bbbb.localhost',
            status: 'unavailable',
          }),
        'preview_environments_unavailable_check',
      )
      await refuses(
        () =>
          preview({
            task_id: task(1),
            hostname: 'site-aaaa-chat-bbbb.localhost',
            unavailable_reason: 'no_core',
          }),
        'preview_environments_unavailable_check',
      )
      await refuses(
        () =>
          preview({
            task_id: task(1),
            hostname: 'site-aaaa-chat-bbbb.localhost',
            status: 'failed',
          }),
        'preview_environments_error_check',
      )
      await refuses(
        () =>
          preview({
            task_id: task(1),
            hostname: 'site-aaaa-chat-bbbb.localhost',
            upstream_host: '127.0.0.1',
          }),
        'preview_environments_upstream_check',
      )
      await refuses(
        () =>
          preview({
            task_id: task(1),
            hostname: 'site-aaaa-chat-bbbb.localhost',
            seed_object_key: 'previews/a/b/seed.sql.zst.enc',
          }),
        'preview_environments_seed_check',
      )
      await refuses(
        () =>
          preview({ task_id: task(1), hostname: 'site-aaaa-chat-bbbb.localhost', write_epoch: -1 }),
        'preview_environments_counters_check',
      )
    })

    it('give a person a ticket of their own and the browser one without a person', async () => {
      const row = await preview()
      const ticket = { preview_id: row.id, expires_at: later }
      await insert('preview_tickets', {
        ...ticket,
        id: randomUUID(),
        kind: 'user',
        user_id: ids.user,
        token_hash: hash,
      })
      await insert('preview_tickets', {
        ...ticket,
        id: randomUUID(),
        kind: 'browser',
        token_hash: 'c'.repeat(64),
      })
      await refuses(
        () =>
          insert('preview_tickets', {
            ...ticket,
            id: randomUUID(),
            kind: 'user',
            token_hash: 'd'.repeat(64),
          }),
        'preview_tickets_kind_check',
      )
      await refuses(
        () =>
          insert('preview_tickets', {
            ...ticket,
            id: randomUUID(),
            kind: 'browser',
            user_id: ids.user,
            token_hash: 'd'.repeat(64),
          }),
        'preview_tickets_kind_check',
      )
      await refuses(
        () =>
          insert('preview_tickets', {
            ...ticket,
            id: randomUUID(),
            kind: 'user',
            user_id: ids.user,
            token_hash: hash,
          }),
        'preview_tickets_token_hash_key',
        UNIQUE_VIOLATION,
      )
      await refuses(
        () =>
          insert('preview_sessions', {
            id: randomUUID(),
            preview_id: row.id,
            kind: 'admin',
            user_id: ids.user,
            access_epoch: 0,
            expires_at: later,
          }),
        'preview_sessions_kind_check',
      )
    })
  })

  describe('the content journal of a preview', () => {
    const call = (extra: Values) => ({
      id: randomUUID(),
      turn_id: ids.turn,
      tool: 'wp_rest',
      idempotency_key: randomUUID(),
      object_ref: 'post:42',
      snapshot_id: ids.source,
      assignment_id: ids.assignment,
      credential_key_id: ids.key,
      request_hash: hash,
      lease_epoch: 1,
      ...extra,
    })

    it('takes a call of the agent on its preview with the write epoch, and nothing between the shapes', async () => {
      const row = await preview()
      await insert('mcp_calls', call({ preview_id: row.id, preview_write_epoch: 0 }))
      await refuses(
        () => insert('mcp_calls', call({ preview_id: row.id })),
        'mcp_calls_managed_binding_check',
      )
      await refuses(
        () => insert('mcp_calls', call({ preview_write_epoch: 2 })),
        'mcp_calls_managed_binding_check',
      )
      await refuses(
        () =>
          insert(
            'mcp_calls',
            call({
              preview_id: row.id,
              preview_write_epoch: 0,
              assignment_id: null,
              credential_key_id: null,
            }),
          ),
        'mcp_calls_managed_binding_check',
      )
      await refuses(
        () => insert('mcp_calls', call({ preview_id: randomUUID(), preview_write_epoch: 0 })),
        'mcp_calls_preview_id_fkey',
        FOREIGN_KEY_VIOLATION,
      )
    })

    it('records a write as an operation of the plan once per call', async () => {
      const row = await preview()
      const written = await insert(
        'mcp_calls',
        call({ preview_id: row.id, preview_write_epoch: 1 }),
      )
      const operation = {
        task_id: task(0),
        preview_id: row.id,
        turn_no: 1,
        mcp_call_id: written.id,
        kind: 'content_update',
        object_ref: 'post:42',
        fields: ['title', 'excerpt'],
        before_hash: hash,
        after_hash: 'c'.repeat(64),
        after_object_key: 'previews/s/p/ops/1-after.enc',
        after_sha256: 'd'.repeat(64),
        after_bytes: 140,
        before_object_key: 'previews/s/p/ops/1-before.enc',
        before_sha256: 'e'.repeat(64),
        before_bytes: 120,
      }
      await insert('preview_db_operations', operation)
      await refuses(
        () => insert('preview_db_operations', operation),
        'preview_db_operations_task_id_mcp_call_id_key',
        UNIQUE_VIOLATION,
      )
      await refuses(
        () =>
          insert('preview_db_operations', {
            ...operation,
            mcp_call_id: ids.agentCall,
            object_ref: 'option:blogname',
          }),
        'preview_db_operations_object_check',
      )
      await refuses(
        () =>
          insert('preview_db_operations', {
            ...operation,
            mcp_call_id: ids.agentCall,
            after_hash: 'C'.repeat(64),
          }),
        'preview_db_operations_object_check',
      )
      // The fields: known, each once, in the one order of orderDbContentFields.
      for (const fields of [['excerpt', 'title'], ['title', 'title'], ['post_password'], []])
        await refuses(
          () =>
            insert('preview_db_operations', { ...operation, mcp_call_id: ids.agentCall, fields }),
          'preview_db_operations_fields_check',
        )
      for (const broken of [
        { before_bytes: 0 },
        { after_bytes: 65_537 },
        { after_sha256: 'x'.repeat(64) },
      ])
        await refuses(
          () =>
            insert('preview_db_operations', {
              ...operation,
              mcp_call_id: ids.agentCall,
              ...broken,
            }),
          'preview_db_operations_values_check',
        )
    })
    it('takes a row of every kind of a plan with its own references and fields', async () => {
      const row = await preview()
      const written = () =>
        insert('mcp_calls', call({ preview_id: row.id, preview_write_epoch: 1 }))
      const base = {
        task_id: task(0),
        preview_id: row.id,
        turn_no: 1,
        before_hash: hash,
        after_hash: 'c'.repeat(64),
        after_object_key: 'tasks/t/db/1/after.json',
        after_sha256: 'd'.repeat(64),
        after_bytes: 140,
        before_object_key: 'tasks/t/db/1/before.json',
        before_sha256: 'e'.repeat(64),
        before_bytes: 120,
      }
      for (const [kind, object_ref, fields] of [
        ['option_update', 'option:blogname', ['value']],
        ['post_create', 'page:1000000001', ['title', 'content', 'excerpt']],
        ['post_trash', 'page:1000000001', []],
        ['schema_migration', 'table:bookings', ['definition']],
        ['content_update', 'page:1000000001', ['title']],
      ] as const)
        await insert('preview_db_operations', {
          ...base,
          mcp_call_id: (await written()).id,
          kind,
          object_ref,
          fields,
        })
      const call_ = (await written()).id
      for (const [kind, object_ref] of [
        ['option_update', 'page:42'],
        ['option_update', 'option:Blog'],
        ['schema_migration', 'option:blogname'],
        ['schema_migration', 'table:a-b'],
        ['post_create', 'page:42'],
        ['post_create', 'option:1000000001'],
        ['post_trash', 'page:999999999'],
        ['content_update', 'table:bookings'],
        ['content_update', 'option:12'],
      ] as const)
        await refuses(
          () =>
            insert('preview_db_operations', {
              ...base,
              mcp_call_id: call_,
              kind,
              object_ref,
              fields:
                kind === 'content_update'
                  ? ['title']
                  : kind === 'option_update'
                    ? ['value']
                    : kind === 'schema_migration'
                      ? ['definition']
                      : kind === 'post_trash'
                        ? []
                        : ['title', 'content', 'excerpt'],
            }),
          'preview_db_operations_object_check',
        )
      for (const [kind, object_ref, fields] of [
        ['option_update', 'option:blogname', ['title']],
        ['post_create', 'page:1000000001', ['title']],
        ['post_trash', 'page:1000000001', ['title']],
        ['schema_migration', 'table:bookings', []],
      ] as const)
        await refuses(
          () =>
            insert('preview_db_operations', {
              ...base,
              mcp_call_id: call_,
              kind,
              object_ref,
              fields,
            }),
          'preview_db_operations_fields_check',
        )
    })
  })

  describe('candidates and releases', () => {
    it('keep the description of a plan with its hash, or neither', async () => {
      await candidate({ db_view: '{"v":1}', db_view_sha256: hash })
      for (const broken of [
        { db_view: '{"v":1}' },
        { db_view_sha256: hash },
        { db_view: '[]', db_view_sha256: hash },
        { db_view: '{"v":1}', db_view_sha256: 'A'.repeat(64) },
        { db_view: JSON.stringify({ text: 'щ'.repeat(262_144) }), db_view_sha256: hash },
      ])
        await refuses(
          () => candidate({ task_id: task(1), ...broken }),
          'task_candidates_db_view_check',
        )
    })

    it('keep one current candidate per dialog and a revision once', async () => {
      await candidate()
      await refuses(
        () => candidate({ revision: 2 }),
        'task_candidates_current_key',
        UNIQUE_VIOLATION,
      )
      await candidate({ revision: 2, status: 'superseded', superseded_at: at })
      await refuses(
        () => candidate({ revision: 2, status: 'stale' }),
        'task_candidates_task_id_revision_key',
        UNIQUE_VIOLATION,
      )
      await refuses(
        () => candidate({ task_id: task(1), proposed_version: '1.1.0' }),
        'task_candidates_version_check',
      )
      await refuses(
        () => candidate({ task_id: task(1), base_sha: 'B'.repeat(40) }),
        'task_candidates_sha_check',
      )
      await refuses(
        () => candidate({ task_id: task(1), files: '{}' }),
        'task_candidates_json_check',
      )
      await refuses(
        () => candidate({ task_id: task(1), status: 'superseded' }),
        'task_candidates_superseded_check',
      )
    })

    it('measures the JSON of a candidate as the domain does', async () => {
      for (const value of [
        [],
        [{ path: 'wp-content/themes/shop/style.css', change: 'modified', sizeBytes: 10 }],
        [{ path: 'wp-content/themes/магазин/файл "1".php', change: 'added', executable: false }],
        { a: [1, { b: null, c: 'й' }], d: {} },
      ]) {
        const measured = await schema.db.query('SELECT octet_length($1::jsonb::text) AS bytes', [
          JSON.stringify(value),
        ])
        expect(Number((measured.rows[0] as Values).bytes)).toBe(jsonbTextBytes(value))
      }
    })

    it('takes known check kinds only', async () => {
      const row = await candidate()
      await insert('candidate_checks', {
        id: randomUUID(),
        candidate_id: row.id,
        revision: 1,
        kind: 'php_lint',
      })
      await refuses(
        () =>
          insert('candidate_checks', {
            id: randomUUID(),
            candidate_id: row.id,
            revision: 1,
            kind: 'vibes',
          }),
        'candidate_checks_kind_check',
      )
      await refuses(
        () =>
          insert('candidate_checks', {
            id: randomUUID(),
            candidate_id: row.id,
            revision: 1,
            kind: 'php_lint',
            status: 'passed',
          }),
        'candidate_checks_finished_check',
      )
    })

    it('keep one release of a candidate in work, burn a version for the site, key a release once', async () => {
      const row = await candidate()
      const first = await release(String(row.id))
      await refuses(
        () => release(String(row.id), { attempt: 2, version: 'v1.1.1', tag: 'v1.1.1' }),
        'site_releases_candidate_open_key',
        UNIQUE_VIOLATION,
      )
      await update('site_releases', 'id', String(first.id), { status: 'failed' })
      await refuses(
        () => release(String(row.id), { attempt: 2 }),
        'site_releases_site_id_version_key',
        UNIQUE_VIOLATION,
      )
      const second = await release(String(row.id), { attempt: 2, version: 'v1.1.1', tag: 'v1.1.1' })
      await refuses(
        () =>
          release(String(row.id), {
            attempt: 3,
            version: 'v1.1.2',
            tag: 'v1.1.2',
            release_key: second.release_key,
          }),
        'site_releases_release_key_key',
        UNIQUE_VIOLATION,
      )
      // `unknown` is still in work.
      await update('site_releases', 'id', String(second.id), {
        status: 'unknown',
        approved_sha: sha,
        main_pushed_at: at,
      })
      await refuses(
        () => release(String(row.id), { attempt: 3, version: 'v1.1.2', tag: 'v1.1.2' }),
        'site_releases_candidate_open_key',
        UNIQUE_VIOLATION,
      )
      expect(
        releaseStatuses.filter(
          (status) => !(terminalReleaseStatuses as readonly string[]).includes(status),
        ),
      ).toContain('unknown')
    })

    it('checks the formats of a release', async () => {
      const row = await candidate()
      await refuses(
        () => release(String(row.id), { version: 'v1.1' }),
        'site_releases_version_check',
      )
      await refuses(
        () => release(String(row.id), { main_before_sha: 'x'.repeat(40) }),
        'site_releases_hash_check',
      )
      await refuses(() => release(String(row.id), { step: 'deploy' }), 'site_releases_step_check')
      await refuses(
        () => release(String(row.id), { status: 'deploying' }),
        'site_releases_approved_sha_check',
      )
      await refuses(
        () => release(String(row.id), { deploy_token_hash: hash }),
        'site_releases_deploy_token_check',
      )
      await refuses(
        () => release(String(row.id), { backup_verified_at: at }),
        'site_releases_backup_check',
      )
      await refuses(
        () => release(String(row.id), { error_code: 'Permission denied' }),
        'site_releases_error_code_check',
      )
      await refuses(() => release(String(row.id), { enqueues: 0 }), 'site_releases_counters_check')
    })

    it('knows whether the release commit reached main, and reverts only one that did', async () => {
      const row = await candidate()
      const shipping = await release(String(row.id))
      const set = (values: Values) => update('site_releases', 'id', String(shipping.id), values)
      // Not before the commit exists, never while approved.
      await refuses(() => set({ main_pushed_at: at }), 'site_releases_main_pushed_check')
      await refuses(
        () => set({ approved_sha: sha, main_pushed_at: at }),
        'site_releases_main_pushed_check',
      )
      // Publishing: not known yet. Published on: pushed.
      await set({ status: 'publishing', approved_sha: sha })
      await refuses(() => set({ status: 'published' }), 'site_releases_main_pushed_check')
      await set({ status: 'published', main_pushed_at: at })
      // Refused before main moved: failed without the fact and without a revert commit.
      const refused = await release(String(row.id), {
        attempt: 2,
        version: 'v1.1.1',
        tag: 'v1.1.1',
        status: 'failed',
        approved_sha: sha,
      })
      await refuses(
        () => update('site_releases', 'id', String(refused.id), { revert_sha: sha }),
        'site_releases_main_pushed_check',
      )
    })

    it('holds the release barrier only under the lease of a deploy', async () => {
      const row = await candidate()
      const shipping = await release(String(row.id))
      await insert('site_leases', {
        site_id: ids.site,
        operation: 'deploy',
        holder_task_id: task(0),
        epoch: 1,
        acquired_at: at,
        expires_at: later,
        inflight_release_id: shipping.id,
        updated_at: at,
      })
      await refuses(
        () => update('site_leases', 'site_id', ids.site, { operation: 'turn' }),
        'site_leases_release_barrier_check',
      )
    })

    it('records each report of a step once, with a known step and state', async () => {
      const row = await candidate()
      const shipping = await release(String(row.id))
      const step = {
        release_id: shipping.id,
        deploy_attempt: 1,
        step: 'files',
        state: 'succeeded',
        report_key: '1:files:succeeded',
      }
      await insert('release_steps', step)
      await refuses(
        () => insert('release_steps', step),
        'release_steps_release_id_report_key_key',
        UNIQUE_VIOLATION,
      )
      await refuses(
        () => insert('release_steps', { ...step, step: 'upload', report_key: 'x' }),
        'release_steps_step_check',
      )
      // The check of the site after a rollback has its own step and key.
      await insert('release_steps', {
        ...step,
        step: 'reverify',
        state: 'started',
        report_key: '1:reverify:started',
      })
      await refuses(
        () => insert('release_steps', { ...step, state: 'done', report_key: 'y' }),
        'release_steps_state_check',
      )
      await refuses(
        () => insert('release_steps', { ...step, detail: '[]', report_key: 'z' }),
        'release_steps_detail_check',
      )
    })

    it('lets a deploy of a release go without an environment, never a deploy of nothing', async () => {
      const row = await candidate()
      const shipping = await release(String(row.id))
      const deploy = { site_id: ids.site, task_id: task(0), updated_at: at }
      await insert('deployments', {
        ...deploy,
        id: randomUUID(),
        release_id: shipping.id,
        tag: 'v1.1.0',
        version: 'v1.1.0',
      })
      await refuses(
        () => insert('deployments', { ...deploy, id: randomUUID() }),
        'deployments_target_check',
      )
      await refuses(
        () =>
          insert('deployments', {
            ...deploy,
            id: randomUUID(),
            environment_id: ids.environment,
            tag: 'latest',
          }),
        'deployments_version_check',
      )
    })
  })

  describe('client variables', () => {
    const variable = (extra: Values) => ({
      id: randomUUID(),
      site_id: ids.site,
      updated_at: at,
      ...extra,
    })

    it('refuse in the table the names the domain refuses', async () => {
      await insert(
        'site_env_vars',
        variable({ name: 'MAP_API_TOKEN', hosts: '["api.example.ru:443"]' }),
      )
      const reserved = [
        ...refusedEnvVarPrefixes.map((prefix) => `${prefix}X`),
        ...refusedEnvVarNames,
        'ALL_PROXY',
        'map_token',
      ]
      for (const name of reserved)
        await refuses(() => insert('site_env_vars', variable({ name })), 'site_env_vars_name_check')
      await refuses(
        () => insert('site_env_vars', variable({ name: 'MAP_API_TOKEN' })),
        'site_env_vars_site_id_name_key',
        UNIQUE_VIOLATION,
      )
    })

    it('give the agent a variable only with a consent, and sixteen hosts at most', async () => {
      await insert(
        'site_env_vars',
        variable({
          name: 'A_TOKEN',
          to_agent: true,
          agent_consent_at: at,
          agent_consent_by: ids.user,
        }),
      )
      await refuses(
        () => insert('site_env_vars', variable({ name: 'B_TOKEN', to_agent: true })),
        'site_env_vars_agent_check',
      )
      const hosts = JSON.stringify(Array.from({ length: 17 }, (_, i) => `h${i}.example.ru:443`))
      await refuses(
        () => insert('site_env_vars', variable({ name: 'C_TOKEN', hosts })),
        'site_env_vars_hosts_check',
      )
      await refuses(
        () => insert('site_env_vars', variable({ name: 'D_TOKEN', hosts: '{"a":1}' })),
        'site_env_vars_hosts_check',
      )
    })
  })
})
