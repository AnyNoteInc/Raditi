import { z } from 'zod'

import { versionTagSchema } from './semver.ts'

/**
 * The idempotency key of a release (docs/plan/53-chat-preview-release.md, Р33):
 * `site_releases.release_key`, the SHA-256 hex of a canonical text of the candidate, its
 * revision, the version and the number of the candidate's release attempt. A repeated
 * `/release` with the same confirmation lands on the same row. The domain has no hash: it
 * fixes the input and the text; `@repo/db` and the transport compute SHA-256 over it.
 */
export const RELEASE_KEY_PATTERN_SOURCE = '^[0-9a-f]{64}$'
export const releaseKeySchema = z.string().regex(new RegExp(RELEASE_KEY_PATTERN_SOURCE))

export const releaseKeyInputSchema = z.strictObject({
  candidateId: z.uuid(),
  revision: z.number().int().min(1),
  version: versionTagSchema,
  /** `site_releases.attempt`: the n-th release of this candidate. */
  attempt: z.number().int().min(1),
})
export type ReleaseKeyInput = z.infer<typeof releaseKeyInputSchema>

/** The text the key is the SHA-256 of; a new version prefix if the fields ever change. */
export function releaseKeyMaterial(input: ReleaseKeyInput): string {
  const key = releaseKeyInputSchema.parse(input)
  return ['raditi-release-key:v1', key.candidateId, key.revision, key.version, key.attempt].join(
    '\n',
  )
}

/**
 * The idempotency key of the undo of a release (docs/plan/53, «Отмена выпуска»): the release
 * undone, the plan the client confirmed, the version and the n-th undo of that release. A repeated
 * confirmation lands on the same row.
 */
export const undoKeyInputSchema = z.strictObject({
  undoesReleaseId: z.uuid(),
  planId: z.uuid(),
  version: versionTagSchema,
  attempt: z.number().int().min(1),
})
export type UndoKeyInput = z.infer<typeof undoKeyInputSchema>

export function undoKeyMaterial(input: UndoKeyInput): string {
  const key = undoKeyInputSchema.parse(input)
  return ['raditi-undo-key:v1', key.undoesReleaseId, key.planId, key.version, key.attempt].join(
    '\n',
  )
}
