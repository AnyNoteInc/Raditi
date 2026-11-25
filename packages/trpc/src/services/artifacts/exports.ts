import { artifactRole, enqueueOutbox, type PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import {
  ARTIFACT_EXPORT_JOB,
  ARTIFACT_QUEUE,
  artifactExportFileName,
  artifactExportLimits,
  artifactKindSpecOf,
  artifactLimit,
  artifactNotFound,
  type ArtifactExportState,
  artifactExportContentTypes,
  artifactExportFormats,
  type ArtifactExportFormat,
} from '@repo/domain/artifacts'
import { z } from 'zod'

// The exports of an artifact in the cabinet (docs/plan/88-artifacts.md, question 26; plan 93):
// the PDF and PPTX of a presentation and the PNG of a picture, which core builds — web writes the
// row and its job in one transaction, the cabinet asks how it goes, and the person who asked
// downloads it while they may still open the artifact.

/** «Скачать»: a new export of the artifact in a format of its kind, built by core. */
export async function startArtifactExport(
  db: PrismaClient,
  input: { userId: string; artifactId: string; format: ArtifactExportFormat; frame?: string },
): Promise<{ exportId: string }> {
  const format = input.format
  return db.$transaction(async (tx) => {
    const role = await artifactRole(tx, { artifactId: input.artifactId, userId: input.userId })
    if (role === null) throw artifactNotFound()
    const artifact = await tx.artifact.findUniqueOrThrow({
      where: { id: input.artifactId },
      select: { kind: true },
    })
    // The formats of its kind only: a presentation's PDF and PPTX (88.25в), a picture's PNG.
    if (
      !(artifactKindSpecOf(artifact.kind)?.exports as readonly string[] | undefined)?.includes(
        format,
      )
    )
      throw artifactNotFound()
    // A PNG draws one picture of «Изображение», named here (88.26).
    if (format === 'png' && input.frame === undefined) throw artifactNotFound()
    const waiting = await tx.artifactExport.count({
      where: { artifactId: input.artifactId, userId: input.userId, state: 'pending' },
    })
    if (waiting >= artifactExportLimits.pendingPerArtifact) throw artifactLimit('exports')
    const row = await tx.artifactExport.create({
      data: {
        artifactId: input.artifactId,
        userId: input.userId,
        format,
        blockKey: format === 'png' ? (input.frame ?? null) : null,
      },
      select: { id: true },
    })
    await enqueueOutbox(tx, {
      topic: ARTIFACT_QUEUE,
      type: ARTIFACT_EXPORT_JOB,
      payload: { exportId: row.id },
      dedupeKey: `${ARTIFACT_EXPORT_JOB}:${row.id}`,
    })
    return { exportId: row.id }
  })
}

const exportOf = async (db: PrismaClient, input: { userId: string; exportId: string }) => {
  if (!z.uuid().safeParse(input.exportId).success) return null
  const row = await db.artifactExport.findFirst({
    where: { id: input.exportId.toLowerCase(), userId: input.userId },
    include: { artifact: { select: { title: true } } },
  })
  if (row === null) return null
  // An artifact the person can no longer open gives them nothing, not even an old export.
  if ((await artifactRole(db, { artifactId: row.artifactId, userId: input.userId })) === null)
    return null
  return row
}

/** How an export goes: `pending`, `ready` (download it), `failed` (ask again). */
export async function artifactExportStatus(
  db: PrismaClient,
  input: { userId: string; exportId: string },
): Promise<{ state: ArtifactExportState }> {
  const row = await exportOf(db, input)
  if (row === null) throw artifactNotFound()
  return { state: row.state as ArtifactExportState }
}

/**
 * The file of a ready export of this person, or null: not theirs, not ready, gone, or of a format
 * that is no longer made (an old workbook of a removed table, plan 93).
 */
export async function readArtifactExport(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; exportId: string },
): Promise<{ name: string; bytes: Uint8Array; contentType: string } | null> {
  const row = await exportOf(db, input)
  if (row === null || row.state !== 'ready' || row.objectKey === null) return null
  if (!(artifactExportFormats as readonly string[]).includes(row.format)) return null
  const format = row.format as ArtifactExportFormat
  const body = await storage.get('artifacts', row.objectKey)
  if (body === null) return null
  const parts: Uint8Array[] = []
  for await (const part of body) parts.push(part)
  return {
    name: artifactExportFileName(row.artifact.title, format),
    bytes: Buffer.concat(parts),
    contentType: artifactExportContentTypes[format],
  }
}
