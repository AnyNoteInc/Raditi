import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { isForbiddenPath, normalizeRepoPath } from '../policies/diff-paths.ts'

// The build settings of a project repository (docs/plan/84-projects.md, ПР16, §4.6; slice 84.20):
// which paths are build settings, what core keeps of them (`project_repositories.ci_paths`), what
// `git.ci_lint` leaves for the card «Агент хочет изменить настройки сборки»
// (`project_repo_branches.ci_lint`), and the refusals around it. A branch whose diff touches these
// paths goes to the client only after that card, bound to the SHA-256 of their diff.

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const repoPath = z.string().min(1).max(4096)

/** At most this many `include: local` files are kept of one configuration. */
export const REPO_CI_INCLUDES_KEPT = 100

/**
 * `project_repositories.ci_paths` v1: the client's own paths of build settings, besides the
 * provider's (`support.ciPaths`) and the domain's (`forbiddenCiPaths`).
 */
export const repoCiPathsSchema = z.strictObject({
  v: z.literal(1),
  /** GitLab `ci_config_path` of this very repository; null — the provider's default file. */
  configPath: z.string().min(1).max(255).nullable(),
  /** `ci_config_path` names another project or an address: nothing is sent (ПР16). */
  foreign: z.boolean(),
  /** The files of `include: local` of the main branch, as CI Lint read them. */
  includes: z.array(repoPath).max(REPO_CI_INCLUDES_KEPT),
})
export type RepoCiPaths = z.infer<typeof repoCiPathsSchema>

export const noRepoCiPaths: RepoCiPaths = Object.freeze({
  v: 1,
  configPath: null,
  foreign: false,
  includes: [],
}) as RepoCiPaths

/**
 * What a row holds, read as v1. The form of slice 84.17 — `[ci_config_path]` — reads as its own
 * configuration path; anything else as no own paths.
 */
export function readRepoCiPaths(value: unknown): RepoCiPaths {
  if (Array.isArray(value)) {
    const path = typeof value[0] === 'string' ? ciConfigPathOf(value[0]) : null
    return { ...noRepoCiPaths, configPath: path?.path ?? null, foreign: path?.foreign ?? false }
  }
  const parsed = repoCiPathsSchema.safeParse(value)
  return parsed.success ? parsed.data : noRepoCiPaths
}

/**
 * GitLab `ci_config_path` (https://docs.gitlab.com/ci/pipelines/settings/): empty — the default;
 * a path of this repository; `path@group/project[:ref]` or a URL — another project or an address,
 * which the platform cannot show and so never sends a branch for (ПР16).
 */
export function ciConfigPathOf(value: string | null | undefined): {
  path: string | null
  foreign: boolean
} {
  if (!value) return { path: null, foreign: false }
  if (value.includes('@') || value.includes('://') || value.startsWith('/'))
    return { path: null, foreign: true }
  const normalized = normalizeRepoPath(value)
  if (normalized === null || value.split('/').some((part) => part === '..' || part === ''))
    return { path: null, foreign: true }
  return value.length <= 255 ? { path: normalized, foreign: false } : { path: null, foreign: true }
}

/** The `include: local` files of a CI Lint answer, as paths of the repository; at most 100. */
export function ciIncludePaths(locations: readonly string[]): string[] {
  const paths = new Set<string>()
  for (const location of locations) {
    const normalized = normalizeRepoPath(location)
    if (normalized === null) continue
    // A wildcard include (`configs/**/*.yml`) holds everything below its fixed directory.
    const star = normalized.indexOf('*')
    if (star >= 0) {
      const directory = normalized.slice(0, normalized.lastIndexOf('/', star) + 1)
      paths.add(directory === '' ? '*' : directory)
    } else paths.add(normalized)
    if (paths.size >= REPO_CI_INCLUDES_KEPT) break
  }
  return [...paths].sort()
}

/**
 * Whether a changed path is a build setting (ПР16): `forbiddenCiPaths` and `.gitmodules`, the
 * provider's `support.ciPaths`, the repository's own configuration path and its `include: local`
 * files. A path that cannot be trusted counts as one. An own path that ends with `/` holds what is
 * below it; `*` alone — every path (an include the platform cannot bound).
 */
export function repoBuildPathMatcher(input: {
  providerPaths: readonly string[]
  own: readonly string[]
}): (path: string) => boolean {
  const exact = new Set<string>()
  const below: string[] = []
  let everything = false
  for (const path of input.own) {
    if (path === '*') everything = true
    else if (path.endsWith('/')) {
      const normalized = normalizeRepoPath(path)
      if (normalized) below.push(`${normalized.toLowerCase()}/`)
    } else {
      const normalized = normalizeRepoPath(path)
      if (normalized) exact.add(normalized.toLowerCase())
    }
  }
  return (path) => {
    if (everything) return true
    const normalized = normalizeRepoPath(path)
    if (normalized === null) return true
    if (isForbiddenPath(normalized, input.providerPaths)) return true
    const lower = normalized.toLowerCase()
    return exact.has(lower) || below.some((prefix) => lower.startsWith(prefix))
  }
}

/** The own paths of a row of `ci_paths`: its configuration path and its includes. */
export const repoCiOwnPaths = (ci: RepoCiPaths, extra: readonly string[] = []): string[] => [
  ...(ci.configPath ? [ci.configPath] : []),
  ...ci.includes,
  ...extra,
]

/** The provider's default configuration file when `ci_config_path` names none (GitLab). */
export const DEFAULT_CI_CONFIG_PATH = '.gitlab-ci.yml'

/** A configuration larger than this is not sent to CI Lint. */
export const REPO_CI_CONFIG_LINT_BYTES = 256 * 1024

const ciFile = z.strictObject({
  path: repoPath,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

/**
 * `project_repo_branches.ci_lint` v1 — what `git.ci_lint` found for one head of the chat: the diff
 * of the build settings since the last push (its SHA-256 is `ci_diff_sha256`), CI Lint where the
 * provider has it, and whether the client said «Не отправлять» to this very diff.
 */
export const repoCiLintSchema = z.strictObject({
  v: z.literal(1),
  headSha: sha,
  fromSha: sha,
  ciDiffSha256: sha256.nullable(),
  files: z.array(ciFile).max(50),
  /** The diff is above REPO_DIFF_KEPT_BYTES: it cannot be shown, so it is not sent. */
  tooLarge: z.boolean(),
  lint: z
    .strictObject({ valid: z.boolean(), errors: z.array(z.string().max(1000)).max(50) })
    .nullable(),
  includes: z.array(repoPath).max(REPO_CI_INCLUDES_KEPT),
  declined: z.boolean(),
})
export type RepoCiLint = z.infer<typeof repoCiLintSchema>

/** The key of the diff of the build settings of a head in `raditi-artifacts`: core writes it. */
export const repoCiDiffKey = (taskId: string, headSha: string): string =>
  `repo-ci-diffs/${taskId.toLowerCase()}/${headSha}.diff`

/** `git.ci_lint` of the queue `git`: the chat whose branch touches build settings, at a head. */
export const gitCiLintPayloadSchema = z.strictObject({ taskId: z.uuid(), headSha: sha })

/** The files of one unified diff of git, each with its own part (the card shows them apart). */
export function splitDiffByFile(patch: string): { path: string; diff: string }[] {
  const files: { path: string; diff: string }[] = []
  const starts = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
  for (const [i, match] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : patch.length
    files.push({ path: match[2]!, diff: patch.slice(match.index, end) })
  }
  return files
}

// --- refusals ---------------------------------------------------------------------------------

/** `ci_config_path` names another project or an address (ПР16). */
export const repoCiConfigForeign = (): DomainError =>
  new DomainError('REPO_CI_CONFIG_FOREIGN', 'The build configuration lives elsewhere', 409)

/** The client said «Не отправлять» to this change of build settings. */
export const repoCiDeclined = (): DomainError =>
  new DomainError('REPO_CI_DECLINED', 'The change of build settings was declined', 409)

/** The diff of the build settings is too large to be shown. */
export const repoCiDiffTooLarge = (): DomainError =>
  new DomainError('REPO_CI_DIFF_TOO_LARGE', 'The change of build settings is too large', 409)

/** The words of the refusals of the card, without a final period. */
export const repoCiRefusalTexts = Object.freeze({
  REPO_CI_CONFIG_FOREIGN:
    'Настройки сборки этого проекта лежат в другом репозитории или по адресу — Радити не может показать, что запустит сборка, и не отправляет ветку',
  REPO_CI_DECLINED:
    'Вы не разрешили изменить настройки сборки — попросите агента вернуть файлы сборки, тогда остальное можно будет отправить',
  REPO_CI_DIFF_TOO_LARGE:
    'Изменение настроек сборки больше 2 МБ — Радити не может его показать и не отправляет',
} satisfies Record<string, string>)
