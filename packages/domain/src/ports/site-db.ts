import { z } from 'zod'

import {
  DB_CREATED_ID_BASE,
  DB_CREATED_ID_MAX,
  dbObjectRefSchema,
  dbSlugSchema,
  type DbObjectState,
  type DbTableState,
  type TableDefinition,
} from '../release/db-objects.ts'
import { dbOperationKinds } from '../release/db-plan.ts'
import {
  contentHashSchema,
  contentNoWriteProofSchema,
  contentOperationRefSchema,
  contentTimeLeftSchema,
  contentWriteProofSchema,
  publishedObjectRefSchema,
  type ContentWriteOutcome,
  type PublishedContentGateway,
} from './published-content.ts'

// The objects of a database plan on a site (docs/plan/53-chat-preview-release.md, «Операции БД и
// миграции»), through the same plugin and the same rules as published content: the fence of an
// epoch, the time left of a deadline, a receipt per call, a precondition by state hash, the modes
// `edit`, `restore` and `release`. A stack without them has no `db` on its gateway.

/**
 * What the plugin of a site can write here, with the rights of the user it was connected with
 * (`GET /raditi/v1/capabilities`). A plugin before version 2 has no such route: it writes the
 * text of records alone (`legacySiteDbCapabilities`).
 */
export const siteDbCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('capabilities'),
  /** The version of the plugin. */
  plugin: z.number().int().min(1).max(1000),
  operations: z.array(z.enum(dbOperationKinds)).max(dbOperationKinds.length),
  /** The settings (names in the database) the plugin reads and writes. */
  settings: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64),
  /**
   * The highest id of a record of the site. A site whose ids reach DB_CREATED_ID_BASE gets no
   * created records: their ids would not be told from its own.
   */
  maxRecordId: z.number().int().min(0).max(DB_CREATED_ID_MAX),
  /**
   * A preview's plugin only: the lowest free id at or above the base. The preview runs the
   * agent's code, so the platform takes it as a floor, never as the id itself.
   */
  nextCreatedId: z.number().int().min(DB_CREATED_ID_BASE).max(DB_CREATED_ID_MAX).optional(),
})
export type SiteDbCapabilities = z.infer<typeof siteDbCapabilitiesSchema>
export const legacySiteDbCapabilities: Readonly<SiteDbCapabilities> = Object.freeze({
  version: 1 as const,
  kind: 'capabilities' as const,
  plugin: 1,
  operations: ['content_update' as const],
  settings: [],
  maxRecordId: 0,
})

/** A record a plan creates: what production stores of it, the address and the status as well. */
export const dbCreatedRecordSchema = z.strictObject({
  status: z.enum(['publish', 'draft']),
  slug: dbSlugSchema,
  title: z.string().min(1).max(32768),
  content: z.string().max(32768),
  excerpt: z.string().max(32768),
})
export type DbCreatedRecord = z.infer<typeof dbCreatedRecordSchema>

/** What one write of an object of a plan changes. */
export type DbWriteChange =
  /** The value of a setting, as the database keeps it; null — no row (a `restore` alone). */
  | { kind: 'option_update'; value: string | null }
  /**
   * A new record. `createCallId` is the mark the plugin keeps with it (the call that created it
   * in the journal): only a record of that mark is ever taken out again. Into a preview the
   * record gets the id of `objectRef`; on production the plugin gives it its own and says which
   * (`createdRef` of the receipt).
   */
  | { kind: 'post_create'; record: DbCreatedRecord; createCallId: string }
  /**
   * The record created with `createCallId` goes to the trash, at its address and nowhere else —
   * and only while nothing of the site stands on it (comments, pages below it, menu items).
   */
  | { kind: 'post_trash'; expectedSlug: string; createCallId: string }
  /**
   * The record of `createCallId` that a `post_trash` took to the trash comes back as it was, at
   * the address it had (`restore` alone): the rollback of an undo (docs/plan/53, «Отмена выпуска»).
   */
  | { kind: 'post_untrash'; expectedSlug: string; createCallId: string }
  /**
   * The table goes from `before` (the state of `expectedStateHash`, said whole: the plugin finds
   * where a repeated call left it) to this definition; null — it is taken away (a preview alone).
   */
  | {
      kind: 'schema_migration'
      before: Pick<DbTableState, 'exists' | 'managed' | 'definition'>
      definition: TableDefinition | null
    }

export interface DbWriteRequest {
  callId: string
  siteId: string
  epoch: number
  requestHash: string
  objectRef: string
  expectedStateHash: string
  deadlineAt: number
  /** See `contentTimeLeftSchema`. */
  ttlMs: number
  /** As for published content (`ContentWriteRequest.mode`). */
  mode: 'edit' | 'restore' | 'release'
  change: DbWriteChange
}

/** The receipt of a write of an object of a plan. */
export const dbWriteProofSchema = contentWriteProofSchema.extend({
  objectRef: dbObjectRefSchema,
  /** A creation on production: the reference the record got there; its state hash is under it. */
  createdRef: publishedObjectRefSchema.optional(),
  stateHash: contentHashSchema,
})
export type DbWriteProof = z.infer<typeof dbWriteProofSchema>
/** The identity of a write of an object of a plan, as it was sent, and the time it has left. */
export const dbOperationRefSchema = contentOperationRefSchema.extend({
  objectRef: dbObjectRefSchema,
  ttlMs: contentTimeLeftSchema,
})
export type DbOperationRequest = z.infer<typeof dbOperationRefSchema>
/**
 * What a reconcile of such a write says: its receipt, a proof it never landed, or nothing. A
 * table is changed by statements no transaction holds: its plugin never proves a write did not
 * land — its state says what it holds.
 */
export const dbRecoveryOutcomeSchema = z.union([
  dbWriteProofSchema,
  contentNoWriteProofSchema.extend({ objectRef: dbObjectRefSchema }),
  z.strictObject({ version: z.literal(1), kind: z.literal('unknown') }),
])
export type DbRecoveryOutcome = z.infer<typeof dbRecoveryOutcomeSchema>
export type DbWriteOutcome =
  | DbWriteProof
  | Exclude<ContentWriteOutcome, { kind: 'committed' }>
  | { version: 1; kind: 'rejected'; code: 'invalid'; reason: 'slug' | 'unsupported' }
  /**
   * The precondition holds no longer: `dependents` — records of the site stand on the record
   * a trash would take; `slug` — its address is taken (an untrash).
   */
  | { version: 1; kind: 'rejected'; code: 'conflict'; reason: 'dependents' | 'slug' }

export interface SiteDbGateway {
  capabilities(): Promise<SiteDbCapabilities>
  /**
   * The state of an object: a record (published, or a draft the platform created), a record that
   * is not there (absent), a setting of the list, a table of the platform.
   */
  readObject(objectRef: string): Promise<DbObjectState>
  /** Whether a record of `type` at this address would collide with one of the site. */
  slugTaken(type: string, slug: string): Promise<boolean>
  /**
   * How many records of the site stand on a record — its comments of any status, records below
   * it, menu items that open it: a record the platform created is taken to the trash only
   * without them, whose trash would take them along (docs/plan/53, «Отмена выпуска»).
   */
  dependents(objectRef: string): Promise<number>
  writeObject(request: DbWriteRequest): Promise<DbWriteOutcome>
  /**
   * The receipt of a write by its call id — a creation's names the record production made; null
   * is absence of evidence, never proof that a delayed write cannot still commit.
   */
  operation(callId: string): Promise<DbWriteProof | null>
  /** Reconcile a write after its deadline; absence alone is never a negative proof. */
  reconcile(request: DbOperationRequest): Promise<DbRecoveryOutcome>
  /**
   * Moves the fence of the plugin to `epoch` when it is lower; writes nothing else. After it no
   * write of an earlier epoch can still commit, whatever its time left.
   */
  fence(input: { siteId: string; epoch: number }): Promise<void>
}

/**
 * The gateway of a stack's plugin: published content, and through the same plugin the settings,
 * created records and tables of a database plan (`db`); a stack whose plugin has none has no
 * such property.
 */
export type SiteContentGateway = PublishedContentGateway & { readonly db?: SiteDbGateway }
