import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { assertTurnSkillFiles, turnInputSchema } from '../ports/turn-executor.ts'
import {
  accountSkillsSection,
  builtinSkills,
  checkSkillFiles,
  isReservedSkillName,
  isSkillJunk,
  isSkillName,
  marketplacePlugins,
  parseSkillRepoAddress,
  skillCallOf,
  skillFilePath,
  skillFrontmatterBlock,
  skillFrontmatterOf,
  skillLoadable,
  turnSkillFileOf,
  turnSkillPath,
  type SkillFileEntry,
  type SkillRepoRef,
} from './index.ts'

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

const file = (path: string, text: string, executable = false): SkillFileEntry => ({
  path,
  bytes: new TextEncoder().encode(text),
  executable,
})

const skillMd = '---\nname: demo\ndescription: Does the demo.\n---\n\n# Demo\n'

describe('skill names', () => {
  it('follows the open standard', () => {
    for (const name of ['pdf', 'skill-creator', 'a1-b2']) expect(isSkillName(name)).toBe(true)
    for (const name of ['', 'PDF', '-pdf', 'pdf-', 'pd--f', 'pdf_x', 'a'.repeat(65), 'пдф'])
      expect(isSkillName(name)).toBe(false)
  })

  it('reserves the commands of a chat and of the bot', () => {
    for (const name of ['compact', 'new', 'usage', 'start', 'release', 'customize-opencode'])
      expect(isReservedSkillName(name)).toBe(true)
    expect(isReservedSkillName('pdf')).toBe(false)
  })
})

describe('frontmatter', () => {
  it('reads the block between the first two ---', () => {
    expect(skillFrontmatterBlock(skillMd)).toBe('name: demo\ndescription: Does the demo.')
    expect(skillFrontmatterBlock('﻿---\r\nname: x\r\n---\r\nbody')).toBe('name: x')
    expect(skillFrontmatterBlock('# no header')).toBeNull()
  })

  it('checks name, folder and description', () => {
    expect(skillFrontmatterOf({ name: 'demo', description: ' Does it. ' }, 'demo')).toEqual({
      name: 'demo',
      description: 'Does it.',
      metadata: {},
      userOnly: false,
    })
    expect(reasonOf(() => skillFrontmatterOf('x'))).toBe('frontmatter')
    expect(reasonOf(() => skillFrontmatterOf({ name: 'Demo', description: 'x' }))).toBe('name')
    expect(reasonOf(() => skillFrontmatterOf({ name: 'demo', description: 'x' }, 'other'))).toBe(
      'name_folder',
    )
    expect(reasonOf(() => skillFrontmatterOf({ name: 'demo' }))).toBe('description')
    expect(
      reasonOf(() => skillFrontmatterOf({ name: 'demo', description: 'x'.repeat(1025) })),
    ).toBe('description')
    expect(
      reasonOf(() => skillFrontmatterOf({ name: 'demo', description: 'Use </skill> here' })),
    ).toBe('description_brackets')
  })

  it('keeps string metadata and reads disable-model-invocation', () => {
    const fields = skillFrontmatterOf({
      name: 'demo',
      description: 'x',
      license: 'MIT',
      metadata: { 'raditi-title': 'Демо', version: 2, nested: { a: 'b' } },
      'disable-model-invocation': true,
      'allowed-tools': 'Bash',
    })
    expect(fields).toMatchObject({
      license: 'MIT',
      metadata: { 'raditi-title': 'Демо' },
      userOnly: true,
    })
  })
})

describe('files of a skill', () => {
  it('cleans paths', () => {
    expect(skillFilePath('scripts/run.py')).toBe('scripts/run.py')
    for (const raw of ['', '/etc/passwd', '../x', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'a/'])
      expect(skillFilePath(raw)).toBeNull()
    expect(skillFilePath(Array.from({ length: 11 }, () => 'a').join('/'))).toBeNull()
  })

  it('drops the junk of a repository', () => {
    expect(isSkillJunk('.git/config')).toBe(true)
    expect(isSkillJunk('scripts/__pycache__/x.cpython-312.pyc')).toBe(true)
    expect(isSkillJunk('.DS_Store')).toBe(true)
    expect(isSkillJunk('scripts/run.py')).toBe(false)
  })

  it('takes a skill with SKILL.md at its root and returns its text', () => {
    expect(
      checkSkillFiles([file('SKILL.md', skillMd), file('scripts/a.py', 'print(1)', true)]),
    ).toBe(skillMd)
  })

  it('refuses what is not a skill', () => {
    expect(reasonOf(() => checkSkillFiles([file('README.md', 'x')]))).toBe('no_skill_md')
    expect(
      reasonOf(() => checkSkillFiles([file('SKILL.md', skillMd), file('SKILL.md', 'x')])),
    ).toBe('path')
    expect(
      reasonOf(() =>
        checkSkillFiles([file('SKILL.md', skillMd), file('a', 'x'), file('a/b', 'y')]),
      ),
    ).toBe('path')
    expect(
      reasonOf(() =>
        checkSkillFiles([
          file('SKILL.md', skillMd),
          ...Array.from({ length: 100 }, (_, i) => file(`r/${i}.md`, 'x')),
        ]),
      ),
    ).toBe('too_many_files')
    expect(
      reasonOf(() =>
        checkSkillFiles([
          file('SKILL.md', skillMd),
          file('notes.md', 'AWS key AKIAIOSFODNN7EXAMPLE'),
        ]),
      ),
    ).toBe('secret')
  })

  it('takes the code and docs of a skill that name passwords and keys without holding one', () => {
    const code = [
      'api_key = os.environ["API_KEY"]',
      'password = getpass.getpass()',
      'DB_PASSWORD=<your password here>',
      'headers = {"Authorization": f"Bearer {token}"}',
    ].join('\n')
    expect(() =>
      checkSkillFiles([file('SKILL.md', skillMd), file('scripts/a.py', code)]),
    ).not.toThrow()
  })

  it('places a file under the folder of its skill', () => {
    expect(turnSkillPath('demo', 'scripts/a.py')).toBe('/workspace/skills/demo/scripts/a.py')
    expect(turnSkillPath('Demo', 'a')).toBeNull()
    expect(turnSkillPath('demo', '../a')).toBeNull()
    expect(turnSkillFileOf('/workspace/skills/demo/scripts/a.py')).toEqual({
      name: 'demo',
      path: 'scripts/a.py',
    })
    for (const path of ['/workspace/skills/demo', '/workspace/skills/demo/../x', '/workspace/x/a'])
      expect(turnSkillFileOf(path)).toBeNull()
  })
})

describe('addresses of repositories', () => {
  it('reads the forms a client types', () => {
    expect(parseSkillRepoAddress('anthropics/skills')).toEqual({
      host: 'github',
      repo: 'anthropics/skills',
      path: '',
    })
    expect(
      parseSkillRepoAddress('https://github.com/anthropics/skills/tree/main/skills/pdf'),
    ).toEqual({ host: 'github', repo: 'anthropics/skills', ref: 'main', path: 'skills/pdf' })
    expect(parseSkillRepoAddress('https://github.com/o/r/blob/v1/skills/pdf/SKILL.md')).toEqual({
      host: 'github',
      repo: 'o/r',
      ref: 'v1',
      path: 'skills/pdf',
    })
    expect(parseSkillRepoAddress('https://gitlab.com/g/sub/p/-/tree/main/s/x')).toEqual({
      host: 'gitlab',
      repo: 'g/sub/p',
      ref: 'main',
      path: 's/x',
    })
    expect(parseSkillRepoAddress('https://github.com/o/r.git')).toMatchObject({ repo: 'o/r' })
  })

  it('refuses other hosts and odd addresses', () => {
    for (const input of [
      'http://github.com/o/r',
      'https://example.com/o/r',
      'https://user:pw@github.com/o/r',
      'https://github.com/o',
      'https://github.com/o/r/issues/1',
      'https://github.com:8443/o/r',
    ])
      expect(reasonOf(() => parseSkillRepoAddress(input))).toBe('SKILL_SOURCE_INVALID')
  })
})

describe('marketplaces', () => {
  const home: SkillRepoRef = { host: 'github', repo: 'anthropics/skills', path: '' }

  it('reads the plugins whose skills the platform can install', () => {
    const plugins = marketplacePlugins(
      {
        name: 'anthropic-agent-skills',
        owner: { name: 'Anthropic' },
        plugins: [
          {
            name: 'document-skills',
            description: 'Docs',
            source: './',
            strict: false,
            skills: ['./skills/docx', './skills/pdf'],
          },
          { name: 'gh', source: { source: 'github', repo: 'o/r', ref: 'v1' } },
          {
            name: 'sub',
            source: { source: 'git-subdir', url: 'https://gitlab.com/g/p.git', path: 'x' },
          },
          { name: 'npm', source: { source: 'npm', package: 'x' } },
          { name: 'elsewhere', source: { source: 'url', url: 'https://example.com/r.git' } },
          { name: 'up', source: '../outside' },
          { bad: true },
        ],
      },
      home,
    )
    expect(plugins).toEqual([
      {
        name: 'document-skills',
        description: 'Docs',
        repo: { host: 'github', repo: 'anthropics/skills', path: '' },
        skillFolders: ['skills/docx', 'skills/pdf'],
      },
      { name: 'gh', repo: { host: 'github', repo: 'o/r', ref: 'v1', path: '' } },
      { name: 'sub', repo: { host: 'gitlab', repo: 'g/p', path: 'x' } },
    ])
  })

  it('refuses a file that is not a marketplace', () => {
    expect(reasonOf(() => marketplacePlugins({ plugins: 'x' }, home))).toBe('MARKETPLACE_INVALID')
  })
})

describe('a turn with skills', () => {
  const skills = [
    { name: 'demo', builtin: false, userOnly: false },
    { name: 'deploy-notes', builtin: false, userOnly: true },
  ]

  it('finds the skill a message calls', () => {
    expect(skillCallOf('/demo сделай отчёт')).toBe('demo')
    expect(skillCallOf('  /demo')).toBe('demo')
    expect(skillCallOf('/compact')).toBeNull()
    expect(skillCallOf('/demo-')).toBeNull()
    expect(skillCallOf('напиши /demo')).toBeNull()
    expect(skillCallOf('/demo,сделай')).toBeNull()
  })

  it('lets the model load a skill only the client starts only when called', () => {
    expect(skillLoadable(skills[1]!, null)).toBe(false)
    expect(skillLoadable(skills[1]!, 'deploy-notes')).toBe(true)
    expect(skillLoadable(skills[0]!, null)).toBe(true)
  })

  it('tells the agent about skills and about the one called', () => {
    expect(accountSkillsSection([], null)).toBe('')
    expect(accountSkillsSection([skills[1]!], null)).toBe('')
    const section = accountSkillsSection(skills, 'deploy-notes')
    expect(section).toContain('## Skills of the client')
    expect(section).toContain('The client called the skill `deploy-notes`')
    expect(accountSkillsSection(skills, 'missing')).not.toContain('The client called')
  })

  it('has every built-in skill named by the standard and not reserved', () => {
    for (const skill of builtinSkills) {
      expect(isSkillName(skill.name)).toBe(true)
      expect(isReservedSkillName(skill.name)).toBe(false)
      expect(skill.description.length).toBeLessThanOrEqual(1024)
      expect(skill.description).not.toMatch(/[<>]/u)
    }
  })
})

describe('the files of skills of a turn', () => {
  const at = (path: string, sizeBytes = 10, executable = false) => ({ path, sizeBytes, executable })

  it('takes clean paths of skills for the turn of a chat', () => {
    expect(() =>
      assertTurnSkillFiles(
        [at('/workspace/skills/demo/SKILL.md'), at('/workspace/skills/demo/scripts/a.py', 5, true)],
        true,
      ),
    ).not.toThrow()
    expect(() => assertTurnSkillFiles([], false)).not.toThrow()
  })

  it.each([
    ['for a turn that is not a chat', [at('/workspace/skills/demo/SKILL.md')], false],
    ['outside the folder of skills', [at('/workspace/project/SKILL.md')], true],
    ['without a skill folder', [at('/workspace/skills/SKILL.md')], true],
    ['twice', [at('/workspace/skills/d/a'), at('/workspace/skills/d/a')], true],
    ['a file that is a folder', [at('/workspace/skills/d/a'), at('/workspace/skills/d/a/b')], true],
    ['too large', [at('/workspace/skills/d/a', 6 * 1024 * 1024)], true],
  ])('refuses files %s', (_label, files, mayHold) => {
    expect(() => assertTurnSkillFiles(files, mayHold)).toThrow()
  })

  it('names the skills of a plan and its called skill in the plan schema', () => {
    expect(
      turnInputSchema.safeParse({
        prompt: 'x',
        attachments: [],
        skillFiles: ['/workspace/skills/demo/SKILL.md'],
      }).success,
    ).toBe(true)
    expect(
      turnInputSchema.safeParse({ prompt: 'x', attachments: [], skillFiles: ['/etc/passwd'] })
        .success,
    ).toBe(false)
  })
})
