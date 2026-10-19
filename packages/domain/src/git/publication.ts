import { z } from 'zod'

import { publicationForbidden, publicationTooLarge, turnOutputRejected } from '../errors.ts'
import { isForbiddenPath } from '../policies/diff-paths.ts'
import { gitProviderKinds } from '../ports/git-provider.ts'
import { snapshotLimits } from '../sessions/session-state.ts'
import { snapshotIdSchema } from '../sessions/snapshot-manifest.ts'
import {
  mediaChecksSchema,
  mediaContentProblem,
  mediaNameProblem,
  type MediaChecks,
} from './media.ts'
import { agentWorkingSetSchema, workingSetMatcher } from './working-set.ts'

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
/**
 * A directory where the agent may only add files (docs/plan/53-chat-preview-release.md, Р12):
 * a relative path ending in `/`, e.g. `wp-content/uploads/raditi/`.
 */
export const addOnlyPathSchema = z
  .string()
  .min(2)
  .max(publicationLimits.pathBytes)
  .refine(
    (path) => path.endsWith('/') && isPublicationPath(path.slice(0, -1)),
    'expected a relative directory ending in /',
  )

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
    /** Trusted replacement CAS: last completed task head; null means no published branch yet. */
    expectedBranchSha: publicationShaSchema.nullable().optional(),
    /** SiteAdapter.protectedPaths() of the site; required so a caller cannot silently omit it. */
    protectedPaths: z.array(z.string().min(1).max(1024)).max(100),
    /**
     * `SiteAdapter.agentWorkingSet()` (Р11): the part of `expectedBaseSha` the agent gets and may
     * change. The bundle then carries one root commit of it (`sandboxBaseSha`), `capture` diffs
     * against that commit, and publication applies the patch to the full `expectedBaseSha` and
     * refuses any change outside the set but new media under `addOnlyPaths`. Those directories
     * never go into the sandbox, even when the set names them: they only grow. Absent in plans
     * written before the working set: the agent gets the full tree, as before.
     */
    workingSet: agentWorkingSetSchema.optional(),
    /**
     * The commit of the working set, when the planner computed it (TurnWorkspace.sandboxBase):
     * the bundle and publication refuse a different one. Absent — derived from `workingSet`,
     * `expectedBaseSha` and the turn's `committedAt`, deterministically.
     */
    sandboxBaseSha: publicationShaSchema.optional(),
    /**
     * `SiteAdapter.mediaRules().addOnlyPaths` (Р12): under these the patch may only add files,
     * which then pass `media`. They win over `protectedPaths` (a stack protects its media library
     * and opens one directory of it). Absent — no path is add-only, as before.
     */
    addOnlyPaths: z.array(addOnlyPathSchema).max(8).optional(),
    /** The rest of `SiteAdapter.mediaRules()`; required with `addOnlyPaths`. */
    media: mediaChecksSchema.optional(),
  })
  .strict()
export type PublicationSource = z.input<typeof publicationSourceSchema>

/**
 * The rules that span fields of a source, as one refinement: a working-set commit needs the
 * working set it was cut by, add-only paths need their media checks.
 */
export function publicationRulesHold(source: {
  workingSet?: unknown
  sandboxBaseSha?: string
  addOnlyPaths?: readonly string[]
  media?: unknown
}): boolean {
  if (source.sandboxBaseSha !== undefined && source.workingSet === undefined) return false
  if (source.addOnlyPaths?.length && source.media === undefined) return false
  return true
}

/** The add-only directory `path` lies below, if any (Р12). Letter case counts, as in Git. */
export function addOnlyPathOf(
  path: string,
  addOnlyPaths: readonly string[] | undefined,
): string | undefined {
  return addOnlyPaths?.find((prefix) => path.startsWith(prefix) && path.length > prefix.length)
}

export const publicationMetadataSchema = publicationSourceSchema
  .extend({
    taskId: snapshotIdSchema,
    turn: z.number().int().positive().max(999_999),
    // A fixed instant is essential: commit-tree must reproduce the same SHA after a crash.
    createdAt: z.iso.datetime().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict()
  .refine((value) => value.branch === `agent/${value.taskId}`, 'task branch mismatch')
  .refine(publicationRulesHold, 'a working-set commit or add-only paths without their rules')
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

/**
 * What a candidate may change (docs/plan/53-chat-preview-release.md, Р11, Р12): the site's
 * protected paths, its working set and the add-only directories with their media checks. The
 * add-only directories lie outside the working set: the agent adds files there it cannot see.
 */
export interface CandidateRules {
  protectedPaths: readonly string[]
  /** Null without a working set: every path the protected ones allow. */
  inWorkingSet: ((path: string) => boolean) | null
  addOnlyPaths?: readonly string[]
  media?: MediaChecks
}

export function candidateRulesOf(source: PublicationSource): CandidateRules {
  return {
    protectedPaths: source.protectedPaths,
    inWorkingSet: source.workingSet ? workingSetMatcher(source.workingSet) : null,
    ...(source.addOnlyPaths ? { addOnlyPaths: source.addOnlyPaths } : {}),
    ...(source.media ? { media: source.media } : {}),
  }
}

const outsideWorkingSet = () =>
  publicationForbidden('Publication changes a path outside the working set')
const mediaOnlyAdded = () =>
  publicationForbidden('Media under an add-only path may only be added, never changed or deleted')

/**
 * The checks of a path whatever its change is — before a patch is applied its modes are not
 * known yet. An add-only directory wins over the working set and the protected paths, never
 * over the CI ones.
 */
export function assertCandidatePath(path: string, rules: CandidateRules): void {
  assertPublicationPath(path)
  const prefix = addOnlyPathOf(path, rules.addOnlyPaths)
  if (!prefix && rules.inWorkingSet && !rules.inWorkingSet(path)) throw outsideWorkingSet()
  if (isForbiddenPath(path, prefix ? [] : rules.protectedPaths))
    throw publicationForbidden('Publication changes a protected path')
  if (!prefix) return
  if (!rules.media) throw mediaOnlyAdded()
  const problem = mediaNameProblem(path.slice(prefix.length), rules.media)
  if (problem) throw publicationForbidden(`Publication adds media the rules refuse: ${problem}`)
}

/** One changed entry of the candidate: its path, modes and size. */
export function assertCandidateChange(change: PublicationChange, rules: CandidateRules): void {
  const prefix = addOnlyPathOf(change.path, rules.addOnlyPaths)
  if (!prefix) {
    assertPublicationChange(change, rules.protectedPaths)
    if (rules.inWorkingSet && !rules.inWorkingSet(change.path)) throw outsideWorkingSet()
    return
  }
  assertCandidatePath(change.path, rules)
  if (change.oldMode !== '000000' || change.newMode === '000000') throw mediaOnlyAdded()
  if (change.newMode !== '100644')
    throw publicationForbidden('Publication contains a link, submodule or permission change')
  if (!Number.isSafeInteger(change.sizeBytes) || change.sizeBytes < 0)
    throw turnOutputRejected('Invalid publication file size')
  if (change.sizeBytes > rules.media!.maxFileBytes)
    throw publicationTooLarge('Media file exceeds its size limit')
}

/** The content of a media file the candidate adds; true when `path` is one. */
export function assertCandidateMedia(
  path: string,
  bytes: Uint8Array,
  rules: CandidateRules,
): boolean {
  const prefix = addOnlyPathOf(path, rules.addOnlyPaths)
  if (!prefix) return false
  const problem = rules.media
    ? mediaContentProblem(path.slice(prefix.length), bytes, rules.media)
    : 'extension'
  if (problem === 'size') throw publicationTooLarge('Media file exceeds its size limit')
  if (problem) throw publicationForbidden(`Publication adds media the rules refuse: ${problem}`)
  return true
}
