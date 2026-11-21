// Artifacts, release 1 (docs/plan/88-artifacts.md, Ар11, Ар20, §7.1, slice 88.2): the migration
// only adds — the documents of plan 69 get their owner, the ranks of their sections in the order
// of positions and their checked text in `content`; the CHECKs are relaxed so a person may write a
// block; a statement of the journal notifies `raditi_artifact` once per artifact with its id.
import { randomUUID } from 'node:crypto'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { uuidv7 } from '../src/uuidv7.ts'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before artifacts. */
const before = '20261119200000_task_events_todo_list'
const at = new Date('2026-11-19T09:00:00Z')
type Values = Record<string, unknown>

async function insert(target: MigratedSchema, table: string, values: Values) {
  const columns = Object.keys(values)
  await target.db.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  )
}

async function refused(target: MigratedSchema, sql: string, values: unknown[] = []) {
  await target.db.query('SAVEPOINT probe')
  try {
    await target.db.query(sql, values)
    return null
  } catch (error) {
    return (error as { constraint?: string }).constraint ?? String(error)
  } finally {
    await target.db.query('ROLLBACK TO SAVEPOINT probe')
  }
}

describe.skipIf(!databaseUrl)('the migration of documents into artifacts (release 1)', () => {
  let schema: MigratedSchema
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const taskId = uuidv7()
  const documentId = randomUUID()

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'artifacts')
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
    await insert(schema, 'members', {
      id: randomUUID(),
      workspace_id: workspaceId,
      user_id: userId,
      role: 'owner',
      updated_at: at,
    })
    await insert(schema, 'tasks', {
      id: taskId,
      workspace_id: workspaceId,
      updated_at: at,
    })
    await insert(schema, 'chat_documents', {
      id: documentId,
      workspace_id: workspaceId,
      task_id: taskId,
      title: 'Прайс',
      updated_at: at,
    })
    // Positions out of order of the keys, one written but unchecked, one pending.
    const rows: Values[] = [
      { key: 'c', position: 2, checked: true },
      { key: 'a', position: 0, checked: true },
      { key: 'b', position: 1, checked: false },
      { key: 'd', position: 3, pending: true },
    ]
    for (const row of rows)
      await insert(schema, 'chat_document_sections', {
        id: randomUUID(),
        document_id: documentId,
        section_key: row.key,
        position: row.position,
        intent: 'Раздел',
        ...(row.pending
          ? { state: 'pending' }
          : {
              state: 'written',
              heading: `Раздел ${String(row.key)}`,
              markdown: `Текст ${String(row.key)}`,
              written_task_id: taskId,
              written_turn: 1,
              checked_turn: row.checked ? 1 : null,
            }),
      })
    await schema.migrate()
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('gives the documents their owner, their ranks and their checked text', async () => {
    const document = await schema.db.query(
      'SELECT owner_user_id, kind, seq, bytes FROM chat_documents WHERE id = $1',
      [documentId],
    )
    expect(document.rows[0]).toMatchObject({ owner_user_id: userId, kind: 'document' })
    // «Текст a» and «Текст c»: only the checked text counts.
    expect(Number(document.rows[0].bytes)).toBe(2 * Buffer.byteLength('Текст a'))
    const sections = await schema.db.query(
      `SELECT section_key, rank, content, rev, block_kind FROM chat_document_sections
       WHERE document_id = $1 ORDER BY rank`,
      [documentId],
    )
    expect(sections.rows.map((row) => row.section_key)).toEqual(['a', 'b', 'c', 'd'])
    expect(sections.rows.map((row) => row.rank)).toEqual(['000i', '001i', '002i', '003i'])
    expect(sections.rows.map((row) => row.content)).toEqual(['Текст a', null, 'Текст c', null])
    expect(sections.rows.map((row) => row.rev)).toEqual([1, 1, 1, 0])
    expect(sections.rows.every((row) => row.block_kind === 'section')).toBe(true)
  })

  it('lets a person write a block, and keeps what may not be', async () => {
    await schema.db.query('BEGIN')
    try {
      // A person's block: no turn, a heading only on a section.
      expect(
        await refused(
          schema,
          `INSERT INTO chat_document_sections (id, document_id, section_key, position, intent, state,
             block_kind, rank, content, written_by_user_id, rev)
           VALUES ($1, $2, 'p', 9, '', 'written', 'html', '00ai', '<p>x</p>', $3, 1)`,
          [randomUUID(), documentId, userId],
        ),
      ).toBeNull()
      expect(
        await refused(
          schema,
          `INSERT INTO chat_document_sections (id, document_id, section_key, position, intent, state,
             block_kind, heading, content, written_by_user_id, written_task_id, written_turn, rev)
           VALUES ($1, $2, 'q', 9, '', 'written', 'section', 'Т', 'x', $3, $4, 1, 1)`,
          [randomUUID(), documentId, userId, taskId],
        ),
      ).toBe('chat_document_sections_check')
      expect(
        await refused(
          schema,
          `INSERT INTO chat_document_sections (id, document_id, section_key, position, intent, state,
             block_kind, heading, content, written_by_user_id, rev)
           VALUES ($1, $2, 'r', 9, '', 'written', 'html', 'Т', 'x', $3, 1)`,
          [randomUUID(), documentId, userId],
        ),
      ).toBe('chat_document_sections_check')
      // A rank never ends with «0»; a lease of a person names the person.
      expect(
        await refused(
          schema,
          `UPDATE chat_document_sections SET rank = 'a0' WHERE document_id = $1 AND section_key = 'a'`,
          [documentId],
        ),
      ).toBe('chat_document_sections_check')
      expect(
        await refused(
          schema,
          `UPDATE chat_document_sections SET lease_holder = 'human', lease_until = now()
           WHERE document_id = $1 AND section_key = 'a'`,
          [documentId],
        ),
      ).toBe('chat_document_sections_check')
      // A version is up to 2 MiB now.
      expect(
        await refused(
          schema,
          `INSERT INTO chat_document_versions (id, document_id, no, size_bytes, sha256)
           VALUES ($1, $2, 1, 2097152, $3)`,
          [randomUUID(), documentId, 'a'.repeat(64)],
        ),
      ).toBeNull()
      expect(
        await refused(
          schema,
          `INSERT INTO chat_document_versions (id, document_id, no, size_bytes, sha256)
           VALUES ($1, $2, 2, 2097153, $3)`,
          [randomUUID(), documentId, 'a'.repeat(64)],
        ),
      ).toBe('chat_document_versions_check')
      expect(
        await refused(schema, `UPDATE chat_documents SET deleted_at = now() WHERE id = $1`, [
          documentId,
        ]),
      ).toBe('chat_documents_artifact_check')
    } finally {
      await schema.db.query('ROLLBACK')
    }
  })

  it('notifies raditi_artifact once per artifact and statement, with the id alone', async () => {
    const listener = new Client({ connectionString: databaseUrl })
    await listener.connect()
    const heard: string[] = []
    listener.on('notification', (message) => {
      if (message.channel === 'raditi_artifact') heard.push(message.payload ?? '')
    })
    try {
      await listener.query('LISTEN raditi_artifact')
      await schema.db.query(
        `INSERT INTO artifact_ops (artifact_id, seq, actor, user_id, kind, result)
         VALUES ($1, 1, 'user', $2, 'title', 'applied'), ($1, 2, 'user', $2, 'title', 'applied')`,
        [documentId, userId],
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(heard.filter((payload) => payload === documentId)).toEqual([documentId])
    } finally {
      await listener.end()
    }
  })
})
