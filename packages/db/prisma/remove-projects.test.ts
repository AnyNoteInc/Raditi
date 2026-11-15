// The migration that removes projects (docs/plan/83-remove-projects.md, БП6): the real files in a
// disposable schema, over rows a project left. Chats of projects stay chats without a project;
// what waited with a candidate waits for words; the access, the leases and the tables of sites go.
// `public` is never touched.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the change. */
const before = '20261116100000_workspace_env_vars'
const migration = '20261116110000_remove_projects'
const at = new Date('2026-11-15T12:00:00Z')
// A chat of a project could have an id of version 8, as its site had.
const version = (digit: string) => () => {
  const id = randomUUID()
  return `${id.slice(0, 14)}${digit}${id.slice(15)}`
}
const v7 = version('7')
const v8 = version('8')

describe.skipIf(!databaseUrl)('removing projects: the migration', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: v8(),
    chat: v7(),
    turn: randomUUID(),
    attachment: randomUUID(),
    browser: randomUUID(),
    ref: randomUUID(),
    platformRef: randomUUID(),
  }

  async function insert(table: string, values: Record<string, unknown>) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }

  const tableExists = async (table: string) => {
    const { rows } = await schema.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2) AS exists`,
      [schema.name, table],
    )
    return rows[0]?.exists
  }

  const columns = async (table: string) => {
    const { rows } = await schema.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schema.name, table],
    )
    return rows.map(({ column_name }) => column_name)
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'remove_projects')
    await schema.migrate(before)
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
      id: ids.task,
      workspace_id: ids.workspace,
      site_id: ids.site,
      status: 'awaiting_approval',
      needs_repository: true,
      needs_browser: true,
      updated_at: at,
    })
    await insert('tasks', {
      id: ids.chat,
      workspace_id: ids.workspace,
      site_id: null,
      status: 'awaiting_user',
      needs_repository: false,
      needs_browser: false,
      updated_at: at,
    })
    await insert('site_leases', {
      site_id: ids.site,
      operation: 'deploy',
      holder_task_id: ids.task,
      epoch: 4,
      acquired_at: at,
      expires_at: at,
      held_for_operator: true,
      updated_at: at,
    })
    await insert('site_leases', { site_id: ids.chat, epoch: 2, updated_at: at })
    await insert('turn_assignments', {
      id: ids.turn,
      task_id: ids.task,
      site_id: ids.site,
      session_id: 'old',
      turn_no: 1,
      executor: 'local',
      plan: {},
      first_epoch: 1,
      lease_epoch: 1,
      deadline_at: at,
      updated_at: at,
    })
    await insert('attachments', {
      id: ids.attachment,
      workspace_id: ids.workspace,
      site_id: ids.site,
      source: 'web',
      s3_key: `inbox/${ids.workspace}/${ids.attachment}`,
      file_name: 'a.txt',
      content_type: 'text/plain',
      size_bytes: 1,
      expires_at: at,
    })
    await insert('browser_sessions', {
      id: ids.browser,
      task_id: ids.task,
      site_id: ids.site,
      workspace_id: ids.workspace,
      status: 'closed',
      created_at: at,
      expires_at: new Date(at.getTime() + 60_000),
      closed_at: at,
      close_reason: 'idle',
    })
    await insert('credential_refs', {
      id: ids.ref,
      workspace_id: ids.workspace,
      site_id: ids.site,
      kind: 'wp',
      vault_path: `kv/sites/${ids.site}/wp`,
      updated_at: at,
    })
    await insert('credential_refs', {
      id: ids.platformRef,
      kind: 'subscription',
      vault_path: 'kv/subscriptions/synthetic',
      updated_at: at,
    })
    await schema.migrate(migration)
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('keeps the chat of a project as a chat without one, waiting for words', async () => {
    const { rows } = await schema.db.query(
      'SELECT id, status, needs_browser FROM tasks ORDER BY id',
    )
    expect(rows).toEqual(
      [
        { id: ids.task, status: 'awaiting_user', needs_browser: true },
        { id: ids.chat, status: 'awaiting_user', needs_browser: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(await columns('tasks')).not.toEqual(
      expect.arrayContaining(['site_id', 'needs_repository', 'alias', 'deployment_id']),
    )
  })

  it('names the chat in its assignments and keeps only the leases of chats', async () => {
    const { rows: turns } = await schema.db.query('SELECT site_id FROM turn_assignments')
    expect(turns).toEqual([{ site_id: ids.task }])
    const { rows: leases } = await schema.db.query('SELECT site_id, epoch FROM site_leases')
    expect(leases).toEqual([{ site_id: ids.chat, epoch: 2 }])
    expect(await columns('site_leases')).not.toEqual(
      expect.arrayContaining(['inflight_release_id', 'inflight_mcp_call_id']),
    )
  })

  it('keeps files and browsers of the chat, without their site', async () => {
    const { rows: files } = await schema.db.query('SELECT id FROM attachments')
    expect(files).toEqual([{ id: ids.attachment }])
    const { rows: browsers } = await schema.db.query('SELECT id FROM browser_sessions')
    expect(browsers).toEqual([{ id: ids.browser }])
    expect(await columns('attachments')).not.toContain('site_id')
    expect(await columns('browser_sessions')).not.toContain('site_id')
  })

  it('drops the access of sites and keeps the refs of the platform', async () => {
    const { rows } = await schema.db.query('SELECT id, kind FROM credential_refs')
    expect(rows).toEqual([{ id: ids.platformRef, kind: 'subscription' }])
  })

  it('drops the tables of projects', async () => {
    for (const table of [
      'sites',
      'git_repositories',
      'site_releases',
      'task_candidates',
      'preview_environments',
      'mcp_calls',
      'snapshots',
      'site_env_vars',
      'gift_site_claims',
    ])
      expect(await tableExists(table), table).toBe(false)
    expect(await tableExists('workspace_env_vars')).toBe(true)
  })

  it('lets a new chat in only with an id of version 7, and fixes its browser', async () => {
    await expect(
      insert('tasks', { id: v8(), workspace_id: ids.workspace, updated_at: at }),
    ).rejects.toThrow(/tasks_chat_id_check/)
    await expect(
      schema.db.query('UPDATE tasks SET needs_browser = NOT needs_browser WHERE id = $1', [
        ids.chat,
      ]),
    ).rejects.toThrow(/fixed/)
  })
})
