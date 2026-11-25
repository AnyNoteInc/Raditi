import {
  artifactFileKey,
  artifactFileNameSchema,
  artifactForbidden,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
  artifactRoleAtLeast,
  artifactTooLarge,
} from '@repo/domain/artifacts'

import { artifactRole } from './artifacts.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

// The files of an artifact (docs/plan/88-artifacts.md, Ар12, §7.1; slice 88.12): a photo, a picture
// or a font a frame shows by `artifact-file:<id>`. A person with «Правит» uploads one in the
// cabinet (`uploading` → `ready`); a turn reserves one of its outbox (`artifact_file_put`,
// `reserved`), and core writes it at the end of the turn. Up to 5 MiB a file and 50 MiB an artifact,
// counting what is on its way. Only `ready` files are shown.

type Db = Pick<PrismaClient, '$queryRaw' | '$transaction' | 'artifact' | 'artifactFile'>

/** An upload that never came is not counted after this. */
const UPLOAD_GRACE_MS = 60 * 60 * 1000

export interface ArtifactFileRow {
  id: string
  artifactId: string
  name: string
  contentType: string
  bytes: number
  objectKey: string
  state: string
  createdAt: Date
}

const asRow = (row: {
  id: string
  artifactId: string
  name: string
  contentType: string
  bytes: bigint
  objectKey: string
  state: string
  createdAt: Date
}): ArtifactFileRow => ({ ...row, bytes: Number(row.bytes) })

const select = {
  id: true,
  artifactId: true,
  name: true,
  contentType: true,
  bytes: true,
  objectKey: true,
  state: true,
  createdAt: true,
} as const

/** The bytes the files of an artifact hold or are about to: ready, reserved, fresh uploads. */
async function filesBytes(db: Pick<PrismaClient, 'artifactFile'>, artifactId: string, now: Date) {
  const sum = await db.artifactFile.aggregate({
    where: {
      artifactId,
      OR: [
        { state: { in: ['ready', 'reserved'] } },
        { state: 'uploading', createdAt: { gt: new Date(now.getTime() - UPLOAD_GRACE_MS) } },
      ],
    },
    _sum: { bytes: true },
  })
  return Number(sum._sum.bytes ?? 0n)
}

async function workspaceOf(db: Pick<PrismaClient, 'artifact'>, artifactId: string) {
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    select: { workspaceId: true },
  })
  if (!artifact) throw artifactNotFound()
  return artifact.workspaceId
}

/**
 * A person announces a file to upload (`artifact.fileStart`): «Правит» or the owner; the row and
 * the key its bytes go to. The bytes come by `PUT /api/artifact-files/<id>`.
 */
export async function startArtifactFileUpload(
  db: Db,
  input: { userId: string; artifactId: string; name: string; sizeBytes: number; now?: Date },
): Promise<ArtifactFileRow> {
  const now = input.now ?? new Date()
  const role = await artifactRole(db, { artifactId: input.artifactId, userId: input.userId })
  if (role === null) throw artifactNotFound()
  if (!artifactRoleAtLeast(role, 'edit')) throw artifactForbidden()
  if (!artifactFileNameSchema.safeParse(input.name).success)
    throw artifactLimit('a picture or a font: png, jpg, gif, webp, avif, svg, woff2, woff')
  if (input.sizeBytes > artifactLimits.fileBytes) throw artifactTooLarge('fileBytes')
  return db.$transaction(async (tx) => {
    // One upload of an artifact at a time is counted against its bound: the row of the artifact.
    await tx.$queryRaw`SELECT id FROM chat_documents WHERE id = ${input.artifactId}::uuid FOR NO KEY UPDATE`
    if ((await filesBytes(tx, input.artifactId, now)) + input.sizeBytes > artifactLimits.filesBytes)
      throw artifactTooLarge('filesBytes')
    const workspaceId = await workspaceOf(tx, input.artifactId)
    const id = crypto.randomUUID()
    const row = await tx.artifactFile.create({
      data: {
        id,
        artifactId: input.artifactId,
        objectKey: artifactFileKey({ workspaceId, artifactId: input.artifactId, fileId: id }),
        name: input.name,
        contentType: 'application/octet-stream',
        bytes: BigInt(input.sizeBytes),
        state: 'uploading',
        createdByUserId: input.userId,
        createdAt: now,
      },
      select,
    })
    return asRow(row)
  })
}

/**
 * The upload a person announced and has not finished, fresh, while they may still write the
 * artifact (the role is read again now); null — none.
 */
export async function artifactFileUpload(
  db: Pick<PrismaClient, 'artifactFile' | '$queryRaw'>,
  input: { id: string; userId: string; now?: Date },
): Promise<ArtifactFileRow | null> {
  const now = input.now ?? new Date()
  const row = await db.artifactFile.findFirst({
    where: {
      id: input.id,
      createdByUserId: input.userId,
      state: 'uploading',
      createdAt: { gt: new Date(now.getTime() - UPLOAD_GRACE_MS) },
    },
    select,
  })
  if (!row) return null
  const role = await artifactRole(db, { artifactId: row.artifactId, userId: input.userId })
  return role !== null && artifactRoleAtLeast(role, 'edit') ? asRow(row) : null
}

/**
 * The bytes of a file are stored and checked: it is ready, with its type. False — it is no longer
 * an upload or a reservation (another call finished it, or it went).
 */
export async function markArtifactFileReady(
  db: Pick<PrismaClient, 'artifactFile'>,
  input: {
    id: string
    contentType: string
    sizeBytes: number
    sha256: string
    /** Where the bytes were put, when not at the key of the row (an upload: by their hash). */
    objectKey?: string
    now?: Date
  },
): Promise<boolean> {
  const done = await db.artifactFile.updateMany({
    where: { id: input.id, state: { in: ['uploading', 'reserved'] } },
    data: {
      ...(input.objectKey === undefined ? {} : { objectKey: input.objectKey }),
      state: 'ready',
      contentType: input.contentType,
      bytes: BigInt(input.sizeBytes),
      sha256: input.sha256,
      readyAt: input.now ?? new Date(),
    },
  })
  return done.count === 1
}

/** A reservation or an upload that did not come true goes. */
export async function dropArtifactFile(
  db: Pick<PrismaClient, 'artifactFile'>,
  id: string,
): Promise<void> {
  await db.artifactFile.deleteMany({ where: { id, state: { not: 'ready' } } })
}

/**
 * `artifact_file_put` (§7.5): a file of the outbox of this turn into an artifact the chat may write,
 * at the end of the turn. The same file of the same turn again is the same reservation; another
 * artifact for it is refused. The caller checked the chat's role (`chatArtifactAccess`).
 */
export async function reserveArtifactFile(
  db: Db,
  input: { taskId: string; turnNo: number; artifactId: string; fileName: string; now?: Date },
): Promise<ArtifactFileRow> {
  const now = input.now ?? new Date()
  if (!artifactFileNameSchema.safeParse(input.fileName).success)
    throw artifactLimit('a picture or a font: png, jpg, gif, webp, avif, svg, woff2, woff')
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM chat_documents WHERE id = ${input.artifactId}::uuid FOR NO KEY UPDATE`
    const known = await tx.artifactFile.findFirst({
      where: { taskId: input.taskId, turnNo: input.turnNo, fileName: input.fileName },
      select,
    })
    if (known) {
      if (known.artifactId !== input.artifactId)
        throw artifactLimit('this file of the outbox is already put into another artifact')
      return asRow(known)
    }
    // A reservation counts the most a file may be, until core knows its size.
    if (
      (await filesBytes(tx, input.artifactId, now)) + artifactLimits.fileBytes >
      artifactLimits.filesBytes
    )
      throw artifactTooLarge('filesBytes')
    const workspaceId = await workspaceOf(tx, input.artifactId)
    const id = crypto.randomUUID()
    return asRow(
      await tx.artifactFile.create({
        data: {
          id,
          artifactId: input.artifactId,
          objectKey: artifactFileKey({ workspaceId, artifactId: input.artifactId, fileId: id }),
          name: input.fileName,
          contentType: 'application/octet-stream',
          bytes: BigInt(artifactLimits.fileBytes),
          state: 'reserved',
          taskId: input.taskId,
          turnNo: input.turnNo,
          fileName: input.fileName,
          createdAt: now,
        },
        select,
      }),
    )
  })
}

/** The files a turn reserved, by their name in the outbox — ready ones too: a repeat skips them. */
export async function artifactFilesOfTurn(
  db: Pick<PrismaClient, 'artifactFile'>,
  input: { taskId: string; turnNo: number },
): Promise<Map<string, ArtifactFileRow>> {
  const rows = await db.artifactFile.findMany({
    where: { taskId: input.taskId, turnNo: input.turnNo },
    orderBy: { createdAt: 'asc' },
    select: { ...select, fileName: true },
  })
  return new Map(rows.map((row) => [row.fileName!, asRow(row)]))
}

/** The ready files of an artifact for a reader (`view` and up). */
export async function listArtifactFiles(
  db: Db,
  input: { userId: string; artifactId: string },
): Promise<ArtifactFileRow[]> {
  if ((await artifactRole(db, input)) === null) throw artifactNotFound()
  const rows = await db.artifactFile.findMany({
    where: { artifactId: input.artifactId, state: 'ready' },
    orderBy: { createdAt: 'asc' },
    select,
  })
  return rows.map(asRow)
}

/** The ready files of an artifact that a text names (the caller checked the role). */
export async function artifactFilesByIds(
  db: Pick<PrismaClient, 'artifactFile'>,
  input: { artifactId: string; ids: readonly string[] },
): Promise<ArtifactFileRow[]> {
  if (input.ids.length === 0) return []
  const rows = await db.artifactFile.findMany({
    where: { artifactId: input.artifactId, id: { in: [...input.ids] }, state: 'ready' },
    select,
  })
  return rows.map(asRow)
}

/** One ready file for a viewer whose role is read again now (Ар12); null — no such file for them. */
export async function artifactFileFor(
  db: Db,
  input: { userId: string; artifactId: string; fileId: string },
): Promise<ArtifactFileRow | null> {
  if ((await artifactRole(db, input)) === null) return null
  const row = await db.artifactFile.findFirst({
    where: { id: input.fileId, artifactId: input.artifactId, state: 'ready' },
    select,
  })
  return row ? asRow(row) : null
}

// ———————————————————————————————————————— imports of the outbox (§7.5)

export interface ArtifactImportRow {
  id: string
  fileName: string
  artifactId: string
  intoExisting: boolean
  title: string | null
  personal: boolean
  state: string
}

/**
 * `artifact_import`: a file of this turn's outbox becomes a new artifact — its id is named now —
 * or the content of one the chat may write (the caller checked that and its kind). The same file of
 * the same turn again is the same reservation.
 */
export async function reserveArtifactImport(
  db: Pick<PrismaClient, '$transaction'>,
  input: {
    taskId: string
    turnNo: number
    fileName: string
    artifactId: string | null
    title: string | null
    personal: boolean
  },
): Promise<ArtifactImportRow> {
  return db.$transaction(async (tx) => {
    // The imports of one turn are counted one at a time: two calls never both take the fifth.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`artifact-import:${input.taskId}:${input.turnNo}`}))`
    const known = await tx.artifactImport.findFirst({
      where: { taskId: input.taskId, turnNo: input.turnNo, fileName: input.fileName },
    })
    if (known) return known
    const imports = await tx.artifactImport.count({
      where: { taskId: input.taskId, turnNo: input.turnNo },
    })
    if (imports >= artifactLimits.agentImportsPerTurn) throw artifactLimit('agentImportsPerTurn')
    return tx.artifactImport.create({
      data: {
        taskId: input.taskId,
        turnNo: input.turnNo,
        fileName: input.fileName,
        artifactId: input.artifactId ?? crypto.randomUUID(),
        intoExisting: input.artifactId !== null,
        title: input.title,
        personal: input.personal,
      },
    })
  })
}

/** The imports a turn reserved, by name. */
export async function artifactImportsOfTurn(
  db: Pick<PrismaClient, 'artifactImport'>,
  input: { taskId: string; turnNo: number },
): Promise<Map<string, ArtifactImportRow>> {
  const rows = await db.artifactImport.findMany({
    where: { taskId: input.taskId, turnNo: input.turnNo },
    orderBy: { createdAt: 'asc' },
  })
  return new Map(rows.map((row) => [row.fileName, row]))
}

/** An import done or refused: once. */
export async function settleArtifactImport(
  db: Pick<PrismaClient, 'artifactImport'>,
  input: { id: string; state: 'done' | 'refused'; now?: Date },
): Promise<boolean> {
  const done = await db.artifactImport.updateMany({
    where: { id: input.id, state: 'reserved' },
    data: { state: input.state, settledAt: input.now ?? new Date() },
  })
  return done.count === 1
}
