import {
  artifactsChangedByTurn,
  listArtifactChanges,
  listArtifactVersions,
  previewArtifactRestore,
  readArtifactVersion,
  restoreArtifactVersion,
  undoArtifactTurn,
  type PrismaClient,
} from '@repo/db'
import { DomainError } from '@repo/domain'

import { accessibleTask } from '../chat/access.ts'

// The history of an artifact in the cabinet (docs/plan/88-artifacts.md, Ар13; board D-history;
// slice 88.11а): «Версии / Все изменения», a version to read, «Вернуть эту версию» with what it
// overwrites, «Отменить правки этого хода» — and the artifacts a turn changed, which `/undo` names.

export async function cabinetVersions(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) {
  const rows = await listArtifactVersions(db, input)
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
}

export async function cabinetChanges(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) {
  const rows = await listArtifactChanges(db, input)
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
}

export async function cabinetVersion(
  db: PrismaClient,
  input: { userId: string; artifactId: string; no: number },
) {
  const version = await readArtifactVersion(db, {
    artifactId: input.artifactId,
    no: input.no,
    actor: { kind: 'user', userId: input.userId },
  })
  return {
    no: version.no,
    label: version.label,
    createdAt: version.createdAt.toISOString(),
    blocks: version.blocks.map((block) => ({
      key: block.key,
      kind: block.kind,
      heading: typeof block.props.heading === 'string' ? block.props.heading : null,
      content: block.content,
    })),
  }
}

export const cabinetRestorePreview = (
  db: PrismaClient,
  input: { userId: string; artifactId: string; no: number },
) => previewArtifactRestore(db, input)

export const cabinetRestore = (
  db: PrismaClient,
  input: { userId: string; artifactId: string; no: number },
) => restoreArtifactVersion(db, input)

/** The artifacts a turn of a chat of the reader changed (`/undo`, Ар13). */
export async function cabinetTurnArtifacts(
  db: PrismaClient,
  input: { userId: string; taskId: string; turnNo: number },
) {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (!task) throw new DomainError('NOT_FOUND', 'No such chat', 404)
  return artifactsChangedByTurn(db, input)
}

/** «Отменить правки этого хода» of a turn of a chat of the reader. */
export async function cabinetUndoTurn(
  db: PrismaClient,
  input: { userId: string; artifactId: string; taskId: string; turnNo: number },
) {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (!task) throw new DomainError('NOT_FOUND', 'No such chat', 404)
  return undoArtifactTurn(db, input)
}
