import {
  accountSkillLimits,
  isDomainError,
  isSkillJunk,
  skillFileExecutable,
  skillFilePath,
  skillInvalid,
  SKILL_MD,
  type SkillFileEntry,
} from '@repo/domain'
import { unzipSync, type UnzipFileInfo } from 'fflate'

import { readSkillVersion, type SkillVersion } from './skill-md.ts'

// An archive the client uploads (docs/plan/97-skills.md, Нв9): a `.zip`, or a `.skill` of
// `package_skill.py` of Claude — a zip too. One skill: its `SKILL.md` at the root of the archive,
// or in the one folder the archive holds. Read in memory with the bounds of a skill checked
// before a byte is inflated: the size an entry declares, then the size it inflates to.

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
/** The upper half of `external attributes` of a zip made on Unix: the mode of the file. */
const UNIX_LINK = 0o120000
const UNIX_TYPE = 0o170000
const UNIX_EXEC = 0o111

interface ZipEntryInfo extends UnzipFileInfo {
  attrs?: number
}

/** A version of a skill from the bytes of an archive; SKILL_INVALID with the reason otherwise. */
export function readSkillArchive(bytes: Uint8Array): SkillVersion {
  if (bytes.byteLength > accountSkillLimits.uploadBytes) throw skillInvalid('too_large')
  if (!ZIP_MAGIC.every((byte, at) => bytes[at] === byte)) throw skillInvalid('archive')
  const modes = new Map<string, number>()
  let declared = 0
  let entries = 0
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(bytes, {
      filter: (info: ZipEntryInfo) => {
        if (info.name.endsWith('/')) return false
        entries += 1
        if (entries > accountSkillLimits.filesPerSkill * 2) throw skillInvalid('too_many_files')
        declared += info.originalSize
        if (info.originalSize > accountSkillLimits.fileBytes)
          throw skillInvalid('file_too_large', info.name)
        if (declared > accountSkillLimits.skillBytes) throw skillInvalid('too_large')
        // fflate does not hand the attributes to the filter; the central directory is read below.
        return true
      },
    })
  } catch (error) {
    if (isDomainError(error)) throw error
    throw skillInvalid('archive')
  }
  for (const [name, mode] of centralModes(bytes)) modes.set(name, mode)

  const names = Object.keys(raw).filter((name) => !isSkillJunk(name))
  const prefix = rootOf(names)
  const files: SkillFileEntry[] = []
  for (const name of names) {
    const mode = modes.get(name) ?? 0
    if ((mode & UNIX_TYPE) === UNIX_LINK) throw skillInvalid('link', name)
    const path = name.slice(prefix.length)
    if (skillFilePath(path) !== path) throw skillInvalid('path', name)
    const content = raw[name]!
    // The declared sizes are the archive's word; these are the bytes.
    if (content.byteLength > accountSkillLimits.fileBytes)
      throw skillInvalid('file_too_large', path)
    files.push({
      path,
      bytes: content,
      executable: skillFileExecutable(path, (mode & UNIX_EXEC) !== 0),
    })
  }
  const folder = prefix ? prefix.slice(0, -1) : undefined
  return readSkillVersion(files, folder ? { folder } : {})
}

/**
 * The folder all of the skill is in: '' when `SKILL.md` is at the root, `<name>/` when the
 * archive holds that one folder. Several skills, or none, are refused.
 */
function rootOf(names: readonly string[]): string {
  if (names.includes(SKILL_MD)) return ''
  const roots = names.filter(
    (name) => name.split('/').length === 2 && name.endsWith(`/${SKILL_MD}`),
  )
  if (roots.length === 0) throw skillInvalid('no_skill_md')
  if (roots.length > 1) throw skillInvalid('several_skills')
  const prefix = roots[0]!.slice(0, -SKILL_MD.length)
  if (names.some((name) => !name.startsWith(prefix))) throw skillInvalid('several_skills')
  return prefix
}

/**
 * The Unix modes of the entries of a zip, from its central directory: name → mode. An archive
 * made elsewhere has none; its entries are plain files.
 */
function centralModes(bytes: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end of the central directory: its signature within the last 64 KiB and 22 bytes.
  let end = -1
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65_557); at -= 1)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) return modes
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  for (let index = 0; index < count && at + 46 <= bytes.byteLength; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break
    const madeBy = view.getUint16(at + 4, true) >> 8
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const external = view.getUint32(at + 38, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    // 3 — Unix: the mode is the upper half.
    if (madeBy === 3) modes.set(name, external >>> 16)
    at += 46 + nameLength + extraLength + commentLength
  }
  return modes
}
