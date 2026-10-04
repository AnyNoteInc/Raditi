import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  contentUndoFenceSchema,
  contentUndoOperations,
  contentUndoResultSchema,
  contentUndoStopCodes,
  undoTaskInputSchema,
  undoTurnInputSchema,
  type ContentUndoResult,
  type TrustedContentUndo,
} from './content-undo.ts'
import type { TurnContentRollback } from './turn-assignment.ts'
import { siteLeaseOperations, type SiteLeaseFence } from './turn-runner.ts'

const siteId = '01960000-0000-7000-8000-000000000001'
const taskId = '01960000-0000-7000-8000-000000000002'
const targetTaskId = '01960000-0000-7000-8000-000000000003'
const fence = (operation: string, extra: Record<string, unknown> = {}) => ({
  siteId,
  taskId,
  operation,
  epoch: 7,
  ...extra,
})

describe('the trusted content undo', () => {
  it('is admitted by the fence of a turn or a revert lease, never of a deploy', () => {
    expect(contentUndoOperations).toEqual(['turn', 'revert'])
    for (const operation of contentUndoOperations) {
      expect(siteLeaseOperations).toContain(operation)
      expect(contentUndoFenceSchema.parse(fence(operation))).toEqual(fence(operation))
    }
    expect(contentUndoFenceSchema.safeParse(fence('deploy')).success).toBe(false)
  })

  it('takes a lease grant for its fence and drops the expiry and the clock of it', () => {
    const grant = fence('turn', { expiresAt: new Date(), serverNow: new Date() })
    expect(undoTurnInputSchema.parse({ fence: grant, turn: 2 })).toEqual({
      fence: fence('turn'),
      turn: 2,
    })
  })

  it('undoes a turn only under the turn lease of its task', () => {
    expect(undoTurnInputSchema.safeParse({ fence: fence('turn'), turn: 1 }).success).toBe(true)
    for (const input of [
      { fence: fence('revert'), turn: 1 },
      { fence: fence('turn'), turn: 0 },
      { fence: fence('turn'), turn: 1.5 },
      { fence: fence('turn'), turn: 2_147_483_648 },
      { fence: fence('turn', { epoch: 0 }), turn: 1 },
      { fence: fence('turn', { siteId: 'site' }), turn: 1 },
      { fence: fence('turn') },
    ])
      expect(undoTurnInputSchema.safeParse(input).success).toBe(false)
  })

  it('undoes a task under a turn or a revert lease, by the id of the task alone', () => {
    for (const operation of contentUndoOperations)
      expect(
        undoTaskInputSchema.parse({ fence: fence(operation), targetTaskId }).targetTaskId,
      ).toBe(targetTaskId)
    for (const input of [
      { fence: fence('deploy'), targetTaskId },
      { fence: fence('revert'), targetTaskId: 'task' },
      { fence: fence('revert') },
    ])
      expect(undoTaskInputSchema.safeParse(input).success).toBe(false)
  })

  it('carries nothing else: a credential of a turn is refused, not ignored', () => {
    const mcpToken = `mcp_${'a'.repeat(64)}`
    expect(undoTurnInputSchema.safeParse({ fence: fence('turn'), turn: 1, mcpToken }).success).toBe(
      false,
    )
    expect(
      undoTaskInputSchema.safeParse({ fence: fence('revert'), targetTaskId, mcpToken }).success,
    ).toBe(false)
    // The rollback before a replacement run is admitted the same way.
    expectTypeOf<Parameters<TurnContentRollback['rollback']>[0]>().toEqualTypeOf<{
      fence: SiteLeaseFence
      turn: number
    }>()
  })

  it('answers with a counter, and stops with one of two fixed codes', () => {
    expect(contentUndoResultSchema.parse({ restored: 0 })).toEqual({ restored: 0 })
    for (const result of [
      { restored: -1 },
      { restored: 1.5 },
      { restored: 1, objectRef: 'post:1' },
    ])
      expect(contentUndoResultSchema.safeParse(result).success).toBe(false)
    expect(contentUndoStopCodes).toEqual(['CONFLICT', 'CONTENT_RESTORE_FAILED'])
    expectTypeOf<ReturnType<TrustedContentUndo['undoTurn']>>().toEqualTypeOf<
      Promise<ContentUndoResult>
    >()
    expectTypeOf<ReturnType<TrustedContentUndo['undoTask']>>().toEqualTypeOf<
      Promise<ContentUndoResult>
    >()
  })
})
