// Four kinds of artifacts stay (docs/plan/93-artifacts-trim.md, АТ1, АТ2): the artifacts of the six
// removed kinds go into the trash with a term already over, so the collector deletes them with their
// files; the exports narrow to pdf, pptx and png; the pictures of «Схема» and their jobs go.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { uuidv7 } from '../src/uuidv7.ts'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the removal. */
const before = '20261124150000_artifact_export_png'
const at = new Date('2026-11-24T09:00:00Z')
type Values = Record<string, unknown>

async function insert(target: MigratedSchema, table: string, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}

describe.skipIf(!databaseUrl)('the removal of six kinds of artifacts (plan 93)', () => {
  let schema: MigratedSchema
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const canvasId = randomUUID()
  const tableId = randomUUID()
  const trashedMockupId = randomUUID()
  const projectReportId = randomUUID()
  const pending = uuidv7()
  const published = uuidv7()
  const tableInvite = uuidv7()
  const canvasInvite = uuidv7()

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'remove_kinds')
    await schema.migrate(before)
    await insert(schema, 'users', {
      id: userId,
      name: 'Synthetic',
      email: `${userId}@example.test`,
      updated_at: at,
    })
    await insert(schema, 'workspaces', {
      id: workspaceId,
      name: 'Synthetic',
      data_class: 'synthetic',
      updated_at: at,
    })
    const artifact = (id: string, kind: string, extra: Values = {}) =>
      insert(schema, 'chat_documents', {
        id,
        workspace_id: workspaceId,
        owner_user_id: userId,
        title: kind,
        kind,
        updated_at: at,
        ...extra,
      })
    await artifact(canvasId, 'canvas')
    await artifact(tableId, 'table')
    await artifact(trashedMockupId, 'mockup', {
      deleted_at: at,
      deleted_by: 'agent',
      purge_after: new Date('2026-12-24T09:00:00Z'),
    })
    await artifact(projectReportId, 'report', {
      deleted_at: at,
      deleted_by: 'project',
      purge_after: new Date('2026-12-24T09:00:00Z'),
    })
    await insert(schema, 'artifact_exports', {
      id: uuidv7(),
      artifact_id: tableId,
      user_id: userId,
      format: 'xlsx',
    })
    await insert(schema, 'artifact_exports', {
      id: uuidv7(),
      artifact_id: tableId,
      user_id: userId,
      format: 'xlsx',
      state: 'ready',
      object_key: 'workspaces/w/artifacts/a/exports/e.xlsx',
      bytes: 10,
      ready_at: at,
    })
    for (const [id, status] of [
      [pending, 'pending'],
      [published, 'published'],
    ] as const)
      await insert(schema, 'outbox_events', {
        id,
        topic: 'agent-turns',
        type: 'artifact.diagram',
        payload: JSON.stringify({ artifactId: tableId, block: 'd1' }),
        status,
      })
    for (const [id, kindWord] of [
      [tableInvite, 'таблицу'],
      [canvasInvite, 'холст'],
    ] as const)
      await insert(schema, 'outbox_events', {
        id,
        topic: 'notifications',
        type: 'artifact.invite',
        payload: JSON.stringify({ to: 'a@example.test', kindWord, url: 'https://example.test' }),
        status: 'pending',
      })
    await schema.migrate()
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('puts the artifacts of removed kinds into the trash with a term already over', async () => {
    const rows = await schema.db.query<{
      id: string
      deleted_by: string | null
      over: boolean | null
    }>('SELECT id, deleted_by, purge_after <= now() AS over FROM chat_documents')
    const byId = new Map(rows.rows.map((row) => [row.id, row]))
    expect(byId.get(canvasId)).toMatchObject({ deleted_by: null, over: null })
    expect(byId.get(tableId)).toMatchObject({ deleted_by: 'client', over: true })
    // A removed artifact already in the trash keeps who put it there; its term ends now.
    expect(byId.get(trashedMockupId)).toMatchObject({ deleted_by: 'agent', over: true })
    // One trashed with its project is no longer the project's: «Вернуть» of it leaves it there.
    expect(byId.get(projectReportId)).toMatchObject({ deleted_by: 'client', over: true })
  })

  it('keeps an old file for the collector, drops one with no file, and takes no new one', async () => {
    const exports = await schema.db.query('SELECT format, state FROM artifact_exports')
    // The pending workbook had no file: a job marking it failed would break the new CHECK.
    expect(exports.rows).toEqual([{ format: 'xlsx', state: 'ready' }])
    await expect(
      insert(schema, 'artifact_exports', {
        id: uuidv7(),
        artifact_id: canvasId,
        user_id: userId,
        format: 'xlsx',
      }),
    ).rejects.toMatchObject({ constraint: 'artifact_exports_format_check' })
    await insert(schema, 'artifact_exports', {
      id: uuidv7(),
      artifact_id: canvasId,
      user_id: userId,
      format: 'png',
    })
  })

  it('drops the pictures of «Схема» and their jobs not yet delivered', async () => {
    const table = await schema.db.query(`SELECT to_regclass('artifact_diagram_renders') AS name`)
    expect(table.rows[0]).toEqual({ name: null })
    const events = await schema.db.query(
      `SELECT id FROM outbox_events WHERE type = 'artifact.diagram' ORDER BY id`,
    )
    expect(events.rows.map((row: { id: string }) => row.id)).toEqual([published])
  })

  it('drops the invitations not yet sent to an artifact of a removed kind', async () => {
    const events = await schema.db.query(
      `SELECT id FROM outbox_events WHERE type = 'artifact.invite' ORDER BY id`,
    )
    expect(events.rows.map((row: { id: string }) => row.id)).toEqual([canvasInvite])
  })
})
