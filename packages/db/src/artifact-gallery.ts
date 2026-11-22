import { tableCellText, tableOfBlocks } from '@repo/domain/artifacts'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { artifactBlockOrder, blockCheckedText } from './pages.ts'

// The gallery «Артефакты» (docs/plan/88-artifacts.md, Ар50, slice 88.9): the artifacts a user
// owns — personal ones and those of the projects they made — in the order and with the filters
// the page asks for. Until the grants of slice 88.16 «Доступные мне» is empty: only the owner has
// a role (`artifactRole`), and this list asks the same rule of it — the owner alive and a member
// of the workspace, the author of the project of a project's artifact, nothing taken down.

export const artifactGalleryFilters = ['all', 'mine', 'projects', 'shared', 'trash'] as const
export type ArtifactGalleryFilter = (typeof artifactGalleryFilters)[number]

export const artifactGallerySorts = ['newest', 'oldest', 'title'] as const
export type ArtifactGallerySort = (typeof artifactGallerySorts)[number]

export interface ArtifactGalleryRow {
  id: string
  kind: string
  title: string
  project: { id: string; name: string } | null
  version: number
  blocks: number
  /** The beginning of the checked text: the preview of the card. */
  excerpt: string
  createdAt: Date
  updatedAt: Date
  /** In the trash: when it goes for good. */
  purgeAfter: Date | null
}

const EXCERPT_CHARS = 240

/**
 * The preview of a card from the first blocks: the text of Markdown, or — for a table (its
 * `columns` and `row` blocks) — the names of its columns and its first rows as words, not JSON.
 */
function excerptOf(
  blocks: readonly {
    sectionKey: string
    blockKind: string
    rev: number
    state: string
    checkedTurn: number | null
    writtenByUserId: string | null
    markdown: string | null
    content: string | null
  }[],
): string {
  const table = tableOfBlocks(
    blocks.map((block) => ({
      key: block.sectionKey,
      kind: block.blockKind,
      rev: block.rev,
      content: blockCheckedText(block),
    })),
  )
  if (table.columnsKey !== null)
    return artifactExcerpt(
      [
        table.columns.map((column) => column.name).join(' · '),
        ...table.rows.map((row) =>
          table.columns
            .map((column) => tableCellText(column, row.cells[column.key]))
            .filter(Boolean)
            .join(' · '),
        ),
      ].join('\n'),
    )
  return artifactExcerpt(blocks.map((block) => blockCheckedText(block) ?? '').join('\n\n'))
}

/** The beginning of Markdown as text: no marks, links by their words, lines joined. */
export function artifactExcerpt(markdown: string, chars = EXCERPT_CHARS): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/[*_`~|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const letters = [...text]
  return letters.length <= chars
    ? text
    : `${letters
        .slice(0, chars - 1)
        .join('')
        .trimEnd()}…`
}

/**
 * What the owner sees in the gallery: live artifacts (or the trash), optionally one kind or one
 * project, found by a word of the title or of the checked text, newest first by default.
 */
export async function listArtifacts(
  db: Pick<PrismaClient, 'artifact' | 'artifactBlock'>,
  input: {
    userId: string
    filter?: ArtifactGalleryFilter
    query?: string
    kind?: string | null
    projectId?: string | null
    sort?: ArtifactGallerySort
    limit?: number
  },
): Promise<ArtifactGalleryRow[]> {
  const filter = input.filter ?? 'all'
  const query = input.query?.trim() ?? ''
  const now = new Date()
  // «Доступные мне» (Ар34, 88.16-1): those of others the user holds a live grant of — by an
  // invitation, or by a link neither revoked nor expired. Every read checks the role again.
  const shared: Prisma.ArtifactWhereInput = {
    takenDownAt: null,
    deletedAt: null,
    NOT: { ownerUserId: input.userId },
    grants: {
      some: {
        userId: input.userId,
        OR: [
          { source: 'invite' },
          { link: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
        ],
      },
    },
    ...(query === '' ? {} : { title: { contains: query, mode: 'insensitive' as const } }),
    ...(input.kind ? { kind: input.kind } : {}),
  }
  const owned: Prisma.ArtifactWhereInput = {
    takenDownAt: null,
    workspace: { members: { some: { userId: input.userId } } },
    OR: [
      { ownerUserId: input.userId },
      {
        ownerUserId: null,
        workspace: { members: { some: { userId: input.userId, role: 'owner' } } },
      },
    ],
    AND: [
      { OR: [{ projectId: null }, { project: { createdById: input.userId } }] },
      ...(query === ''
        ? []
        : [
            {
              OR: [
                { title: { contains: query, mode: 'insensitive' as const } },
                {
                  sections: {
                    some: {
                      deletedRev: null,
                      state: 'written',
                      content: { contains: query, mode: 'insensitive' as const },
                    },
                  },
                },
              ],
            },
          ]),
    ],
    deletedAt: filter === 'trash' ? { not: null } : null,
    // Purged with its project (Ар42): its day has come, the collector takes it within minutes.
    ...(filter === 'trash' ? { purgeAfter: { gt: now } } : {}),
    ...(filter === 'mine' ? { projectId: null } : {}),
    ...(filter === 'projects' ? { projectId: { not: null } } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  }
  const sort = input.sort ?? 'newest'
  const orderBy: Prisma.ArtifactOrderByWithRelationInput[] =
    sort === 'title'
      ? [{ title: 'asc' }, { id: 'asc' }]
      : [{ updatedAt: sort === 'newest' ? 'desc' : 'asc' }, { id: 'asc' }]
  const rows = await db.artifact.findMany({
    where: filter === 'shared' ? shared : owned,
    orderBy,
    take: Math.min(Math.max(input.limit ?? 200, 1), 500),
    select: {
      id: true,
      kind: true,
      title: true,
      currentVersion: true,
      createdAt: true,
      updatedAt: true,
      purgeAfter: true,
      project: { select: { id: true, name: true } },
      _count: { select: { sections: { where: { deletedRev: null } } } },
    },
  })
  const firsts = await Promise.all(
    rows.map((row) =>
      db.artifactBlock.findMany({
        where: { documentId: row.id, deletedRev: null, state: 'written' },
        orderBy: [...artifactBlockOrder],
        take: 3,
        select: {
          sectionKey: true,
          blockKind: true,
          rev: true,
          state: true,
          checkedTurn: true,
          writtenByUserId: true,
          markdown: true,
          content: true,
        },
      }),
    ),
  )
  return rows.map((row, index) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    // The owner's project is none of a recipient's business (Ар35).
    project: filter === 'shared' ? null : row.project,
    version: row.currentVersion,
    blocks: row._count.sections,
    excerpt: excerptOf(firsts[index]!),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    purgeAfter: row.purgeAfter,
  }))
}
