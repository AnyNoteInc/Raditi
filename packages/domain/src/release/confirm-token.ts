import { z } from 'zod'

import { versionTagSchema } from './semver.ts'

/**
 * The confirmation of a release (docs/plan/53-chat-preview-release.md, Р25): `release.prepare`
 * hands the client a `confirmToken`, an HMAC over these claims; `release.confirm` takes it back.
 * Words of the model never stand for a confirmation. The domain fixes the claims and the text;
 * the transport signs and verifies with a key of its own.
 */
export const CONFIRM_TOKEN_TTL_SECONDS = 10 * 60

export const confirmTokenClaimsSchema = z.strictObject({
  userId: z.uuid(),
  candidateId: z.uuid(),
  revision: z.number().int().min(1),
  version: versionTagSchema,
  /**
   * `task_candidates.db_view_sha256` of the revision: the description of the database plan the
   * client was shown (docs/plan/53, «Операции БД и миграции»); null — the plan is empty.
   */
  dbViewSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
})
export type ConfirmTokenClaims = z.infer<typeof confirmTokenClaimsSchema>

/** The text the HMAC is computed over. */
export function confirmTokenMaterial(claims: ConfirmTokenClaims): string {
  const value = confirmTokenClaimsSchema.parse(claims)
  return [
    'raditi-release-confirm:v2',
    value.userId,
    value.candidateId,
    value.revision,
    value.version,
    value.dbViewSha256 ?? '-',
    value.expiresAt,
  ].join('\n')
}

export const isConfirmTokenExpired = (claims: ConfirmTokenClaims, now: Date): boolean =>
  now.getTime() >= claims.expiresAt * 1000

/**
 * The confirmation of «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): `release.undoPlan`
 * hands it out with a ready plan of the undo, `release.undoConfirm` takes it back. It names the
 * release undone, the plan the client was shown (its id and its hash) and the number of the
 * undo; another text prefix than a release's, so neither token passes as the other.
 */
export const undoConfirmTokenClaimsSchema = z.strictObject({
  userId: z.uuid(),
  releaseId: z.uuid(),
  planId: z.uuid(),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/),
  version: versionTagSchema,
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
})
export type UndoConfirmTokenClaims = z.infer<typeof undoConfirmTokenClaimsSchema>

/** The text the HMAC of an undo's confirmation is computed over. */
export function undoConfirmTokenMaterial(claims: UndoConfirmTokenClaims): string {
  const value = undoConfirmTokenClaimsSchema.parse(claims)
  return [
    'raditi-undo-confirm:v1',
    value.userId,
    value.releaseId,
    value.planId,
    value.planSha256,
    value.version,
    value.expiresAt,
  ].join('\n')
}
