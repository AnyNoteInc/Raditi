import {
  dbOperationKinds,
  isPublicationPath,
  previewImageSchema,
  previewRuntimeMatchSchema,
  siteDatabaseSettingsSchema,
  type SiteDatabaseSettings,
} from '@repo/domain'
import { z } from 'zod'

// What core keeps of a built preview in `preview_environments.runtime` (docs/plan/53, R5c): never
// a secret, at most 8 KiB (CHECK preview_environments_runtime_check). The database settings the
// seed was copied with — a rebuild reuses them instead of asking the site's catalog again — the
// web image, whether the seed was compared with production (Р15; the objects that differed are
// rows of `preview_seed_mismatches`), and what syncs of the running turn wrote over the files of
// the revision (Р23).

/** The bytes of synced paths a record keeps; past them a rebuild writes the whole tree. */
export const SYNC_PATHS_BYTES = 6 * 1024

const syncSchema = z.strictObject({
  /** The open assignment of the turn whose working tree was written. */
  assignmentId: z.uuid(),
  /** The commit the files were brought to before the first sync of the turn. */
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** What syncs wrote or removed over it; null — more than a record keeps. */
  paths: z.array(z.string().refine(isPublicationPath)).nullable(),
})
export type PreviewSyncRecord = z.infer<typeof syncSchema>

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
/** A preview of a build before these kinds, or whose production could not be asked. */
export const textOnlyDbRuntime: PreviewDbRuntime = Object.freeze({
  kinds: ['content_update' as const],
  settings: [],
  createdIds: false,
})

export const previewRecordSchema = z.strictObject({
  v: z.literal(1),
  /** The settings of the production database the seed was copied with; null — no copy yet. */
  database: siteDatabaseSettingsSchema.nullable(),
  web: previewImageSchema.nullable(),
  /**
   * The seed was compared with production object by object (Р15) and the differing ones are in
   * `preview_seed_mismatches`; false — not yet, or production could not be asked: then every
   * object of the copy is there, and the next build asks again.
   */
  seedChecked: z.boolean(),
  sync: syncSchema.nullable(),
  /**
   * How the preview's runtime stands to the site's (Р2, Р18): the version the site's server
   * runs, the one of the preview, the extensions it lacks; null or absent — the site's could not
   * be read at the last build.
   */
  runtimeMatch: previewRuntimeMatchSchema.nullable().optional(),
  /** Absent — a record of a build before the kinds of a plan: the text of records alone. */
  db: previewDbRuntimeSchema.optional(),
})
export type PreviewRecord = z.infer<typeof previewRecordSchema>

export const emptyPreviewRecord = (): PreviewRecord => ({
  v: 1,
  database: null,
  web: null,
  seedChecked: false,
  sync: null,
})

/** The record of a row; a row of another shape (or none) reads as empty. */
export function previewRecordOf(value: unknown): PreviewRecord {
  const parsed = previewRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyPreviewRecord()
}

/**
 * The paths a sync adds to those written before in the same turn; null once they no longer fit
 * a record (a rebuild then writes the whole tree).
 */
export function withSyncedPaths(
  known: readonly string[] | null,
  added: Iterable<string>,
): string[] | null {
  if (known === null) return null
  const paths = [...new Set([...known, ...added])].sort()
  const bytes = paths.reduce((sum, path) => sum + Buffer.byteLength(path) + 3, 0)
  return bytes > SYNC_PATHS_BYTES ? null : paths
}

export type { SiteDatabaseSettings }
