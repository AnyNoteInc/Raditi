import { z } from 'zod'

import { publicationForbidden, publicationTooLarge, turnOutputRejected } from '../errors.ts'
import { isForbiddenPath } from '../policies/diff-paths.ts'
import { gitProviderKinds } from '../ports/git-provider.ts'
import { snapshotLimits } from '../sessions/session-state.ts'
import { snapshotIdSchema } from '../sessions/snapshot-manifest.ts'

export const publicationLimits = Object.freeze({
  /** The candidate patch is saved as the snapshot's patch part: one limit for both. */
  patchBytes: snapshotLimits.patchBytes,
  fileBytes: 32 * 1024 * 1024,
  treeBytes: 128 * 1024 * 1024,
  bundleBytes: 64 * 1024 * 1024,
  /** Files the agent's changes may add, change or delete in one turn. */
  files: 10_000,
  /**
   * Files in the site's own base tree. A guess for WordPress with plugins and uploads in Git;
   * to be checked on real sites (P5).
   */
  repositoryFiles: 100_000,
  pathBytes: 1024,
  commandMs: 60_000,
})

export const publicationShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const repoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
export const publicationSourceSchema = z
  .object({
    repo: z
      .object({ provider: z.enum(gitProviderKinds), owner: repoName, name: repoName })
      .strict(),
    branch: z
      .string()
      .min(1)
      .max(200)
      .regex(/^agent\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    expectedBaseSha: publicationShaSchema,
    /** SiteAdapter.protectedPaths() of the site; required so a caller cannot silently omit it. */
    protectedPaths: z.array(z.string().min(1).max(1024)).max(100),
  })
  .strict()
export type PublicationSource = z.input<typeof publicationSourceSchema>

export const publicationMetadataSchema = publicationSourceSchema
  .extend({
    taskId: snapshotIdSchema,
    turn: z.number().int().positive().max(999_999),
    // A fixed instant is essential: commit-tree must reproduce the same SHA after a crash.
    createdAt: z.iso.datetime().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict()
  .refine((value) => value.branch === `agent/${value.taskId}`, 'task branch mismatch')
export type PublicationMetadata = z.input<typeof publicationMetadataSchema>

/**
 * `.git` or its NTFS short name `git~1`, with the trailing dots, spaces or stream suffix NTFS
 * ignores. Git refuses such a component under core.protectNTFS, on by default everywhere.
 */
const ntfsDotGit = /^(?:\.git|git~1)[. ]*(?::|$)/i

/** Validate, never normalize, paths crossing the trusted publication boundary. */
export function isPublicationPath(path: string): boolean {
  return !(
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > publicationLimits.pathBytes ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes('\ufffd') ||
    path.split('/').length > 32 ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || ntfsDotGit.test(part))
  )
}

/** A path the agent produced: its output, not the client's input. */
export function assertPublicationPath(path: string): void {
  if (!isPublicationPath(path)) throw turnOutputRejected('Invalid publication path')
}

export interface PublicationChange {
  path: string
  oldMode: string
  newMode: string
  sizeBytes: number
}

export function assertPublicationChange(
  change: PublicationChange,
  protectedPaths: readonly string[],
): void {
  assertPublicationPath(change.path)
  if (isForbiddenPath(change.path, protectedPaths))
    throw publicationForbidden('Publication changes a protected path')
  const modes = new Set(['000000', '100644', '100755'])
  if (
    !modes.has(change.oldMode) ||
    !modes.has(change.newMode) ||
    (change.oldMode !== '000000' &&
      change.newMode !== '000000' &&
      change.oldMode !== change.newMode)
  ) {
    throw publicationForbidden('Publication contains a link, submodule or permission change')
  }
  if (!Number.isSafeInteger(change.sizeBytes) || change.sizeBytes < 0)
    throw turnOutputRejected('Invalid publication file size')
  if (change.sizeBytes > publicationLimits.fileBytes)
    throw publicationTooLarge('Publication file exceeds the size limit')
}
