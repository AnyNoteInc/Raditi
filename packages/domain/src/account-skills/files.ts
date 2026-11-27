import { SANDBOX_SKILLS } from '../ports/agent-driver.ts'
import { secretInContent } from '../projects/text.ts'
import { skillInvalid } from './errors.ts'
import { accountSkillLimits } from './limits.ts'
import { isSkillName } from './name.ts'

// The files of a skill (docs/plan/97-skills.md, Нв4, Нв10, Нв13): how a path inside a skill is
// cleaned, which files are dropped on the way in, how a whole skill is checked, where its objects
// lie in raditi-inbox and where a turn finds them. Pure rules: web, core and the runner read the
// same ones.

export const SKILL_MD = 'SKILL.md'

/** One file of a skill as an installer read it: its clean path inside the skill and its bytes. */
export interface SkillFileEntry {
  path: string
  bytes: Uint8Array
  /** A program to run (a git mode 100755, a zip entry with the bit, or anything under `scripts/`). */
  executable: boolean
}

const control = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/**
 * A path inside a skill: relative, parts separated by `/`, none empty, `.` or `..`, no control
 * character or backslash, at most 10 parts and 255 characters. null — not a clean path.
 */
export function skillFilePath(raw: string): string | null {
  if (raw.length === 0 || raw.length > accountSkillLimits.pathChars) return null
  if (raw.startsWith('/') || raw.includes('\\') || control(raw)) return null
  const parts = raw.split('/')
  if (parts.length > accountSkillLimits.pathParts) return null
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return raw
}

/**
 * Files an installer leaves out without a word: what a repository or an archive carries beside a
 * skill — git, the caches of Python and macOS, packages someone forgot. They are not the skill.
 */
export function isSkillJunk(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1)!
  return (
    parts.some((part) =>
      ['.git', '__pycache__', 'node_modules', '.venv', '__MACOSX', '.DS_Store'].includes(part),
    ) ||
    name === 'Thumbs.db' ||
    name.endsWith('.pyc')
  )
}

/** Whether a file is a program the skill runs: the executable bit, or a place under `scripts/`. */
export const skillFileExecutable = (path: string, bit: boolean): boolean =>
  bit || path.startsWith('scripts/')

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The text of a file when it is UTF-8 without NUL, else null: a picture, a font, an archive. */
export function skillFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

/**
 * A whole version of a skill before it is kept (Нв10): `SKILL.md` at its root, every path clean
 * and once, no file that is also a folder, within the bounds of a skill, and no text that holds a
 * secret (secretInContent, the check of the files of a project). Returns the text of `SKILL.md`;
 * SKILL_INVALID with the reason otherwise.
 */
export function checkSkillFiles(files: readonly SkillFileEntry[]): string {
  if (files.length > accountSkillLimits.filesPerSkill) throw skillInvalid('too_many_files')
  let bytes = 0
  let skillMd: string | null = null
  const paths = new Set<string>()
  for (const file of files) {
    if (skillFilePath(file.path) !== file.path || paths.has(file.path))
      throw skillInvalid('path', file.path)
    for (const other of paths)
      if (other.startsWith(`${file.path}/`) || file.path.startsWith(`${other}/`))
        throw skillInvalid('path', file.path)
    paths.add(file.path)
    if (file.bytes.byteLength > accountSkillLimits.fileBytes)
      throw skillInvalid('file_too_large', file.path)
    bytes += file.bytes.byteLength
    const text = skillFileText(file.bytes)
    if (file.path === SKILL_MD) {
      if (file.bytes.byteLength > accountSkillLimits.skillMdBytes)
        throw skillInvalid('skill_md_too_large')
      if (text === null) throw skillInvalid('frontmatter')
      skillMd = text
    }
    if (text !== null && secretInContent(text)) throw skillInvalid('secret', file.path)
  }
  if (bytes > accountSkillLimits.skillBytes) throw skillInvalid('too_large')
  if (skillMd === null) throw skillInvalid('no_skill_md')
  return skillMd
}

/** The key of a file of a version of a skill in raditi-inbox (Нв4). */
export const accountSkillFileKey = (userId: string, versionId: string, index: number): string =>
  `skills/${userId}/${versionId}/${index}`

/** The prefix of every object of one version, for its removal. */
export const accountSkillVersionPrefix = (userId: string, versionId: string): string =>
  `skills/${userId}/${versionId}/`

/** Where a turn finds a file of a skill of its account (Нв13). null — not a clean path. */
export function turnSkillPath(name: string, path: string): string | null {
  return isSkillName(name) && skillFilePath(path) === path
    ? `${SANDBOX_SKILLS}/${name}/${path}`
    : null
}

/** The skill and the path inside it a path of turnSkillPath() names; null for any other path. */
export function turnSkillFileOf(path: string): { name: string; path: string } | null {
  if (!path.startsWith(`${SANDBOX_SKILLS}/`)) return null
  const rest = path.slice(SANDBOX_SKILLS.length + 1)
  const at = rest.indexOf('/')
  if (at < 1) return null
  const name = rest.slice(0, at)
  const inner = rest.slice(at + 1)
  return turnSkillPath(name, inner) === path ? { name, path: inner } : null
}

/** The mode a file of a skill gets in the sandbox: the agent reads and runs it, never changes it. */
export const turnSkillFileMode = (executable: boolean): number => (executable ? 0o555 : 0o444)
