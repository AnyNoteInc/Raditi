// The new kinds of a database plan in the database (docs/plan/53-chat-preview-release.md,
// «Операции БД и миграции»): 20261018100000_db_operation_kinds_enum and
// 20261018100100_db_operation_kinds over rows written before them. Runs the real migrations in a
// disposable schema; `public` is never touched. The rows of each kind are checked with the rest
// of the journal in chat-preview-release-constraints.test.ts.
import { randomUUID } from 'node:crypto'

import { dbJournalKinds } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const before = '20261017210000_preview_seed_mismatches'
const at = new Date('2026-10-18T12:00:00Z')

describe.skipIf(!databaseUrl)('the kinds of a database plan', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
    preview: randomUUID(),
    candidate: randomUUID(),
  }

  async function insert(table: string, values: Record<string, unknown>) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'db_operation_kinds')
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
      status: 'running',
      updated_at: at,
    })
    await insert('preview_environments', {
      id: ids.preview,
      site_id: ids.site,
      task_id: ids.task,
      hostname: 'site-0f3a9c1b-chat-a1b2c3.localhost',
      expires_at: at,
      updated_at: at,
    })
    await insert('preview_seed_mismatches', { preview_id: ids.preview, object_ref: 'post:42' })
    await insert('task_candidates', {
      id: ids.candidate,
      task_id: ids.task,
      revision: 1,
      turn_no: 1,
      base_sha: 'b'.repeat(40),
      base_tree: 'b'.repeat(40),
      head_sha: 'c'.repeat(40),
      db_plan_sha256: 'a'.repeat(64),
      proposed_bump: 'patch',
      proposed_version: 'v1.0.1',
      facts: '{}',
    })
    await schema.migrate()
  })
  afterAll(async () => {
    await schema?.drop()
  })

  it('knows the kinds of the journal in the order of the domain', async () => {
    const { rows } = await schema.db.query(
      `SELECT unnest(enum_range(NULL::"DbOperationKind"))::text AS kind`,
    )
    expect(rows.map((row: { kind: string }) => row.kind)).toEqual([...dbJournalKinds])
  })

  it('keeps the rows written before: an object of a seed, a candidate without a description', async () => {
    const mismatches = await schema.db.query('SELECT object_ref FROM preview_seed_mismatches')
    expect(mismatches.rows).toEqual([{ object_ref: 'post:42' }])
    const candidates = await schema.db.query(
      'SELECT db_view, db_view_sha256 FROM task_candidates WHERE id = $1',
      [ids.candidate],
    )
    expect(candidates.rows).toEqual([{ db_view: null, db_view_sha256: null }])
    // Superseding such a candidate is no write of a description.
    await schema.db.query(
      `UPDATE task_candidates SET status = 'superseded', superseded_at = $2 WHERE id = $1`,
      [ids.candidate, at],
    )
  })
})
