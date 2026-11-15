import {
  outboxFileNameSchema,
  pageDeleteArgumentsSchema,
  pageEditArgumentsSchema,
  pageFilePathSchema,
  pageFileDeleteArgumentsSchema,
  pageFilePutArgumentsSchema,
  pageFilesArgumentsSchema,
  pageListArgumentsSchema,
  pagePathSchema,
  pagePublishArgumentsSchema,
  pageReadArgumentsSchema,
  pageRestoreArgumentsSchema,
  pageSegmentSchema,
  pageTitleSchema,
  pageTreeArgumentsSchema,
  pageUpdateArgumentsSchema,
} from '@repo/domain'
import { z } from 'zod'

/**
 * `page_publish` as the model's tool declares it (docs/plan/69-pages.md, Ст6, Ст7, Ст20;
 * docs/plan/73-pages-sites.md, Дер12, Дер25): one object — an MCP tool's input is an object —
 * with `file` or `docId`, never both; the domain's union is the rule.
 */
export const pagePublishToolArgumentsSchema = z
  .strictObject({
    file: outboxFileNameSchema
      .optional()
      .describe('A file you wrote to the outbox folder in this turn, e.g. price.html or report.md'),
    docId: z
      .uuid()
      .optional()
      .describe('A document of doc_create, to publish its finished version'),
    title: pageTitleSchema.optional().describe('The title of the page, one line'),
    pageId: z
      .uuid()
      .optional()
      .describe('A page of page_list or page_tree: its next version at the same address'),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('With pageId: the version you read; another one since — the publication waits'),
    treeId: z
      .uuid()
      .optional()
      .describe('A site of page_list, with path: a new page of that site, under a page it has'),
    path: pagePathSchema
      .optional()
      .describe('With treeId: the address of the new page in its site, e.g. /uslugi/remont'),
  })
  .refine((args) => pagePublishArgumentsSchema.safeParse(args).success, {
    message:
      'give either file with title (and pageId for a new version, or treeId with path for a new page of a site) or docId',
  })
export type PagePublishToolArguments = z.infer<typeof pagePublishToolArgumentsSchema>

const id = z.uuid()

export const pageListToolArgumentsSchema = z.strictObject({
  query: z.string().max(200).optional().describe('A word of the title of a site to look for'),
  offset: z.number().int().min(0).max(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const pageTreeToolArgumentsSchema = z.strictObject({
  treeId: id.describe('A site of page_list'),
})

export const pageReadToolArgumentsSchema = z.strictObject({
  pageId: id.describe('A page of page_tree'),
  offset: z.number().int().min(0).optional().describe('Where to go on reading, of nextOffset'),
  limit: z.number().int().min(1).max(65_536).optional(),
})

export const pageEditToolArgumentsSchema = z.strictObject({
  pageId: id,
  expectedVersion: z.number().int().min(0).describe('The version page_read gave you'),
  edits: z
    .array(
      z.strictObject({
        old: z.string().min(1).max(20_000).describe('Text of the page, found exactly once'),
        new: z.string().max(20_000).describe('What it becomes'),
        all: z.boolean().optional().describe('Replace every time it is found'),
      }),
    )
    .min(1)
    .max(20),
})

export const pageUpdateToolArgumentsSchema = z
  .strictObject({
    pageId: id,
    expectedVersion: z.number().int().min(0).describe('The version page_tree gave you'),
    title: pageTitleSchema.optional().describe('The new title'),
    segment: pageSegmentSchema
      .optional()
      .describe('The new last part of its address: lower-case Latin letters, digits, hyphens'),
    parentId: id.optional().describe('A page of the same site to put it under'),
    position: z.number().int().min(0).max(1000).optional().describe('Its order among its siblings'),
  })
  .refine((args) => pageUpdateArgumentsSchema.safeParse(args).success, {
    message: 'say what changes: title, segment, parentId or position',
  })

export const pageDeleteToolArgumentsSchema = z.strictObject({
  pageIds: z.array(id).min(1).max(20),
  withChildren: z
    .boolean()
    .optional()
    .describe('Also the pages below them; a home page takes its whole site'),
  confirmedByClient: z
    .literal(true)
    .describe('The client asked in this chat, in their own words, to delete these pages'),
})

export const pageFilePutToolArgumentsSchema = z.strictObject({
  treeId: id.describe('A site of page_list'),
  file: outboxFileNameSchema.describe('A file you wrote to the outbox folder in this turn'),
  path: pageFilePathSchema.describe(
    'Where its pages load it from, e.g. /_files/style.css or /_files/img/logo.png',
  ),
})

export const pageFileDeleteToolArgumentsSchema = z.strictObject({
  treeId: id.describe('A site of page_list'),
  path: pageFilePathSchema.describe('A shared file of page_files, e.g. /_files/old.css'),
  confirmedByClient: z
    .literal(true)
    .describe('The client asked in this chat, in their own words, to delete this file'),
})

export const pageFilesToolArgumentsSchema = z.strictObject({
  treeId: id.describe('A site of page_list'),
})

export const pageRestoreToolArgumentsSchema = z.strictObject({
  pageIds: z.array(id).min(1).max(20),
})

// The domain's own rules, for the body check of the role (mcp-policy).
export {
  pageDeleteArgumentsSchema,
  pageEditArgumentsSchema,
  pageFileDeleteArgumentsSchema,
  pageFilePutArgumentsSchema,
  pageFilesArgumentsSchema,
  pageListArgumentsSchema,
  pageReadArgumentsSchema,
  pageRestoreArgumentsSchema,
  pageTreeArgumentsSchema,
  pageUpdateArgumentsSchema,
}
