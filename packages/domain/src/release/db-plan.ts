import { z } from 'zod'

import { conflict, DomainError } from '../errors.ts'
import {
  dbOptionRefSchema,
  dbRecordRefSchema,
  dbTableRefSchema,
  isCreatedRef,
  isOptionRef,
  isRecordRef,
  isTableRef,
} from './db-objects.ts'

/**
 * The database plan of a candidate (docs/plan/53-chat-preview-release.md, Р3, Р22, Р30, Р31,
 * «Операции БД и миграции»): what the agent changed in the preview's database, as operations the
 * release replays on production with a precondition and undoes with their inverse. Four kinds:
 *
 * - `content_update` — the title, the text or the excerpt of an existing record of the site;
 * - `option_update` — one setting from the closed list of the stack (`SiteAdapter.dbSettings`);
 * - `post_create` — a new record (`isCreatedRef`): production gives it its own id;
 * - `schema_migration` — a table of the platform created, or columns and indexes added to one.
 *
 * Nothing removes: the journal of a preview knows `post_trash` besides them, and only to take a
 * record of the same plan out again — no plan ever holds it. Values are not in the plan: each
 * side of an operation is a reference to an encrypted object of the artifacts bucket, the state
 * of the object before and after (an absent record or table is a state too).
 */
export const dbOperationKinds = [
  'content_update',
  'option_update',
  'post_create',
  'schema_migration',
] as const
export type DbOperationKind = (typeof dbOperationKinds)[number]
/** What a row of the journal of a preview may be: the kinds of a plan and the undo of a creation. */
export const dbJournalKinds = [...dbOperationKinds, 'post_trash'] as const
export type DbJournalKind = (typeof dbJournalKinds)[number]

/**
 * The one order of a plan, kind by kind (and in each kind by the first write of its object):
 * the structure first, then the settings, the new records, the texts. A preview is rebuilt and
 * a release writes in this order; a release returns in the reverse one.
 */
export const dbPlanOrder: readonly DbOperationKind[] = Object.freeze([
  'schema_migration',
  'option_update',
  'post_create',
  'content_update',
])

/** The fields `content_update` may change. */
export const dbContentFields = ['title', 'content', 'excerpt'] as const
export type DbContentField = (typeof dbContentFields)[number]

/** The fields each kind of a journal row other than `content_update` names, in their one order. */
export const dbKindFields: Readonly<
  Record<Exclude<DbJournalKind, 'content_update'>, readonly string[]>
> = Object.freeze({
  option_update: ['value'],
  post_create: [...dbContentFields],
  post_trash: [],
  schema_migration: ['definition'],
})

export const dbPlanLimits = Object.freeze({
  /** Objects of one plan: above twenty a change is a bulk edit (CLAUDE.md rule 4). */
  operations: 200,
  objectRef: 128,
  objectKey: 1024,
  /** One side of an operation (spec §11: snapshots up to 32 KiB). */
  valueBytes: 32 * 1024,
  /** Tables one plan creates or extends. */
  tables: 8,
})

const stateHash = z.string().regex(/^[0-9a-f]{64}$/)
const objectKey = z
  .string()
  .min(1)
  .max(dbPlanLimits.objectKey)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((key) => key.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))

/** One side of an operation: the encrypted value in `raditi-artifacts`. */
export const dbValueRefSchema = z.strictObject({
  key: objectKey,
  /** Of the encrypted object, as the platform stored it. */
  sha256: stateHash,
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(dbPlanLimits.valueBytes * 2),
})
export type DbValueRef = z.infer<typeof dbValueRefSchema>

const contentFieldList = z
  .array(z.enum(dbContentFields))
  .min(1)
  .max(dbContentFields.length)
  .refine((list) => new Set(list).size === list.length, 'each field once')
/** Exactly the fields of a kind, in their order. */
const fixedFields = <const Field extends string>(list: readonly Field[]) =>
  z
    .array(z.enum(list.length ? (list as [Field, ...Field[]]) : (['-'] as unknown as [Field])))
    .refine((given) => JSON.stringify(given) === JSON.stringify(list), 'the fields of the kind')

/** A record that is not one a plan created: production holds it under this very reference. */
const existingRecordRef = dbRecordRefSchema.refine((ref) => !isCreatedRef(ref), 'a created record')
const createdRecordRef = dbRecordRefSchema.refine(isCreatedRef, 'a record a plan created')
const sides = {
  /** The state hash of the object before: the precondition on production. */
  beforeHash: stateHash,
  /** The state hash the write leaves; the receipt of the plugin must repeat it. */
  afterHash: stateHash,
  before: dbValueRefSchema,
  after: dbValueRefSchema,
}

export const dbContentUpdateSchema = z.strictObject({
  kind: z.literal('content_update'),
  objectRef: existingRecordRef,
  fields: contentFieldList,
  ...sides,
})
export type DbContentUpdate = z.infer<typeof dbContentUpdateSchema>
const optionUpdate = z.strictObject({
  kind: z.literal('option_update'),
  objectRef: dbOptionRefSchema,
  fields: fixedFields(['value']),
  ...sides,
})
/** `before` holds the absent state of the record: one shape for every kind. */
const postCreate = z.strictObject({
  kind: z.literal('post_create'),
  objectRef: createdRecordRef,
  fields: fixedFields(dbContentFields),
  ...sides,
})
const schemaMigration = z.strictObject({
  kind: z.literal('schema_migration'),
  objectRef: dbTableRefSchema,
  fields: fixedFields(['definition']),
  ...sides,
})
const postTrash = z.strictObject({
  kind: z.literal('post_trash'),
  objectRef: createdRecordRef,
  fields: z.array(z.string()).length(0),
  ...sides,
})

export const dbOperationSchema = z.discriminatedUnion('kind', [
  dbContentUpdateSchema,
  optionUpdate,
  postCreate,
  schemaMigration,
])
export type DbOperation = z.infer<typeof dbOperationSchema>
/**
 * A row of the journal of a preview: an operation of a plan, or the trash of a created record.
 * A text change may name a record the plan created: compaction folds it into the creation.
 */
export const dbJournalOperationSchema = z.discriminatedUnion('kind', [
  dbContentUpdateSchema.extend({ objectRef: dbRecordRefSchema }),
  optionUpdate,
  postCreate,
  schemaMigration,
  postTrash,
])
export type DbJournalOperation = z.infer<typeof dbJournalOperationSchema>

/** The compacted plan of a candidate: one operation per object, in the one order. */
export const dbPlanSchema = z
  .array(dbOperationSchema)
  .max(dbPlanLimits.operations)
  .refine(
    (plan) => new Set(plan.map((operation) => operation.objectRef)).size === plan.length,
    'one operation per object',
  )
  .refine(
    (plan) =>
      plan.every(
        (operation, at) =>
          at === 0 ||
          dbPlanOrder.indexOf(plan[at - 1]!.kind) <= dbPlanOrder.indexOf(operation.kind),
      ),
    'operations in the one order of a plan',
  )
  .refine(
    (plan) =>
      plan.filter((operation) => operation.kind === 'schema_migration').length <=
      dbPlanLimits.tables,
    'too many tables',
  )
export type DbPlan = z.infer<typeof dbPlanSchema>

/** A row of `preview_db_operations` in the order it was written. */
export interface DbPlanEntry {
  operation: DbJournalOperation
  /** Written by a turn that failed or was cancelled: the rebuild left it out of the preview. */
  excluded: boolean
}

/**
 * The fields in their one order (title, content, excerpt), each once: what a plan and the
 * journal store (`preview_db_operations.fields` accepts only this order).
 */
export const orderDbContentFields = (list: Iterable<DbContentField>): DbContentField[] => {
  const set = new Set(list)
  return dbContentFields.filter((field) => set.has(field))
}

/**
 * A row of `preview_db_operations` as the database keeps it: each side of the operation is its
 * object key, the SHA-256 and the size of the encrypted object.
 */
export interface DbJournalRow {
  kind: string
  objectRef: string
  fields: readonly string[]
  beforeHash: string
  afterHash: string
  beforeObjectKey: string
  beforeSha256: string
  beforeBytes: number
  afterObjectKey: string
  afterSha256: string
  afterBytes: number
  excluded: boolean
}

/**
 * The entry of the plan a journal row stands for. A row that is not an operation — a kind,
 * a field or a reference the plan does not take — is a conflict, never a guess.
 */
export function dbPlanEntryFromJournal(row: DbJournalRow): DbPlanEntry {
  const parsed = dbJournalOperationSchema.safeParse({
    kind: row.kind,
    objectRef: row.objectRef,
    fields: [...row.fields],
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    before: { key: row.beforeObjectKey, sha256: row.beforeSha256, sizeBytes: row.beforeBytes },
    after: { key: row.afterObjectKey, sha256: row.afterSha256, sizeBytes: row.afterBytes },
  })
  if (!parsed.success) throw conflict('A row of the database journal is not an operation of a plan')
  return { operation: parsed.data, excluded: row.excluded }
}

/** What the chain of one object's writes became: its first `before`, its last `after`. */
interface Chain {
  first: DbJournalOperation
  last: DbJournalOperation
  kinds: Set<DbJournalKind>
  fields: Set<DbContentField>
  /** Where the object's first write stands in the journal. */
  position: number
}

/**
 * The compacted operation of a chain, its kind told by its ends: a record created then taken
 * out drops; a created record stays a creation with every later write folded into it; an existing
 * record stays a text change; a setting and a table are what they are. A chain that leaves a
 * record without a creation, or creates one that existed, is a conflict: nothing removes.
 */
function compacted(objectRef: string, chain: Chain): DbOperation | null {
  const { first, last, kinds } = chain
  const ends = {
    objectRef,
    beforeHash: first.beforeHash,
    afterHash: last.afterHash,
    before: first.before,
    after: last.after,
  }
  if (isCreatedRef(objectRef)) {
    if (first.kind !== 'post_create')
      throw conflict(`Database plan holds a created record without its creation: ${objectRef}`)
    if (last.kind === 'post_trash') return null
    return { kind: 'post_create', fields: [...dbContentFields], ...ends }
  }
  const only = (kind: DbJournalKind) => [...kinds].every((given) => given === kind)
  if (isRecordRef(objectRef) && only('content_update'))
    return ends.beforeHash === ends.afterHash
      ? null
      : { kind: 'content_update', fields: orderDbContentFields(chain.fields), ...ends }
  if (isOptionRef(objectRef) && only('option_update'))
    return ends.beforeHash === ends.afterHash
      ? null
      : { kind: 'option_update', fields: ['value'], ...ends }
  if (isTableRef(objectRef) && only('schema_migration'))
    return ends.beforeHash === ends.afterHash
      ? null
      : { kind: 'schema_migration', fields: ['definition'], ...ends }
  throw conflict(`Database plan mixes kinds at ${objectRef}`)
}

/**
 * The plan of a candidate from the journal of its preview: per object the first `before` and
 * the last `after`, the fields of every write; excluded rows are left out; an object written
 * back to where it started drops out. Throws when the writes of an object do not chain — the
 * preview was changed in between, and nothing built on that is released. The result is in the
 * one order of a plan (`dbPlanOrder`).
 */
export function compactDbPlan(entries: readonly DbPlanEntry[]): DbPlan {
  const chains = new Map<string, Chain>()
  entries.forEach((entry, position) => {
    if (entry.excluded) return
    const operation = entry.operation
    const chain = chains.get(operation.objectRef)
    const contentFields = operation.kind === 'content_update' ? operation.fields : []
    if (chain === undefined) {
      chains.set(operation.objectRef, {
        first: operation,
        last: operation,
        kinds: new Set([operation.kind]),
        fields: new Set(contentFields),
        position,
      })
      return
    }
    if (chain.last.afterHash !== operation.beforeHash)
      throw conflict(`Database plan does not chain at ${operation.objectRef}`)
    // A creation opens a chain, a trash closes one: neither stands anywhere else in it.
    if (operation.kind === 'post_create' || chain.last.kind === 'post_trash')
      throw conflict(`Database plan writes a record around its creation: ${operation.objectRef}`)
    chain.last = operation
    chain.kinds.add(operation.kind)
    for (const field of contentFields) chain.fields.add(field)
  })
  const plan: { operation: DbOperation; position: number }[] = []
  for (const [objectRef, chain] of chains) {
    const operation = compacted(objectRef, chain)
    if (operation) plan.push({ operation, position: chain.position })
  }
  plan.sort(
    (a, b) =>
      dbPlanOrder.indexOf(a.operation.kind) - dbPlanOrder.indexOf(b.operation.kind) ||
      a.position - b.position,
  )
  return plan.map((item) => item.operation)
}

/** The operations whose inverse is a value put back. */
export type DbValueOperation = Extract<DbOperation, { kind: 'content_update' | 'option_update' }>

/**
 * The operation that undoes a change of a value on production (Р31): the old value back, with
 * the precondition «production holds what we wrote» — the hash of the plugin's receipt, which a
 * release checks against `afterHash` before it trusts it.
 */
export function inverseOperation<Operation extends DbValueOperation>(
  operation: Operation,
  appliedHash: string = operation.afterHash,
): Operation {
  return {
    ...operation,
    fields: [...operation.fields],
    beforeHash: appliedHash,
    afterHash: operation.beforeHash,
    before: operation.after,
    after: operation.before,
  }
}

/**
 * What returning an operation does on production. A value goes back (`inverseOperation`); a
 * created record goes to the trash, and only while it holds what the release wrote — production
 * gave it its own reference (`productionRef`); a table stays as it is: the structure a release
 * added is kept, a removal would take the rows the site wrote since («новые записи прода
 * сохраняются»).
 */
export type DbInverse =
  | DbValueOperation
  | {
      kind: 'post_trash'
      /** The reference of the plan; `productionRef` — the one production gave the record. */
      objectRef: string
      productionRef: string
      /** The receipt of the creation: what the record must still hold to be taken out. */
      expectedStateHash: string
    }
  | { kind: 'kept'; objectRef: string }

export function dbInverseOf(
  operation: DbOperation,
  applied: { appliedHash: string; productionRef?: string } = {
    appliedHash: operation.afterHash,
  },
): DbInverse {
  switch (operation.kind) {
    case 'content_update':
    case 'option_update':
      return inverseOperation(operation, applied.appliedHash)
    case 'post_create':
      return {
        kind: 'post_trash',
        objectRef: operation.objectRef,
        productionRef: applied.productionRef ?? operation.objectRef,
        expectedStateHash: applied.appliedHash,
      }
    case 'schema_migration':
      return { kind: 'kept', objectRef: operation.objectRef }
  }
}

/** Whether returning the operation writes anything: a kept structure does not. */
export const dbInverseWrites = (inverse: DbInverse): boolean => inverse.kind !== 'kept'

// ---------------------------------------------------------------------------------------------
// «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): the inverse of an installed release
// ---------------------------------------------------------------------------------------------

/**
 * The trash of a record a release created, as the undo of that release writes it on production:
 * under the reference production gave the record (`objectRef`, its own id — never the plan's),
 * only while it holds what the release wrote (`beforeHash`, the state of the creation's receipt).
 * `createdRef` names the record in the plan of the release; the sides are that plan's values of
 * the record — `before` the creation as written, `after` its absence.
 */
export const dbProductionTrashSchema = z.strictObject({
  kind: z.literal('post_trash'),
  objectRef: existingRecordRef,
  createdRef: createdRecordRef,
  fields: z.array(z.string()).length(0),
  ...sides,
})
export type DbProductionTrash = z.infer<typeof dbProductionTrashSchema>

/**
 * One write of an undo: a text or a setting back to what it held before the release (the
 * release's operation with its sides swapped, `inverseOperation`), or a record the release
 * created to the trash. A table the release made or extended has no write: its structure stays.
 */
export const dbUndoOperationSchema = z.discriminatedUnion('kind', [
  dbContentUpdateSchema,
  optionUpdate,
  dbProductionTrashSchema,
])
export type DbUndoOperation = z.infer<typeof dbUndoOperationSchema>

/** The writes of an undo, in the reverse of the release's order: one per object. */
export const dbUndoPlanSchema = z
  .array(dbUndoOperationSchema)
  .max(dbPlanLimits.operations)
  .refine(
    (plan) => new Set(plan.map((operation) => operation.objectRef)).size === plan.length,
    'one operation per object',
  )
export type DbUndoPlan = z.infer<typeof dbUndoPlanSchema>

/**
 * An operation the deploy job writes: one of a release's plan (`dbOperationSchema`), or one of
 * an undo's (`dbUndoOperationSchema`): the manifest says which (`deployManifestSchema.kind`).
 */
export const deployDbOperationSchema = z.discriminatedUnion('kind', [
  dbContentUpdateSchema,
  optionUpdate,
  postCreate,
  schemaMigration,
  dbProductionTrashSchema,
])
export type DeployDbOperation = z.infer<typeof deployDbOperationSchema>
export type DeployDbOperationKind = DeployDbOperation['kind']

/**
 * The write that undoes one operation of an installed release, or null for one whose return
 * writes nothing (a table: its structure stays). A created record is named by what production
 * gave it — its reference and the state hash of its receipt (`created`); `absentHash` is the state
 * hash of that reference without the record (the caller hashes, the domain has no hash).
 */
export function undoOperationOf(
  operation: DbOperation,
  created?: { productionRef: string; stateHash: string; absentHash: string },
): DbUndoOperation | null {
  switch (operation.kind) {
    case 'content_update':
    case 'option_update':
      return inverseOperation(operation)
    case 'post_create':
      if (!created) return null
      return {
        kind: 'post_trash',
        objectRef: created.productionRef,
        createdRef: operation.objectRef,
        fields: [],
        beforeHash: created.stateHash,
        afterHash: created.absentHash,
        before: operation.after,
        after: operation.before,
      }
    case 'schema_migration':
      return null
  }
}

/** The text the plan of an undo is hashed over: keys in a fixed order, as `canonicalDbPlanJson`. */
export function canonicalDbUndoPlanJson(plan: DbUndoPlan): string {
  return JSON.stringify(
    plan.map((operation) => ({
      kind: operation.kind,
      objectRef: operation.objectRef,
      ...(operation.kind === 'post_trash' ? { createdRef: operation.createdRef } : {}),
      fields:
        operation.kind === 'content_update'
          ? orderDbContentFields(operation.fields)
          : [...operation.fields],
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      before: {
        key: operation.before.key,
        sha256: operation.before.sha256,
        sizeBytes: operation.before.sizeBytes,
      },
      after: {
        key: operation.after.key,
        sha256: operation.after.sha256,
        sizeBytes: operation.after.sizeBytes,
      },
    })),
  )
}

/** The inverse plan: inverse operations in reverse order. */
export const inverseDbPlan = (plan: DbPlan): DbInverse[] =>
  [...plan].reverse().map((operation) => dbInverseOf(operation))

/** A kind of change the stack does not declare (SiteAdapter.dbOperationKinds). */
export const dbOperationNotAllowed = (kind: string): DomainError =>
  new DomainError(
    'DB_OPERATION_NOT_ALLOWED',
    `Database operation ${kind} is not allowed for this site`,
    422,
    { kind },
  )

export function assertDbOperationAllowed(
  kind: string,
  allowed: readonly DbOperationKind[],
): asserts kind is DbOperationKind {
  if (!(allowed as readonly string[]).includes(kind)) throw dbOperationNotAllowed(kind)
}

/**
 * The text a plan is hashed over (`task_candidates.db_plan_sha256`): keys in a fixed order, the
 * same for every kind — a plan of `content_update` alone has the hash it always had.
 */
export function canonicalDbPlanJson(plan: DbPlan): string {
  return JSON.stringify(
    plan.map((operation) => ({
      kind: operation.kind,
      objectRef: operation.objectRef,
      fields:
        operation.kind === 'content_update'
          ? orderDbContentFields(operation.fields)
          : [...operation.fields],
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      before: {
        key: operation.before.key,
        sha256: operation.before.sha256,
        sizeBytes: operation.before.sizeBytes,
      },
      after: {
        key: operation.after.key,
        sha256: operation.after.sha256,
        sizeBytes: operation.after.sizeBytes,
      },
    })),
  )
}
