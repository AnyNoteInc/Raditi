import { randomUUID } from 'node:crypto'

import { isDomainError } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  archiveProject,
  createProject,
  listProjects,
  moveChatToProject,
  projectOwnedBy,
  purgeProjectNow,
  readProject,
  restoreProject,
  setProjectInstructions,
  starProject,
  touchProjectActivity,
  trashProject,
  updateProject,
} from './projects.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 10, day, hour))

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : String(error)
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL: the projects of a workspace (plan 84)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'projects')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  /** A user with a personal workspace of their own. */
  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const project = (name = 'Сайт кофейни', now = at(17)) =>
      db.$transaction((tx) =>
        createProject(tx, {
          id: uuidv7(),
          workspaceId: workspace.id,
          userId: user.id,
          name,
          goal: null,
          now,
        }),
      )
    return { user, workspace, project }
  }

  it('creates a project once: a repeat returns it, an id of someone else is not found', async () => {
    const { user, workspace } = await owner()
    const other = await owner()
    const input = {
      id: uuidv7(),
      workspaceId: workspace.id,
      userId: user.id,
      name: 'Рассылки',
      goal: 'Писать письма',
      now: at(17),
    }
    expect(await db.$transaction((tx) => createProject(tx, input))).toEqual({
      projectId: input.id,
      created: true,
    })
    expect(await db.$transaction((tx) => createProject(tx, input))).toEqual({
      projectId: input.id,
      created: false,
    })
    expect(
      await codeOf(() =>
        db.$transaction((tx) =>
          createProject(tx, { ...input, userId: other.user.id, workspaceId: other.workspace.id }),
        ),
      ),
    ).toBe('PROJECT_NOT_FOUND')
    const view = await readProject(db, { projectId: input.id, userId: user.id })
    expect(view).toMatchObject({
      name: 'Рассылки',
      goal: 'Писать письма',
      chats: 0,
      starred: false,
    })
    expect(
      await codeOf(() => readProject(db, { projectId: input.id, userId: other.user.id })),
    ).toBe('PROJECT_NOT_FOUND')
  })

  it('shows a project to its author only while they are a member of its workspace', async () => {
    const { user, workspace, project } = await owner()
    const { projectId } = await project()
    expect(await projectOwnedBy(db, projectId, user.id)).toMatchObject({ id: projectId })
    await db.member.delete({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    })
    expect(await projectOwnedBy(db, projectId, user.id)).toBeNull()
  })

  it('lists by tabs, sorts, searches, stars and archives', async () => {
    const { user, project } = await owner()
    const a = await project('Альфа', at(10))
    const b = await project('бета 10% скидка', at(11))
    const c = await project('Ёлка', at(12))
    await touchProjectActivity(db, a.projectId, at(20))
    await starProject(db, { projectId: b.projectId, userId: user.id, starred: true, now: at(13) })
    await archiveProject(db, {
      projectId: c.projectId,
      userId: user.id,
      archived: true,
      now: at(14),
    })
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
    expect(ids(await listProjects(db, { userId: user.id }))).toEqual([a.projectId, b.projectId])
    expect(ids(await listProjects(db, { userId: user.id, sort: 'created' }))).toEqual([
      b.projectId,
      a.projectId,
    ])
    expect(ids(await listProjects(db, { userId: user.id, view: 'starred' }))).toEqual([b.projectId])
    expect(ids(await listProjects(db, { userId: user.id, view: 'archive' }))).toEqual([c.projectId])
    expect(ids(await listProjects(db, { userId: user.id, query: 'БЕТА' }))).toEqual([b.projectId])
    // `%` is a letter of the words, not a pattern.
    expect(ids(await listProjects(db, { userId: user.id, query: '10%' }))).toEqual([b.projectId])
    expect(ids(await listProjects(db, { userId: user.id, query: '%' }))).toEqual([b.projectId])
    await archiveProject(db, {
      projectId: c.projectId,
      userId: user.id,
      archived: false,
      now: at(15),
    })
    expect(ids(await listProjects(db, { userId: user.id, sort: 'name' }))).toEqual([
      a.projectId,
      b.projectId,
      c.projectId,
    ])
  })

  it('updates the name, the goal and the instructions, and counts it as activity', async () => {
    const { user, project } = await owner()
    const { projectId } = await project('Старое', at(10))
    await updateProject(db, {
      projectId,
      userId: user.id,
      name: 'Новое',
      goal: 'Цель',
      now: at(18),
    })
    await setProjectInstructions(db, {
      projectId,
      userId: user.id,
      instructions: 'Пишите коротко',
      now: at(19),
    })
    expect(await readProject(db, { projectId, userId: user.id })).toMatchObject({
      name: 'Новое',
      goal: 'Цель',
      instructions: 'Пишите коротко',
      activityAt: at(19),
    })
    const stranger = await owner()
    expect(
      await codeOf(() =>
        updateProject(db, { projectId, userId: stranger.user.id, name: 'Чужое', now: at(19) }),
      ),
    ).toBe('PROJECT_NOT_FOUND')
  })

  it('puts a project into the trash for 30 days and returns it until then', async () => {
    const { user, project } = await owner()
    const { projectId } = await project()
    const first = await trashProject(db, { projectId, userId: user.id, now: at(1) })
    expect(first.purgeAfter).toEqual(new Date(Date.UTC(2026, 11, 1, 12)))
    // A second «Удалить» keeps the day.
    expect(await trashProject(db, { projectId, userId: user.id, now: at(2) })).toEqual(first)
    expect(await listProjects(db, { userId: user.id })).toEqual([])
    expect(
      (await listProjects(db, { userId: user.id, view: 'trash', now: at(2) })).map((r) => r.id),
    ).toEqual([projectId])
    expect(await codeOf(() => readProject(db, { projectId, userId: user.id }))).toBe(
      'PROJECT_NOT_FOUND',
    )
    await restoreProject(db, { projectId, userId: user.id, now: at(3) })
    expect(await readProject(db, { projectId, userId: user.id })).toMatchObject({ id: projectId })

    await trashProject(db, { projectId, userId: user.id, now: at(4) })
    expect(
      await codeOf(() =>
        restoreProject(db, { projectId, userId: user.id, now: new Date(Date.UTC(2026, 11, 5)) }),
      ),
    ).toBe('PROJECT_NOT_FOUND')
  })

  it('«Удалить навсегда»: out of the trash at once, «Вернуть» refused, core takes it (ПР38)', async () => {
    const { user, project } = await owner()
    const { projectId } = await project()
    const trash = (now: Date) =>
      listProjects(db, { userId: user.id, view: 'trash', now }).then((rows) =>
        rows.map((r) => r.id),
      )
    // Only from the trash: a live project is not purged by a stale press.
    expect(
      await codeOf(() => purgeProjectNow(db, { projectId, userId: user.id, now: at(1) })),
    ).toBe('PROJECT_NOT_IN_TRASH')
    await trashProject(db, { projectId, userId: user.id, now: at(1) })
    // Someone else's is not found, and nothing changes.
    const stranger = await owner()
    expect(
      await codeOf(() => purgeProjectNow(db, { projectId, userId: stranger.user.id, now: at(2) })),
    ).toBe('PROJECT_NOT_FOUND')
    expect(await trash(at(2))).toEqual([projectId])

    await purgeProjectNow(db, { projectId, userId: user.id, now: at(3) })
    const row = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { deletedAt: true, purgeAfter: true },
    })
    // Its day is the moment it went into the trash: the row waits for core, as one past its 30 days.
    expect(row).toEqual({ deletedAt: at(1), purgeAfter: at(1) })
    expect(await trash(at(3))).toEqual([])
    // A «Вернуть» whose clock read earlier than the press but writes after it is refused too.
    expect(await codeOf(() => restoreProject(db, { projectId, userId: user.id, now: at(2) }))).toBe(
      'PROJECT_NOT_FOUND',
    )
    expect(
      await codeOf(() => restoreProject(db, { projectId, userId: user.id, now: at(3, 13) })),
    ).toBe('PROJECT_NOT_FOUND')
    // A repeat changes nothing, and «Удалить» again keeps the day it has.
    await purgeProjectNow(db, { projectId, userId: user.id, now: at(4) })
    expect(await trashProject(db, { projectId, userId: user.id, now: at(4) })).toEqual({
      purgeAfter: at(1),
    })
    expect(
      await db.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { purgeAfter: true },
      }),
    ).toEqual({ purgeAfter: at(1) })
    // Once core purged it, a stale press is told the project is gone.
    await db.project.delete({ where: { id: projectId } })
    expect(
      await codeOf(() => purgeProjectNow(db, { projectId, userId: user.id, now: at(5) })),
    ).toBe('PROJECT_NOT_FOUND')
  })

  describe('a chat moved to a project and out of it (ПР2)', () => {
    async function chat(
      workspaceId: string,
      status: 'awaiting_user' | 'running' = 'awaiting_user',
    ) {
      return db.task.create({
        data: { workspaceId, status },
        select: { id: true, workspaceId: true, status: true },
      })
    }

    it('moves a waiting chat in and out, and the project rises in «Недавние»', async () => {
      const { user, workspace, project } = await owner()
      const { projectId } = await project('Проект', at(1))
      const task = await chat(workspace.id)
      const move = (to: string | null) =>
        db.$transaction((tx) =>
          moveChatToProject(tx, { task, projectId: to, userId: user.id, now: at(20) }),
        )
      expect(await move(projectId)).toEqual({ projectId, moved: true })
      expect(await move(projectId)).toEqual({ projectId, moved: false })
      expect((await readProject(db, { projectId, userId: user.id })).chats).toBe(1)
      expect((await readProject(db, { projectId, userId: user.id })).activityAt).toEqual(at(20))
      expect(await move(null)).toEqual({ projectId: null, moved: true })
      expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).projectId).toBeNull()
    })

    it('refuses a chat whose pass is queued or runs', async () => {
      const { user, workspace, project } = await owner()
      const { projectId } = await project()
      const task = await chat(workspace.id, 'running')
      expect(
        await codeOf(() =>
          db.$transaction((tx) =>
            moveChatToProject(tx, { task, projectId, userId: user.id, now: at(20) }),
          ),
        ),
      ).toBe('TASK_PROJECT_BUSY')
    })

    it('refuses an archived project, and a project of another workspace or of someone else', async () => {
      const { user, workspace, project } = await owner()
      const archived = await project('Архивный')
      await archiveProject(db, {
        projectId: archived.projectId,
        userId: user.id,
        archived: true,
        now: at(2),
      })
      const task = await chat(workspace.id)
      const move = (projectId: string, userId = user.id) =>
        codeOf(() =>
          db.$transaction((tx) => moveChatToProject(tx, { task, projectId, userId, now: at(20) })),
        )
      expect(await move(archived.projectId)).toBe('PROJECT_ARCHIVED')
      const stranger = await owner()
      const theirs = await stranger.project()
      expect(await move(theirs.projectId)).toBe('PROJECT_NOT_FOUND')
      // The same author in a second workspace of theirs: the database refuses it as well.
      const second = await db.workspace.create({ data: { name: 'Second', dataClass: 'synthetic' } })
      await db.member.create({ data: { workspaceId: second.id, userId: user.id, role: 'owner' } })
      const elsewhere = await db.$transaction((tx) =>
        createProject(tx, {
          id: uuidv7(),
          workspaceId: second.id,
          userId: user.id,
          name: 'Там',
          goal: null,
          now: at(3),
        }),
      )
      expect(await move(elsewhere.projectId)).toBe('PROJECT_NOT_FOUND')
      await expect(
        db.task.update({ where: { id: task.id }, data: { projectId: elsewhere.projectId } }),
      ).rejects.toThrow(/tasks_project_workspace|live project of its own workspace/)
    })
  })
})
