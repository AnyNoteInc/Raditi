import { z } from 'zod'

import { pageTitleSchema } from './doc.ts'
import { pageSlugSchema } from './slug.ts'

/**
 * The payloads of the feed rows of pages and documents (docs/plan/69-pages.md, Ст22, Ст23). They
 * join `feedEventTypes` in the slices that write and read them (69.6, 69.8); the shapes are here
 * so that the writers and readers of the three apps agree from the first slice.
 */

const version = z.literal(1)
const id = z.uuid()

/** Where the content of a page came from: a file of the agent, Markdown, a document. */
export const pageKinds = ['html', 'markdown', 'doc'] as const
export type PageKind = (typeof pageKinds)[number]

/** A page version number: v1, v2, … — only grows (Ст16). */
export const pageVersionSchema = z.number().int().min(1).max(1_000_000)

/** `feed.page` v1 — a page was published or got a new version: its one address is the slug's. */
export const feedPagePayloadSchema = z.strictObject({
  v: version,
  pageId: id,
  slug: pageSlugSchema,
  title: pageTitleSchema,
  version: pageVersionSchema,
  kind: z.enum(pageKinds),
})
export type FeedPagePayload = z.infer<typeof feedPagePayloadSchema>

/**
 * Why a publication of the turn did not come to be: `missing` — no file of that name in the
 * outbox; `refused` — the checks took it out (the reason is not told to the client: a found
 * secret least of all); `failed` — the platform lost it.
 */
export const pageLeftReasons = ['missing', 'refused', 'failed'] as const
export type PageLeftReason = (typeof pageLeftReasons)[number]

/** `feed.page_left` v1 — the agent named the page, it did not get the version. */
export const feedPageLeftPayloadSchema = z.strictObject({
  v: version,
  pageId: id,
  reason: z.enum(pageLeftReasons),
})
export type FeedPageLeftPayload = z.infer<typeof feedPageLeftPayloadSchema>

/** `feed.doc` v1 — the agent set up a document: the card shows it from now on. */
export const feedDocPayloadSchema = z.strictObject({
  v: version,
  docId: id,
  title: pageTitleSchema,
})
export type FeedDocPayload = z.infer<typeof feedDocPayloadSchema>

/**
 * `feed.doc_touch` v1 — the document changed: the card reads it again by tRPC. A signal only; the
 * text of the sections is never in the feed.
 */
export const feedDocTouchPayloadSchema = z.strictObject({
  v: version,
  docId: id,
  revision: z.number().int().min(1).max(1_000_000_000),
})
export type FeedDocTouchPayload = z.infer<typeof feedDocTouchPayloadSchema>

/** `feed.doc_left` v1 — sections of the turn did not pass core's checks and are pending again. */
export const feedDocLeftPayloadSchema = z.strictObject({
  v: version,
  docId: id,
  sections: z.number().int().min(1).max(1000),
  reason: z.literal('refused'),
})
export type FeedDocLeftPayload = z.infer<typeof feedDocLeftPayloadSchema>
