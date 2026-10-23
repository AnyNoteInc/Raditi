import {
  dbColumnSchema,
  dbIndexSchema,
  dbSlugSchema,
  dbTableRefSchema,
  publishedContentPatchSchema,
} from '@repo/domain'
import { z } from 'zod'

import { isOneLine } from '../common/one-line.ts'

/**
 * The arguments of the content tools (wp_rest, restore, db_schema): what tools/list shows of each
 * and the exact calls it admits. A leaf beside the content service — zod, the domain and one
 * helper of common — so the request policy checks a call without loading the service.
 */

/** The caller's key for one distinct change; the tools and the journal share this rule. */
export const mcpIdempotencyKeySchema = z.string().min(1).max(200).refine(isOneLine)
const idempotencyKey = mcpIdempotencyKeySchema
const recordRoute = z.string().regex(/^\/wp\/v2\/(posts|pages)\/[1-9][0-9]{0,9}$/)
const collectionRoute = z.string().regex(/^\/wp\/v2\/(posts|pages)$/)
const settingsRoute = z.literal('/wp/v2/settings')
/** A new record (docs/plan/53, «Операции БД и миграции»): a title, an address, a status. */
export const createBody = z.strictObject({
  title: z.string().min(1).max(32768),
  content: z.string().max(32768).optional(),
  excerpt: z.string().max(32768).optional(),
  slug: dbSlugSchema,
  status: z.enum(['publish', 'draft']),
})
/** One setting of the list by the name the agent knows (`/wp/v2/settings`): a text or a number. */
const settingBody = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([z.string().max(4096), z.int()]))
  .refine((body) => Object.keys(body).length === 1, 'one setting')
export const wpRestCallSchema = z.union([
  z.strictObject({ method: z.literal('GET'), route: recordRoute }),
  z.strictObject({
    method: z.literal('POST'),
    route: recordRoute,
    body: publishedContentPatchSchema,
    idempotencyKey,
  }),
  z.strictObject({
    method: z.literal('POST'),
    route: collectionRoute,
    body: createBody,
    idempotencyKey,
  }),
  z.strictObject({ method: z.literal('GET'), route: settingsRoute }),
  z.strictObject({
    method: z.literal('POST'),
    route: settingsRoute,
    body: settingBody,
    idempotencyKey,
  }),
])
/**
 * MCP advertises a tool's input only as a JSON object schema, and clients refuse a tool list
 * with any tool lacking one. The flat object is what tools/list shows; the refinement keeps
 * the exact GET/POST combinations.
 */
export const wpRestArgumentsSchema = z
  .strictObject({
    method: z.enum(['GET', 'POST']).describe('GET reads, POST changes or creates'),
    route: z
      .string()
      .max(64)
      .describe('/wp/v2/posts/ID, /wp/v2/pages/ID, /wp/v2/posts, /wp/v2/pages or /wp/v2/settings'),
    body: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([z.string().max(32768), z.int()]))
      .optional()
      .describe(
        'POST only: title, content or excerpt of a record; title, content, excerpt, slug and status of a new one; one setting',
      ),
    idempotencyKey: idempotencyKey
      .optional()
      .describe('POST only: a new key for every distinct change'),
  })
  .superRefine((value, context) => {
    if (!wpRestCallSchema.safeParse(value).success)
      context.addIssue({ code: 'custom', message: 'Invalid wp_rest arguments' })
  })
export const restoreArgumentsSchema = z.strictObject({ snapshotId: z.uuid(), idempotencyKey })
export type WpRestArguments = z.infer<typeof wpRestArgumentsSchema>
export type RestoreArguments = z.infer<typeof restoreArgumentsSchema>

export const tableName = dbTableRefSchema.transform((ref) => ref.slice('table:'.length))
const tableArguments = z.strictObject({
  columns: z.array(dbColumnSchema).max(31).optional(),
  indexes: z.array(dbIndexSchema).max(8).optional(),
})
export const dbSchemaCallSchema = z.union([
  z.strictObject({ method: z.literal('GET'), table: z.string() }),
  z.strictObject({
    method: z.literal('POST'),
    table: z.string(),
    create: tableArguments,
    idempotencyKey,
  }),
  z.strictObject({
    method: z.literal('POST'),
    table: z.string(),
    add: tableArguments,
    idempotencyKey,
  }),
])
/** `db_schema`: a table of the platform read, created, or extended by the dictionary. */
export const dbSchemaArgumentsSchema = z
  .strictObject({
    method: z.enum(['GET', 'POST']).describe('GET reads the table, POST creates or extends it'),
    table: z
      .string()
      .max(30)
      .describe('The name of the table without any prefix: lower-case letters, digits, _'),
    create: tableArguments
      .optional()
      .describe('POST only: the columns and indexes of a new table (an id column is implicit)'),
    add: tableArguments
      .optional()
      .describe('POST only: columns and non-unique indexes added to a table of the platform'),
    idempotencyKey: idempotencyKey
      .optional()
      .describe('POST only: a new key for every distinct change'),
  })
  .superRefine((value, context) => {
    if (!dbSchemaCallSchema.safeParse(value).success)
      context.addIssue({ code: 'custom', message: 'Invalid db_schema arguments' })
  })
export type DbSchemaArguments = z.infer<typeof dbSchemaArgumentsSchema>
