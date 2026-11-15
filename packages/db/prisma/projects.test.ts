// The migration of projects (docs/plan/84-projects.md, 84.3): the CHECKs of `projects` and the
// trigger that keeps a chat in a live project of its own workspace, on the real files in a
// disposable schema. `public` is never touched.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { uuidv7 } from '../src/uuidv7.ts'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const before = '20261116120100_workspace_agent_skills'
const migration = '20261117100000_projects'

describe.skipIf(!databaseUrl)('projects: the migration', () => {
  let schema: MigratedSchema
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    other: randomUUID(),
    chat: uuidv7(),
    project: uuidv7(),
  }

  const query = (sql: string, values: unknown[] = []) => schema.db.query(sql, values)
  /** The constraint that refused the statement; undefined — it went through. */
  async function refused(sql: string, values: unknown[] = []): Promise<string | undefined> {
    await query('SAVEPOINT attempt')
    try {
      await query(sql, values)
      await query('RELEASE SAVEPOINT attempt')
      return undefined
    } catch (error) {
      await query('ROLLBACK TO SAVEPOINT attempt')
      return (error as { constraint?: string }).constraint ?? String(error)
    }
  }
  const project = (values: Record<string, unknown> = {}) => {
    const row = {
      id: uuidv7(),
      workspace_id: ids.workspace,
      created_by_id: ids.user,
      name: 'Сайт кофейни',
      updated_at: new Date(),
      ...values,
    }
    const columns = Object.keys(row)
    return [
      `INSERT INTO projects (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    ] as const
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'projects_migration')
    await schema.migrate(before)
    // A chat from before the migration stays a chat without a project.
    await query(`INSERT INTO users (id, name, email, updated_at) VALUES ($1, 'S', $2, now())`, [
      ids.user,
      `${ids.user}@example.test`,
    ])
    for (const id of [ids.workspace, ids.other])
      await query(`INSERT INTO workspaces (id, name, updated_at) VALUES ($1, 'S', now())`, [id])
    await query(`INSERT INTO tasks (id, workspace_id, updated_at) VALUES ($1, $2, now())`, [
      ids.chat,
      ids.workspace,
    ])
    await schema.migrate(migration)
    await query('BEGIN')
  }, 60_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('leaves the chats of before without a project', async () => {
    const { rows } = await query('SELECT project_id FROM tasks WHERE id = $1', [ids.chat])
    expect(rows).toEqual([{ project_id: null }])
  })

  it('keeps the id, the name, the goal, the instructions and the trash in shape', async () => {
    expect(await refused(...project({ id: randomUUID() }))).toBe('projects_id_check')
    expect(await refused(...project({ name: '   ' }))).toBe('projects_name_check')
    expect(await refused(...project({ name: 'две\nстроки' }))).toBe('projects_name_check')
    expect(await refused(...project({ goal: ' ' }))).toBe('projects_goal_check')
    expect(await refused(...project({ instructions: 'я'.repeat(8001) }))).toBe(
      'projects_instructions_check',
    )
    expect(await refused(...project({ instructions: 'я'.repeat(8000) }))).toBeUndefined()
    expect(await refused(...project({ deleted_at: new Date() }))).toBe('projects_trash_check')
    expect(
      await refused(...project({ deleted_at: new Date(), purge_after: new Date() })),
    ).toBeUndefined()
  })

  it('puts a chat only into a live project of its own workspace', async () => {
    await query(...project({ id: ids.project }))
    const move = (projectId: string) =>
      refused('UPDATE tasks SET project_id = $1 WHERE id = $2', [projectId, ids.chat])
    expect(await move(ids.project)).toBeUndefined()

    const foreign = uuidv7()
    await query(...project({ id: foreign, workspace_id: ids.other }))
    expect(await move(foreign)).toBe('tasks_project_workspace')
    expect(
      await refused(
        `INSERT INTO tasks (id, workspace_id, project_id, updated_at) VALUES ($1, $2, $3, now())`,
        [uuidv7(), ids.workspace, foreign],
      ),
    ).toBe('tasks_project_workspace')

    const trashed = uuidv7()
    await query(...project({ id: trashed, deleted_at: new Date(), purge_after: new Date() }))
    expect(await move(trashed)).toBe('tasks_project_workspace')
  })

  it('keeps a chat in a project put into the trash, and frees it when the project is purged', async () => {
    const id = uuidv7()
    const chat = uuidv7()
    await query(...project({ id }))
    await query(
      `INSERT INTO tasks (id, workspace_id, project_id, updated_at) VALUES ($1, $2, $3, now())`,
      [chat, ids.workspace, id],
    )
    await query(`UPDATE projects SET deleted_at = now(), purge_after = now() WHERE id = $1`, [id])
    // Other columns of the chat change freely: the trigger reads only a change of its project.
    expect(await refused(`UPDATE tasks SET title = 'Новое' WHERE id = $1`, [chat])).toBeUndefined()
    await query('DELETE FROM projects WHERE id = $1', [id])
    const { rows } = await query('SELECT project_id FROM tasks WHERE id = $1', [chat])
    expect(rows).toEqual([{ project_id: null }])
  })
})
