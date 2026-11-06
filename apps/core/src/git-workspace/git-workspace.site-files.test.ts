import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { GitProvider } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitWorkspaceService } from './git-workspace.service.ts'

// The files of a commit for the section «Терминал» of a project (06.11.2026) on a real repository:
// the list of its regular files and one file by its path.

const execute = promisify(execFile)
const roots: string[] = []
const env = (cwd: string) => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
})
const git = async (cwd: string, ...args: string[]) =>
  (await execute('git', args, { cwd, env: env(cwd) })).stdout.trim()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-site-files-test-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  const files: Record<string, string | Buffer> = {
    'index.php': '<?php require "wp-blog-header.php";\n',
    'wp-content/themes/shop/style.css': 'body {}\n',
    'wp-content/themes/shop/цены.txt': 'Капучино — 250 ₽\n',
    'wp-content/uploads/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
  await symlink('../index.php', join(work, 'wp-content/link.php'))
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'site')
  const sha = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  const repo = { provider: 'gitea' as const, owner: 'fixture', name: 'site' }
  const provider = {
    kind: 'gitea',
    getRepository: vi.fn(async () => ({
      ref: repo,
      cloneUrl: remote,
      defaultBranch: 'main',
      private: true,
    })),
    issueCredentials: vi.fn(async () => {
      throw new Error('Local tests must not request real credentials')
    }),
  } as unknown as GitProvider
  const service = new GitWorkspaceService(provider, {
    transport: { kind: 'local-test', root },
    gitleaksBinary: '/usr/bin/false',
    mirrorDir: join(root, 'mirrors'),
  })
  return { service, repo, sha, files }
}

describe('the files of a commit for «Терминал»', { timeout: 60_000 }, () => {
  it('lists the regular files with sizes and content ids, links left out', async () => {
    const f = await fixture()
    const listed = await f.service.listFiles({ repo: f.repo, sha: f.sha, limit: 100 })
    expect(listed.truncated).toBe(false)
    expect(listed.files.map((file) => file.path).sort()).toEqual(Object.keys(f.files).sort())
    const css = listed.files.find((file) => file.path === 'wp-content/themes/shop/style.css')
    expect(css?.size).toBe(8)
    expect(css?.oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it('lists at most the limit and says the tree has more', async () => {
    const f = await fixture()
    const listed = await f.service.listFiles({ repo: f.repo, sha: f.sha, limit: 2 })
    expect(listed).toMatchObject({ truncated: true })
    expect(listed.files).toHaveLength(2)
  })

  it('reads a file by its path, a long one by its size alone, and nothing of a folder', async () => {
    const f = await fixture()
    const read = (path: string, maxBytes = 1024) =>
      f.service.readFile({ repo: f.repo, sha: f.sha, path, maxBytes })
    const text = await read('wp-content/themes/shop/цены.txt')
    expect(text?.bytes?.toString('utf8')).toBe('Капучино — 250 ₽\n')
    expect(await read('index.php', 4)).toMatchObject({ bytes: null, size: 36 })
    // A folder and a path the commit lacks are no file; a link reads as where it leads — the list
    // leaves it out, and web reads only a path of the list.
    expect(await read('wp-content/themes')).toBeNull()
    expect(await read('wp-content/missing.php')).toBeNull()
    expect((await read('wp-content/link.php'))?.bytes?.toString('utf8')).toBe('../index.php')
    await expect(read('a\nb')).rejects.toThrow('Invalid repository file')
  })
})
