import { z } from 'zod'

import { badRequest, forbidden } from '../errors.ts'
import { isForbiddenPath } from '../policies/diff-paths.ts'
import { gitProviderKinds } from '../ports/git-provider.ts'
import { snapshotIdSchema } from '../sessions/snapshot-manifest.ts'

export const publicationLimits = Object.freeze({
  patchBytes: 8 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  treeBytes: 128 * 1024 * 1024,
  bundleBytes: 64 * 1024 * 1024,
  files: 10_000,
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
    protectedPaths: z.array(z.string().min(1).max(1024)).max(100).default([]),
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

/** Validate, never normalize, paths crossing the trusted publication boundary. */
export function assertPublicationPath(path: string): void {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > 1024 ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes('\ufffd') ||
    path.split('/').length > 32 ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw badRequest('Invalid publication path')
}

export interface PublicationChange {
  path: string
  oldMode: string
  newMode: string
  sizeBytes: number
}

export function assertPublicationChange(
  change: PublicationChange,
  protectedPaths: readonly string[] = [],
): void {
  assertPublicationPath(change.path)
  if (isForbiddenPath(change.path, protectedPaths))
    throw forbidden('Publication changes a protected path')
  const modes = new Set(['000000', '100644', '100755'])
  if (
    !modes.has(change.oldMode) ||
    !modes.has(change.newMode) ||
    (change.oldMode !== '000000' &&
      change.newMode !== '000000' &&
      change.oldMode !== change.newMode)
  ) {
    throw forbidden('Publication contains a link, submodule or permission change')
  }
  if (
    !Number.isSafeInteger(change.sizeBytes) ||
    change.sizeBytes < 0 ||
    change.sizeBytes > publicationLimits.fileBytes
  ) {
    throw badRequest('Publication file exceeds the size limit')
  }
}
