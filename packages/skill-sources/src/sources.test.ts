import { isDomainError, type SkillRepoRef } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { repoReaders, type Fetch } from './repo.ts'
import { SkillSources, skillFolders } from './sources.ts'

const COMMIT = 'a'.repeat(40)

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when asked.\n---\n# ${name}\n`

/** A public repository of GitHub, as its API and raw.githubusercontent.com answer. */
function github(files: Record<string, { text: string; mode?: string }>) {
  const calls: string[] = []
  const fetchFn: Fetch = async (url) => {
    calls.push(url)
    if (url.startsWith('https://api.github.com/repos/o/r/commits/'))
      return Response.json({ sha: COMMIT })
    if (url === `https://api.github.com/repos/o/r/git/trees/${COMMIT}?recursive=1`)
      return Response.json({
        truncated: false,
        tree: Object.entries(files).map(([path, file]) => ({
          path,
          mode: file.mode ?? '100644',
          type: 'blob',
          size: file.text.length,
        })),
      })
    const raw = `https://raw.githubusercontent.com/o/r/${COMMIT}/`
    if (url.startsWith(raw)) {
      const file = files[decodeURIComponent(url.slice(raw.length))]
      return file ? new Response(file.text) : new Response('', { status: 404 })
    }
    return new Response('', { status: 404 })
  }
  return { sources: new SkillSources(repoReaders(fetchFn)), calls, fetchFn }
}

const repo = (path = '', ref?: string): SkillRepoRef => ({
  host: 'github',
  repo: 'o/r',
  path,
  ...(ref ? { ref } : {}),
})

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    if (isDomainError(error))
      return (error.details as { reason?: string } | undefined)?.reason ?? error.code
    throw error
  }
  return 'no error'
}

describe('skills of a repository', () => {
  const files = {
    'README.md': { text: '# repo' },
    'skills/pdf/SKILL.md': { text: skillMd('pdf') },
    'skills/pdf/scripts/fill.py': { text: 'print(1)', mode: '100755' },
    'skills/pdf/__pycache__/x.pyc': { text: 'junk' },
    'skills/docx/SKILL.md': { text: skillMd('docx') },
    'skills/broken/SKILL.md': { text: 'no header' },
    'deep/a/b/c/d/e/f/g/SKILL.md': { text: skillMd('g') },
  }

  it('lists the folders with SKILL.md under a path, not too deep', () => {
    const tree = Object.keys(files).map((path) => ({ path, mode: '100644' }))
    expect(skillFolders(tree, '')).toEqual(['skills/broken', 'skills/docx', 'skills/pdf'])
    expect(skillFolders(tree, 'skills/pdf')).toEqual(['skills/pdf'])
  })

  it('finds the skills of a repository with their descriptions', async () => {
    const { sources, calls } = github(files)
    const found = await sources.find(repo('skills', 'main'))
    expect(found.commit).toBe(COMMIT)
    expect(found.skills).toEqual([
      { path: 'skills/broken', name: 'broken' },
      { path: 'skills/docx', name: 'docx', description: 'Does docx. Use when asked.' },
      { path: 'skills/pdf', name: 'pdf', description: 'Does pdf. Use when asked.' },
    ])
    expect(calls[0]).toBe('https://api.github.com/repos/o/r/commits/main')
  })

  it('reads one skill whole at the commit, junk left out', async () => {
    const { sources } = github(files)
    const version = await sources.read(repo(), COMMIT, 'skills/pdf')
    expect(version.frontmatter.name).toBe('pdf')
    expect(version.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/fill.py', true],
    ])
  })

  it('refuses a link, and a path with no skill', async () => {
    const { sources } = github({
      'x/SKILL.md': { text: skillMd('x') },
      'x/evil': { text: '/etc/passwd', mode: '120000' },
    })
    expect(await codeOf(() => sources.read(repo(), COMMIT, 'x'))).toBe('link')
    expect(await codeOf(() => sources.find(repo('nothing')))).toBe('SKILL_SOURCE_NOT_FOUND')
  })

  it('keeps the bound of a whole skill while reading, when the tree has no sizes', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024)
    const files = {
      'big/SKILL.md': { text: skillMd('big') },
      'big/a.bin': { text: big },
      'big/b.bin': { text: big },
      'big/c.bin': { text: big },
    }
    const { fetchFn } = github(files)
    // As GitLab answers: no `size` in the tree.
    const sizeless = new SkillSources(
      repoReaders(async (url, init) => {
        const response = await fetchFn(url, init)
        if (!url.includes('/git/trees/')) return response
        const tree = (await response.json()) as { tree: Record<string, unknown>[] }
        return Response.json({
          truncated: false,
          tree: tree.tree.map(({ size: _size, ...rest }) => rest),
        })
      }),
    )
    expect(await codeOf(() => sizeless.read(repo(), COMMIT, 'big'))).toBe('too_large')
  })

  it('tells a missing repository from a provider that does not answer', async () => {
    const missing = new SkillSources(repoReaders(async () => new Response('', { status: 404 })))
    expect(await codeOf(() => missing.find(repo()))).toBe('SKILL_SOURCE_NOT_FOUND')
    const limited = new SkillSources(repoReaders(async () => new Response('', { status: 403 })))
    expect(await codeOf(() => limited.find(repo()))).toBe('SKILL_SOURCE_UNAVAILABLE')
    const down = new SkillSources(
      repoReaders(async () => {
        throw new Error('ECONNRESET')
      }),
    )
    expect(await codeOf(() => down.find(repo()))).toBe('SKILL_SOURCE_UNAVAILABLE')
  })
})

describe('a marketplace', () => {
  it('lists the plugins and the skills of each, as anthropics/skills has them', async () => {
    const { sources } = github({
      '.claude-plugin/marketplace.json': {
        text: JSON.stringify({
          name: 'anthropic-agent-skills',
          owner: { name: 'Anthropic' },
          plugins: [
            {
              name: 'document-skills',
              description: 'Documents',
              source: './',
              strict: false,
              skills: ['./skills/pdf', './skills/missing'],
            },
            { name: 'tools', source: './plugins/tools' },
            { name: 'outside', source: { source: 'github', repo: 'x/y' } },
            { name: 'npm', source: { source: 'npm', package: 'z' } },
          ],
        }),
      },
      'skills/pdf/SKILL.md': { text: skillMd('pdf') },
      'plugins/tools/skills/lint/SKILL.md': { text: skillMd('lint') },
      'plugins/tools/skills/lint/deeper/x/SKILL.md': { text: skillMd('x') },
    })
    const listing = await sources.marketplace(repo())
    expect(listing.name).toBe('anthropic-agent-skills')
    expect(listing.plugins).toEqual([
      {
        name: 'document-skills',
        description: 'Documents',
        repo: repo(),
        skills: [{ path: 'skills/pdf', name: 'pdf', description: 'Does pdf. Use when asked.' }],
      },
      {
        name: 'tools',
        repo: repo('plugins/tools'),
        skills: [
          {
            path: 'plugins/tools/skills/lint',
            name: 'lint',
            description: 'Does lint. Use when asked.',
          },
        ],
      },
      { name: 'outside', repo: { host: 'github', repo: 'x/y', path: '' }, skills: null },
    ])
  })

  it('refuses a repository without a marketplace', async () => {
    const { sources } = github({ 'README.md': { text: 'x' } })
    expect(await codeOf(() => sources.marketplace(repo()))).toBe('MARKETPLACE_INVALID')
  })
})
