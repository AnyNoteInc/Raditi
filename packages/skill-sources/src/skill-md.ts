import {
  checkSkillFiles,
  codexUserOnly,
  isReservedSkillName,
  skillFrontmatterBlock,
  skillFrontmatterOf,
  skillInvalid,
  builtinSkillNames,
  skillFileText,
  type SkillFileEntry,
  type SkillFrontmatter,
} from '@repo/domain'
import { parse } from 'yaml'

// SKILL.md as the platform reads it (docs/plan/97-skills.md, Нв10, Нв17): the YAML between the
// first two `---`, checked by the rules of the domain. YAML here is data only: no custom tags, no
// aliases expanded past a small bound, no document past the first.

const yamlOptions = {
  // A YAML bomb of aliases stops here instead of filling the memory of web.
  maxAliasCount: 100,
  uniqueKeys: false,
  prettyErrors: false,
} as const

function parseYaml(text: string): unknown {
  try {
    return parse(text, yamlOptions)
  } catch {
    return undefined
  }
}

/** The checked frontmatter of a `SKILL.md`; `folder` — the name of its folder, when it has one. */
export function parseSkillMd(text: string, folder?: string): SkillFrontmatter {
  const block = skillFrontmatterBlock(text)
  if (block === null) throw skillInvalid('frontmatter')
  return skillFrontmatterOf(parseYaml(block), folder)
}

/** A version of a skill, read and checked: what is kept of it. */
export interface SkillVersion {
  frontmatter: SkillFrontmatter
  files: SkillFileEntry[]
  bytes: number
}

/**
 * A version of a skill from its files (Нв10): the checks of the domain, the frontmatter of its
 * `SKILL.md`, the name of its folder when it came in one, `policy.allow_implicit_invocation` of
 * `agents/openai.yaml` of Codex, and a name a skill of an account may take — not a command of
 * the chat, not a built-in skill. The files are sorted by path: the same skill is the same
 * version.
 */
export function readSkillVersion(
  entries: readonly SkillFileEntry[],
  options: { folder?: string; builtin?: boolean } = {},
): SkillVersion {
  const files = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const skillMd = checkSkillFiles(files)
  const frontmatter = parseSkillMd(skillMd, options.folder)
  if (
    !options.builtin &&
    (isReservedSkillName(frontmatter.name) || builtinSkillNames.has(frontmatter.name))
  )
    throw skillInvalid('reserved_name')
  const codex = files.find((file) => file.path === 'agents/openai.yaml')
  const codexText = codex ? skillFileText(codex.bytes) : null
  const userOnly =
    frontmatter.userOnly || (codexText !== null && codexUserOnly(parseYaml(codexText)))
  return {
    frontmatter: { ...frontmatter, userOnly },
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
  }
}
