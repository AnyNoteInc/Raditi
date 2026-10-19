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
/** What a record is besides its text: published, or a draft the platform created. */
export const publishedRecordStatuses = ['publish', 'draft'] as const
export const publishedContentStateSchema = publishedContentFieldsSchema.extend({
  version: z.literal(1),
  objectRef: publishedObjectRefSchema,
  kind: z.enum(['post', 'page']),
  /**
   * Absent — `publish`, as a plugin before version 2 answers: it reads published records only.
   * `draft` — a record the platform created as a draft (a `post_create` of a plan, docs/plan/53).
   */
  status: z.enum(publishedRecordStatuses).optional(),
  /** The address of the record within its site, as the plugin of version 2 reads it. Not hashed. */
  slug: z.string().max(200).optional(),
  stateHash: contentHashSchema,
})
export type PublishedContentFields = z.infer<typeof publishedContentFieldsSchema>
export type PublishedContentPatch = z.infer<typeof publishedContentPatchSchema>
export type PublishedContentState = z.infer<typeof publishedContentStateSchema>

/**
 * Byte framing shared with the site-side transaction; modified dates are not content. The third
 * frame is the status — `publish` for every record a plugin before version 2 could read, so their
 * hashes did not change with it; the fourth, empty, is the password a readable record never has.
 */
export function publishedContentHashMaterial(
  state: Omit<PublishedContentState, 'stateHash' | 'slug'>,
): string {
  return [
    state.objectRef,
    state.kind,
    state.status ?? 'publish',
    '',
    state.title,
    state.content,
    state.excerpt,
  ]
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
  /**
   * `edit` — the agent's text, stored as the site's filter makes it (the filter may cost the
   * markup nothing); `restore` — exact bytes of a state the site held, never more HTML than the
   * writer may write; `release` — exact bytes a release carries from a preview: they must come
   * out of the site's filter unchanged, whoever writes them (docs/plan/53-chat-preview-release.md,
   * Р30) — the preview runs the agent's code, so its plugin's word on the filter proves nothing.
   */
  mode: 'edit' | 'restore' | 'release'
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
  /**
   * What the site's server runs (`siteRuntimeSchema`), for the runtime of a preview; a stack
   * whose plugin cannot tell has no method.
   */
  runtime?(): Promise<SiteRuntime>
}

// ---------------------------------------------------------------------------------------------
// The code cache of the site's server (stand R12)
// ---------------------------------------------------------------------------------------------

/**
 * What the server of a site keeps of its code between requests (PHP's opcache), as the site's
 * plugin reads it: whether a cache is on, whether it looks at the time of a file and how often
 * (seconds; 0 — at every request), and whether the plugin may drop a file from it. A release
 * checks the site only once the code it wrote is the code the site runs.
 */
export const siteCodeCacheSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('code_cache'),
  enabled: z.boolean(),
  validateTimestamps: z.boolean(),
  revalidateSeconds: z.number().int().min(0).max(31_536_000),
  refresh: z.boolean(),
})
export type SiteCodeCache = z.infer<typeof siteCodeCacheSchema>

/**
 * What a refresh did, path by path: dropped from the cache (or not in it), not in the tree (a
 * deleted file: nothing to run), or refused by the server.
 */
export const siteCodeRefreshSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('code_cache_refreshed'),
  refreshed: z.number().int().min(0),
  absent: z.number().int().min(0),
  failed: z.number().int().min(0),
})
export type SiteCodeRefresh = z.infer<typeof siteCodeRefreshSchema>

/**
 * What the site's server runs, as the platform's plugin reads it (docs/plan/53, Р2, Р18): the
 * version of its language runtime (`8.3`) and the names of its loaded extensions, lower case. A
 * preview runs on the closest version its host has and tells what it lacks.
 */
export const siteRuntimeSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('runtime'),
  runtimeVersion: z.string().regex(/^\d{1,2}\.\d{1,2}$/),
  extensions: z.array(z.string().regex(/^[a-z0-9][a-z0-9_ .+-]{0,62}$/)).max(256),
})
export type SiteRuntime = z.infer<typeof siteRuntimeSchema>

/** The most paths one refresh names; a release with more refreshes in several requests. */
export const SITE_CODE_REFRESH_PATHS = 1000

export interface SiteCodeCacheGateway {
  codeCache(): Promise<SiteCodeCache>
  /** Drops these files (paths from the root of the site) from the cache of the server. */
  refreshCode(paths: readonly string[]): Promise<SiteCodeRefresh>
}
