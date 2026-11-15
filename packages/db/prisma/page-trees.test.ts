// Sites of pages in the database (docs/plan/73-pages-sites.md, Дер11–Дер13, §4.2): the migration
// page_trees makes every page of today a site of one home page — the id of the site is the id of
// the page, its slug, password, epoch and take-down are copied — so no address changes and a
// cookie of a password stays good. Runs the real migrations in a disposable schema.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { servedPage } from '../src/pages.ts'
import { uuidv7 } from '../src/uuidv7.ts'
import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before sites. */
const before = '20261115100000_page_trash'
const at = new Date('2026-11-14T09:00:00Z')
type Values = Record<string, unknown>

async function insert(target: MigratedSchema, table: string, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}

const slugOf = (letter: string) => letter.repeat(26)

describe.skipIf(!databaseUrl)('the migration of pages into sites', () => {
  let schema: MigratedSchema
  const workspaceId = randomUUID()
  // A chat without a project: its id is a UUID of version 7 (tasks_chat_id_check).
  const taskId = uuidv7()
  const documentId = randomUUID()
  const ids = {
    live: randomUUID(),
    locked: randomUUID(),
    pending: randomUUID(),
    byClient: randomUUID(),
    byOperator: randomUUID(),
    doc: randomUUID(),
    trashed: randomUUID(),
  }

  /** A page as plan 69 wrote it: one row, one host. */
  const page = (id: string, slug: string, extra: Values = {}): Values => ({
    id,
    workspace_id: workspaceId,
    task_id: taskId,
    kind: 'html',
    slug,
    title: 'Страница',
    state: 'live',
    current_version: 1,
    password_epoch: 0,
    created_at: at,
    updated_at: at,
    ...extra,
  })

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'page_trees')
    await schema.migrate(before)
    await insert(schema, 'workspaces', {
      id: workspaceId,
      name: 'Synthetic workspace',
      data_class: 'synthetic',
      updated_at: at,
    })
    await insert(schema, 'tasks', {
      id: taskId,
      workspace_id: workspaceId,
      needs_repository: false,
      needs_browser: false,
      updated_at: at,
    })
    await insert(schema, 'chat_documents', {
      id: documentId,
      workspace_id: workspaceId,
      task_id: taskId,
      title: 'Аудит',
      updated_at: at,
    })
    const down = { state: 'taken_down', taken_down_at: at }
    for (const row of [
      page(ids.live, slugOf('a')),
      page(ids.locked, slugOf('b'), { password_hash: 'scrypt$x', password_epoch: 3 }),
      page(ids.pending, slugOf('c'), { state: 'pending', current_version: 0 }),
      page(ids.byClient, slugOf('d'), { ...down, taken_down_by: 'client' }),
      page(ids.byOperator, slugOf('e'), { ...down, taken_down_by: 'operator' }),
      page(ids.doc, slugOf('f'), { kind: 'doc', document_id: documentId }),
      page(ids.trashed, slugOf('g'), {
        deleted_at: at,
        deleted_by: 'client',
        purge_after: new Date('2026-12-14T09:00:00Z'),
      }),
    ])
      await insert(schema, 'pages', row)
    for (const id of [ids.live, ids.locked, ids.byClient, ids.byOperator, ids.doc, ids.trashed]) {
      await insert(schema, 'page_versions', {
        id: randomUUID(),
        page_id: id,
        no: 1,
        size_bytes: 3,
        sha256: 'a'.repeat(64),
        source: 'outbox',
      })
      await insert(schema, 'page_contents', {
        page_id: id,
        version_no: 1,
        bytes: Buffer.from('<p>'),
        updated_at: at,
      })
    }
    await schema.migrate()
  }, 120_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('makes every page a site of one home page, the id of the site the id of the page', async () => {
    const trees = await schema.db.query(
      'SELECT id, workspace_id, slug, password_hash, password_epoch, taken_down_by, created_task_id FROM page_trees ORDER BY slug',
    )
    expect(trees.rows).toEqual(
      [
        [ids.live, 'a', null, 0, null],
        [ids.locked, 'b', 'scrypt$x', 3, null],
        [ids.pending, 'c', null, 0, null],
        [ids.byClient, 'd', null, 0, 'client'],
        [ids.byOperator, 'e', null, 0, 'operator'],
        [ids.doc, 'f', null, 0, null],
        [ids.trashed, 'g', null, 0, null],
      ].map(([id, letter, hash, epoch, by]) => ({
        id,
        workspace_id: workspaceId,
        slug: slugOf(String(letter)),
        password_hash: hash,
        password_epoch: epoch,
        taken_down_by: by,
        created_task_id: taskId,
      })),
    )
    const pages = await schema.db.query(
      'SELECT id, tree_id, parent_id, segment, path, state, taken_down_by, deleted_at IS NOT NULL AS deleted FROM pages ORDER BY slug',
    )
    for (const row of pages.rows)
      expect(row).toMatchObject({ tree_id: row.id, parent_id: null, segment: null, path: '/' })
    // The take-down is the site's, and the page keeps its own: the release before reads pages.state.
    expect(pages.rows.map((row) => [row.state, row.taken_down_by])).toEqual([
      ['live', null],
      ['live', null],
      ['pending', null],
      ['taken_down', 'client'],
      ['taken_down', 'operator'],
      ['live', null],
      ['live', null],
    ])
    expect(pages.rows.find((row) => row.id === ids.trashed)?.deleted).toBe(true)
  })

  it('answers every address as before: the same slug, the password and its epoch, the take-down, the trash', async () => {
    const db = schemaClient(databaseUrl ?? '', schema)
    try {
      expect(await servedPage(db, slugOf('a'))).toMatchObject({
        treeId: ids.live,
        gone: null,
        page: { id: ids.live, state: 'live', content: { version: 1 } },
      })
      expect(await servedPage(db, slugOf('b'))).toMatchObject({
        treeId: ids.locked,
        passwordHash: 'scrypt$x',
        passwordEpoch: 3,
      })
      expect((await servedPage(db, slugOf('c')))?.page?.state).toBe('pending')
      expect((await servedPage(db, slugOf('d')))?.gone).toBe('taken_down')
      expect((await servedPage(db, slugOf('e')))?.gone).toBe('taken_down')
      expect((await servedPage(db, slugOf('f')))?.page?.kind).toBe('doc')
      expect((await servedPage(db, slugOf('g')))?.gone).toBe('deleted')
      expect(await servedPage(db, slugOf('h'))).toBeNull()
    } finally {
      await db.$disconnect()
    }
  })

  it('holds a node to its place in the site, and a site to one home page', async () => {
    const child = (values: Values) =>
      insert(schema, 'pages', {
        ...page(randomUUID(), slugOf('z'), { slug: null, tree_id: ids.live }),
        ...values,
      })
    // A page under the home page needs its parent, a segment and its path.
    await expect(child({ path: '/uslugi' })).rejects.toThrow(/pages_tree_check/)
    await expect(
      child({ parent_id: ids.live, segment: 'uslugi', path: '/Uslugi' }),
    ).rejects.toThrow(/pages_tree_check/)
    // A second page at the path of the home page: one home a site (the path holds it first).
    await expect(child({ path: '/' })).rejects.toThrow(/pages_tree_(path|home)_key/)
    await child({ parent_id: ids.live, segment: 'uslugi', path: '/uslugi' })
    await expect(
      child({ parent_id: ids.live, segment: 'uslugi', path: '/uslugi' }),
    ).rejects.toThrow(/pages_tree_path_key/)
    await expect(
      insert(schema, 'page_redirects', { tree_id: ids.live, from_path: '/', page_id: ids.live }),
    ).rejects.toThrow(/page_redirects_check/)
  })
})
