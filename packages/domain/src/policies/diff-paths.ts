import { badRequest } from '../errors.ts'

/**
 * DiffPolicy paths — spec §8 (publication), §10. Pure core logic: the trusted side runs it on
 * every path of an agent patch before `git apply --cached`.
 */

/**
 * Paths an agent diff may never touch, for every provider (spec §10, CLAUDE.md rule 6),
 * on top of SiteAdapter.protectedPaths(). Matched as path prefixes; `*` is a wildcard.
 */
export const forbiddenCiPaths = [
  '.gitea/',
  '.github/',
  '.gitlab-ci.yml',
  '.gitlab/',
  '.forgejo/',
  '.woodpecker*',
  '.drone.yml',
  'Jenkinsfile',
  'bitbucket-pipelines.yml',
  '.circleci/',
  '.gitmodules',
] as const

/**
 * Normalises a repository-relative path taken from an agent diff: backslashes become `/`,
 * leading `./` and `/`, empty and `.` segments are dropped. Returns null when the path cannot
 * be trusted at all: empty, contains NUL or has a `..` segment.
 */
export function normalizeRepoPath(path: string): string | null {
  if (path.includes('\0')) return null
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return segments.join('/')
}

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * A pattern matches as a path prefix; `*` matches within one path segment. A trailing `/`
 * marks a directory: `wp-admin/` matches `wp-admin` and everything below it, but not
 * `wp-admin-custom.php`. A leading `**` part lets the rest start at any depth: `**` + `/.htaccess`
 * matches `.htaccess` and `wp-content/themes/shop/.htaccess` (docs/plan/53, Р12); `**` anywhere
 * else is refused, never read as `*`. Matching ignores case, because some hostings (FTP on
 * Windows, macOS volumes) treat `WP-CONFIG.PHP` as `wp-config.php`.
 */
function compilePattern(pattern: string): RegExp {
  const normalized = normalizeRepoPath(pattern)
  const anyDepth = normalized?.startsWith('**/') === true
  const rest = anyDepth ? normalized!.slice(3) : normalized
  if (rest === null || rest === '' || rest.includes('**'))
    throw badRequest(`Invalid protected path pattern: "${pattern}"`)
  const isDirectory = /[/\\]$/.test(pattern)
  const body = rest.split('*').map(escapeRegExp).join('[^/]*')
  return new RegExp(`^${anyDepth ? '(?:[^/]+/)*' : ''}${body}${isDirectory ? '(?:/|$)' : ''}`, 'i')
}

const ciMatchers = forbiddenCiPaths.map(compilePattern)

/**
 * The patterns of `patterns` that match at any depth (a leading `**` part). They hold under the
 * add-only directories too, where the other protected paths give way (docs/plan/53, Р12): the
 * media name rules already refuse `.htaccess` there, and these patterns are the second line
 * next to them (owner's answer of 19.10.2026), so a new any-depth pattern of an adapter holds
 * there without a new media rule.
 */
export function anyDepthPatterns(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => normalizeRepoPath(pattern)?.startsWith('**/') === true)
}

/**
 * True when an agent diff may not touch `path`: CI files of every provider (CLAUDE.md rule 6)
 * plus `extraProtected`, usually SiteAdapter.protectedPaths(). Untrustworthy paths
 * (`..`, NUL, empty) count as forbidden.
 */
export function isForbiddenPath(path: string, extraProtected: readonly string[] = []): boolean {
  const normalized = normalizeRepoPath(path)
  if (normalized === null) return true
  const matchers = [...ciMatchers, ...extraProtected.map(compilePattern)]
  return matchers.some((re) => re.test(normalized))
}
