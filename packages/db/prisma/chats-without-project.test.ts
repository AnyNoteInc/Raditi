// The migration of chats without a project (docs/plan/61-chats-first.md, §5.1): the real files in
// a disposable schema, over rows written before it. What it lets in is tried in
// `browser-tasks-constraints.test.ts`; here — what stays of the rows and the shape it leaves.
// `public` is never touched.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the change. */
const before = '20261026150000_task_deleted_at'
const migration = '20261031100000_chats_without_project'
const at = new Date('2026-10-31T12:00:00Z')

describe.skipIf(!databaseUrl)('chats without a project: the migration', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
    turn: randomUUID(),
  }

  async function insert(table: string, values: Record<string, unknown>) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }

  const nullable = async (table: string, column: string) => {
    const { rows } = await schema.db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema.name, table, column],
    )
    return rows[0]?.is_nullable
  }

  const foreignKeys = async (table: string) => {
    const { rows } = await schema.db.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f'
        ORDER BY c.conname`,
      [schema.name, table],
    )
    return rows.map(({ conname }) => conname)
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'chats_without_project')
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
      needs_repository: false,
      needs_browser: true,
      updated_at: at,
    })
    await insert('site_leases', { site_id: ids.site, epoch: 7, updated_at: at })
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
    await schema.migrate(migration)
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('keeps the rows there are', async () => {
    const { rows: tasks } = await schema.db.query(
      'SELECT site_id, needs_repository, needs_browser, web_masks_purged_at FROM tasks',
    )
    expect(tasks).toEqual([
      {
        site_id: ids.site,
        needs_repository: false,
        needs_browser: true,
        web_masks_purged_at: null,
      },
    ])
    const { rows: leases } = await schema.db.query('SELECT site_id, epoch FROM site_leases')
    expect(leases).toEqual([{ site_id: ids.site, epoch: 7 }])
    const { rows: turns } = await schema.db.query('SELECT id, site_id FROM turn_assignments')
    expect(turns).toEqual([{ id: ids.turn, site_id: ids.site }])
  })

  it('lets a task, its files and its browser go without a site, and nothing else', async () => {
    expect(await nullable('tasks', 'site_id')).toBe('YES')
    expect(await nullable('attachments', 'site_id')).toBe('YES')
    expect(await nullable('browser_sessions', 'site_id')).toBe('YES')
    expect(await nullable('site_leases', 'site_id')).toBe('NO')
    expect(await nullable('turn_assignments', 'site_id')).toBe('NO')
    expect(await nullable('browser_sessions', 'last_wrote_at')).toBe('YES')
  })

  it('leaves site_id of a lease and of an assignment no key to the sites', async () => {
    expect(await foreignKeys('site_leases')).not.toContain('site_leases_site_id_fkey')
    expect(await foreignKeys('turn_assignments')).not.toContain('turn_assignments_site_id_fkey')
    // The keys that fence a lease and an assignment by the task stay.
    expect(await foreignKeys('site_leases')).toContain('site_leases_holder_task_id_fkey')
    expect(await foreignKeys('turn_assignments')).toContain('turn_assignments_task_id_fkey')
    // A task keeps its site for as long as it has one.
    expect(await foreignKeys('tasks')).toContain('tasks_site_id_fkey')
  })

  it('orders the chats of a workspace by the index of the list', async () => {
    const { rows } = await schema.db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      [schema.name, 'tasks_workspace_updated_idx'],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toContain('(workspace_id, updated_at DESC, id DESC)')
  })
})
