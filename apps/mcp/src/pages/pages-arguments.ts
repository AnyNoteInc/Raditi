import {
  outboxFileNameSchema,
  pageListArgumentsSchema,
  pagePublishArgumentsSchema,
  pageTitleSchema,
} from '@repo/domain'
import { z } from 'zod'

/**
 * `page_publish` as the model's tool declares it (docs/plan/69-pages.md, Ст6, Ст7, Ст20): one
 * object — an MCP tool's input is an object — with `file` or `docId`, never both; the domain's
 * union is the rule.
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
      .describe('A page of page_list: its next version at the same address'),
  })
  .refine((args) => pagePublishArgumentsSchema.safeParse(args).success, {
    message: 'give either file with title (and pageId for a new version) or docId',
  })
export type PagePublishToolArguments = z.infer<typeof pagePublishToolArgumentsSchema>

export { pageListArgumentsSchema }
