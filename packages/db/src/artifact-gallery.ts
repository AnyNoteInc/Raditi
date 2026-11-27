import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { blockCheckedText } from './pages.ts'

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
 * How much of a block's text the excerpt query reads: the card shows 240 letters of the first
 * three blocks, the database need not send whole documents for it.
 */
const EXCERPT_READ_CHARS = 2000

/** Where the next page of the gallery starts: the last card of the page before. */
export interface ArtifactGalleryCursor {
  id: string
  updatedAt: Date
  title: string
}

/** The preview of a card from the first blocks: their checked text. */
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
  db: Pick<PrismaClient, 'artifact' | '$queryRaw'>,
  input: {
    userId: string
    filter?: ArtifactGalleryFilter
    query?: string
    kind?: string | null
    projectId?: string | null
    sort?: ArtifactGallerySort
    limit?: number
    /** The last card of the page before: the page goes on after it in the same order. */
    after?: ArtifactGalleryCursor | null
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
  const where = filter === 'shared' ? shared : owned
  const rows = await db.artifact.findMany({
    where: input.after ? { AND: [where, afterCursor(sort, input.after)] } : where,
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
  const firsts = await firstBlocks(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    // The owner's project is none of a recipient's business (Ар35).
    project: filter === 'shared' ? null : row.project,
    version: row.currentVersion,
    blocks: row._count.sections,
    excerpt: excerptOf(firsts.get(row.id) ?? []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    purgeAfter: row.purgeAfter,
  }))
}

/**
 * The rows after the cursor in the order of the page: keyset pagination by `(updatedAt, id)`, or
 * by `(title, id)` for the sort by title. `updatedAt` is written by Prisma (`@updatedAt`) in
 * milliseconds, so the cursor's Date names it exactly.
 */
function afterCursor(
  sort: ArtifactGallerySort,
  after: ArtifactGalleryCursor,
): Prisma.ArtifactWhereInput {
  if (sort === 'title')
    return { OR: [{ title: { gt: after.title } }, { title: after.title, id: { gt: after.id } }] }
  return {
    OR: [
      { updatedAt: sort === 'newest' ? { lt: after.updatedAt } : { gt: after.updatedAt } },
      { updatedAt: after.updatedAt, id: { gt: after.id } },
    ],
  }
}

interface FirstBlockRow {
  document_id: string
  section_key: string
  block_kind: string
  rev: number
  state: string
  checked_turn: number | null
  written_by_user_id: string | null
  markdown: string | null
  content: string | null
}

/**
 * The first three written blocks of each card, in one query: the order of `artifactBlockOrder`
 * (`rank` NULLS LAST, `position`, `id`), served by `chat_document_sections_excerpt_idx`, and only
 * the beginning of their texts.
 */
async function firstBlocks(
  db: Pick<PrismaClient, '$queryRaw'>,
  documentIds: readonly string[],
): Promise<Map<string, Parameters<typeof excerptOf>[0][number][]>> {
  const byDocument = new Map<string, Parameters<typeof excerptOf>[0][number][]>()
  if (documentIds.length === 0) return byDocument
  const rows = await db.$queryRaw<FirstBlockRow[]>`
    SELECT d.id::text AS document_id, b.section_key, b.block_kind, b.rev, b.state,
           b.checked_turn, b.written_by_user_id::text AS written_by_user_id,
           b.markdown, b.content
    FROM unnest(${[...documentIds]}::uuid[]) WITH ORDINALITY AS d(id, n)
    JOIN LATERAL (
      SELECT s.section_key, s.block_kind, s.rev, s.state, s.checked_turn, s.written_by_user_id,
             left(s.markdown, ${EXCERPT_READ_CHARS}::int) AS markdown,
             left(s.content, ${EXCERPT_READ_CHARS}::int) AS content,
             s.rank, s.position, s.id
      FROM chat_document_sections s
      WHERE s.document_id = d.id AND s.deleted_rev IS NULL AND s.state = 'written'
      ORDER BY s.rank ASC NULLS LAST, s.position ASC, s.id ASC
      LIMIT 3
    ) b ON true
    ORDER BY d.n, b.rank ASC NULLS LAST, b.position ASC, b.id ASC`
  for (const row of rows) {
    const blocks = byDocument.get(row.document_id) ?? []
    blocks.push({
      sectionKey: row.section_key,
      blockKind: row.block_kind,
      rev: row.rev,
      state: row.state,
      checkedTurn: row.checked_turn,
      writtenByUserId: row.written_by_user_id,
      markdown: row.markdown,
      content: row.content,
    })
    byDocument.set(row.document_id, blocks)
  }
  return byDocument
}
