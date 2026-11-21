import {
  addArtifactComment,
  readArtifactComments,
  type ArtifactAnchorReaders,
  type PrismaClient,
} from '@repo/db'
import { artifactElementOf } from '@repo/doc-bridge'
import { artifactSectionText } from '@repo/doc-render/markdown'
import {
  artifactCommentAnchorSchema,
  hasUniqueCommentQuote,
  normalizeCommentQuote,
  type ArtifactColumn,
  type ArtifactCommentAnchor,
  type ArtifactCommentAnchorInput,
} from '@repo/domain/artifacts'

type Owner = { artifactId: string; userId: string }
const quoteText = (markdown: string) => normalizeCommentQuote(artifactSectionText(markdown))

export function createCabinetComment(
  db: PrismaClient,
  input: Owner & { anchor: ArtifactCommentAnchorInput; body: string },
) {
  return addArtifactComment(db, input, anchorReaders)
}

const anchorReaders: ArtifactAnchorReaders = {
  quote: (markdown, quote) => hasUniqueCommentQuote(quoteText(markdown), quote),
  element: artifactElementOf,
}

/**
 * «Место изменилось»: a quote no longer found once in its section; a cell whose row or column is
 * gone (a new value keeps its place); an element no longer found once by its id.
 */
function anchorMoved(
  anchor: ArtifactCommentAnchor,
  blocks: ReadonlyMap<string, string | null>,
  columns: readonly ArtifactColumn[],
): boolean {
  const text = blocks.get(anchor.block)
  if (anchor.kind === 'cell')
    return text == null || !columns.some((column) => column.key === anchor.column)
  if (anchor.kind === 'element')
    return (
      text == null ||
      artifactElementOf({ block: anchor.block, html: text, id: anchor.element }) === null
    )
  return !hasUniqueCommentQuote(text == null ? '' : quoteText(text), anchor.quote)
}

export async function cabinetComments(db: PrismaClient, input: Owner) {
  const { comments, blocks, columns } = await readArtifactComments(db, input)
  return comments.flatMap((comment) => {
    const anchor = artifactCommentAnchorSchema.safeParse(comment.anchor)
    if (!anchor.success || anchor.data.block !== comment.blockKey) return []
    return [
      {
        id: comment.id,
        anchor: anchor.data,
        body: comment.body,
        resolved: comment.resolvedAt !== null,
        moved: anchorMoved(anchor.data, blocks, columns),
        replies: comment.replies.map(({ id, body, createdAt, byAgent }) => ({
          id,
          body,
          createdAt: createdAt.toISOString(),
          byAgent,
        })),
      },
    ]
  })
}
