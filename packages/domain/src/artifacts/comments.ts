import { z } from 'zod'

import { artifactBlockKeySchema } from './blocks.ts'
import { artifactLimits } from './limits.ts'

export const normalizeCommentQuote = (text: string): string => text.replace(/\s+/gu, ' ').trim()

const storableText = (text: string) => !text.includes('\0') && text.isWellFormed()

export const artifactQuoteAnchorSchema = z.strictObject({
  kind: z.literal('quote'),
  block: artifactBlockKeySchema,
  rev: z.number().int().nonnegative(),
  quote: z
    .string()
    .max(artifactLimits.commentChars)
    .refine(storableText)
    .transform(normalizeCommentQuote)
    .pipe(z.string().min(1)),
})

export type ArtifactQuoteAnchor = z.infer<typeof artifactQuoteAnchorSchema>

export const artifactCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(artifactLimits.commentChars)
  .refine(storableText)

/** Bounds an explicitly sent snapshot, both at storage and before it becomes turn data. */
export const artifactCommentDispatchLimits = { threads: 16, entries: 48, bytes: 24 * 1024 } as const
export const artifactCommentSnapshotSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      anchor: artifactQuoteAnchorSchema,
      body: artifactCommentBodySchema,
      replies: z.array(artifactCommentBodySchema).max(artifactCommentDispatchLimits.entries),
    }),
  )
  .min(1)
  .max(artifactCommentDispatchLimits.threads)
  .refine(
    (roots) =>
      roots.reduce((count, root) => count + 1 + root.replies.length, 0) <=
      artifactCommentDispatchLimits.entries,
  )
export type ArtifactCommentSnapshot = z.infer<typeof artifactCommentSnapshotSchema>

/** Both inputs are normalized visible text, not Markdown source or editor offsets. */
export function hasUniqueCommentQuote(text: string, quote: string): boolean {
  const first = text.indexOf(quote)
  return quote.length > 0 && first >= 0 && text.indexOf(quote, first + 1) < 0
}
