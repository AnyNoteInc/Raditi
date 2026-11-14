import { z } from 'zod'

import { outboxFileNameSchema } from '../tasks/chat-files.ts'
import {
  docHeadingSchema,
  docIntentSchema,
  docSectionKeySchema,
  docSectionMarkdownSchema,
  pageTitleSchema,
} from './doc.ts'
import { pageLimits } from './limits.ts'
import { pageFilePathSchema } from './files.ts'
import { pagePathSchema, pageSegmentSchema } from './path.ts'

/**
 * The arguments of the `pages` tools of the mcp role (docs/plan/69-pages.md, Ст20), as the model
 * sends them. Strict objects: an unknown key is a refusal, not a guess.
 */

const id = z.uuid()

const version = z.number().int().min(0).max(1_000_000)

/**
 * `page_publish`: a page from a file of the outbox (Ст6) — a new site of one home page, a new
 * page of a site at a path (`treeId` and `path`, docs/plan/73-pages-sites.md, Дер12), or a new
 * version of `pageId` at the version the agent read (`expectedVersion`, Дер25) — or a finished
 * document (Ст7). Exactly one of the two shapes, and of a file one target at most.
 */
export const pagePublishArgumentsSchema = z.union([
  z
    .strictObject({
      file: outboxFileNameSchema,
      title: pageTitleSchema,
      pageId: id.optional(),
      expectedVersion: version.optional(),
      treeId: id.optional(),
      path: pagePathSchema.optional(),
    })
    .refine(
      (args) =>
        !(args.pageId !== undefined && (args.treeId !== undefined || args.path !== undefined)),
      'give pageId for a new version, or treeId with path for a new page of a site',
    )
    .refine(
      (args) => (args.treeId === undefined) === (args.path === undefined),
      'treeId and path go together',
    ),
  z.strictObject({ docId: id, title: pageTitleSchema.optional() }),
])
export type PagePublishArguments = z.infer<typeof pagePublishArgumentsSchema>

/** `page_list`: the sites of the workspace, by a word of a title, a page of them at a time. */
export const pageListArgumentsSchema = z.strictObject({
  query: z.string().max(200).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

/** `page_tree`: the pages of one site with their paths (Дер12). */
export const pageTreeArgumentsSchema = z.strictObject({ treeId: id })

/** `page_read`: the text of a page, a piece at a time (Дер26). */
export const pageReadArgumentsSchema = z.strictObject({
  pageId: id,
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(65_536).optional(),
})

/** `page_edit`: search and replace in the text of a page at the version the agent read (Дер23). */
export const pageEditArgumentsSchema = z.strictObject({
  pageId: id,
  expectedVersion: version,
  edits: z
    .array(
      z.strictObject({
        old: z.string().min(1).max(20_000),
        new: z.string().max(20_000),
        all: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
})

/** `page_update`: the title, the address (its segment), the place (its parent) or the order of a page. */
export const pageUpdateArgumentsSchema = z
  .strictObject({
    pageId: id,
    expectedVersion: version,
    title: pageTitleSchema.optional(),
    segment: pageSegmentSchema.optional(),
    parentId: id.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine(
    (args) =>
      args.title !== undefined ||
      args.segment !== undefined ||
      args.parentId !== undefined ||
      args.position !== undefined,
    'say what changes',
  )

/**
 * `page_delete`: pages to the trash at the client's own request in this chat (Дер27, rule 4):
 * `confirmedByClient` must be true, a page with pages below it needs `withChildren`.
 */
export const pageDeleteArgumentsSchema = z.strictObject({
  pageIds: z.array(id).min(1).max(20),
  withChildren: z.boolean().optional(),
  confirmedByClient: z.literal(true),
})

/** `page_file_put`: a file of the outbox as a shared file of a site (Дер34). */
export const pageFilePutArgumentsSchema = z.strictObject({
  treeId: id,
  file: outboxFileNameSchema,
  path: pageFilePathSchema,
})

/** `page_restore`: pages back from the trash. */
export const pageRestoreArgumentsSchema = z.strictObject({
  pageIds: z.array(id).min(1).max(20),
})

export const docCreateArgumentsSchema = z.strictObject({
  title: pageTitleSchema,
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
export const docFinishArgumentsSchema = z.strictObject({ docId: id })

/** The names of the tools as the role declares them (the model sees `raditi_<name>`). */
export const pagesToolNames = [
  'page_publish',
  'page_list',
  'page_tree',
  'page_read',
  'page_edit',
  'page_update',
  'page_delete',
  'page_restore',
  'page_file_put',
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
  page_tree: pageTreeArgumentsSchema,
  page_read: pageReadArgumentsSchema,
  page_edit: pageEditArgumentsSchema,
  page_update: pageUpdateArgumentsSchema,
  page_delete: pageDeleteArgumentsSchema,
  page_restore: pageRestoreArgumentsSchema,
  page_file_put: pageFilePutArgumentsSchema,
  doc_create: docCreateArgumentsSchema,
  doc_section_write: docSectionWriteArgumentsSchema,
  doc_section_remove: docSectionRemoveArgumentsSchema,
  doc_section_move: docSectionMoveArgumentsSchema,
  doc_read: docReadArgumentsSchema,
  doc_finish: docFinishArgumentsSchema,
} as const satisfies Record<PagesToolName, z.ZodType>
