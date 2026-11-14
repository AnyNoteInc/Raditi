import { z } from 'zod'

import { outboxFileNameSchema } from '../tasks/chat-files.ts'
import {
  docHeadingSchema,
  docIntentSchema,
  docSectionKeySchema,
  docSectionMarkdownSchema,
  docViewSchema,
  pageTitleSchema,
} from './doc.ts'
import { pageLimits } from './limits.ts'

/**
 * The arguments of the `pages` tools of the mcp role (docs/plan/69-pages.md, Ст20), as the model
 * sends them. Strict objects: an unknown key is a refusal, not a guess.
 */

const id = z.uuid()

/**
 * `page_publish`: a page from a file of the outbox (Ст6) — new, or a new version of `pageId` —
 * or a finished document (Ст7). Exactly one of the two shapes.
 */
export const pagePublishArgumentsSchema = z.union([
  z.strictObject({ file: outboxFileNameSchema, title: pageTitleSchema, pageId: id.optional() }),
  z.strictObject({ docId: id, title: pageTitleSchema.optional() }),
])
export type PagePublishArguments = z.infer<typeof pagePublishArgumentsSchema>

export const pageListArgumentsSchema = z.strictObject({})

export const docCreateArgumentsSchema = z.strictObject({
  title: pageTitleSchema,
  view: docViewSchema,
  sections: z
    .array(z.strictObject({ id: docSectionKeySchema, intent: docIntentSchema }))
    .min(1)
    .max(pageLimits.docSections)
    .refine(
      (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
      'section ids must be unique',
    ),
})
export type DocCreateArguments = z.infer<typeof docCreateArgumentsSchema>

/** Writes a section whole; with `after` — a new section after that one (`null` — the first). */
export const docSectionWriteArgumentsSchema = z.strictObject({
  docId: id,
  id: docSectionKeySchema,
  heading: docHeadingSchema,
  markdown: docSectionMarkdownSchema,
  after: docSectionKeySchema.nullable().optional(),
})
export type DocSectionWriteArguments = z.infer<typeof docSectionWriteArgumentsSchema>

export const docSectionRemoveArgumentsSchema = z.strictObject({
  docId: id,
  id: docSectionKeySchema,
})

/** Puts a section after another one, `null` — first. */
export const docSectionMoveArgumentsSchema = z.strictObject({
  docId: id,
  id: docSectionKeySchema,
  after: docSectionKeySchema.nullable(),
})

export const docReadArgumentsSchema = z.strictObject({ docId: id })
/** `view` changes how the finished document is shown (docs/plan/74, Д1); absent — as it was. */
export const docFinishArgumentsSchema = z.strictObject({
  docId: id,
  view: docViewSchema.optional(),
})
export type DocFinishArguments = z.infer<typeof docFinishArgumentsSchema>

/** The names of the tools as the role declares them (the model sees `raditi_<name>`). */
export const pagesToolNames = [
  'page_publish',
  'page_list',
  'doc_create',
  'doc_section_write',
  'doc_section_remove',
  'doc_section_move',
  'doc_read',
  'doc_finish',
] as const
export type PagesToolName = (typeof pagesToolNames)[number]

export const pagesToolArgumentSchemas = {
  page_publish: pagePublishArgumentsSchema,
  page_list: pageListArgumentsSchema,
  doc_create: docCreateArgumentsSchema,
  doc_section_write: docSectionWriteArgumentsSchema,
  doc_section_remove: docSectionRemoveArgumentsSchema,
  doc_section_move: docSectionMoveArgumentsSchema,
  doc_read: docReadArgumentsSchema,
  doc_finish: docFinishArgumentsSchema,
} as const satisfies Record<PagesToolName, z.ZodType>
