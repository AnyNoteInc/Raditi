import { createHash } from 'node:crypto'

import {
  absentStateHashMaterial,
  badRequest,
  dbContentFields,
  deployValueAad,
  deployValueSchemas,
  optionStateHashMaterial,
  publishedContentHashMaterial,
  recordTypeOf,
  tableStateHashMaterial,
  type DbContentUpdate,
  type DbCreatedRecord,
  type DbTableState,
  type DeployDbOperation,
  type DbWriteChange,
  type DeployValue,
  type PublishedContentGateway,
  type PublishedContentPatch,
  type PublishedContentState,
  type ReleaseKind,
  type SiteDbGateway,
  type TableDefinition,
} from '@repo/domain'

import { openDeployEnvelope } from './envelope.ts'

// The database operations of a release on production (Р3, Р30, Р31): `content_update` through
// the site's plugin in its mode `release` — exact bytes that its filter keeps as they are,
// whoever writes: the value comes from a preview that ran the agent's code, so the preview's
// word on the filter proves nothing —, with the precondition «the state hash is the operation's
// base» and the plugin's receipt checked against `afterHash`. The inverse writes the prior
// fields back in the mode `restore` (exact bytes the site held) with the precondition
// «production holds what we wrote».

/** How long one write may take to land; the plugin measures it on its own clock (spec §11). */
export const CONTENT_WRITE_WINDOW_MS = 60_000
const WRITE_TRIES = 3

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The state hash of a state as the plugin computes it from its fields. */
export const stateHashOf = (state: Omit<PublishedContentState, 'stateHash'>): string =>
  sha256(publishedContentHashMaterial(state))

/** The fields of an operation as they stand in `state`: what a write of it carries. */
export function fieldsOf(
  state: PublishedContentState,
  operation: DbContentUpdate,
): PublishedContentPatch {
  const fields: PublishedContentPatch = {}
  for (const field of dbContentFields)
    if (operation.fields.includes(field)) fields[field] = state[field]
  return fields
}

/**
 * The value an operation writes: the manifest's value opened with the attempt's key
 * (`deployValueAad`), in the shape of its kind (`deployValueSchemas`). A value of another object,
 * operation, release or kind of release (a release's value as an undo's) does not open; a text
 * change with other fields than the operation's is refused.
 */
export function openOperationValue<Operation extends DeployDbOperation>(
  sealed: Uint8Array,
  key: Uint8Array,
  releaseId: string,
  operation: Operation,
  kind: ReleaseKind = 'release',
): DeployValue<Operation['kind']> {
  const plaintext = openDeployEnvelope(
    sealed,
    key,
    deployValueAad(releaseId, operation.objectRef, operation.afterHash, kind),
  )
  let value: unknown
  try {
    value = deployValueSchemas[operation.kind].parse(JSON.parse(plaintext.toString('utf8')))
  } catch {
    throw badRequest('Invalid value of a database operation')
  } finally {
    plaintext.fill(0)
  }
  if (operation.kind === 'content_update') {
    const fields = (value as DeployValue<'content_update'>).fields
    const names = Object.keys(fields).sort((a, b) => (a < b ? -1 : 1))
    const expected = [...operation.fields].sort((a, b) => (a < b ? -1 : 1))
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index]))
      throw badRequest('Invalid value of a database operation')
  }
  return value as DeployValue<Operation['kind']>
}

/** The state hash of a setting holding `value` (null — no row), as the plugin computes it. */
export const optionHashOf = (objectRef: string, value: string | null): string =>
  sha256(optionStateHashMaterial({ objectRef, value }))

/** The state hash of a table, as the plugin computes it. */
export const tableHashOf = (
  objectRef: string,
  table: Pick<DbTableState, 'exists' | 'managed' | 'definition'>,
): string => sha256(tableStateHashMaterial({ objectRef, ...table }))

/** A table of the platform holding `definition`: what a migration leaves. */
export const migratedHashOf = (objectRef: string, definition: TableDefinition): string =>
  tableHashOf(objectRef, { exists: true, managed: true, definition })

/** The state hash of a new record under `objectRef` — the plan's, or the one production gave it. */
export const createdHashOf = (objectRef: string, record: DbCreatedRecord): string =>
  stateHashOf({
    version: 1,
    objectRef,
    kind: recordTypeOf(objectRef) as PublishedContentState['kind'],
    status: record.status,
    title: record.title,
    content: record.content,
    excerpt: record.excerpt,
  })

/** The state hash of a record that is not there. */
export const absentHashOf = (objectRef: string): string =>
  sha256(absentStateHashMaterial(objectRef))

/** The state hash of `state` with `fields` written into it, as the plugin computes it. */
export function stateHashWith(state: PublishedContentState, fields: PublishedContentPatch): string {
  return stateHashOf({ ...state, ...fields })
}

/**
 * A call id of the plugin's receipts that the same write of the same attempt always repeats:
 * a retry is a replay, never a second write. A UUID (version 8) of SHA-256.
 */
export function contentCallId(
  releaseId: string,
  deployAttempt: number,
  objectRef: string,
  direction: 'apply' | 'undo',
): string {
  const digest = createHash('sha256')
    .update(
      `raditi-release-content-call-v1|${releaseId.toLowerCase()}|${deployAttempt}|${objectRef}|${direction}`,
    )
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export interface ExactWrite {
  releaseId: string
  deployAttempt: number
  siteId: string
  epoch: number
  objectRef: string
  direction: 'apply' | 'undo'
  expectedStateHash: string
  fields: PublishedContentPatch
  /**
   * The plugin's mode: by default `release` for `apply`, `restore` for `undo`. The writes of an
   * undo of a release (docs/plan/53, «Отмена выпуска») put back what production held before it:
   * `restore` both ways.
   */
  mode?: 'release' | 'restore'
}

export type ExactWriteResult =
  | { kind: 'committed'; stateHash: string }
  | { kind: 'refused'; code: 'conflict' | 'fenced' | 'invalid' | 'unavailable' }
  /** No answer and no proof either way: the operator decides (Р31). */
  | { kind: 'unknown' }

/**
 * One write of exact bytes with its own call id and deadline: `apply` in the plugin's mode
 * `release`, `undo` in its mode `restore`. A lost answer is asked again with
 * the same identity (the plugin answers a replay with its receipt); still nothing — the job waits
 * out the deadline and asks the plugin to reconcile it: a receipt, a proof that it never landed,
 * or nothing — `unknown`.
 */
export async function writeExact(
  gateway: PublishedContentGateway,
  write: ExactWrite,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<ExactWriteResult> {
  const callId = contentCallId(
    write.releaseId,
    write.deployAttempt,
    write.objectRef,
    write.direction,
  )
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'raditi-release-content-v1',
        write.releaseId.toLowerCase(),
        write.deployAttempt,
        write.objectRef,
        write.direction,
        write.expectedStateHash,
        write.fields,
      ]),
    )
    .digest('hex')
  const deadlineAt = clock.now() + CONTENT_WRITE_WINDOW_MS
  const identity = {
    callId,
    siteId: write.siteId,
    epoch: write.epoch,
    requestHash,
    objectRef: write.objectRef,
    deadlineAt,
  }
  for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
    const ttlMs = deadlineAt - clock.now()
    if (ttlMs <= 0) break
    try {
      const outcome = await gateway.conditionalWrite({
        ...identity,
        ttlMs,
        expectedStateHash: write.expectedStateHash,
        mode: write.mode ?? (write.direction === 'apply' ? 'release' : 'restore'),
        fields: write.fields,
      })
      return outcome.kind === 'committed'
        ? { kind: 'committed', stateHash: outcome.stateHash }
        : { kind: 'refused', code: outcome.code }
    } catch {
      // No answer: the same identity again.
    }
  }
  await clock.sleep(Math.max(0, deadlineAt - clock.now()) + 1_000)
  try {
    const proof = await gateway.reconcileOperation({ ...identity, ttlMs: deadlineAt - clock.now() })
    if (proof.kind === 'committed') return { kind: 'committed', stateHash: proof.stateHash }
    if (proof.kind === 'not_committed') return { kind: 'refused', code: 'unavailable' }
  } catch {
    // No proof either way.
  }
  return { kind: 'unknown' }
}

/** The identity a write was sent with: what a later reconcile of it must name again. */
export interface WriteIdentity {
  callId: string
  siteId: string
  epoch: number
  requestHash: string
  objectRef: string
  deadlineAt: number
}

export interface DbExactWrite {
  releaseId: string
  deployAttempt: number
  siteId: string
  epoch: number
  /** The object the plugin writes: a setting, a table, the plan's new record or production's. */
  objectRef: string
  direction: 'apply' | 'undo'
  expectedStateHash: string
  /** A creation names its own call id as its mark (`contentCallId` of the same write). */
  change: DbWriteChange
  /** A table: the state hash a write that did not land leaves it in. */
  unchangedHash?: string
  /** As `ExactWrite.mode`. */
  mode?: 'release' | 'restore'
}

export type DbExactWriteResult =
  | { kind: 'committed'; stateHash: string; createdRef?: string }
  | Exclude<ExactWriteResult, { kind: 'committed' }>

/**
 * A table's statements run outside any transaction and wait at most 5 s each for their lock
 * (the plugin): after the deadline of the request and this much more none of them can still be
 * waiting, so the table holds what the request did.
 */
const TABLE_SETTLE_MS = 15_000

/**
 * One write of an object of a plan other than a text change (docs/plan/53, «Операции БД и
 * миграции»): a setting, a new record, a record of the platform to the trash, a table. The same
 * call id for the same write of the same attempt, `apply` in the plugin's mode `release`, `undo`
 * in its mode `restore`; a lost answer asked again with the same identity; still nothing — after
 * the deadline the plugin reconciles it (a receipt, a proof that it never landed, or nothing) —
 * except a table, whose statements no receipt holds: what it holds once they can no longer run
 * is the answer.
 */
export async function writeDbExact(
  db: SiteDbGateway,
  write: DbExactWrite,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<{ result: DbExactWriteResult; identity: WriteIdentity }> {
  const callId = contentCallId(
    write.releaseId,
    write.deployAttempt,
    write.objectRef,
    write.direction,
  )
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'raditi-release-db-v1',
        write.releaseId.toLowerCase(),
        write.deployAttempt,
        write.objectRef,
        write.direction,
        write.expectedStateHash,
        write.change,
      ]),
    )
    .digest('hex')
  const deadlineAt = clock.now() + CONTENT_WRITE_WINDOW_MS
  const identity: WriteIdentity = {
    callId,
    siteId: write.siteId,
    epoch: write.epoch,
    requestHash,
    objectRef: write.objectRef,
    deadlineAt,
  }
  const done = (result: DbExactWriteResult) => ({ result, identity })
  for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
    const ttlMs = deadlineAt - clock.now()
    if (ttlMs <= 0) break
    try {
      const outcome = await db.writeObject({
        ...identity,
        ttlMs,
        expectedStateHash: write.expectedStateHash,
        mode: write.mode ?? (write.direction === 'apply' ? 'release' : 'restore'),
        change: write.change,
      })
      if (outcome.kind === 'committed')
        return done({
          kind: 'committed',
          stateHash: outcome.stateHash,
          ...(outcome.createdRef ? { createdRef: outcome.createdRef } : {}),
        })
      return done({ kind: 'refused', code: outcome.code })
    } catch {
      // No answer: the same identity again.
    }
  }
  await clock.sleep(Math.max(0, deadlineAt - clock.now()) + 1_000)
  if (write.change.kind === 'schema_migration') {
    await clock.sleep(TABLE_SETTLE_MS)
    const target =
      write.change.definition === null
        ? null
        : migratedHashOf(write.objectRef, write.change.definition)
    try {
      const state = await db.readObject(write.objectRef)
      if (state.stateHash === target) return done({ kind: 'committed', stateHash: target })
      if (state.stateHash === (write.unchangedHash ?? write.expectedStateHash))
        return done({ kind: 'refused', code: 'unavailable' })
    } catch {
      // No proof either way.
    }
    return done({ kind: 'unknown' })
  }
  try {
    const proof = await db.reconcile({ ...identity, ttlMs: deadlineAt - clock.now() })
    if (proof.kind === 'committed')
      return done({
        kind: 'committed',
        stateHash: proof.stateHash,
        ...(proof.createdRef ? { createdRef: proof.createdRef } : {}),
      })
    if (proof.kind === 'not_committed') return done({ kind: 'refused', code: 'unavailable' })
  } catch {
    // No proof either way.
  }
  return done({ kind: 'unknown' })
}
