import { z } from 'zod'

import {
  siteLeaseFenceSchema,
  type SiteLeaseFence,
  type SiteLeaseOperation,
} from './turn-runner.ts'

/**
 * The site leases under which the trusted host returns published content (spec §11): the turn
 * of the task itself, or the revert that «Отменить» of a finished task holds. Never a deploy.
 */
export const contentUndoOperations = [
  'turn',
  'revert',
] as const satisfies readonly SiteLeaseOperation[]
export type ContentUndoOperation = (typeof contentUndoOperations)[number]

/** The fence of such a lease. Other keys are stripped: a lease grant may be passed as it is. */
export const contentUndoFenceSchema = siteLeaseFenceSchema.extend({
  operation: z.enum(contentUndoOperations),
})

/** Nothing but the fence admits an undo: an unknown key, a turn credential above all, is refused. */
export const undoTurnInputSchema = z.strictObject({
  fence: contentUndoFenceSchema.extend({ operation: z.literal('turn') }),
  turn: z.number().int().positive().max(2_147_483_647),
})
export type UndoTurnInput = z.infer<typeof undoTurnInputSchema>

export const undoTaskInputSchema = z.strictObject({
  fence: contentUndoFenceSchema,
  targetTaskId: z.uuid(),
})
export type UndoTaskInput = z.infer<typeof undoTaskInputSchema>

/** How many edits this call returned; 0 when nothing was left to return. No content, no ids. */
export const contentUndoResultSchema = z.strictObject({
  restored: z.number().int().nonnegative(),
})
export type ContentUndoResult = z.infer<typeof contentUndoResultSchema>

/**
 * Why an undo stopped before the end, as the code of the DomainError it throws:
 * `CONFLICT` — the content was changed after the edit, or its snapshot is gone: a repeat
 * cannot help, what was returned stays returned; `CONTENT_RESTORE_FAILED` — the site, the
 * storage or the journal did not answer, or a write is still unresolved: a repeat goes on
 * from where this one stopped (past an unresolved write — only after it is reconciled).
 * A fence that no longer holds the site — the lease was taken over, has expired or is held
 * for the operator — is `LEASE_LOST`.
 */
export const contentUndoStopCodes = ['CONFLICT', 'CONTENT_RESTORE_FAILED'] as const
export type ContentUndoStopCode = (typeof contentUndoStopCodes)[number]

/**
 * Returns the content edits of a task to the state before them, newest first. Called by the
 * trusted side only, and admitted by the fence of the site lease its caller holds — never by a
 * credential of a turn, so it works when the turn key is revoked and no account is left in the
 * pool (spec §8, §11). Every call is safe to repeat.
 */
export interface TrustedContentUndo {
  /** The edits of one turn of the task that holds the turn lease: a turn that did not complete. */
  undoTurn(input: { fence: SiteLeaseFence; turn: number }): Promise<ContentUndoResult>
  /**
   * Every edit of the target task that is not returned yet. The target is the holder of the
   * lease, or the task the holder reverts («Отменить»).
   */
  undoTask(input: { fence: SiteLeaseFence; targetTaskId: string }): Promise<ContentUndoResult>
}
