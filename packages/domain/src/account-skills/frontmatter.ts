import { skillInvalid } from './errors.ts'
import { accountSkillLimits } from './limits.ts'
import { isSkillName } from './name.ts'

// The frontmatter of `SKILL.md` (docs/plan/97-skills.md, Нв10, Нв17, Нв23): the fields of the
// open standard the platform reads, from the object a YAML parser made of the lines between the
// two `---`. Any other field is kept as it is and means nothing here: `allowed-tools` and the
// ``!`cmd` `` lines of Claude Code give no right on Радити.

export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  /** String to string only; other values of the map are left out. */
  metadata: Record<string, string>
  /**
   * Only the client starts it, with `/<name>` (Нв17): `disable-model-invocation: true` of Claude
   * Code, or `policy.allow_implicit_invocation: false` of `agents/openai.yaml` of Codex.
   */
  userOnly: boolean
}

/** The lines between the first two `---` of a `SKILL.md`, or null when it has none. */
export function skillFrontmatterBlock(text: string): string | null {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(body)
  return match ? match[1]! : null
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/**
 * The fields of a parsed frontmatter, checked: `name` by the standard, and the name of the
 * folder when it is known; `description` from 1 to 1024 characters without `<` or `>` — OpenCode
 * puts it in its system prompt inside XML as it is, and `quick_validate.py` of skill-creator
 * refuses them too. SKILL_INVALID with the reason otherwise.
 */
export function skillFrontmatterOf(data: unknown, folder?: string): SkillFrontmatter {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw skillInvalid('frontmatter')
  const fields = data as Record<string, unknown>
  const name = asString(fields.name)?.trim()
  if (!name || !isSkillName(name)) throw skillInvalid('name')
  if (folder !== undefined && folder !== name) throw skillInvalid('name_folder')
  const description = asString(fields.description)?.trim()
  if (!description || description.length > accountSkillLimits.descriptionChars)
    throw skillInvalid('description')
  if (/[<>]/u.test(description)) throw skillInvalid('description_brackets')
  const metadata: Record<string, string> = {}
  if (fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata))
    for (const [key, value] of Object.entries(fields.metadata as Record<string, unknown>))
      if (typeof value === 'string') metadata[key] = value
  const license = asString(fields.license)?.trim().slice(0, accountSkillLimits.licenseChars)
  const compatibility = asString(fields.compatibility)
    ?.trim()
    .slice(0, accountSkillLimits.compatibilityChars)
  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    metadata,
    userOnly: fields['disable-model-invocation'] === true,
  }
}

/** `policy.allow_implicit_invocation: false` of a parsed `agents/openai.yaml` of Codex. */
export function codexUserOnly(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const policy = (data as Record<string, unknown>).policy
  return (
    policy !== null &&
    typeof policy === 'object' &&
    (policy as Record<string, unknown>).allow_implicit_invocation === false
  )
}

/** The Russian title and summary a skill of the catalog of Радити carries in its metadata. */
export function skillRussianTexts(metadata: Readonly<Record<string, string>>): {
  title?: string
  summary?: string
} {
  const title = metadata['raditi-title']?.trim().slice(0, accountSkillLimits.titleChars)
  const summary = metadata['raditi-summary']?.trim().slice(0, accountSkillLimits.summaryChars)
  return { ...(title ? { title } : {}), ...(summary ? { summary } : {}) }
}
