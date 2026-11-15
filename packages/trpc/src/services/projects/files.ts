import { createHash } from 'node:crypto'

import {
  bindProjectFiles,
  createProjectFile,
  listProjectFiles,
  markProjectFileReady,
  projectFilesSummary,
  projectOwnedBy,
  removeProjectFile,
  type Prisma,
  type PrismaClient,
  type ProjectFileRow,
} from '@repo/db'
import {
  projectFileOf,
  projectFilesTooMany,
  projectLimits,
  projectNotFound,
  projectRoomPercent,
  projectTextFileOf,
  type AppEnv,
  type ObjectStorage,
} from '@repo/domain'

import { personalWorkspaceOf, WRITE } from '../chat/dialog-lock.ts'

// The files and texts of the context of a project (docs/plan/84-projects.md, ПР8; slice 84.8):
// announced here (`projectFile.start`), their bytes streamed by web into raditi-inbox
// (`PUT /api/project-files/<id>`, which marks them `ready`), taken by a project at its creation
// (`project.create({ fileIds })`) or later (`projectFile.bind`). A text the client writes is kept
// as a `.md` file and stored here. No key of an object leaves the server.

/** Where the browser sends the bytes of an announced file. */
export const projectFileUploadPath = (fileId: string) => `/api/project-files/${fileId}`

/**
 * Files announced and not taken by a project, of one person at a time: a folder of a project
 * twice over. A bound on the rows nobody took, not a quota — the room is (ПР8).
 */
export const UNBOUND_PROJECT_FILES_PER_USER = projectLimits.filesPerProject * 2

/** The workspace a file goes to: of the project it is meant for, else the personal one. */
async function workspaceFor(
  db: PrismaClient,
  input: { userId: string; appEnv: AppEnv; projectId: string | null },
): Promise<string> {
  if (input.projectId === null)
    return (await personalWorkspaceOf(db, { userId: input.userId, appEnv: input.appEnv })).id
  const project = await projectOwnedBy(db, input.projectId, input.userId)
  if (project === null) throw projectNotFound()
  return project.workspaceId
}

async function assertUnboundRoom(db: PrismaClient, userId: string): Promise<void> {
  const unbound = await db.projectFile.count({
    where: { uploadedById: userId, projectId: null, expiresAt: { gt: new Date() } },
  })
  if (unbound >= UNBOUND_PROJECT_FILES_PER_USER) throw projectFilesTooMany()
}

/**
 * `projectFile.start`: a file of the context is announced (`uploading`, a day to be taken). The
 * room of the workspace — and of the project, when the file is meant for one — is checked now, so
 * the client learns of a full project before the bytes go; the project takes it with `bind`.
 */
export async function startProjectFile(
  db: PrismaClient,
  input: {
    userId: string
    appEnv: AppEnv
    projectId: string | null
    name: string
    size: number
    type: string
  },
): Promise<{ fileId: string; name: string; uploadPath: string }> {
  const file = projectFileOf(input)
  await assertUnboundRoom(db, input.userId)
  const workspaceId = await workspaceFor(db, input)
  const row = await createProjectFile(db, {
    workspaceId,
    uploadedById: input.userId,
    kind: 'file',
    name: file.path,
    mediaType: file.type.mime,
    sizeBytes: file.size,
    forProjectId: input.projectId,
  })
  // The membership was lost between the two reads.
  if (row === null) throw projectNotFound()
  return { fileId: row.id, name: file.path, uploadPath: projectFileUploadPath(row.id) }
}

/**
 * «Добавить текстовое содержимое» (P-context-text): the text is checked (100 000 characters, no
 * secret), stored as a `.md` file and, with a project, taken by it — all or nothing: a text the
 * project could not take is removed again.
 */
export async function addProjectText(
  db: PrismaClient,
  storage: () => ObjectStorage,
  input: { userId: string; appEnv: AppEnv; projectId: string | null; title: string; text: string },
): Promise<{ fileId: string; name: string }> {
  const file = projectTextFileOf(input)
  await assertUnboundRoom(db, input.userId)
  const workspaceId = await workspaceFor(db, input)
  const row = await createProjectFile(db, {
    workspaceId,
    uploadedById: input.userId,
    kind: 'text',
    name: file.path,
    mediaType: 'text/markdown',
    sizeBytes: file.bytes.byteLength,
    forProjectId: input.projectId,
  })
  if (row === null) throw projectNotFound()
  const sha256 = createHash('sha256').update(file.bytes).digest('hex')
  const undo = async () => {
    await storage().delete('inbox', row.key)
    await db.projectFile.deleteMany({ where: { id: row.id } })
  }
  try {
    await storage().put('inbox', row.key, file.bytes, {
      contentType: 'text/markdown',
      sizeBytes: file.bytes.byteLength,
    })
    if (!(await markProjectFileReady(db, { id: row.id, sizeBytes: file.bytes.byteLength, sha256 })))
      throw new Error('A text of a project could not be marked ready')
    if (input.projectId !== null) {
      const projectId = input.projectId
      await db.$transaction(
        (tx) =>
          bindProjectFiles(tx, { projectId, workspaceId, userId: input.userId, ids: [row.id] }),
        WRITE,
      )
    }
  } catch (error) {
    // The row of a text nobody took expires anyway; the object is removed now if it can be.
    await undo().catch(() => {})
    throw error
  }
  const name =
    input.projectId === null
      ? file.path
      : ((await db.projectFile.findUnique({ where: { id: row.id }, select: { name: true } }))
          ?.name ?? file.path)
  return { fileId: row.id, name }
}

/** The live project of `userId`, for the procedures of its files. */
async function ownedProject(
  db: Pick<Prisma.TransactionClient, 'project'>,
  projectId: string,
  userId: string,
) {
  const project = await projectOwnedBy(db, projectId, userId)
  if (project === null) throw projectNotFound()
  return project
}

/**
 * Files of the author taken by a project in the caller's transaction (`project.create`,
 * `projectFile.bind`): all or none, within the room of the project.
 */
export async function bindFilesToProject(
  tx: Prisma.TransactionClient,
  input: { projectId: string; userId: string; fileIds: readonly string[] },
): Promise<{ bound: number }> {
  if (input.fileIds.length === 0) return { bound: 0 }
  const project = await ownedProject(tx, input.projectId, input.userId)
  return bindProjectFiles(tx, {
    projectId: project.id,
    workspaceId: project.workspaceId,
    userId: input.userId,
    ids: input.fileIds,
  })
}

/** «Контекст»: the files of a project and the room they take. */
export async function listFilesOfProject(
  db: PrismaClient,
  input: { userId: string; projectId: string },
): Promise<{
  files: ProjectFileRow[]
  bytes: number
  limitBytes: number
  percent: number
}> {
  const project = await ownedProject(db, input.projectId, input.userId)
  const files = await listProjectFiles(db, project.id)
  const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  return {
    files,
    bytes,
    limitBytes: projectLimits.projectBytes,
    percent: projectRoomPercent(bytes),
  }
}

/** The room of a project for its page: the count, the bytes and the first files. */
export async function projectFilesOverview(
  db: PrismaClient,
  projectId: string,
  first = 5,
): Promise<{ count: number; bytes: number; limitBytes: number; first: ProjectFileRow[] }> {
  const summary = await projectFilesSummary(db, projectId)
  const files = summary.count === 0 ? [] : (await listProjectFiles(db, projectId)).slice(0, first)
  return { ...summary, limitBytes: projectLimits.projectBytes, first: files }
}

/**
 * Removes a file: of the author's project, or — `projectId: null` — one of theirs no project took
 * yet. The object first, then the row, so a failed delete of the object can be repeated.
 */
export async function removeFileOfProject(
  db: PrismaClient,
  storage: () => ObjectStorage,
  input: { userId: string; projectId: string | null; fileId: string },
): Promise<void> {
  if (input.projectId !== null) await ownedProject(db, input.projectId, input.userId)
  await removeProjectFile(
    db,
    { id: input.fileId, userId: input.userId, projectId: input.projectId },
    (key) => storage().delete('inbox', key),
  )
}
