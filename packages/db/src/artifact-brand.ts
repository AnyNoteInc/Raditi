import type { PrismaClient } from './generated/prisma/client.ts'
import { artifactBlockOrder, blockCheckedText } from './pages.ts'

/**
 * The brand of a project (docs/plan/88-artifacts.md, §4, Ар42; slice 88.15а): its newest live
 * artifact of the kind «Фирменный стиль», the checked JSON of its `settings` and its `seq` — the
 * frames of the project's mockups and canvases stand in its CSS variables, every turn of the
 * project reads it. Null — the project has none, or no project.
 */
export interface ProjectBrand {
  id: string
  title: string
  seq: number
  settings: string | null
  /** The checked text of its first section: the tone of the texts in words. */
  tone: string | null
}

type Db = Pick<PrismaClient, 'artifact' | 'artifactBlock'>

export async function projectBrandOf(
  db: Db,
  projectId: string | null,
): Promise<ProjectBrand | null> {
  if (projectId === null) return null
  const brand = await db.artifact.findFirst({
    where: { projectId, kind: 'brand', deletedAt: null, takenDownAt: null },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, title: true, seq: true },
  })
  if (brand === null) return null
  const blocks = await db.artifactBlock.findMany({
    where: {
      documentId: brand.id,
      deletedRev: null,
      parentKey: null,
      blockKind: { in: ['settings', 'section'] },
    },
    orderBy: [...artifactBlockOrder],
  })
  const text = (kind: string) => {
    const block = blocks.find((each) => each.blockKind === kind)
    return block ? blockCheckedText(block) : null
  }
  return {
    id: brand.id,
    title: brand.title,
    seq: Number(brand.seq),
    settings: text('settings'),
    tone: text('section'),
  }
}

/** The brand that stands in the frames of an artifact: of its project. */
export async function artifactBrandOf(db: Db, artifactId: string): Promise<ProjectBrand | null> {
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    select: { projectId: true, kind: true },
  })
  if (artifact === null || artifact.kind === 'brand') return null
  return projectBrandOf(db, artifact.projectId)
}
