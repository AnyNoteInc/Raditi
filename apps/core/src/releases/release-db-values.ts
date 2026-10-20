import {
  dbContentFields,
  deployValueAad,
  isOptionState,
  isRecordState,
  isTableState,
  type DbObjectState,
  type DbOperation,
  type DbUndoOperation,
  type DbValueRef,
  type DeployDbOperation,
  type DeployValue,
  type PublishedContentPatch,
  type ReleaseKind,
} from '@repo/domain'

import { sealDeployEnvelope } from '../deploy-step/envelope.ts'

// The values a release writes into the database of production (docs/plan/53-chat-preview-
// release.md, Р3, Р30, «Операции БД и миграции»): each operation of the candidate's plan has as
// its `after` side the state the mcp role sealed when the agent wrote into the preview (R7) —
// read back by the reader of the preview manager (R5c: `previewDbPlanValues`). core keeps
// exactly what the operation writes (`deployValueSchemas` of its kind) and seals it for the
// deploy job with the data key of the attempt — the envelope and the associated data of
// deploy-manifest.ts that `openOperationValue` of the job opens. A value of one object, one
// operation or one release does not open as another's.

/**
 * What a release reads the plan's values with (`DbPlanValueReader` of previews/db-plan-values.ts).
 * A value that is not what the plan names is a DomainError with HTTP status 409; anything else
 * may pass on a retry.
 */
export interface DbPlanValueReader {
  readState(
    owner: { workspaceId: string; taskId: string },
    objectRef: string,
    side: 'before' | 'after',
    value: DbValueRef,
  ): Promise<{ state: DbObjectState }>
}

/** The states a release reads of one operation: its `after`, and a table's `before` besides. */
export interface DbOperationStates {
  after: DbObjectState
  /** A table is found in its `before` state, said whole; other kinds do not need it. */
  before: DbObjectState | null
}

/** The value an operation writes, as `deployValueSchemas` of its kind holds it. */
export function dbOperationPayload(
  states: DbOperationStates,
  operation: Pick<DbOperation, 'kind' | 'fields'>,
): DeployValue<DbOperation['kind']> {
  const { after, before } = states
  switch (operation.kind) {
    case 'content_update': {
      if (!isRecordState(after)) throw new Error('Not the state of a record')
      const fields: PublishedContentPatch = {}
      for (const field of dbContentFields)
        if ((operation.fields as readonly string[]).includes(field)) fields[field] = after[field]
      return { v: 1, fields }
    }
    case 'option_update':
      if (!isOptionState(after) || after.value === null) throw new Error('Not a setting')
      return { v: 1, value: after.value }
    case 'post_create':
      if (!isRecordState(after) || after.slug === undefined) throw new Error('Not a new record')
      return {
        v: 1,
        record: {
          status: after.status ?? 'publish',
          slug: after.slug,
          title: after.title,
          content: after.content,
          excerpt: after.excerpt,
        },
      }
    case 'schema_migration':
      if (!before || !isTableState(before) || !isTableState(after) || !after.definition)
        throw new Error('Not a table')
      return {
        v: 1,
        before: { exists: before.exists, managed: before.managed, definition: before.definition },
        definition: after.definition,
      }
  }
}

/** The plaintext of one operation's value: the JSON the job's schema of its kind reads. */
export function dbOperationValue(
  states: DbOperationStates,
  operation: Pick<DbOperation, 'kind' | 'fields'>,
): Buffer {
  return Buffer.from(JSON.stringify(dbOperationPayload(states, operation)), 'utf8')
}

/** The sealed value of one operation of `releaseId`, as the manifest hands it to the job. */
export function sealDbOperationValue(
  states: DbOperationStates,
  operation: Pick<DbOperation, 'kind' | 'fields' | 'objectRef' | 'afterHash'>,
  releaseId: string,
  key: Uint8Array,
): Buffer {
  const plaintext = dbOperationValue(states, operation)
  try {
    return sealDeployEnvelope(
      plaintext,
      key,
      deployValueAad(releaseId, operation.objectRef, operation.afterHash),
    )
  } finally {
    plaintext.fill(0)
  }
}

/**
 * The value of one write of an undo of a release (docs/plan/53, «Отмена выпуска»), from what the
 * release's plan keeps: a text's fields and a setting's value as they stood before the release
 * (`prior`: the `before` side of its operation; a setting may have had no row), a trash's address
 * — of the record as the release created it (`prior`: the `after` side of the creation) — with the
 * mark of its creation.
 */
export function undoOperationPayload(
  operation: DbUndoOperation,
  prior: DbObjectState,
  createCallId?: string,
): DeployValue<DbUndoOperation['kind']> {
  switch (operation.kind) {
    case 'content_update':
      return dbOperationPayload(
        { after: prior, before: null },
        operation,
      ) as DeployValue<'content_update'>
    case 'option_update':
      if (!isOptionState(prior)) throw new Error('Not a setting')
      return { v: 1, value: prior.value }
    case 'post_trash':
      if (!isRecordState(prior) || prior.slug === undefined || !createCallId)
        throw new Error('Not a new record')
      return { v: 1, slug: prior.slug, createCallId }
  }
}

/** A value sealed for the job of one attempt of a release or an undo (`deployValueAad`). */
export function sealDeployValue(
  payload: DeployValue<DeployDbOperation['kind']>,
  operation: Pick<DeployDbOperation, 'objectRef' | 'afterHash'>,
  releaseId: string,
  kind: ReleaseKind,
  key: Uint8Array,
): Buffer {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    return sealDeployEnvelope(
      plaintext,
      key,
      deployValueAad(releaseId, operation.objectRef, operation.afterHash, kind),
    )
  } finally {
    plaintext.fill(0)
  }
}
