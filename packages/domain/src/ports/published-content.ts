import { z } from 'zod'

/** Deliberately excludes drafts, authors, metadata and arbitrary REST routes. */
export const publishedObjectRefSchema = z.string().regex(/^(post|page):[1-9][0-9]{0,9}$/)
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const text = z
  .string()
  .max(32768)
  .refine((value) => !value.includes('\0'))
export const publishedContentFieldsSchema = z.strictObject({
  title: text,
  content: text,
  excerpt: text,
})
export const publishedContentPatchSchema = publishedContentFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0)
export const publishedContentStateSchema = publishedContentFieldsSchema.extend({
  version: z.literal(1),
  objectRef: publishedObjectRefSchema,
  kind: z.enum(['post', 'page']),
  stateHash: contentHashSchema,
})
export type PublishedContentFields = z.infer<typeof publishedContentFieldsSchema>
export type PublishedContentPatch = z.infer<typeof publishedContentPatchSchema>
export type PublishedContentState = z.infer<typeof publishedContentStateSchema>

/** Byte framing shared with the site-side transaction; modified dates are not content. */
export function publishedContentHashMaterial(
  state: Omit<PublishedContentState, 'stateHash'>,
): string {
  return [state.objectRef, state.kind, 'publish', '', state.title, state.content, state.excerpt]
    .map((value) => `${new TextEncoder().encode(value).byteLength}:${value}`)
    .join('')
}

export const contentWriteProofSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('committed'),
  callId: z.uuid(),
  siteId: z.uuid(),
  epoch: z.number().int().positive(),
  requestHash: contentHashSchema,
  objectRef: publishedObjectRefSchema,
  stateHash: contentHashSchema,
})
export type ContentWriteProof = z.infer<typeof contentWriteProofSchema>
/** A trusted host supplies the identity persisted before dispatch, never a new write. */
export const contentOperationRefSchema = z.strictObject({
  callId: z.uuid(),
  siteId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  requestHash: contentHashSchema,
  objectRef: publishedObjectRefSchema,
  deadlineAt: z.number().int().safe().positive(),
})
export type ContentOperationRef = z.infer<typeof contentOperationRefSchema>
/**
 * What is left of `deadlineAt`, in whole milliseconds, on the clock that set the deadline; zero
 * or less once it has passed. A site counts this duration on its own clock and never compares
 * its clock with the deadline, so the caller takes both from one clock and passes them on.
 */
export const contentTimeLeftSchema = z.number().int().safe()
/** The identity of an operation and the time it has left. The time is no part of any proof. */
export type ContentOperationRequest = ContentOperationRef & { ttlMs: number }
/** Persisted under the same site lock as a write; a late dispatch can no longer commit. */
export const contentNoWriteProofSchema = contentOperationRefSchema.extend({
  version: z.literal(1),
  kind: z.literal('not_committed'),
})
export type ContentNoWriteProof = z.infer<typeof contentNoWriteProofSchema>
export const contentRecoveryOutcomeSchema = z.union([
  contentWriteProofSchema,
  contentNoWriteProofSchema,
  z.strictObject({ version: z.literal(1), kind: z.literal('unknown') }),
])
export type ContentRecoveryOutcome = z.infer<typeof contentRecoveryOutcomeSchema>
export type ContentWriteOutcome =
  | ContentWriteProof
  | {
      version: 1
      kind: 'rejected'
      code: 'conflict' | 'fenced' | 'invalid' | 'unavailable'
      /**
       * Why an `invalid` value cannot be written to this site as given: its filters would alter
       * the markup, the state would exceed the size limit, or its database would store other text.
       */
      reason?: 'markup' | 'size' | 'storage'
    }

export interface ContentWriteRequest {
  callId: string
  siteId: string
  epoch: number
  requestHash: string
  objectRef: string
  expectedStateHash: string
  deadlineAt: number
  /** See `contentTimeLeftSchema`. */
  ttlMs: number
  mode: 'edit' | 'restore'
  fields: PublishedContentPatch
}

/** An adapter must atomically compare content and persist its receipt with the write. */
export interface PublishedContentGateway {
  read(objectRef: string): Promise<PublishedContentState>
  conditionalWrite(request: ContentWriteRequest): Promise<ContentWriteOutcome>
  /** null is absence of evidence, never proof that a delayed write cannot still commit. */
  operation(callId: string): Promise<ContentWriteProof | null>
  /** Reconcile after the persisted deadline; absence alone is never a negative proof. */
  reconcileOperation(request: ContentOperationRequest): Promise<ContentRecoveryOutcome>
  /** Host GC only after journal completion and snapshot expiry. Idempotent on absence. */
  forgetOperation(request: ContentOperationRequest): Promise<void>
}
