import { z } from 'zod'

import { DomainError, isDomainError } from '../errors.ts'
import type { MediaChecks } from './media.ts'
import { compilePathPatterns, pathPatternProblem } from './path-patterns.ts'

// The agent's working set (docs/plan/53-chat-preview-release.md, Р11): the part of the site's
// full tree its sandbox gets. The rest — the core of the CMS, the media library, configuration
// with secrets, the platform's own files — stays in the repository and in the preview, never
// in the sandbox, and a candidate may not change it.

const pattern = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => pathPatternProblem(value) === null, 'invalid path pattern')

/**
 * The largest working set any stack may ask for. 256 MiB since 26.10.2026: a real WordPress site
 * of the owner (two ready-made block and form plugins of 34 and 33 MB) had a working set of 84 MB
 * and no turn could start. The bundle of the set keeps its own limit (`publicationLimits.bundleBytes`),
 * the sandbox limits stay as they are.
 */
export const WORKING_SET_MAX_BYTES = 256 * 1024 * 1024

/**
 * `SiteAdapter.agentWorkingSet()`: path patterns over the tree of `expectedBaseSha` in the
 * syntax of path-patterns.ts. A file is in the working set when an `include` pattern matches it
 * and no `exclude` pattern does. Excludes ignore letter case: `BACKUP.SQL` or `.ENV` left by a
 * hosting is as much a dump or a secret as its lower-case name, and leaving more out is safe.
 */
export const agentWorkingSetSchema = z.strictObject({
  include: z.array(pattern).min(1).max(256),
  exclude: z.array(pattern).max(256),
  /** Above this the turn is refused with `working_set_too_large`. */
  maxBytes: z.number().int().positive().max(WORKING_SET_MAX_BYTES),
})
export type AgentWorkingSet = z.infer<typeof agentWorkingSetSchema>

/** The test of membership; throws on a working set its schema refuses. */
export function workingSetMatcher(set: AgentWorkingSet): (path: string) => boolean {
  const include = compilePathPatterns(set.include)
  const exclude = compilePathPatterns(set.exclude, { ignoreCase: true })
  return (path) => include(path) && !exclude(path)
}

const WORKING_SET_TOO_LARGE = 'working_set_too_large'

/**
 * The agent's part of the site exceeds its working set limit or the bundle limit: a 413 like
 * every size limit, told apart by its reason.
 */
export const workingSetTooLarge = (message = 'Working set exceeds its size limit'): DomainError =>
  new DomainError('REPOSITORY_TOO_LARGE', message, 413, { reason: WORKING_SET_TOO_LARGE })

export function isWorkingSetTooLarge(error: unknown): error is DomainError {
  return (
    isDomainError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === WORKING_SET_TOO_LARGE
  )
}

/**
 * The commit of the working set (`workspace.sandboxBaseSha`): a root commit of the platform's
 * bot whose tree is the working set of `baseSha`, made at the turn's `committedAt`. Its message
 * names the full commit it was cut from, so the same base, set and instant give the same SHA.
 */
export function workingSetCommitMessage(baseSha: string): string {
  return `Raditi working set of ${baseSha}\n\nRaditi-Base: ${baseSha}\n`
}

/**
 * What a turn's `workspace` takes from the site's adapter: the protected paths, the working set
 * and the add-only media rules. One call, so a planner cannot take one and forget another.
 */
export function siteWorkspaceRules<Site>(
  // The three methods of SiteAdapter, named here so the port and this module do not import
  // each other.
  adapter: {
    protectedPaths(site: Site): string[]
    agentWorkingSet(site: Site): AgentWorkingSet
    mediaRules(site: Site): MediaChecks & { addOnlyPaths: string[] }
  },
  site: Site,
) {
  const { addOnlyPaths, ...media } = adapter.mediaRules(site)
  return {
    protectedPaths: adapter.protectedPaths(site),
    workingSet: adapter.agentWorkingSet(site),
    addOnlyPaths,
    media,
  }
}
