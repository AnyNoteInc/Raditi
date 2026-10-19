// Objects of a preview that are not editable (docs/plan/53-chat-preview-release.md, Р15, Р24):
// the table 20261017210000_preview_seed_mismatches adds. core writes the rows with the seed, the
// mcp role refuses a content write into them. Runs the real migrations in a disposable schema;
// `public` is never touched.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const at = new Date('2026-10-17T12:00:00Z')

describe.skipIf(!databaseUrl)('objects a preview may not edit', () => {
  let schema: MigratedSchema
  const ids = {
    workspace: randomUUID(),
    site: randomUUID(),
    task: randomUUID(),
    preview: randomUUID(),
  }

  async function insert(table: string, values: Record<string, unknown>) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    )
  }

  const mismatch = (objectRef: string, previewId = ids.preview) =>
    insert('preview_seed_mismatches', { preview_id: previewId, object_ref: objectRef })

  /** A statement that must fail with `code` and `constraint`, the connection still usable. */
  async function refuses(query: () => Promise<unknown>, code: string, constraint: string) {
    await schema.db.query('BEGIN')
    try {
      await expect(query()).rejects.toMatchObject({ code, constraint })
    } finally {
      await schema.db.query('ROLLBACK')
    }
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'preview_seed_mismatches')
    await schema.migrate()
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
  })
  afterAll(async () => {
    await schema?.drop()
  })

  it('names an object of the preview once, in the notation of the plan', async () => {
    await mismatch('post:42')
    await mismatch('page:7')
    await refuses(() => mismatch('post:42'), '23505', 'preview_seed_mismatches_pkey')
    // A setting of the list too (docs/plan/53, «Операции БД и миграции»); never a table.
    await mismatch('option:blogname')
    for (const objectRef of [
      'post:0',
      'post:x',
      'Post:1',
      'table:bookings',
      'option:7',
      ':1',
      'post:42 ',
    ])
      await refuses(() => mismatch(objectRef), '23514', 'preview_seed_mismatches_object_check')
    await refuses(
      () => mismatch('post:1', randomUUID()),
      '23503',
      'preview_seed_mismatches_preview_id_fkey',
    )
  })

  it('goes with its preview', async () => {
    const { rows } = await schema.db.query(
      'SELECT object_ref FROM preview_seed_mismatches WHERE preview_id = $1 ORDER BY object_ref',
      [ids.preview],
    )
    expect(rows).toEqual([
      { object_ref: 'option:blogname' },
      { object_ref: 'page:7' },
      { object_ref: 'post:42' },
    ])
    await schema.db.query('DELETE FROM preview_environments WHERE id = $1', [ids.preview])
    expect(
      (await schema.db.query('SELECT count(*)::int AS n FROM preview_seed_mismatches')).rows,
    ).toEqual([{ n: 0 }])
  })
})
