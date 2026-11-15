import { z } from 'zod'

import { pageTitleSchema } from './doc.ts'
import { pagePathSchema } from './path.ts'
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

/** A link of a page to its own site that leads nowhere (Дер20). */
export const pageLinkWarningSchema = z.strictObject({
  // As the page has it, within the letters of a path: anything else is not told, only counted.
  href: z.string().regex(/^[A-Za-z0-9/._~-]{1,200}$/),
  problem: z.enum(['missing', 'relative']),
})
export type PageLinkWarning = z.infer<typeof pageLinkWarningSchema>

/**
 * `feed.page` v1 — a page was published or got a new version: its one address is the host of
 * its site and its path (docs/plan/73-pages-sites.md, Дер15) — none, `/`, for a home page, as
 * every row before sites.
 */
export const feedPagePayloadSchema = z.strictObject({
  v: version,
  pageId: id,
  slug: pageSlugSchema,
  path: pagePathSchema.optional(),
  /**
   * Links of the version to its own site that lead nowhere (Дер20): a path no page of the site
   * has after the turn, or a relative link. A word to the client, not a refusal.
   */
  warnings: z.array(pageLinkWarningSchema).max(20).optional(),
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
/**
 * … `changed` — the page got another version while the agent worked on it, or what it asked of
 * the page no longer fits it (docs/plan/73-pages-sites.md, Дер25).
 */
export const pageLeftReasons = ['missing', 'refused', 'failed', 'changed'] as const
export type PageLeftReason = (typeof pageLeftReasons)[number]

/** What the agent did to a page besides a version (Дер23–Дер27): to the trash, back, renamed or moved. */
export const pageChanges = ['trashed', 'restored', 'updated'] as const
export type PageChangeName = (typeof pageChanges)[number]

/**
 * `feed.page_change` v1 — the agent changed a page at the end of its turn: moved it to the trash
 * with the pages below it, returned it, or renamed or moved it. The card reads what the page is
 * now from `pages.list` — «Вернуть» for one in the trash.
 */
export const feedPageChangePayloadSchema = z.strictObject({
  v: version,
  pageId: id,
  title: pageTitleSchema,
  change: z.enum(pageChanges),
  pages: z.number().int().min(1).max(1000),
})
export type FeedPageChangePayload = z.infer<typeof feedPageChangePayloadSchema>

/**
 * What did not come true (docs/plan/73-pages-sites.md, Дер23, Дер34): a version of a page — the
 * row says nothing then, as before —, a shared file of its site, or a change of it.
 */
export const pageLeftObjects = ['page', 'file', 'change'] as const
export type PageLeftObject = (typeof pageLeftObjects)[number]

/**
 * The object of a reservation of its kind (`page_reservations.kind`): a deletion that names a
 * shared file (`payload.file`, `page_file_delete`) is of the file.
 */
export const pageLeftObjectOf = (kind: string, payload?: unknown): PageLeftObject =>
  kind === 'asset' ||
  (kind === 'delete' && typeof (payload as { file?: unknown } | null)?.file === 'string')
    ? 'file'
    : kind === 'version'
      ? 'page'
      : 'change'

/** `feed.page_left` v1 — the agent named the page, it did not get the version. */
export const feedPageLeftPayloadSchema = z.strictObject({
  v: version,
  pageId: id,
  reason: z.enum(pageLeftReasons),
  /** A shared file or a change of the page; absent — its version (Дер23, Дер34). */
  of: z.enum(['file', 'change']).optional(),
})
export type FeedPageLeftPayload = z.infer<typeof feedPageLeftPayloadSchema>

/**
 * `feed.doc` v1 — the agent set up a document: the card shows it from now on and reads its title
 * by tRPC. The row carries no title: what the agent typed is checked only at the end of the turn
 * (Ст19), and a row of the feed is never rewritten.
 */
export const feedDocPayloadSchema = z.strictObject({ v: version, docId: id })
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
