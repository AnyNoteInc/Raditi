import { isDomainError } from '@repo/domain'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'

import { readSkillArchive } from './archive.ts'

const skillMd = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when asked.\n${extra}---\n\n# ${name}\n`

const reasonOf = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    if (isDomainError(error))
      return (error.details as { reason?: string } | undefined)?.reason ?? error.code
    throw error
  }
  return 'no error'
}

/** A zip as Python's zipfile makes it on Linux: Unix modes in the external attributes. */
const zip = (files: Record<string, [string, number?]>): Uint8Array => {
  const entries: Zippable = {}
  for (const [name, [text, mode]] of Object.entries(files))
    entries[name] = [strToU8(text), { os: 3, attrs: ((mode ?? 0o100644) << 16) >>> 0 }]
  return zipSync(entries)
}

describe('an uploaded archive', () => {
  it('reads a skill at the root of the archive', () => {
    const version = readSkillArchive(
      zip({ 'SKILL.md': [skillMd('demo')], 'scripts/run.sh': ['echo 1', 0o100755] }),
    )
    expect(version.frontmatter.name).toBe('demo')
    expect(version.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/run.sh', true],
    ])
  })

  it('reads a .skill of package_skill.py: one folder named as the skill', () => {
    const version = readSkillArchive(
      zip({
        'demo/SKILL.md': [skillMd('demo')],
        'demo/assets/logo.svg': ['<svg/>'],
        'demo/__pycache__/x.pyc': ['junk'],
        '__MACOSX/demo/._SKILL.md': ['junk'],
      }),
    )
    expect(version.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.svg'])
  })

  it('takes disable-model-invocation and the policy of Codex', () => {
    expect(
      readSkillArchive(zip({ 'SKILL.md': [skillMd('demo', 'disable-model-invocation: true\n')] }))
        .frontmatter.userOnly,
    ).toBe(true)
    expect(
      readSkillArchive(
        zip({
          'SKILL.md': [skillMd('demo')],
          'agents/openai.yaml': ['policy:\n  allow_implicit_invocation: false\n'],
        }),
      ).frontmatter.userOnly,
    ).toBe(true)
  })

  it('refuses what is not one valid skill', () => {
    expect(reasonOf(() => readSkillArchive(strToU8('not a zip')))).toBe('archive')
    expect(reasonOf(() => readSkillArchive(zip({ 'README.md': ['x'] })))).toBe('no_skill_md')
    expect(
      reasonOf(() =>
        readSkillArchive(zip({ 'a/SKILL.md': [skillMd('a')], 'b/SKILL.md': [skillMd('b')] })),
      ),
    ).toBe('several_skills')
    expect(reasonOf(() => readSkillArchive(zip({ 'other/SKILL.md': [skillMd('demo')] })))).toBe(
      'name_folder',
    )
    expect(
      reasonOf(() =>
        readSkillArchive(zip({ 'SKILL.md': [skillMd('demo')], link: ['/etc/passwd', 0o120777] })),
      ),
    ).toBe('link')
    expect(reasonOf(() => readSkillArchive(zip({ 'SKILL.md': [skillMd('usage')] })))).toBe(
      'reserved_name',
    )
    expect(reasonOf(() => readSkillArchive(zip({ 'SKILL.md': [skillMd('skill-creator')] })))).toBe(
      'reserved_name',
    )
    expect(
      reasonOf(() =>
        readSkillArchive(zip({ 'SKILL.md': ['---\nname: demo\ndescription: [unclosed\n---\n'] })),
      ),
    ).toBe('frontmatter')
  })

  it('refuses an entry that inflates past the bounds of a file', () => {
    const big = new Uint8Array(6 * 1024 * 1024)
    const bytes = zipSync({ 'SKILL.md': strToU8(skillMd('demo')), 'big.bin': big })
    expect(reasonOf(() => readSkillArchive(bytes))).toBe('file_too_large')
  })
})
