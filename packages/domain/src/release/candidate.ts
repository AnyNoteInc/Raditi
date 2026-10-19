import { z } from 'zod'

import { conflict, type DomainError } from '../errors.ts'
import { mediaChecksSchema, mediaLimits } from '../git/media.ts'
import { addOnlyPathSchema, isPublicationPath } from '../git/publication.ts'
import { turnResultSchema } from '../ports/agent-driver.ts'
import type { DbPlan } from './db-plan.ts'
import type { VersionFacts } from './semver.ts'

/**
 * A candidate (docs/plan/53-chat-preview-release.md, Р5, Р7, Р22, Р27): what a pass that
 * changed something left — the base it stands on, the commit of its files, its media, the
 * compacted database plan, the checks and the revision of the preview. One `current` candidate
 * per dialog; a new pass with changes supersedes it.
 */
export const candidateStatuses = ['current', 'superseded', 'stale', 'released'] as const
export type CandidateStatus = (typeof candidateStatuses)[number]

export const candidateCheckStatuses = ['pending', 'passed', 'failed', 'stale'] as const
export type CandidateCheckStatus = (typeof candidateCheckStatuses)[number]

/** `candidate_checks.kind`. */
export const candidateCheckKinds = ['php_lint', 'preview_smoke', 'agent_browser'] as const
export type CandidateCheckKind = (typeof candidateCheckKinds)[number]

const transitions: Record<CandidateStatus, readonly CandidateStatus[]> = {
  // A new pass with changes supersedes; a release that ended later makes it stale; it is released.
  current: ['superseded', 'stale', 'released'],
  // «Обновить» makes a new revision of the dialog: the stale one is superseded by it.
  stale: ['superseded'],
  superseded: [],
  released: [],
}

export function canCandidateTransition(from: CandidateStatus, to: CandidateStatus): boolean {
  return transitions[from].includes(to)
}

export function assertCandidateTransition(from: CandidateStatus, to: CandidateStatus): void {
  if (!canCandidateTransition(from, to)) throw invalidTransition(from, to)
}

const invalidTransition = (from: CandidateStatus, to: CandidateStatus): DomainError =>
  conflict(`Candidate cannot move from ${from} to ${to}`)

// ---------------------------------------------------------------------------------------------
// What a candidate holds (JSONB columns of task_candidates)
// ---------------------------------------------------------------------------------------------

export const candidateLimits = Object.freeze({
  files: 10_000,
  media: 1_000,
  /** One media file (Р12). */
  mediaFileBytes: mediaLimits.fileBytes,
  /** `task_candidates.files` as PostgreSQL prints it (CHECK task_candidates_json_check). */
  filesJsonBytes: 4 * 1024 * 1024,
  /** `task_candidates.media`, the same way. */
  mediaJsonBytes: 1024 * 1024,
})

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** Separators PostgreSQL prints with a space after them: `: ` and `, `. */
function jsonbSpaces(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce<number>(
      (sum, item) => sum + jsonbSpaces(item),
      Math.max(value.length - 1, 0),
    )
  if (value === null || typeof value !== 'object') return 0
  const entries = Object.values(value).filter((item) => item !== undefined)
  return entries.reduce<number>(
    (sum, item) => sum + jsonbSpaces(item),
    entries.length + Math.max(entries.length - 1, 0),
  )
}

/**
 * The bytes of `value` as `jsonb::text`, which a CHECK measures with `octet_length`: the UTF-8
 * of the JSON and one space after every `:` and `,`. Escapes and numbers print alike.
 */
export const jsonbTextBytes = (value: unknown): number =>
  utf8Bytes(JSON.stringify(value)) + jsonbSpaces(value)

const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPublicationPath, 'expected a relative path of the site tree')
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const candidateFileChanges = ['added', 'modified', 'deleted'] as const
export type CandidateFileChange = (typeof candidateFileChanges)[number]

/** `task_candidates.files`: the diff of the candidate against its base, path by path. */
export const candidateFilesSchema = z
  .array(
    z.strictObject({
      path,
      change: z.enum(candidateFileChanges),
      /** Size after the change; 0 for a deleted file. */
      sizeBytes: z.number().int().min(0),
      executable: z.boolean(),
    }),
  )
  .max(candidateLimits.files)
  .refine(
    (files) => jsonbTextBytes(files) <= candidateLimits.filesJsonBytes,
    'the list of files is too large',
  )
export type CandidateFiles = z.infer<typeof candidateFilesSchema>

/** `task_candidates.media`: files added under the media path of the stack, never changed. */
export const candidateMediaSchema = z
  .array(
    z.strictObject({
      path,
      contentType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
      sizeBytes: z.number().int().min(1).max(candidateLimits.mediaFileBytes),
      sha256,
    }),
  )
  .max(candidateLimits.media)
  .refine(
    (media) => jsonbTextBytes(media) <= candidateLimits.mediaJsonBytes,
    'the list of media is too large',
  )
export type CandidateMedia = z.infer<typeof candidateMediaSchema>

const turnResult = turnResultSchema.shape

/** `task_candidates.facts`: counts and the agent's claims, read by the platform. */
export const candidateFactsSchema = z.strictObject({
  changeType: turnResult.change_type,
  risk: turnResult.risk,
  addedFiles: z.number().int().min(0),
  modifiedFiles: z.number().int().min(0),
  deletedFiles: z.number().int().min(0),
  mediaFiles: z.number().int().min(0),
  dbObjects: z.number().int().min(0),
  /**
   * Of the plan's objects (docs/plan/53, «Операции БД и миграции»): settings, created records and
   * tables; a candidate recorded before them reads 0.
   */
  dbSettings: z.number().int().min(0).default(0),
  dbCreated: z.number().int().min(0).default(0),
  dbTables: z.number().int().min(0).default(0),
  /**
   * Changed files whose text names the id a record created by the plan has in the preview: on
   * production the record gets another, and such a file would point at nothing. A release refuses
   * a candidate with any.
   */
  createdIdFiles: z.number().int().min(0).default(0),
  newFunctionality: z.boolean(),
})
/** As written: the counts of the plan's kinds may be absent and read 0. */
export type CandidateFacts = z.input<typeof candidateFactsSchema>

/** The counts of a candidate's facts from its files, media and plan. */
export function candidateCounts(
  files: CandidateFiles,
  media: CandidateMedia,
  plan: DbPlan,
): Pick<
  CandidateFacts,
  | 'addedFiles'
  | 'modifiedFiles'
  | 'deletedFiles'
  | 'mediaFiles'
  | 'dbObjects'
  | 'dbSettings'
  | 'dbCreated'
  | 'dbTables'
> {
  const count = (change: CandidateFileChange) =>
    files.filter((file) => file.change === change).length
  const kind = (name: DbPlan[number]['kind']) =>
    plan.filter((operation) => operation.kind === name).length
  return {
    addedFiles: count('added'),
    modifiedFiles: count('modified'),
    deletedFiles: count('deleted'),
    mediaFiles: media.length,
    dbObjects: plan.length,
    dbSettings: kind('option_update'),
    dbCreated: kind('post_create'),
    dbTables: kind('schema_migration'),
  }
}

/**
 * «Ничего не изменилось» counts from the start (Р5): the tree of the pass equals the tree of the
 * base and the plan is empty. A pass on top of a candidate without new changes keeps its revision.
 */
export function isEmptyCandidate(input: {
  headTree: string
  baseTree: string
  plan: DbPlan
}): boolean {
  return input.headTree === input.baseTree && input.plan.length === 0
}

/**
 * What the number of a candidate is proposed by (Р26): an added medium is a new file too, so a
 * candidate that adds an image is a minor release. One rule for core, which records the
 * proposal with the candidate, and for web, which offers the numbers again at `/release`.
 */
export function candidateVersionFacts(facts: CandidateFacts): VersionFacts {
  return {
    changeType: facts.changeType,
    risk: facts.risk,
    addedFiles: facts.addedFiles + facts.mediaFiles,
    deletedFiles: facts.deletedFiles,
    newFunctionality: facts.newFunctionality,
    // A table of its own is something the site did not have: a minor release at least.
    newTables: facts.dbTables ?? 0,
  }
}

/**
 * The diff of a candidate in `raditi-artifacts` (docs/plan/53-chat-preview-release.md, «Имена»):
 * `git diff --binary --full-index --no-renames` of its base against its head, unencrypted — web
 * has no Transit. core writes it when it records the candidate; web reads the part of one file
 * for the «Файлы» tab. The id is written as PostgreSQL prints it.
 */
export const candidatePatchKey = (taskId: string, revision: number): string =>
  `candidates/${taskId.toLowerCase()}/${revision}/patch.diff`

/**
 * `raditi-artifacts`: a screenshot the agent's browser took of the preview (Р21, N22), PNG without
 * encryption — the cabinet shows it, and web has no Transit. The mcp role writes it; core makes it
 * the artifact of the candidate's check `agent_browser`; web reads it for the «Проверки» tab. The
 * task's own prefix: the sweep of the task's content removes it (spec §14).
 */
export const browserScreenshotKey = (taskId: string, id: string): string =>
  `tasks/${taskId.toLowerCase()}/screenshots/${id.toLowerCase()}.png`

/** The largest screenshot the mcp role stores, and web serves. */
export const BROWSER_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------------------------
// May it be released (Р27)
// ---------------------------------------------------------------------------------------------

export const candidateRefusals = [
  /** Not the current candidate of its dialog. */
  'not_current',
  /** The client saw another revision. */
  'revision_changed',
  'checks_failed',
  /** The tree of its base is not the tree of `main`: «Обновить» first. */
  'base_outdated',
  'release_in_progress',
] as const
export type CandidateRefusal = (typeof candidateRefusals)[number]

export interface CandidateReadinessInput {
  status: CandidateStatus
  revision: number
  /** The revision the client confirmed. */
  confirmedRevision: number
  checks: readonly { status: CandidateCheckStatus }[]
  baseTree: string
  mainTree: string
  releaseInProgress: boolean
}

/** Every reason the candidate cannot be released now; empty — it can. */
export function candidateRefusalsOf(input: CandidateReadinessInput): CandidateRefusal[] {
  const reasons: CandidateRefusal[] = []
  if (input.status !== 'current') reasons.push('not_current')
  if (input.revision !== input.confirmedRevision) reasons.push('revision_changed')
  if (input.checks.some((check) => check.status === 'failed')) reasons.push('checks_failed')
  if (input.baseTree !== input.mainTree) reasons.push('base_outdated')
  if (input.releaseInProgress) reasons.push('release_in_progress')
  return reasons
}

// ---------------------------------------------------------------------------------------------
// What a stack adapter says about the agent's tree and media (SiteAdapter)
// ---------------------------------------------------------------------------------------------

// The working set and the media checks live with the publication that enforces them
// (git/working-set.ts, git/media.ts); the adapter's answers are checked by these schemas.
export { agentWorkingSetSchema, type AgentWorkingSet } from '../git/working-set.ts'

/**
 * `SiteAdapter.mediaRules()` (Р12): where the agent may add media and what it may add. Only
 * additions; a name with one of `refusedNameParts` or a leading dot is refused at any depth.
 */
export const mediaRulesSchema = mediaChecksSchema.extend({
  /** Directories, each ending in `/` (`PublicationMetadata.addOnlyPaths`). */
  addOnlyPaths: z.array(addOnlyPathSchema).max(8),
})
export type MediaRules = z.infer<typeof mediaRulesSchema>
