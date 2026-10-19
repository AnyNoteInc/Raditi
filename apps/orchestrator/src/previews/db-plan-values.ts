import type { PrismaClient } from '@repo/db'
import {
  DomainError,
  isRecordState,
  type DbObjectState,
  type DbValueRef,
  type PublishedContentState,
} from '@repo/domain'

import type { PreviewDbValueRef, PreviewDbValueSide } from '../mcp/preview-db-values.ts'

// The values of a candidate's database plan (docs/plan/53-chat-preview-release.md, Р3, Р22, Р24):
// each side of an operation is the state of the object the mcp role sealed when the agent wrote
// into the preview (`PreviewDbValueStorage`, R7), an object of `raditi-artifacts` whose key,
// SHA-256 and size the plan keeps (`DbValueRef`). Whose value it is — the write it belongs to —
// is a row of `preview_db_operations` of the same task, found by that key: a rebuild of the
// preview reads the `after` side to write it again (R5c), a release reads both (R8b).

export interface DbPlanValueOwner {
  workspaceId: string
  taskId: string
}

export interface DbPlanValueReader {
  /**
   * The state of a record one side of an operation of `owner` holds; PREVIEW_DB_VALUE_INVALID
   * otherwise.
   */
  read(
    owner: DbPlanValueOwner,
    objectRef: string,
    side: PreviewDbValueSide,
    value: DbValueRef,
  ): Promise<PublishedContentState>
  /**
   * The state one side holds, of any object of a plan, and the journal call it belongs to (the
   * `before` of a creation is the call that created the record: its mark on the site).
   */
  readState(
    owner: DbPlanValueOwner,
    objectRef: string,
    side: PreviewDbValueSide,
    value: DbValueRef,
  ): Promise<{ state: DbObjectState; callId: string }>
}

/** What loads a sealed value: `PreviewDbValueStorage.loadState` of the mcp module. */
export interface DbPlanValueStorage {
  loadState(ref: PreviewDbValueRef, value: DbValueRef): Promise<DbObjectState>
}

const notTheValue = () =>
  new DomainError('PREVIEW_DB_VALUE_INVALID', 'Database plan value failed verification', 409)

export function previewDbPlanValues(deps: {
  prisma: Pick<PrismaClient, 'previewDbOperation'>
  values: DbPlanValueStorage
}): DbPlanValueReader {
  const reader: DbPlanValueReader = {
    async read(owner, objectRef, side, value) {
      const { state } = await reader.readState(owner, objectRef, side, value)
      if (!isRecordState(state)) throw notTheValue()
      return state
    },
    async readState(owner, objectRef, side, value) {
      const row = await deps.prisma.previewDbOperation.findFirst({
        where: {
          taskId: owner.taskId,
          objectRef,
          ...(side === 'after'
            ? { afterObjectKey: value.key, afterSha256: value.sha256, afterBytes: value.sizeBytes }
            : {
                beforeObjectKey: value.key,
                beforeSha256: value.sha256,
                beforeBytes: value.sizeBytes,
              }),
        },
        select: { mcpCallId: true, previewId: true },
      })
      if (!row) throw notTheValue()
      const state = await deps.values.loadState(
        {
          workspaceId: owner.workspaceId,
          taskId: owner.taskId,
          previewId: row.previewId,
          callId: row.mcpCallId,
          side,
          objectRef,
        },
        value,
      )
      return { state, callId: row.mcpCallId }
    },
  }
  return reader
}
