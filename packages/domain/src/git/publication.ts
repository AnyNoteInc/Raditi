import { z } from 'zod'

import { publicationForbidden, publicationTooLarge, turnOutputRejected } from '../errors.ts'
import { isForbiddenPath } from '../policies/diff-paths.ts'
import { snapshotLimits } from '../sessions/session-state.ts'
import { snapshotIdSchema } from '../sessions/snapshot-manifest.ts'

// The trusted git of a project's repository (docs/plan/84-projects.md, ПР12, ПР33, §4.3): what
// crosses the boundary between core, its git worker and a turn — limits, commits, paths. Returned
// from main without the site parts of plan 53 (working sets, media, protected paths of a CMS).

export const publicationLimits = Object.freeze({
  /** The candidate patch is saved as the snapshot's patch part: one limit for both. */
  patchBytes: snapshotLimits.patchBytes,
  fileBytes: 32 * 1024 * 1024,
  /** The tree a sandbox gets (§4.7): 128 MiB of files. */
  treeBytes: 128 * 1024 * 1024,
  /** The bundle of that tree, without history (ПР12). */
  bundleBytes: 64 * 1024 * 1024,
  /** Files the agent's changes may add, change or delete in one turn. */
  files: 10_000,
  /** Files of the base tree of a repository (§4.7). */
  repositoryFiles: 100_000,
  pathBytes: 1024,
  commandMs: 60_000,
  /**
   * One gitleaks scan of a whole tree (ПР12, ПР35): the tree a sandbox may get, 128 MiB, at about
   * 1 MB/s of one core — a single scan, never the 60 s of a git command (19.11.2026: the 60 MB tree
   * of Raditi took 69 s on the one core of the worker).
   */
  scanMs: 300_000,
})

/**
 * The mirrors of the repositories of projects (ПР12): one fetch brings at most `fetchBytes` to
 * disk, no object of it is larger than `objectBytes`, and the volume of the mirrors keeps
 * `volumeBytes` by default (GIT_MIRROR_DIR; core refuses new fetches beyond it).
 */
export const mirrorLimits = Object.freeze({
  fetchBytes: 512 * 1024 * 1024,
  objectBytes: publicationLimits.fileBytes,
  volumeBytes: 20 * 1024 * 1024 * 1024,
  /** A provider that names a larger repository is not fetched at all. */
  repositoryBytes: 1024 * 1024 * 1024,
  /** Bundles kept in the cache of each volume. */
  bundlesKept: 64,
})

export const publicationShaSchema = z.string().regex(/^[a-f0-9]{40}$/)

/** `project_repositories.id`: the key of a mirror and of its cached bundles (§4.6). */
export const projectRepositoryIdSchema = z.uuid()

/**
 * The ref of a chat in the mirror of its repository: the commit of the last published turn
 * (ПР12). Never a branch or a tag of the client's repository.
 */
export const repoChatRef = (chatId: string): string => `refs/raditi/${chatId}`

/** A branch of the client's repository the mirror fetches: main and the pushed branch of a chat. */
export const repoBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (branch) =>
      /^[A-Za-z0-9._/-]+$/.test(branch) &&
      !branch.startsWith('-') &&
      !branch.startsWith('/') &&
      !branch.endsWith('/') &&
      !branch.endsWith('.lock') &&
      !branch.includes('..') &&
      !branch.includes('//') &&
      !branch.includes('/.') &&
      !branch.startsWith('.'),
    'Not a branch name',
  )

/** What a turn publishes: its commit on `baseSha`, under the chat's ref of the mirror. */
export const repoPublicationSchema = z
  .object({
    projectRepositoryId: projectRepositoryIdSchema,
    baseSha: publicationShaSchema,
    chatId: snapshotIdSchema,
    turn: z.number().int().positive().max(999_999),
    // A fixed instant is essential: commit-tree must reproduce the same SHA after a crash.
    createdAt: z.iso.datetime().refine((value) => Number.isFinite(Date.parse(value))),
    /** The chat's ref before this turn (CAS); null — the chat has published nothing yet. */
    expectedRef: publicationShaSchema.nullable(),
  })
  .strict()
export type RepoPublication = z.input<typeof repoPublicationSchema>

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
    path.includes('�') ||
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

/**
 * One changed entry of a candidate. Links, submodules and mode changes are refused; a path of
 * the build (CI files, `.gitmodules`) is not refused but reported — the card of ПР16 shows it
 * before any push (ПР12: «отмечаются, а не отклоняются»).
 */
export function publicationChangeOf(change: PublicationChange): { build: boolean } {
  assertPublicationPath(change.path)
  const modes = new Set(['000000', '100644', '100755'])
  if (
    !modes.has(change.oldMode) ||
    !modes.has(change.newMode) ||
    (change.oldMode !== '000000' &&
      change.newMode !== '000000' &&
      change.oldMode !== change.newMode)
  )
    throw publicationForbidden('Publication contains a link, submodule or permission change')
  if (!Number.isSafeInteger(change.sizeBytes) || change.sizeBytes < 0)
    throw turnOutputRejected('Invalid publication file size')
  if (change.sizeBytes > publicationLimits.fileBytes)
    throw publicationTooLarge('Publication file exceeds the size limit')
  return { build: isForbiddenPath(change.path) }
}

/**
 * The base of a turn with a repository as a git bundle without credentials or history (ПР12):
 * one root commit of the tree of `baseSha` (`sandboxBaseSha`, no parent) under the single ref
 * `refs/heads/raditi-base`. Imported through exec stdin into /workspace/repo on `branch`, after
 * its size and SHA-256 are checked; the patch of the turn later lands on the real `baseSha`.
 */
export interface TurnBundleSource {
  baseSha: string
  sandboxBaseSha: string
  branch: string
  sha256: string
  sizeBytes: number
  read(): AsyncIterable<Uint8Array>
}
