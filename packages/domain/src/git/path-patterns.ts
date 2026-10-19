// Path patterns of the agent's working set (docs/plan/53-chat-preview-release.md, Р11). They
// select files of a Git tree, so a pattern always answers for a whole file path:
// - a trailing `/` marks a directory: the pattern matches every file below it;
// - a leading `/` or a `/` inside anchors the pattern at the root of the repository;
// - a pattern without any `/` but a trailing one matches a name at any depth: the last part of
//   the path (`*.sql`), or for a directory any folder on the way (`node_modules/`);
// - `*` matches within one part of the path, `?` one character of it, and `**` as a whole part
//   any number of parts, none included.
// Unlike .gitignore, `/*` is a file in the root, never a folder there: the working set names the
// folders it takes. Negation, character classes and backslashes are refused, not guessed at.
// Letter case counts, as in Git, unless the caller asks otherwise (`ignoreCase`).

const MAX_PATTERN_BYTES = 1024
const MAX_PARTS = 32

const escapeRegExp = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/** Why `pattern` is not a working-set pattern, or null when it is one. */
export function pathPatternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'empty pattern'
  if (new TextEncoder().encode(pattern).byteLength > MAX_PATTERN_BYTES) return 'pattern too long'
  if ([...pattern].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    return 'control character'
  if (pattern.startsWith('!')) return 'negation is not supported'
  if (/[\\[\]]/.test(pattern)) return 'backslashes and character classes are not supported'
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')
  if (!body) return 'pattern names no path'
  const parts = body.split('/')
  if (parts.length > MAX_PARTS) return 'pattern too deep'
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return 'empty, . or .. part'
    if (part.includes('**') && part !== '**') return '** must be a whole part'
  }
  // A name pattern of `**` alone would take every file: say so with `/**` instead.
  if (parts.length === 1 && parts[0] === '**' && !pattern.startsWith('/')) return 'unanchored **'
  return null
}

function partsRegExp(parts: readonly string[]): string {
  let out = ''
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1
    if (part === '**') out += last ? '[^/].*' : '(?:[^/]+/)*'
    else
      out +=
        part
          .split('*')
          .map((piece) => piece.split('?').map(escapeRegExp).join('[^/]'))
          .join('[^/]*') + (last ? '' : '/')
  }
  return out
}

export interface PathPatternOptions {
  /** Match letters of either case: for what is left out, where a wider match is the safe one. */
  ignoreCase?: boolean
}

/** The test for one pattern; throws on a pattern pathPatternProblem refuses. */
export function compilePathPattern(
  pattern: string,
  options: PathPatternOptions = {},
): (path: string) => boolean {
  const problem = pathPatternProblem(pattern)
  if (problem) throw new Error(`Invalid path pattern "${pattern}": ${problem}`)
  const directory = pattern.endsWith('/')
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')
  const parts = body.split('/')
  const anchored = pattern.startsWith('/') || parts.length > 1
  const head = anchored ? '^' : '(?:^|/)'
  const regExp = new RegExp(
    `${head}${partsRegExp(parts)}${directory ? '/' : '$'}`,
    options.ignoreCase ? 'i' : '',
  )
  return (path) => regExp.test(path)
}

/** True when `path` matches one of `patterns`. */
export function compilePathPatterns(
  patterns: readonly string[],
  options: PathPatternOptions = {},
): (path: string) => boolean {
  const tests = patterns.map((pattern) => compilePathPattern(pattern, options))
  return (path) => tests.some((test) => test(path))
}
