import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  artifactCopySource,
  createArtifact,
  listArtifacts,
  readArtifact,
  restoreArtifact,
  trashArtifact,
  type ArtifactGalleryFilter,
  type ArtifactGallerySort,
  type PrismaClient,
} from '@repo/db'
import type { AppEnv } from '@repo/domain'
import {
  artifactBatchSchema,
  artifactKindCreatable,
  artifactKindRefused,
  artifactNotFound,
  artifactTemplateOf,
} from '@repo/domain/artifacts'

import { personalWorkspaceOf } from '../chat/dialog-lock.ts'

// The gallery «Артефакты» and «Создать» (docs/plan/88-artifacts.md, Ар50, slice 88.9): what the
// owner keeps, a new artifact — empty or from a template — and the trash of 30 days.

export async function galleryOf(
  db: PrismaClient,
  input: {
    userId: string
    filter: ArtifactGalleryFilter
    query?: string | undefined
    kind?: string | null | undefined
    projectId?: string | null | undefined
    sort?: ArtifactGallerySort | undefined
  },
) {
  const rows = await listArtifacts(db, input)
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    purgeAfter: row.purgeAfter?.toISOString() ?? null,
  }))
}

/**
 * «Создать» (A-create): a kind whose view shipped, its title, where it is kept — a project of the
 * user or none (the personal workspace) — and how it starts: empty, or the sections of a template.
 * The sections are the person's writes: checked as they are written, shown at once.
 */
export async function createGalleryArtifact(
  db: PrismaClient,
  input: {
    userId: string
    appEnv: AppEnv
    kind: string
    title: string
    projectId: string | null
    templateId: string | null
  },
): Promise<{ id: string }> {
  if (!artifactKindCreatable(input.kind)) throw artifactKindRefused(input.kind)
  const template = input.templateId === null ? null : artifactTemplateOf(input.templateId)
  if (input.templateId !== null && (template === null || template.kind !== input.kind))
    throw artifactNotFound()
  let workspaceId: string
  if (input.projectId !== null) {
    const project = await db.project.findFirst({
      where: {
        id: input.projectId,
        createdById: input.userId,
        deletedAt: null,
        archivedAt: null,
      },
      select: { workspaceId: true },
    })
    if (!project) throw artifactNotFound()
    workspaceId = project.workspaceId
  } else {
    workspaceId = (await personalWorkspaceOf(db, { userId: input.userId, appEnv: input.appEnv })).id
  }
  const actor = { kind: 'user' as const, userId: input.userId }
  const { id } = await createArtifact(db, {
    workspaceId,
    kind: input.kind,
    title: input.title,
    projectId: input.projectId,
    actor,
  })
  if (template !== null && template.blocks.length > 0) {
    // The last block written at each level: the next one of that level goes after it.
    const lastOf = new Map<string | null, string>()
    const ops = template.blocks.map((block, index) => {
      // A document's sections keep the keys `s1…` of plan 88.9; the other parts are `b1…`; a
      // canvas names its screens and their parts itself (slice 88.15).
      const key = block.key ?? `${block.kind === 'section' ? 's' : 'b'}${index + 1}`
      const parent = block.parent ?? null
      const props = {
        ...(block.props ?? {}),
        ...(block.heading === undefined ? {} : { heading: block.heading }),
      }
      const op = {
        op: 'insert' as const,
        block: key,
        after: lastOf.get(parent) ?? null,
        ...(parent === null ? {} : { parent }),
        kind: block.kind,
        content: block.content,
        ...(Object.keys(props).length === 0 ? {} : { props }),
      }
      lastOf.set(parent, key)
      return op
    })
    await applyArtifactOps(db, { batch: { artifactId: id, opId: randomUUID(), ops }, actor })
  }
  return { id }
}

export const trashGalleryArtifact = (
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) => trashArtifact(db, { ...input, by: 'client' })

export const restoreGalleryArtifact = (
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) => restoreArtifact(db, input)

/** A batch of a copy stays well under the limits of a batch (§7.2: 50 operations, 90 KiB). */
const COPY_OPS = 40
const COPY_BYTES = 60 * 1024

/**
 * «Сделать копию» of a recipient (docs/plan/88-artifacts.md, §7.8, slice 88.16-4): the checked
 * blocks as they read them, into a new artifact of their personal workspace, «Копия: …», by the
 * operations of the cabinet with all their checks. Allowed by the owner, without files, of a class
 * of data the workspace may hold. The copy is theirs: revoking access does not touch it.
 */
export async function copyArtifactForRecipient(
  db: PrismaClient,
  input: { userId: string; appEnv: AppEnv; artifactId: string },
): Promise<{ id: string }> {
  const workspaceId = (
    await personalWorkspaceOf(db, { userId: input.userId, appEnv: input.appEnv })
  ).id
  const source = await artifactCopySource(db, {
    artifactId: input.artifactId,
    userId: input.userId,
    targetWorkspaceId: workspaceId,
  })
  const actor = { kind: 'user' as const, userId: input.userId }
  const read = await readArtifact(db, { artifactId: input.artifactId, actor })
  const title = Array.from(`Копия: ${source.title}`).slice(0, 200).join('')
  const { id } = await createArtifact(db, {
    workspaceId,
    kind: source.kind,
    title,
    projectId: null,
    actor,
  })
  const lastOf = new Map<string | null, string>()
  let batch: unknown[] = []
  let bytes = 0
  const flush = async () => {
    if (batch.length === 0) return
    await applyArtifactOps(db, {
      batch: artifactBatchSchema.parse({ artifactId: id, opId: randomUUID(), ops: batch }),
      actor,
    })
    batch = []
    bytes = 0
  }
  for (const block of read.blocks) {
    const parent = block.parent ?? null
    const op = {
      op: 'insert' as const,
      block: block.key,
      after: lastOf.get(parent) ?? null,
      ...(parent === null ? {} : { parent }),
      kind: block.kind,
      content: block.content ?? '',
      ...(Object.keys(block.props).length === 0 ? {} : { props: block.props }),
    }
    lastOf.set(parent, block.key)
    const size = Buffer.byteLength(JSON.stringify(op))
    if (batch.length >= COPY_OPS || bytes + size > COPY_BYTES) await flush()
    batch.push(op)
    bytes += size
  }
  await flush()
  return { id }
}
