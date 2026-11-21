import { addArtifactComment, readArtifactComments, type PrismaClient } from '@repo/db'
import { artifactSectionText } from '@repo/doc-render/markdown'
import {
  artifactQuoteAnchorSchema,
  hasUniqueCommentQuote,
  normalizeCommentQuote,
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'

type Owner = { artifactId: string; userId: string }
const quoteText = (markdown: string) => normalizeCommentQuote(artifactSectionText(markdown))

export function createCabinetComment(
  db: PrismaClient,
  input: Owner & { anchor: ArtifactQuoteAnchor; body: string },
) {
  return addArtifactComment(db, input, (markdown, quote) =>
    hasUniqueCommentQuote(quoteText(markdown), quote),
  )
}

export async function cabinetComments(db: PrismaClient, input: Owner) {
  const { comments, sections } = await readArtifactComments(db, input)
  const texts = new Map(
    [...sections].map(([key, markdown]) => [key, markdown === null ? '' : quoteText(markdown)]),
  )
  return comments.flatMap((comment) => {
    const anchor = artifactQuoteAnchorSchema.safeParse(comment.anchor)
    if (!anchor.success || anchor.data.block !== comment.blockKey) return []
    return [
      {
        id: comment.id,
        anchor: anchor.data,
        body: comment.body,
        resolved: comment.resolvedAt !== null,
        moved: !hasUniqueCommentQuote(texts.get(anchor.data.block) ?? '', anchor.data.quote),
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
