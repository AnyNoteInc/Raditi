import { dbOperationKinds } from '@repo/domain'
import { z } from 'zod'

// What the agent may change in the database of a dialog's preview: core writes it into the record
// of a build (`preview_environments.runtime.db`, docs/plan/53, R5c), the mcp role reads it there
// before it lets a write of a plan through.

/**
 * What the agent may change in the database of this preview (docs/plan/53, «Операции БД и
 * миграции»): the kinds the stack's adapter, production's plugin and the preview's plugin all
 * have, the settings (names in the database) of the list both plugins keep, and whether records
 * may be created — production's ids are below DB_CREATED_ID_BASE. Read at every build.
 */
export const previewDbRuntimeSchema = z.strictObject({
  kinds: z.array(z.enum(dbOperationKinds)).max(dbOperationKinds.length),
  settings: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64),
  createdIds: z.boolean(),
})
export type PreviewDbRuntime = z.infer<typeof previewDbRuntimeSchema>
/**
 * A preview of a build before these kinds, or of a site whose production has a gateway that did
 * not answer now (docs/plan/62-site-stacks.md, Т37): the text of records, as before.
 */
export const textOnlyDbRuntime: PreviewDbRuntime = Object.freeze({
  kinds: ['content_update' as const],
  settings: [],
  createdIds: false,
})
/** A preview no release can carry a change of: production or the preview has no gateway. */
export const noDbRuntime: PreviewDbRuntime = Object.freeze({
  kinds: [],
  settings: [],
  createdIds: false,
})
