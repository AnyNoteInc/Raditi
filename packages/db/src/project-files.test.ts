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
  bindProjectFiles,
  chatProjectFile,
  createProjectFile,
  deleteExpiredProjectFile,
  listExpiredProjectFiles,
  listProjectFiles,
  markProjectFileReady,
  ownedProjectFile,
  projectFileUpload,
  readyProjectFiles,
  removeProjectFile,
} from './project-files.ts'
import { createProject, trashProject } from './projects.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const MIB = 1024 * 1024
const SHA = 'a'.repeat(64)

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : String(error)
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL: the files of a project (plan 84, 84.8)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'project_files')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const project = async () => {
      const id = uuidv7()
      await db.$transaction((tx) =>
        createProject(tx, {
          id,
          workspaceId: workspace.id,
          userId: user.id,
          name: 'Сайт кофейни',
          goal: null,
          now: new Date(),
        }),
      )
      return id
    }
    /** A ready file of the user without a project. */
    const file = async (name: string, sizeBytes = 10, forProjectId: string | null = null) => {
      const row = await createProjectFile(db, {
        workspaceId: workspace.id,
        uploadedById: user.id,
        kind: 'file',
        name,
        mediaType: 'application/pdf',
        sizeBytes,
        forProjectId,
      })
      expect(row).not.toBeNull()
      expect(await markProjectFileReady(db, { id: row!.id, sizeBytes, sha256: SHA })).toBe(true)
      return row!
    }
    return { user, workspace, project, file }
  }

  it('announces a file without a project, keys it and lets only its uploader upload it', async () => {
    const { user, workspace } = await owner()
    const other = await owner()
    const row = await createProjectFile(db, {
      workspaceId: workspace.id,
      uploadedById: user.id,
      kind: 'file',
      name: 'Фото/витрина.jpg',
      mediaType: 'image/jpeg',
      sizeBytes: 5,
    })
    expect(row?.key).toBe(`projects/${workspace.id}/${row?.id}`)
    const upload = await projectFileUpload(db, { id: row!.id, userId: user.id })
    expect(upload).toMatchObject({ status: 'uploading', sizeBytes: 5, mediaType: 'image/jpeg' })
    expect(upload?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000)
    expect(await projectFileUpload(db, { id: row!.id, userId: other.user.id })).toBeNull()
    // Not a member: nothing is announced.
    expect(
      await createProjectFile(db, {
        workspaceId: workspace.id,
        uploadedById: other.user.id,
        kind: 'file',
        name: 'a.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 5,
      }),
    ).toBeNull()
    // A size other than announced is not marked ready.
    expect(await markProjectFileReady(db, { id: row!.id, sizeBytes: 6, sha256: SHA })).toBe(false)
    expect(await markProjectFileReady(db, { id: row!.id, sizeBytes: 5, sha256: SHA })).toBe(true)
    expect(await markProjectFileReady(db, { id: row!.id, sizeBytes: 5, sha256: SHA })).toBe(false)
  })

  it('refuses what the rules refuse: the database keeps its own CHECKs', async () => {
    const { user, workspace } = await owner()
    const id = uuidv7()
    const insert = (name: string, key = `projects/${workspace.id}/${id}`) =>
      db.$executeRaw`
        INSERT INTO project_files (id, workspace_id, uploaded_by_id, kind, name, media_type,
          size_bytes, s3_key, expires_at, updated_at)
        VALUES (${id}::uuid, ${workspace.id}::uuid, ${user.id}::uuid, 'file', ${name},
          'text/plain', 1, ${key}, now() + interval '1 day', now())`
    for (const name of [
      '../a.txt',
      'a/../b.txt',
      '/a.txt',
      'a.txt/',
      'a//b.txt',
      'a\tb.txt',
      '1/2/3/4/5/6/7/8/9.txt',
    ])
      expect(await codeOf(() => insert(name)), name).toMatch(/project_files_name_check/)
    expect(await codeOf(() => insert('a.txt', `inbox/${workspace.id}/${id}`))).toMatch(
      /project_files_key_check/,
    )
    // Into a project only once stored.
    const projectId = uuidv7()
    await db.$transaction((tx) =>
      createProject(tx, {
        id: projectId,
        workspaceId: workspace.id,
        userId: user.id,
        name: 'П',
        goal: null,
        now: new Date(),
      }),
    )
    expect(
      await codeOf(
        () => db.$executeRaw`
          INSERT INTO project_files (id, workspace_id, project_id, kind, name, media_type, size_bytes,
            s3_key, updated_at)
          VALUES (${id}::uuid, ${workspace.id}::uuid, ${projectId}::uuid, 'file', 'a.txt',
            'text/plain', 1, ${`projects/${workspace.id}/${id}`}, now())`,
      ),
    ).toMatch(/project_files_bound_ready_check/)
  })

  it('binds all or none, renames a taken path, and keeps the room of a project', async () => {
    const { user, workspace, project, file } = await owner()
    const projectId = await project()
    const bind = (ids: string[]) =>
      db.$transaction((tx) =>
        bindProjectFiles(tx, { projectId, workspaceId: workspace.id, userId: user.id, ids }),
      )
    const a = await file('Брендбук.pdf')
    const b = await file('Брендбук.pdf')
    const c = await file('Фото/витрина.pdf')
    expect(await bind([a.id, b.id, c.id])).toEqual({ bound: 3 })
    expect((await listProjectFiles(db, projectId)).map((row) => row.name)).toEqual([
      'Брендбук (2).pdf',
      'Брендбук.pdf',
      'Фото/витрина.pdf',
    ])
    // A file taken already, or of someone else, refuses the whole batch.
    const d = await file('Прайс.pdf')
    expect(await codeOf(() => bind([d.id, a.id]))).toBe('PROJECT_FILE_NOT_READY')
    const other = await owner()
    const foreign = await other.file('Чужой.pdf')
    expect(await codeOf(() => bind([d.id, foreign.id]))).toBe('PROJECT_FILE_NOT_READY')
    expect(await projectFileUpload(db, { id: d.id, userId: user.id })).not.toBeNull()
    // 100 MiB in a project: a file of 20 MiB more is refused at bind and at announcement.
    for (let i = 0; i < 5; i++) await bind([(await file(`big-${i}.pdf`, 20 * MIB - 6)).id])
    expect(await codeOf(() => bind([d.id]))).toBe('PROJECT_SPACE_FULL')
    expect(
      await codeOf(() =>
        createProjectFile(db, {
          workspaceId: workspace.id,
          uploadedById: user.id,
          kind: 'file',
          name: 'x.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 1000,
          forProjectId: projectId,
        }),
      ),
    ).toBe('PROJECT_SPACE_FULL')
  })

  it('counts the room under one lock: parallel announcements never pass the limit together', async () => {
    const { user, workspace, project } = await owner()
    const projectId = await project()
    const announce = () =>
      createProjectFile(db, {
        workspaceId: workspace.id,
        uploadedById: user.id,
        kind: 'file',
        name: 'part.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 20 * MIB,
        forProjectId: projectId,
      })
    // Fill the workspace to 1 GiB less 30 MiB with rows of another project's files.
    const otherProject = await project()
    await db.$executeRaw`
      INSERT INTO project_files (id, workspace_id, project_id, uploaded_by_id, kind, name, media_type,
        size_bytes, status, s3_key, updated_at)
      SELECT x.id, ${workspace.id}::uuid, ${otherProject}::uuid, ${user.id}::uuid, 'file',
             'f' || x.n || '.pdf', 'application/pdf', 20971520, 'ready',
             'projects/' || ${workspace.id} || '/' || x.id, now()
        FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 49) AS n) x`
    // 49 × 20 MiB = 980 MiB: room for two more files of 20 MiB, not three.
    const results = await Promise.allSettled([announce(), announce(), announce(), announce()])
    const made = results.filter((result) => result.status === 'fulfilled').length
    expect(made).toBe(2)
    const refused = results.filter((result) => result.status === 'rejected')
    for (const result of refused)
      expect(
        isDomainError((result as PromiseRejectedResult).reason) &&
          (result as PromiseRejectedResult).reason.code,
      ).toBe('PROJECT_SPACE_FULL')
  })

  it('shows a file to the author of its project, and an unbound one to its uploader', async () => {
    const { user, workspace, project, file } = await owner()
    const other = await owner()
    const projectId = await project()
    const unbound = await file('Черновик.pdf')
    expect(await ownedProjectFile(db, { id: unbound.id, userId: user.id })).toMatchObject({
      name: 'Черновик.pdf',
      projectId: null,
    })
    expect(await ownedProjectFile(db, { id: unbound.id, userId: other.user.id })).toBeNull()
    await db.$transaction((tx) =>
      bindProjectFiles(tx, {
        projectId,
        workspaceId: workspace.id,
        userId: user.id,
        ids: [unbound.id],
      }),
    )
    expect(await ownedProjectFile(db, { id: unbound.id, userId: user.id })).toMatchObject({
      projectId,
    })
    // The project in the trash: its files are no longer shown.
    await trashProject(db, { projectId, userId: user.id, now: new Date() })
    expect(await ownedProjectFile(db, { id: unbound.id, userId: user.id })).toBeNull()
  })

  it('removes the object first, then the row; a failed delete keeps the row', async () => {
    const { user, file } = await owner()
    const row = await file('Удалить.pdf')
    const failing = async () => {
      throw new Error('S3 down')
    }
    await expect(
      removeProjectFile(db, { id: row.id, userId: user.id, projectId: null }, failing),
    ).rejects.toThrow('S3 down')
    expect(await ownedProjectFile(db, { id: row.id, userId: user.id })).not.toBeNull()
    const deleted: string[] = []
    await removeProjectFile(db, { id: row.id, userId: user.id, projectId: null }, async (key) => {
      deleted.push(key)
    })
    expect(deleted).toEqual([row.key])
    expect(await ownedProjectFile(db, { id: row.id, userId: user.id })).toBeNull()
    expect(
      await codeOf(() =>
        removeProjectFile(db, { id: row.id, userId: user.id, projectId: null }, failing),
      ),
    ).toBe('PROJECT_FILE_NOT_FOUND')
  })

  it('lists a file no project took after its day and the grace, and deletes only such a row', async () => {
    const { file } = await owner()
    const fresh = await file('Свежий.pdf')
    const old = await file('Старый.pdf')
    await db.$executeRaw`UPDATE project_files SET expires_at = now() - interval '1 hour' WHERE id = ${old.id}::uuid`
    const expired = await listExpiredProjectFiles(db, { limit: 1000 })
    expect(expired.map((row) => row.id)).toContain(old.id)
    expect(expired.map((row) => row.id)).not.toContain(fresh.id)
    expect(await deleteExpiredProjectFile(db, { id: fresh.id })).toBe(false)
    expect(await deleteExpiredProjectFile(db, { id: old.id })).toBe(true)
  })

  it('gives a turn the ready files of the project of its chat, by path', async () => {
    const { user, workspace, project, file } = await owner()
    const projectId = await project()
    const pdf = await file('Бриф.pdf')
    await db.$transaction((tx) =>
      bindProjectFiles(tx, {
        projectId,
        workspaceId: workspace.id,
        userId: user.id,
        ids: [pdf.id],
      }),
    )
    const task = await db.task.create({
      data: { workspaceId: workspace.id, createdById: user.id, projectId },
    })
    expect(await readyProjectFiles(db, projectId)).toEqual([
      { name: 'Бриф.pdf', mediaType: 'application/pdf', sizeBytes: 10 },
    ])
    expect(await chatProjectFile(db, { taskId: task.id, name: 'Бриф.pdf' })).toMatchObject({
      id: pdf.id,
      key: pdf.key,
      sizeBytes: 10,
    })
    expect(await chatProjectFile(db, { taskId: task.id, name: 'Другой.pdf' })).toBeNull()
    // The chat leaves the project: its files are no longer the turn's.
    await db.task.update({ where: { id: task.id }, data: { projectId: null } })
    expect(await chatProjectFile(db, { taskId: task.id, name: 'Бриф.pdf' })).toBeNull()
  })
})
