import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  bindProjectFiles,
  createPrismaClient,
  createProjectFile,
  markProjectFileReady,
  createProject,
  insertFeedEvent,
  purgeProject,
  purgeProjectNow,
  restoreProject,
  trashProject,
  type PrismaClient,
} from '@repo/db'
import { isDomainError, projectLimits } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { PassSettlement } from '../tasks/pass-settlement.ts'
import { ProjectTrash } from './project-trash.ts'

// The trash reads every project of the database: only on a disposable one (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const DAY = 24 * 60 * 60_000
const quiet = { log: vi.fn(), warn: vi.fn() }

/** A UUID of version 7, as the browser makes the id of a project. */
function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe.skipIf(!enabled)('the trash of projects with PostgreSQL (plan 84, 84.5)', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const projectIds: string[] = []
  const taskIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await db.outboxEvent.deleteMany({
      where: { OR: taskIds.splice(0).map((id) => ({ dedupeKey: { contains: id } })) },
    })
    // The chats first: a project of the fixtures is Restrict on its workspace.
    await db.task.updateMany({
      where: { projectId: { in: projectIds } },
      data: { projectId: null },
    })
    await db.project.deleteMany({ where: { id: { in: projectIds.splice(0) } } })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A user's project with a chat in each status given. */
  async function projectWith(statuses: string[], now: Date) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const projectId = uuidv7()
    await db.$transaction((tx) =>
      createProject(tx, {
        id: projectId,
        workspaceId: workspace.id,
        userId,
        name: 'Сайт кофейни',
        goal: null,
        now,
      }),
    )
    projectIds.push(projectId)
    const chats: string[] = []
    for (const status of statuses) {
      const { taskId } = await fixtures.task(workspace.id, { projectId })
      await db.$executeRaw`UPDATE tasks SET status = ${status}::"TaskStatus"
        WHERE id = ${taskId}::uuid`
      chats.push(taskId)
      taskIds.push(taskId)
    }
    return { userId, projectId, chats }
  }

  /** The presses of `cancel` in the feed of the chat and its jobs `turn.cancel`. */
  async function stopsOf(taskId: string) {
    const presses = await db.taskEvent.count({
      where: {
        taskId,
        type: 'feed.request',
        payload: { path: ['command'], equals: 'cancel' },
      },
    })
    const jobs = await db.outboxEvent.count({
      where: { type: 'turn.cancel', dedupeKey: { startsWith: `turn.cancel:${taskId}:` } },
    })
    return { presses, jobs }
  }

  it('«Удалить» stops the passes at work, «Вернуть» gives the chats back, the purge leaves only deleted chats', async () => {
    const now = new Date()
    const { userId, projectId, chats } = await projectWith(
      ['running', 'queued', 'awaiting_user', 'done'],
      now,
    )
    const [running, queued, waiting, done] = chats as [string, string, string, string]

    // «Удалить»: the pass that runs and the one queued are pressed with the project; the chat that
    // waits for its client and the one that ended are left as they are.
    const { purgeAfter } = await trashProject(db, { projectId, userId, now })
    expect(purgeAfter.getTime() - now.getTime()).toBe(projectLimits.trashDays * DAY)
    expect(await stopsOf(running)).toEqual({ presses: 1, jobs: 1 })
    expect(await stopsOf(queued)).toEqual({ presses: 1, jobs: 1 })
    expect(await stopsOf(waiting)).toEqual({ presses: 0, jobs: 0 })
    expect(await stopsOf(done)).toEqual({ presses: 0, jobs: 0 })
    const press = await db.taskEvent.findFirstOrThrow({
      where: { taskId: running, type: 'feed.request' },
      select: { payload: true },
    })
    expect(press.payload).toMatchObject({ kind: 'command', command: 'cancel', authorId: userId })
    // Core carries the press out as any `/cancel`: the queued chat is closed by its author.
    const settlement = new PassSettlement({ db, logger: { ...quiet, error: vi.fn() } })
    await settlement.cancelWaiting(queued)
    expect(await db.task.findUniqueOrThrow({ where: { id: queued } })).toMatchObject({
      status: 'cancelled',
    })
    const cancelled = await db.taskEvent.findFirstOrThrow({
      where: { taskId: queued, type: 'feed.cancelled' },
      select: { payload: true },
    })
    expect(cancelled.payload).toMatchObject({ by: 'customer', authorId: userId })
    // A repeat of «Удалить» presses nothing again and keeps the day.
    expect(await trashProject(db, { projectId, userId, now: new Date(now.getTime() + 1) })).toEqual(
      { purgeAfter },
    )
    expect(await stopsOf(running)).toEqual({ presses: 1, jobs: 1 })

    // The second line: a chat that got into the queue anyway is stopped by the sweep, once.
    const trash = new ProjectTrash({ db, logger: quiet, now: () => now })
    await db.$executeRaw`UPDATE tasks SET status = 'queued' WHERE id = ${waiting}::uuid`
    expect(await trash.stopChats()).toBe(1)
    expect(await stopsOf(waiting)).toEqual({ presses: 1, jobs: 1 })
    expect(await trash.stopChats()).toBe(0)
    expect(await stopsOf(running)).toEqual({ presses: 1, jobs: 1 })

    // Core stopped the rest too: they ended `cancelled`, as `turn.cancel` leaves them.
    await db.$executeRaw`UPDATE tasks SET status = 'cancelled'
      WHERE id IN (${running}::uuid, ${waiting}::uuid)`

    // «Вернуть» within 30 days: the project and its chats are back, not one of them deleted.
    await restoreProject(db, { projectId, userId, now: new Date(now.getTime() + 2 * DAY) })
    expect(await db.project.findUnique({ where: { id: projectId } })).toMatchObject({
      deletedAt: null,
      purgeAfter: null,
    })
    expect(await trash.purge()).toBe(0)
    expect(await db.project.count({ where: { id: projectId } })).toBe(1)

    // Into the trash again, with a chat that waits for its client; 30 days on, the purge.
    const later = new Date(now.getTime() + 3 * DAY)
    // The client wrote in it after «Вернуть»: its newest request is words, not the old press.
    await insertFeedEvent(db, {
      taskId: queued,
      row: {
        type: 'feed.request',
        payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: 'Слова' },
      },
    })
    await db.$executeRaw`UPDATE tasks SET status = 'awaiting_user' WHERE id = ${queued}::uuid`
    const second = await trashProject(db, { projectId, userId, now: later })
    const past = new Date(second.purgeAfter.getTime() + 1)
    const purging = new ProjectTrash({ db, logger: quiet, now: () => past })
    // Not one day before its day.
    const early = new ProjectTrash({
      db,
      logger: quiet,
      now: () => new Date(second.purgeAfter.getTime() - 1),
    })
    expect(await early.purge()).toBe(0)

    // A chat that has not ended is pressed first — a waiting one too — and the project waits.
    expect(await purging.purge()).toBe(0)
    expect(await stopsOf(queued)).toEqual({ presses: 2, jobs: 2 })
    expect(await db.project.count({ where: { id: projectId } })).toBe(1)
    // «Вернуть» past the day is refused: the project is no longer the client's to restore.
    const refused = await restoreProject(db, { projectId, userId, now: past }).then(
      () => null,
      (error: unknown) => (isDomainError(error) ? error.code : String(error)),
    )
    expect(refused).toBe('PROJECT_NOT_FOUND')

    // Core closed it; the next sweep purges: the project row is gone, only deleted chats stay.
    await db.$executeRaw`UPDATE tasks SET status = 'cancelled' WHERE id = ${queued}::uuid`
    const swept = await purging.sweep()
    expect(swept).toEqual({ stopped: 0, purged: 1, collected: 0, paused: 0 })
    expect(await db.project.count({ where: { id: projectId } })).toBe(0)
    const left = await db.task.findMany({
      where: { id: { in: chats } },
      select: { projectId: true, deletedAt: true },
    })
    expect(left).toHaveLength(4)
    for (const chat of left) {
      expect(chat.projectId).toBeNull()
      expect(chat.deletedAt).toEqual(past)
    }
    // A repeat finds nothing to purge, and the next sweep looks again (ПР38).
    expect(await purging.purge()).toBe(0)
    expect(await purging.sweep()).toEqual({ stopped: 0, purged: 0, collected: 0, paused: 0 })
  })

  it('the purge asks core to remove the mirror of the repository of the project (ПР20)', async () => {
    const now = new Date(Date.now() - 31 * DAY)
    const { userId, projectId } = await projectWith(['done'], now)
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const repositoryId = randomUUID()
    await db.projectRepository.create({
      data: {
        id: repositoryId,
        projectId,
        workspaceId: project.workspaceId,
        provider: 'gitlab',
        host: 'gitlab.com',
        path: 'kofeinya/sait',
        webUrl: 'https://gitlab.com/kofeinya/sait',
        defaultBranch: 'main',
        mode: 'read',
      },
    })
    await trashProject(db, { projectId, userId, now })
    expect(await purgeProject(db, { projectId, now: new Date() })).toMatchObject({
      state: 'purged',
    })
    expect(await db.projectRepository.count({ where: { id: repositoryId } })).toBe(0)
    const forget = await db.outboxEvent.findFirstOrThrow({
      where: { dedupeKey: `git.repo.forget:${repositoryId}` },
    })
    expect(forget).toMatchObject({
      topic: 'git',
      type: 'git.repo.forget',
      payload: { projectRepositoryId: repositoryId },
    })
    await db.outboxEvent.delete({ where: { id: forget.id } })
  })

  it('«Удалить навсегда» on its second day: the next sweep purges it, its files first (ПР38)', async () => {
    const now = new Date()
    const { userId, projectId, chats } = await projectWith(['awaiting_user'], now)
    const [waiting] = chats as [string]
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const file = await createProjectFile(db, {
      workspaceId: project.workspaceId,
      uploadedById: userId,
      kind: 'file',
      name: 'Бриф.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
    })
    await markProjectFileReady(db, { id: file!.id, sizeBytes: 10, sha256: 'd'.repeat(64) })
    await db.$transaction((tx) =>
      bindProjectFiles(tx, {
        projectId,
        workspaceId: project.workspaceId,
        userId,
        ids: [file!.id],
      }),
    )
    await trashProject(db, { projectId, userId, now })
    const pressed = new Date(now.getTime() + DAY)
    await purgeProjectNow(db, { projectId, userId, now: pressed })

    const deleted: string[] = []
    const storage = {
      delete: vi.fn(async (_bucket: string, key: string) => void deleted.push(key)),
    }
    const trash = new ProjectTrash({ db, storage, logger: quiet, now: () => pressed })
    // The chat that waits for its client is closed first, as on the 30th day; the project waits.
    expect((await trash.sweep()).purged).toBe(0)
    expect(await stopsOf(waiting)).toEqual({ presses: 1, jobs: 1 })
    expect(deleted).toEqual([file!.key])
    await db.$executeRaw`UPDATE tasks SET status = 'cancelled' WHERE id = ${waiting}::uuid`
    // The very next sweep, a minute on — not the next hour.
    expect((await trash.sweep()).purged).toBe(1)
    expect(await db.project.count({ where: { id: projectId } })).toBe(0)
    expect(await db.projectFile.count({ where: { id: file!.id } })).toBe(0)
    expect(await db.task.findUniqueOrThrow({ where: { id: waiting } })).toMatchObject({
      projectId: null,
      deletedAt: pressed,
    })
  })

  it('a project restored before the purge took it is kept', async () => {
    const now = new Date(Date.now() - 31 * DAY)
    const { userId, projectId } = await projectWith(['done'], now)
    await trashProject(db, { projectId, userId, now })
    // «Вернуть» won the race with a purge that had read the project due: the purge reads the day
    // again under the lock of the row and keeps it.
    await restoreProject(db, { projectId, userId, now: new Date(now.getTime() + DAY) })
    expect(await purgeProject(db, { projectId, now: new Date() })).toEqual({ state: 'kept' })
    expect(await db.project.count({ where: { id: projectId } })).toBe(1)
  })
  it('collects a file no project took after its day, and drops the files of a purged project first (84.8)', async () => {
    const now = new Date(Date.now() - 31 * DAY)
    const { userId, projectId } = await projectWith(['done'], now)
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const announce = async (name: string) => {
      const row = await createProjectFile(db, {
        workspaceId: project.workspaceId,
        uploadedById: userId,
        kind: 'file',
        name,
        mediaType: 'application/pdf',
        sizeBytes: 10,
      })
      await markProjectFileReady(db, { id: row!.id, sizeBytes: 10, sha256: 'c'.repeat(64) })
      return row!
    }
    const kept = await announce('Бриф.pdf')
    await db.$transaction((tx) =>
      bindProjectFiles(tx, {
        projectId,
        workspaceId: project.workspaceId,
        userId,
        ids: [kept.id],
      }),
    )
    const loose = await announce('Черновик.pdf')
    const fresh = await announce('Свежий.pdf')
    // Its day is over, and the grace of an upload that may still be writing too.
    await db.$executeRaw`UPDATE project_files SET expires_at = now() - interval '1 hour'
      WHERE id = ${loose.id}::uuid`
    const deleted: string[] = []
    let failing = true
    const storage = {
      delete: vi.fn(async (_bucket: string, key: string) => {
        if (failing && key === kept.key) throw new Error('S3 down')
        deleted.push(key)
      }),
    }
    const trash = new ProjectTrash({ db, storage, logger: quiet, now: () => new Date() })
    expect(await trash.collectFiles()).toBe(1)
    expect(deleted).toEqual([loose.key])
    expect(
      await db.projectFile.count({ where: { id: { in: [loose.id, fresh.id, kept.id] } } }),
    ).toBe(2)

    // The project past its day: a failed delete of an object of its files keeps it waiting.
    await trashProject(db, { projectId, userId, now })
    expect(await trash.purge()).toBe(0)
    expect(await db.project.count({ where: { id: projectId } })).toBe(1)
    failing = false
    expect(await trash.purge()).toBe(1)
    expect(deleted).toContain(kept.key)
    expect(await db.projectFile.count({ where: { id: kept.id } })).toBe(0)
    await db.projectFile.deleteMany({ where: { id: fresh.id } })
  })
})
