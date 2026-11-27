import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { builtinSkillNames, builtinSkills, reservedSkillNames } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { readSkillVersion } from './skill-md.ts'

// The built-in skills of the sandbox image (docs/plan/97-skills.md, Нв5, Нв6, §5) against the
// catalog of the domain the cabinet reads: every folder is a valid skill, its name and
// description are the catalog's, and the validator of skill-creator reserves what the platform
// reserves.

const root = join(import.meta.dirname, '../../../infra/sandbox/skills')

function filesOf(folder: string) {
  const files: { path: string; bytes: Uint8Array; executable: boolean }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const path = relative(folder, full)
        files.push({
          path,
          bytes: readFileSync(full),
          executable: path.startsWith('scripts/') || (statSync(full).mode & 0o111) !== 0,
        })
      }
    }
  }
  walk(folder)
  return files
}

describe('built-in skills', () => {
  it('has a folder for every skill of the catalog, and no other', () => {
    expect(readdirSync(root).sort()).toEqual([...builtinSkillNames].sort())
  })

  for (const skill of builtinSkills)
    it(`${skill.name} is a valid skill with the catalog's name and description`, () => {
      const version = readSkillVersion(filesOf(join(root, skill.name)), {
        folder: skill.name,
        builtin: true,
      })
      expect(version.frontmatter.name).toBe(skill.name)
      expect(version.frontmatter.description).toBe(skill.description)
      expect(version.frontmatter.metadata['raditi-title']).toBe(skill.title)
    })

  it('skill-creator carries its licence and notice', () => {
    const files = readdirSync(join(root, 'skill-creator'))
    expect(files).toEqual(expect.arrayContaining(['LICENSE.txt', 'NOTICE']))
  })

  it('the validator of skill-creator reserves every name the platform reserves', () => {
    const source = readFileSync(join(root, 'skill-creator/scripts/quick_validate.py'), 'utf8')
    const block = /RESERVED = \{([\s\S]*?)\}/u.exec(source)?.[1] ?? ''
    const names = new Set([...block.matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]))
    for (const name of [...reservedSkillNames, ...builtinSkillNames]) expect(names).toContain(name)
  })
})
