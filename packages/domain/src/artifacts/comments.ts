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

/** The text of an element an anchor keeps, as the client reads it (88.18е). */
export const commentCellTextChars = 200
export const commentCellText = (text: string): string =>
  Array.from(normalizeCommentQuote(text)).slice(0, commentCellTextChars).join('')

/** The id the server stamps into an element of an `html` block: `<block>.<n>` (Ар9). */
const elementIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]+\.[1-9][0-9]{0,5}$/u)

/** An element of a frame as the cabinet picks it: the server reads its tag and text (Ар27). */
export const artifactElementAnchorInputSchema = z
  .strictObject({
    kind: z.literal('element'),
    block: artifactBlockKeySchema,
    element: elementIdSchema,
    rev: z.number().int().nonnegative(),
  })
  .refine((anchor) => anchor.element.startsWith(`${anchor.block}.`), {
    message: 'the element is of its block',
  })
export type ArtifactElementAnchorInput = z.infer<typeof artifactElementAnchorInputSchema>

export const artifactElementAnchorSchema = z
  .strictObject({
    kind: z.literal('element'),
    block: artifactBlockKeySchema,
    element: elementIdSchema,
    rev: z.number().int().nonnegative(),
    tag: z.string().max(32).refine(storableText),
    text: z
      .string()
      .max(commentCellTextChars * 2)
      .refine(storableText),
  })
  .refine((anchor) => anchor.element.startsWith(`${anchor.block}.`))
export type ArtifactElementAnchor = z.infer<typeof artifactElementAnchorSchema>

/** What a note is anchored to: a quote, an element of a frame (Ар53). */
export const artifactCommentAnchorSchema = z.union([
  artifactQuoteAnchorSchema,
  artifactElementAnchorSchema,
])
export type ArtifactCommentAnchor = z.infer<typeof artifactCommentAnchorSchema>

/** The anchor the cabinet sends: an element without what the server reads for it. */
export const artifactCommentAnchorInputSchema = z.union([
  artifactQuoteAnchorSchema,
  artifactElementAnchorInputSchema,
])
export type ArtifactCommentAnchorInput = z.infer<typeof artifactCommentAnchorInputSchema>

export const artifactCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(artifactLimits.commentChars)
  .refine(storableText)

/** Whether threads carry words of another person than the one who sent them (88.17в, Ар25). */
export function artifactCommentsByOthers(
  notes: readonly { by?: 'other'; replies: readonly (string | { by: 'other' })[] }[],
): boolean {
  return notes.some(
    (note) => note.by === 'other' || note.replies.some((reply) => typeof reply !== 'string'),
  )
}

/** Bounds an explicitly sent snapshot, both at storage and before it becomes turn data. */
export const artifactCommentDispatchLimits = { threads: 16, entries: 48, bytes: 24 * 1024 } as const
export const artifactCommentSnapshotSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      anchor: artifactCommentAnchorSchema,
      body: artifactCommentBodySchema,
      /** Written by another person with access, not the one who sent it (88.17а, Ар25). */
      by: z.literal('other').optional(),
      replies: z
        .array(
          z.union([
            artifactCommentBodySchema,
            z.strictObject({ body: artifactCommentBodySchema, by: z.literal('other') }),
          ]),
        )
        .max(artifactCommentDispatchLimits.entries),
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
