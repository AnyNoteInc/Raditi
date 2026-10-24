// Tasks in the cloud browser in the database (docs/plan/57-browser-tasks.md, §3.4): what a task
// needs, the hints of a site, attachments, browser sessions, their stream tickets and
// checkpoints. Runs the real migrations in a disposable schema over rows written before the
// change, then accepted and rejected rows for the hand-written CHECKs and the trigger. `public`
// is never touched.
import { createHash, randomUUID } from 'node:crypto'

import { browserHelpReasons } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the change. */
const before = '20261018150000_task_turn_rejected'
const at = new Date('2026-10-22T12:00:00Z')
const later = new Date('2026-10-22T16:00:00Z')
const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
type Values = Record<string, unknown>

describe.skipIf(!databaseUrl)('browser task constraints', () => {
  let schema: MigratedSchema
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    site: randomUUID(),
    oldTask: randomUUID(),
    task: randomUUID(),
    otherTask: randomUUID(),
  }

  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
    return values
  }

  /** A statement that must fail with `code` and `constraint`, the connection still usable. */
  async function refuses(
    query: () => Promise<unknown>,
    constraint: string,
    code = CHECK_VIOLATION,
  ) {
    await schema.db.query('BEGIN')
    try {
      await expect(query()).rejects.toMatchObject({ code, constraint })
    } finally {
      await schema.db.query('ROLLBACK')
    }
  }

  const attachment = (extra: Values = {}) => {
    const id = (extra.id as string | undefined) ?? randomUUID()
    return insert('attachments', {
      id,
      workspace_id: ids.workspace,
      site_id: ids.site,
      uploaded_by_id: ids.user,
      source: 'web',
      s3_key: `inbox/${ids.workspace}/${id}`,
      file_name: 'photo.jpg',
      content_type: 'image/jpeg',
      size_bytes: 1024,
      expires_at: later,
      ...extra,
    })
  }

  const session = (extra: Values = {}) =>
    insert('browser_sessions', {
      id: randomUUID(),
      task_id: ids.task,
      site_id: ids.site,
      workspace_id: ids.workspace,
      created_at: at,
      last_activity_at: at,
      expires_at: later,
      ...extra,
    })

  const closed = { status: 'closed', closed_at: later, close_reason: 'task_done' }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'browser_tasks')
    await schema.migrate(before)
    await insert('users', {
      id: ids.user,
      name: 'Synthetic',
      email: `${ids.user}@example.invalid`,
      updated_at: at,
    })
    await insert('workspaces', { id: ids.workspace, name: 'Synthetic', updated_at: at })
    await insert('sites', {
      id: ids.site,
      workspace_id: ids.workspace,
      name: 'Synthetic site',
      url: `https://${ids.site}.invalid`,
      stack: 'wordpress',
      updated_at: at,
    })
    await insert('tasks', {
      id: ids.oldTask,
      workspace_id: ids.workspace,
      site_id: ids.site,
      status: 'done',
      updated_at: at,
    })
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('stops on an attachment written before, then keeps every row there is', async () => {
    // The old shape of the table: a file of a task, no workspace or site of its own.
    await insert('attachments', {
      id: randomUUID(),
      task_id: ids.oldTask,
      uploaded_by_id: ids.user,
      source: 'web',
      s3_key: `inbox/${ids.workspace}/${ids.oldTask}/photo`,
      file_name: 'photo.jpg',
      content_type: 'image/jpeg',
      size_bytes: 1,
    })
    await expect(schema.migrate()).rejects.toThrow(
      'attachments holds rows, though nothing in the product writes them',
    )
    // The stop comes before the transaction: nothing of the change is there.
    const { rows: columns } = await schema.db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'tasks' AND column_name LIKE 'needs_%'`,
      [schema.name],
    )
    expect(columns).toEqual([])

    await schema.db.query('DELETE FROM attachments')
    await schema.migrate()
    const { rows } = await schema.db.query(
      `SELECT t.needs_repository, t.needs_browser, s.agent_notes
         FROM tasks t JOIN sites s ON s.id = t.site_id WHERE t.id = $1`,
      [ids.oldTask],
    )
    // A task older than the columns needs the repository alone (REPOSITORY_ONLY).
    expect(rows).toEqual([{ needs_repository: true, needs_browser: false, agent_notes: null }])

    for (const [id, needsBrowser] of [
      [ids.task, true],
      [ids.otherTask, true],
    ] as const)
      await insert('tasks', {
        id,
        workspace_id: ids.workspace,
        site_id: ids.site,
        needs_repository: false,
        needs_browser: needsBrowser,
        updated_at: at,
      })
  })

  it('takes a task that needs something and keeps what it needs', async () => {
    await refuses(
      () =>
        insert('tasks', {
          id: randomUUID(),
          workspace_id: ids.workspace,
          site_id: ids.site,
          needs_repository: false,
          needs_browser: false,
          updated_at: at,
        }),
      'tasks_requirements_check',
    )
    // Both together are a shape the schema keeps for later (Б3).
    await insert('tasks', {
      id: randomUUID(),
      workspace_id: ids.workspace,
      site_id: ids.site,
      needs_repository: true,
      needs_browser: true,
      updated_at: at,
    })
    for (const change of [
      'needs_browser = true',
      'needs_repository = false',
      'needs_repository = true, needs_browser = true',
    ])
      await refuses(
        () => schema.db.query(`UPDATE tasks SET ${change} WHERE id = $1`, [ids.oldTask]),
        'tasks_requirements_fixed',
      )
    // Everything else of a task changes as before, the requirements written again included.
    await schema.db.query(
      `UPDATE tasks SET status = 'cancelled', needs_repository = needs_repository WHERE id = $1`,
      [ids.oldTask],
    )
  })

  it('keeps hints of a site up to 2000 characters', async () => {
    const note = (text: string) =>
      schema.db.query('UPDATE sites SET agent_notes = $2 WHERE id = $1', [ids.site, text])
    await note('вход по адресу /login'.padEnd(2000, '.'))
    await expect(note('x'.repeat(2001))).rejects.toMatchObject({ code: '22001' })
  })

  it('binds an attachment to a task exactly while it is sent, under its own key', async () => {
    await attachment()
    await attachment({ status: 'ready' })
    await attachment({ status: 'deleted' })
    await attachment({ status: 'bound', task_id: ids.task, bound_at: at })
    for (const shape of [
      { status: 'bound' },
      { status: 'bound', task_id: ids.task },
      { status: 'bound', bound_at: at },
      { status: 'ready', task_id: ids.task, bound_at: at },
      { status: 'deleted', task_id: ids.task, bound_at: at },
      { status: 'uploading', bound_at: at },
    ])
      await refuses(() => attachment(shape), 'attachments_bound_check')
    for (const key of [
      `inbox/${ids.workspace}/${randomUUID()}`,
      `inbox/${randomUUID()}/{id}`,
      'inbox/elsewhere',
    ])
      await refuses(() => attachment({ s3_key: key }), 'attachments_key_check')
    await refuses(
      () => attachment({ site_id: randomUUID() }),
      'attachments_site_id_fkey',
      FOREIGN_KEY_VIOLATION,
    )
    // A file nobody sent keeps its site: the site is not deleted under it, its tasks gone or not.
    await refuses(
      async () => {
        await schema.db.query('DELETE FROM tasks WHERE site_id = $1', [ids.site])
        await schema.db.query('DELETE FROM sites WHERE id = $1', [ids.site])
      },
      'attachments_site_id_fkey',
      FOREIGN_KEY_VIOLATION,
    )
  })

  it('keeps one session that holds a browser per task, and its state whole', async () => {
    await session({ status: 'ready', ready_at: at })
    for (const shape of [{}, { status: 'ready', ready_at: at }])
      await refuses(() => session(shape), 'browser_sessions_open_task_key', UNIQUE_VIOLATION)
    // Closed ones are history: as many as there were, beside the open one.
    for (const status of ['closed', 'failed', 'lost'])
      await session({ ...closed, status, ready_at: status === 'failed' ? null : at })
    await session({ task_id: ids.otherTask })

    // The checks below are tried on closed sessions, which the unique index lets be.
    for (const shape of [
      { status: 'closed', close_reason: null, closed_at: null },
      { status: 'closed', close_reason: null },
      { status: 'lost', closed_at: null },
      { status: 'starting' },
      { status: 'ready', ready_at: at },
    ])
      await refuses(() => session({ ...closed, ...shape }), 'browser_sessions_closed_check')
    await refuses(
      () => session({ ...closed, close_reason: 'Task done' }),
      'browser_sessions_close_reason_check',
    )
    await refuses(
      () => session({ ...closed, error_code: 'bad code' }),
      'browser_sessions_error_code_check',
    )
    await session({
      ...closed,
      status: 'failed',
      close_reason: 'crashed',
      error_code: 'LAUNCH_FAILED',
    })
    await refuses(
      () => session({ ...closed, control_epoch: -1 }),
      'browser_sessions_control_epoch_check',
    )
    await refuses(
      () => session({ ...closed, viewport_version: 0 }),
      'browser_sessions_viewport_version_check',
    )
    await refuses(() => session({ ...closed, expires_at: at }), 'browser_sessions_expiry_check')
    // A session is ready exactly when it says since when.
    const third = randomUUID()
    await insert('tasks', {
      id: third,
      workspace_id: ids.workspace,
      site_id: ids.site,
      needs_repository: false,
      needs_browser: true,
      updated_at: at,
    })
    await refuses(
      () => session({ task_id: third, status: 'ready' }),
      'browser_sessions_ready_check',
    )
    await refuses(() => session({ task_id: third, ready_at: at }), 'browser_sessions_ready_check')

    for (const reason of browserHelpReasons)
      await session({ ...closed, help_reason: reason, help_message: 'Войдите, пожалуйста' })
    for (const help of [
      { help_reason: 'login' },
      { help_message: 'Войдите' },
      { help_reason: 'payment', help_message: 'Оплатите' },
      { help_reason: 'login', help_message: '' },
    ])
      await refuses(() => session({ ...closed, ...help }), 'browser_sessions_help_check')
    await expect(
      session({ ...closed, help_reason: 'login', help_message: 'я'.repeat(501) }),
    ).rejects.toMatchObject({ code: '22001' })
  })

  it('keeps only the hash of a ticket, once', async () => {
    const sessionId = randomUUID()
    await session({ id: sessionId, task_id: ids.otherTask, ...closed })
    const ticket = (extra: Values = {}) =>
      insert('browser_stream_tickets', {
        id: randomUUID(),
        session_id: sessionId,
        user_id: ids.user,
        token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        created_at: at,
        expires_at: later,
        ...extra,
      })
    const hash = 'a'.repeat(64)
    await ticket({ token_hash: hash })
    await refuses(
      () => ticket({ token_hash: hash }),
      'browser_stream_tickets_token_hash_key',
      UNIQUE_VIOLATION,
    )
    for (const tokenHash of ['A'.repeat(64), 'a'.repeat(63) + 'g'])
      await refuses(
        () => ticket({ token_hash: tokenHash }),
        'browser_stream_tickets_token_hash_check',
      )
    await refuses(() => ticket({ expires_at: at }), 'browser_stream_tickets_expiry_check')
    await refuses(
      () => ticket({ user_id: randomUUID() }),
      'browser_stream_tickets_user_id_fkey',
      FOREIGN_KEY_VIOLATION,
    )
  })

  it('keeps one checkpoint per object of a task, and what a read found only while confirmed', async () => {
    const sessionId = randomUUID()
    await session({ id: sessionId, task_id: ids.otherTask, ...closed })
    const checkpoint = (extra: Values = {}) =>
      insert('browser_checkpoints', {
        id: randomUUID(),
        task_id: ids.otherTask,
        session_id: sessionId,
        kind: 'post',
        object_id: '42',
        edit_url: 'https://example.invalid/wp-admin/post.php?post=42&action=edit',
        updated_at: at,
        ...extra,
      })
    await checkpoint()
    await refuses(
      () => checkpoint(),
      'browser_checkpoints_task_id_kind_object_id_key',
      UNIQUE_VIOLATION,
    )
    await checkpoint({ object_id: '43', state: 'verified', verified: '{"kind":"post"}' })
    for (const shape of [
      { state: 'verified' },
      { state: 'unverified', verified: '{"kind":"post"}' },
      { state: 'verified', verified: '[1]' },
    ])
      await refuses(
        () => checkpoint({ object_id: '44', ...shape }),
        'browser_checkpoints_verified_check',
      )
    for (const shape of [
      { object_id: '' },
      { object_id: '42/../1' },
      { kind: 'Post' },
      { kind: 'post-type' },
    ])
      await refuses(() => checkpoint(shape), 'browser_checkpoints_object_check')
  })

  it('goes with its task: sessions, tickets and checkpoints', async () => {
    const count = async (table: string) =>
      (await schema.db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n as number
    expect(await count('browser_sessions')).toBeGreaterThan(0)
    await schema.db.query('DELETE FROM attachments')
    await schema.db.query('DELETE FROM tasks WHERE id IN ($1, $2)', [ids.task, ids.otherTask])
    expect(await count('browser_sessions')).toBe(0)
    expect(await count('browser_stream_tickets')).toBe(0)
    expect(await count('browser_checkpoints')).toBe(0)
  })
})
