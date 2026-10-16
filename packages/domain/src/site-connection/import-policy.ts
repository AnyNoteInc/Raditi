import { badRequest } from '../errors.ts'
import { isPublicationPath } from '../git/publication.ts'
import { isForbiddenPath } from '../policies/diff-paths.ts'
import { hasControlCharacter } from './inputs.ts'
import type { ImportSkipReason } from './reasons.ts'

export interface ImportPathPolicy {
  /** `path` is repository-relative with `/`; a directory decision lets the walker not descend. */
  decide(path: string, type: 'file' | 'directory'): 'take' | ImportSkipReason
}

/** The pattern of publication.ts: `.git` or its NTFS short name, with what NTFS ignores after it. */
const ntfsDotGit = /^(?:\.git|git~1)[. ]*(?::|$)/i
/** Working copies of the other version control systems; `CVS` is upper case as the tool writes it. */
const otherVcs = /^(?:\.svn|\.hg|\.bzr)$/i

/**
 * `.svn/pristine/` keeps a copy of every file, the configuration with its passwords included,
 * under hashed names that no exclude line can match; a directory `*.git` is a bare repository
 * left next to the code.
 */
function isVcsSegment(segment: string, isDirectory: boolean): boolean {
  return (
    ntfsDotGit.test(segment) ||
    otherVcs.test(segment) ||
    segment === 'CVS' ||
    (isDirectory && /\.git$/i.test(segment))
  )
}

const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
/** `*` stays inside one segment. */
const segmentSource = (pattern: string) => pattern.split('*').map(escapeRegExp).join('[^/]*')
const anySegment = (patterns: readonly string[]) =>
  patterns.length === 0 ? null : new RegExp(`^(?:${patterns.map(segmentSource).join('|')})$`, 'i')

interface AnchoredRule {
  segments: RegExp[]
  directoryOnly: boolean
}

/**
 * Throws badRequest for a line outside the supported subset, so an adapter cannot add one silently.
 *
 * The subset of .gitignore syntax the adapters use: a leading `/` — or a `/` in the middle —
 * anchors the line to the root; a trailing `/` matches directories only; `*` stays inside one
 * segment; a line without a slash matches at any depth. A matched directory excludes everything
 * below it. Matching ignores letter case: it only excludes more.
 */
export function createImportPathPolicy(excludeLines: readonly string[]): ImportPathPolicy {
  const anchored: AnchoredRule[] = []
  const names: string[] = []
  const directoryNames: string[] = []
  for (const line of excludeLines) {
    const directoryOnly = line.endsWith('/')
    const pattern = line.replace(/^\//, '').replace(/\/$/, '')
    const segments = pattern.split('/')
    if (
      line.startsWith('#') ||
      line.trim() !== line ||
      /\*\*|[![?\\]/.test(line) ||
      segments.includes('') ||
      // No path of a repository has such a segment or character: the line would match nothing.
      segments.includes('.') ||
      segments.includes('..') ||
      hasControlCharacter(line)
    )
      throw badRequest(`Unsupported import exclude line: "${line}"`)
    if (line.startsWith('/') || segments.length > 1) {
      anchored.push({
        segments: segments.map((segment) => new RegExp(`^${segmentSource(segment)}$`, 'i')),
        directoryOnly,
      })
    } else {
      ;(directoryOnly ? directoryNames : names).push(pattern)
    }
  }
  const anyName = anySegment(names)
  const anyDirectoryName = anySegment(directoryNames)

  function isExcluded(segments: readonly string[], type: 'file' | 'directory'): boolean {
    const last = segments.length - 1
    // Every segment but the last is a directory, whatever the entry itself is.
    const isDirectory = (index: number) => index < last || type === 'directory'
    if (
      segments.some(
        (segment, index) =>
          anyName?.test(segment) || (isDirectory(index) && anyDirectoryName?.test(segment)),
      )
    )
      return true
    return anchored.some(
      (rule) =>
        rule.segments.length <= segments.length &&
        rule.segments.every((pattern, index) => pattern.test(segments[index] ?? '')) &&
        (!rule.directoryOnly || isDirectory(rule.segments.length - 1)),
    )
  }

  return {
    decide(path, type) {
      const segments = path.split('/')
      const last = segments.length - 1
      // First: isPublicationPath refuses the `.git` paths too and would report them as unsupported.
      if (
        segments.some((segment, index) =>
          isVcsSegment(segment, index < last || type === 'directory'),
        )
      )
        return 'vcs'
      if (!isPublicationPath(path)) return 'unsupported_path'
      // CLAUDE.md rule 6: the CI paths of every provider and `.gitmodules`.
      if (isForbiddenPath(path, [])) return 'ci'
      return isExcluded(segments, type) ? 'excluded' : 'take'
    },
  }
}

/** A folder below the root that has every marker is another installation: not entered. */
export function isNestedSiteRoot(
  entryNames: readonly string[],
  markers: readonly string[],
): boolean {
  if (markers.length === 0) return false
  const names = new Set(entryNames.map((name) => name.toLowerCase()))
  return markers.every((marker) => names.has(marker.toLowerCase()))
}

/**
 * One path segment that may become part of a repository path: not empty, not `.` or `..`, no
 * separator, no control character — C1 included, which is what the cp1251 step of the FTP
 * decoder makes of the one byte it cannot map —, no U+FFFD and no lone surrogate (an encoder
 * would write it as U+FFFD), at most 255 bytes.
 */
export function isImportSegment(name: string): boolean {
  return !(
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    hasControlCharacter(name, { c1: true }) ||
    name.includes('\ufffd') ||
    !name.isWellFormed() ||
    new TextEncoder().encode(name).byteLength > 255
  )
}
