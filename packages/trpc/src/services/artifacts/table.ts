import { artifactRole, enqueueOutbox, readArtifact, type PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import {
  ARTIFACT_EXPORT_JOB,
  ARTIFACT_QUEUE,
  artifactExportFileName,
  artifactExportLimits,
  artifactKindSpecOf,
  artifactLimit,
  artifactNotFound,
  tableOfBlocks,
  tableTotals,
  type ArtifactExportState,
} from '@repo/domain/artifacts'
import { z } from 'zod'

// The table of an artifact in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13, question 26;
// slice 88.14): its totals, which the server counts on decimal.js (rule 9), and «Скачать → Excel»,
// which core builds — web writes the row and its job in one transaction, the cabinet asks how it
// goes, and the person who asked downloads it while they may still open the table.

const actorOf = (userId: string) => ({ kind: 'user' as const, userId })

/**
 * The totals of a table — over all its rows, or the rows the screen shows (a filter): the sum of
 * each number and money column as a string.
 */
export async function cabinetTableTotals(
  db: PrismaClient,
  input: { userId: string; artifactId: string; rows: readonly string[] | null },
): Promise<{ totals: Record<string, string>; rows: number }> {
  const artifact = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: actorOf(input.userId),
  })
  const table = tableOfBlocks(artifact.blocks)
  const only = input.rows === null ? null : new Set(input.rows)
  const rows = only === null ? table.rows : table.rows.filter((row) => only.has(row.key))
  return { totals: tableTotals(table.columns, rows), rows: rows.length }
}

/** «Скачать → Excel»: a new export of the table, built by core. */
export async function startArtifactExport(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
): Promise<{ exportId: string }> {
  return db.$transaction(async (tx) => {
    const role = await artifactRole(tx, { artifactId: input.artifactId, userId: input.userId })
    if (role === null) throw artifactNotFound()
    const artifact = await tx.artifact.findUniqueOrThrow({
      where: { id: input.artifactId },
      select: { kind: true },
    })
    if (!artifactKindSpecOf(artifact.kind)?.exports.includes('xlsx')) throw artifactNotFound()
    const waiting = await tx.artifactExport.count({
      where: { artifactId: input.artifactId, userId: input.userId, state: 'pending' },
    })
    if (waiting >= artifactExportLimits.pendingPerArtifact) throw artifactLimit('exports')
    const row = await tx.artifactExport.create({
      data: { artifactId: input.artifactId, userId: input.userId, format: 'xlsx' },
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
  // A table the person can no longer open gives them nothing, not even an old workbook.
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

/** The workbook of a ready export of this person, or null: not theirs, not ready, gone. */
export async function readArtifactExport(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; exportId: string },
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const row = await exportOf(db, input)
  if (row === null || row.state !== 'ready' || row.objectKey === null) return null
  const body = await storage.get('artifacts', row.objectKey)
  if (body === null) return null
  const parts: Uint8Array[] = []
  for await (const part of body) parts.push(part)
  return { name: artifactExportFileName(row.artifact.title, 'xlsx'), bytes: Buffer.concat(parts) }
}
