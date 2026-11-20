import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  createArtifact,
  listArtifacts,
  restoreArtifact,
  trashArtifact,
  type ArtifactGalleryFilter,
  type ArtifactGallerySort,
  type PrismaClient,
} from '@repo/db'
import type { AppEnv } from '@repo/domain'
import {
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
