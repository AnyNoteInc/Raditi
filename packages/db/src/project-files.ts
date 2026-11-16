import {
  freeProjectFilePath,
  projectFileKey,
  projectFileMimeTypes,
  projectFileNotFound,
  projectFileNotReady,
  projectFilePath,
  projectLimits,
  projectRoomRefusal,
  type ProjectRoom,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The files and texts of the context of a project (docs/plan/84-projects.md, ПР8; slice 84.8).
// A file is announced without a project (`uploading`, a day to be taken), web streams it into
// raditi-inbox and marks it `ready`, and a project takes it (`bindProjectFiles`) — at its creation
// or later. The room of a project and of its workspace is counted under one lock of the workspace,
// so two uploads side by side never pass a limit together. Only the author of a project sees its
// files; a file without a project, only its uploader.

type Tx = Prisma.TransactionClient
type RawDb = Pick<Tx, '$queryRaw'>

/** How long a file nobody took is kept after it was announced (ПР8). */
export const PROJECT_FILE_UNBOUND_HOURS = 24

/**
 * A file nobody took is collected this long after its day: an upload that began just before may
 * still be writing its object.
 */
export const PROJECT_FILE_COLLECT_GRACE_MINUTES = 15

const id = z.uuid()
const mediaType = z
  .string()
  .refine((type) => projectFileMimeTypes.includes(type), 'expected a listed type')
const size = z.number().int().min(1).max(projectLimits.fileBytes)
const path = z.string().refine((name) => projectFilePath(name) === name, 'expected a clean path')

/** A file of a project as its owner reads it: never its key. */
export interface ProjectFileRow {
  id: string
  projectId: string | null
  kind: 'file' | 'text'
  name: string
  mediaType: string
  sizeBytes: number
  status: 'uploading' | 'ready'
  createdAt: Date
}

const rowSelect = {
  id: true,
  projectId: true,
  kind: true,
  name: true,
  mediaType: true,
  sizeBytes: true,
  status: true,
  createdAt: true,
} as const

const rowOf = (row: {
  id: string
  projectId: string | null
  kind: string
  name: string
  mediaType: string
  sizeBytes: number
  status: string
  createdAt: Date
}): ProjectFileRow => ({
  ...row,
  kind: row.kind === 'text' ? 'text' : 'file',
  status: row.status === 'ready' ? 'ready' : 'uploading',
})

/**
 * The lock of the room of a workspace: every write that adds bytes or files to it holds it to the
 * end of its transaction, so the sums it read stay true.
 */
export async function lockWorkspaceFiles(tx: RawDb, workspaceId: string): Promise<void> {
  const key = `project-files:${id.parse(workspaceId)}`
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/** The room taken in a workspace and, given its id, in one project of it. */
export async function projectRoomOf(
  tx: RawDb,
  input: { workspaceId: string; projectId?: string | null },
): Promise<ProjectRoom> {
  const workspaceId = id.parse(input.workspaceId)
  const projectId = input.projectId ? id.parse(input.projectId) : null
  const [row] = await tx.$queryRaw<
    Array<{ workspace_bytes: bigint; project_files: bigint; project_bytes: bigint }>
  >`
    SELECT coalesce(sum(size_bytes), 0)::bigint AS workspace_bytes,
           count(*) FILTER (WHERE project_id = ${projectId}::uuid)::bigint AS project_files,
           coalesce(sum(size_bytes) FILTER (WHERE project_id = ${projectId}::uuid), 0)::bigint
             AS project_bytes
      FROM project_files
     WHERE workspace_id = ${workspaceId}::uuid`
  return {
    workspaceBytes: Number(row?.workspace_bytes ?? 0),
    ...(projectId
      ? {
          project: {
            files: Number(row?.project_files ?? 0),
            bytes: Number(row?.project_bytes ?? 0),
          },
        }
      : {}),
  }
}

const createSchema = z.strictObject({
  workspaceId: id,
  uploadedById: id,
  kind: z.enum(['file', 'text']),
  name: path,
  mediaType,
  sizeBytes: size,
  /** The room of this project is checked too: the client learns of a full project before uploading. */
  forProjectId: id.nullable(),
})

/**
 * Announces a file of `uploadedById` (ПР8): `uploading`, without a project, with a day to be taken,
 * its key projectFileKey(). The room is checked under the lock of the workspace — of the workspace,
 * and of `forProjectId` when the file is meant for one — and refused with the domain's error. null
 * — the uploader is not a member of the workspace.
 */
export async function createProjectFile(
  db: PrismaClient,
  input: {
    workspaceId: string
    uploadedById: string
    kind: 'file' | 'text'
    name: string
    mediaType: string
    sizeBytes: number
    forProjectId?: string | null
  },
): Promise<{ id: string; key: string } | null> {
  const file = createSchema.parse({ ...input, forProjectId: input.forProjectId ?? null })
  const fileId = uuidv7()
  const key = projectFileKey(file.workspaceId, fileId)
  return db.$transaction(async (tx) => {
    await lockWorkspaceFiles(tx, file.workspaceId)
    const room = await projectRoomOf(tx, {
      workspaceId: file.workspaceId,
      projectId: file.forProjectId,
    })
    const refusal = projectRoomRefusal(room, { files: 1, bytes: file.sizeBytes })
    if (refusal) throw refusal
    const rows = await tx.$queryRaw<unknown[]>`
      INSERT INTO project_files
        (id, workspace_id, uploaded_by_id, kind, name, media_type, size_bytes, status, s3_key,
         expires_at, updated_at)
      SELECT ${fileId}::uuid, m.workspace_id, ${file.uploadedById}::uuid, ${file.kind}, ${file.name},
             ${file.mediaType}, ${file.sizeBytes}, 'uploading', ${key},
             clock_timestamp() + ${PROJECT_FILE_UNBOUND_HOURS}::int * interval '1 hour',
             clock_timestamp()
        FROM members m
       WHERE m.workspace_id = ${file.workspaceId}::uuid AND m.user_id = ${file.uploadedById}::uuid
      RETURNING id`
    return rows.length === 1 ? { id: fileId, key } : null
  })
}

const readySchema = z.strictObject({
  id,
  sizeBytes: size,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * web stored the bytes and checked them: the file may be taken. Only from `uploading`, without a
 * project, before its day is over; false otherwise.
 */
export async function markProjectFileReady(
  db: RawDb,
  input: { id: string; sizeBytes: number; sha256: string },
): Promise<boolean> {
  const ready = readySchema.parse(input)
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE project_files
       SET status = 'ready', sha256 = ${ready.sha256}, updated_at = clock_timestamp()
     WHERE id = ${ready.id}::uuid AND status = 'uploading' AND project_id IS NULL
       AND size_bytes = ${ready.sizeBytes} AND expires_at > clock_timestamp()
    RETURNING id`
  return rows.length === 1
}

/** A file as the upload of web finds it: of this uploader, without a project. */
export interface ProjectFileUpload {
  id: string
  key: string
  kind: 'file' | 'text'
  mediaType: string
  sizeBytes: number
  status: 'uploading' | 'ready'
  expiresAt: Date | null
}

/** The announced file `userId` uploads; null — none of theirs, or one a project took. */
export async function projectFileUpload(
  db: Pick<Tx, 'projectFile'>,
  input: { id: string; userId: string },
): Promise<ProjectFileUpload | null> {
  const row = await db.projectFile.findFirst({
    where: { id: id.parse(input.id), uploadedById: id.parse(input.userId), projectId: null },
    select: {
      id: true,
      s3Key: true,
      kind: true,
      mediaType: true,
      sizeBytes: true,
      status: true,
      expiresAt: true,
    },
  })
  if (row === null) return null
  return {
    id: row.id,
    key: row.s3Key,
    kind: row.kind === 'text' ? 'text' : 'file',
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    status: row.status === 'ready' ? 'ready' : 'uploading',
    expiresAt: row.expiresAt,
  }
}

const bindSchema = z.strictObject({
  projectId: id,
  workspaceId: id,
  userId: id,
  ids: z
    .array(id)
    .max(projectLimits.filesPerProject)
    .refine((ids) => new Set(ids).size === ids.length, 'expected distinct ids'),
})

/**
 * A project takes the files of its author, in the caller's transaction: all of them or none
 * (PROJECT_FILE_NOT_READY). Each must be `ready`, without a project, within its day, of this
 * uploader and workspace. The room of the project is counted again under the lock of the
 * workspace; a path the project already holds becomes «(2)», «(3)»… in the order of `ids`.
 * The caller has checked the project is the author's own and alive.
 */
export async function bindProjectFiles(
  tx: Tx,
  input: { projectId: string; workspaceId: string; userId: string; ids: readonly string[] },
): Promise<{ bound: number }> {
  const { projectId, workspaceId, userId, ids } = bindSchema.parse({
    ...input,
    ids: [...input.ids],
  })
  if (ids.length === 0) return { bound: 0 }
  await lockWorkspaceFiles(tx, workspaceId)
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; size_bytes: number }>>`
    SELECT id, name, size_bytes FROM project_files
     WHERE id = ANY(${ids}::uuid[]) AND status = 'ready' AND project_id IS NULL
       AND expires_at > clock_timestamp()
       AND uploaded_by_id = ${userId}::uuid AND workspace_id = ${workspaceId}::uuid
     FOR UPDATE`
  if (rows.length !== ids.length) throw projectFileNotReady()
  const room = await projectRoomOf(tx, { workspaceId, projectId })
  // The bytes are in the workspace already: only the project's room grows.
  const refusal = projectRoomRefusal(
    { workspaceBytes: 0, ...(room.project ? { project: room.project } : {}) },
    { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.size_bytes, 0) },
  )
  if (refusal) throw refusal
  const taken = (
    await tx.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM project_files WHERE project_id = ${projectId}::uuid`
  ).map((row) => row.name)
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const fileId of ids) {
    const row = byId.get(fileId)!
    const name = freeProjectFilePath(row.name, taken)
    if (name === null) throw projectFileNotReady()
    taken.push(name)
    await tx.$executeRaw`
      UPDATE project_files
         SET project_id = ${projectId}::uuid, name = ${name}, expires_at = NULL,
             updated_at = clock_timestamp()
       WHERE id = ${fileId}::uuid`
  }
  return { bound: ids.length }
}

/** The files of a project, in the order of their paths; the caller checked the project is theirs. */
export async function listProjectFiles(
  db: Pick<Tx, 'projectFile'>,
  projectId: string,
): Promise<ProjectFileRow[]> {
  const rows = await db.projectFile.findMany({
    where: { projectId: id.parse(projectId) },
    select: rowSelect,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map(rowOf)
}

/** The count and the bytes of the files of a project. */
export async function projectFilesSummary(
  db: Pick<Tx, 'projectFile'>,
  projectId: string,
): Promise<{ count: number; bytes: number }> {
  const sum = await db.projectFile.aggregate({
    where: { projectId: id.parse(projectId) },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  })
  return { count: sum._count._all, bytes: sum._sum.sizeBytes ?? 0 }
}

/**
 * A file `userId` may see: one of a live project they are the author of (and a member of its
 * workspace), or one of theirs no project took yet. null — any other.
 */
export async function ownedProjectFile(
  db: Pick<Tx, 'projectFile'>,
  input: { id: string; userId: string },
): Promise<(ProjectFileRow & { key: string; workspaceId: string }) | null> {
  const userId = id.parse(input.userId)
  const row = await db.projectFile.findFirst({
    where: {
      id: id.parse(input.id),
      OR: [
        { projectId: null, uploadedById: userId },
        {
          project: {
            createdById: userId,
            deletedAt: null,
            workspace: { members: { some: { userId } } },
          },
        },
      ],
    },
    select: { ...rowSelect, s3Key: true, workspaceId: true },
  })
  if (row === null) return null
  const { s3Key, workspaceId, ...rest } = row
  return { ...rowOf(rest), key: s3Key, workspaceId }
}

/**
 * Removes a file `userId` may see (ownedProjectFile): the row goes, and the answer is the key the
 * caller deletes from raditi-inbox — the object first, so a failed delete leaves the row to try
 * again (`deleteObject` runs before the row is removed). PROJECT_FILE_NOT_FOUND for any other.
 */
export async function removeProjectFile(
  db: PrismaClient,
  input: { id: string; userId: string; projectId: string | null },
  deleteObject: (key: string) => Promise<void>,
): Promise<void> {
  const file = await ownedProjectFile(db, input)
  if (file === null || file.projectId !== (input.projectId ? id.parse(input.projectId) : null))
    throw projectFileNotFound()
  await deleteObject(file.key)
  await db.$executeRaw`DELETE FROM project_files WHERE id = ${file.id}::uuid`
}

/** A file the collector removes: its id and the key of its object in raditi-inbox. */
export interface ExpiredProjectFile {
  id: string
  key: string
}

/**
 * Files no project took, past their day and the grace, oldest first: core's collector deletes the
 * object of each, then its row (deleteExpiredProjectFile). Nothing can take or ready an expired
 * file, so none of them moves meanwhile.
 */
export async function listExpiredProjectFiles(
  db: RawDb,
  input: { limit: number },
): Promise<ExpiredProjectFile[]> {
  const limit = z.number().int().min(1).max(1000).parse(input.limit)
  const rows = await db.$queryRaw<Array<{ id: string; s3_key: string }>>`
    SELECT id, s3_key FROM project_files
     WHERE project_id IS NULL
       AND expires_at <= clock_timestamp()
                         - make_interval(mins => ${PROJECT_FILE_COLLECT_GRACE_MINUTES}::int)
     ORDER BY expires_at, id
     LIMIT ${limit}`
  return rows.map((row) => ({ id: row.id, key: row.s3_key }))
}

/** The row of an expired file whose object is gone; false — it is not one any more. */
export async function deleteExpiredProjectFile(db: RawDb, input: { id: string }): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    DELETE FROM project_files
     WHERE id = ${id.parse(input.id)}::uuid AND project_id IS NULL
       AND expires_at <= clock_timestamp()
    RETURNING id`
  return rows.length === 1
}

/** The files of a project being purged: their objects go first, then their rows (ПР20). */
export async function projectFileKeys(
  db: RawDb,
  input: { projectId: string; limit: number },
): Promise<ExpiredProjectFile[]> {
  const limit = z.number().int().min(1).max(1000).parse(input.limit)
  const rows = await db.$queryRaw<Array<{ id: string; s3_key: string }>>`
    SELECT id, s3_key FROM project_files WHERE project_id = ${id.parse(input.projectId)}::uuid
     ORDER BY id LIMIT ${limit}`
  return rows.map((row) => ({ id: row.id, key: row.s3_key }))
}

/** A row of a file of a project whose object is gone. */
export async function deleteProjectFileRow(db: RawDb, input: { id: string }): Promise<void> {
  await db.$queryRaw`DELETE FROM project_files WHERE id = ${id.parse(input.id)}::uuid RETURNING id`
}

/** A ready file of a project as a pass gives it to the agent (ПР8): never its key. */
export interface ProjectFileFacts {
  name: string
  mediaType: string
  sizeBytes: number
}

/** The ready files of a project, at most `projectLimits.filesPerProject`, in the order of paths. */
export async function readyProjectFiles(
  db: Pick<Tx, 'projectFile'>,
  projectId: string,
): Promise<ProjectFileFacts[]> {
  return db.projectFile.findMany({
    where: { projectId: id.parse(projectId), status: 'ready' },
    select: { name: true, mediaType: true, sizeBytes: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: projectLimits.filesPerProject,
  })
}

/**
 * A file of the project of a chat at a path, as a turn reads it (TaskProjectFiles): the project
 * the chat is in now, alive, the file ready. null — none.
 */
export async function chatProjectFile(
  db: Pick<Tx, 'task'>,
  input: { taskId: string; name: string },
): Promise<{
  workspaceId: string
  id: string
  key: string
  sizeBytes: number
  name: string
} | null> {
  const task = await db.task.findUnique({
    where: { id: id.parse(input.taskId) },
    select: {
      project: {
        select: {
          deletedAt: true,
          files: {
            where: { name: input.name, status: 'ready' },
            select: { id: true, workspaceId: true, s3Key: true, sizeBytes: true, name: true },
            take: 1,
          },
        },
      },
    },
  })
  const project = task?.project
  const file = project && project.deletedAt === null ? project.files[0] : undefined
  if (!file) return null
  return {
    workspaceId: file.workspaceId,
    id: file.id,
    key: file.s3Key,
    sizeBytes: file.sizeBytes,
    name: file.name,
  }
}
