import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import type { GitProvider } from '@repo/domain'
import { extract } from 'tar-stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitWorkspaceService, type ExportedTree } from './git-workspace.service.ts'

// The files of a commit for the docroot of a preview (docs/plan/53-chat-preview-release.md, Р16,
// Р22; R5c) on a real repository: the whole tree or some paths of it as a tar, the paths a tree
// lacks, the difference of two commits.

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

const longPath = `wp-content/themes/shop/${'deep/'.repeat(25)}template-part.php`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-tree-export-test-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  const files: Record<string, string> = {
    'index.php': '<?php require "wp-blog-header.php";\n',
    'wp-includes/version.php': "<?php $wp_version = '7.1';\n",
    'wp-content/themes/shop/style.css': 'body {}\n',
    'wp-content/themes/shop/old.php': '<?php // old\n',
    'bin/tool.sh': '#!/bin/sh\necho ok\n',
    [longPath]: '<?php // a long way down\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
  await chmod(join(work, 'bin/tool.sh'), 0o755)
  await symlink('../index.php', join(work, 'wp-content/link.php'))
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'site')
  const first = await git(work, 'rev-parse', 'HEAD')
  await writeFile(join(work, 'wp-content/themes/shop/style.css'), 'body { color: red; }\n')
  await writeFile(join(work, 'wp-content/themes/shop/new.php'), '<?php // new\n')
  await git(work, 'rm', '-q', 'wp-content/themes/shop/old.php')
  await git(work, 'rm', '-q', 'wp-content/link.php')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'change')
  const second = await git(work, 'rev-parse', 'HEAD')
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
  return { service, repo, first, second, files }
}

async function entries(tree: ExportedTree) {
  const found: Array<{ name: string; type: string; mode: number; content: string }> = []
  const parser = extract()
  parser.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: unknown) => {
      chunks.push(Buffer.from(chunk as Uint8Array))
    })
    stream.on('end', () => {
      found.push({
        name: header.name,
        type: header.type ?? 'file',
        mode: header.mode ?? 0,
        content: Buffer.concat(chunks).toString('utf8'),
      })
      next()
    })
  })
  const chunks: Buffer[] = []
  for await (const chunk of tree.archive) chunks.push(Buffer.from(chunk))
  await pipeline(Readable.from([Buffer.concat(chunks)]), parser)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

describe('the tree of a commit for a preview', { timeout: 60_000 }, () => {
  it('exports the regular files of the whole tree with their modes, links left out', async () => {
    const f = await fixture()
    const found = await f.service.exportTree({ repo: f.repo, sha: f.first }, async (tree) => {
      expect(tree.files).toBe(6)
      return entries(tree)
    })
    expect(found.map((entry) => entry.name)).toEqual(
      Object.keys(f.files).sort((a, b) => a.localeCompare(b)),
    )
    expect(found.find((entry) => entry.name === longPath)?.content).toBe(f.files[longPath])
    expect(found.find((entry) => entry.name === 'bin/tool.sh')?.mode).toBe(0o755)
    expect(found.find((entry) => entry.name === 'index.php')?.mode).toBe(0o644)
    expect(found.every((entry) => entry.type === 'file')).toBe(true)
  })

  it('exports only the paths asked for', async () => {
    const f = await fixture()
    const found = await f.service.exportTree(
      { repo: f.repo, sha: f.second, paths: ['wp-content/themes/shop/style.css'] },
      entries,
    )
    expect(found).toEqual([
      expect.objectContaining({
        name: 'wp-content/themes/shop/style.css',
        content: 'body { color: red; }\n',
      }),
    ])
  })

  it('exports nothing for no path, and leaves out the files it is told to', async () => {
    const f = await fixture()
    expect(
      await f.service.exportTree({ repo: f.repo, sha: f.first, paths: [] }, async (tree) => {
        expect(tree.files).toBe(0)
        return entries(tree)
      }),
    ).toEqual([])
    const found = await f.service.exportTree(
      { repo: f.repo, sha: f.first, exclude: ['index.php', 'bin/tool.sh'] },
      entries,
    )
    expect(found.map((entry) => entry.name)).toEqual(
      Object.keys(f.files)
        .filter((path) => path !== 'index.php' && path !== 'bin/tool.sh')
        .sort((a, b) => a.localeCompare(b)),
    )
  })

  it('names the paths a commit lacks and what two commits differ in', async () => {
    const f = await fixture()
    expect(
      await f.service.missingPaths({
        repo: f.repo,
        sha: f.second,
        paths: ['index.php', 'wp-content/themes/shop/old.php', 'wp-load.php'],
      }),
    ).toEqual(['wp-content/themes/shop/old.php', 'wp-load.php'])
    expect(
      await f.service.changedPaths({ repo: f.repo, fromSha: f.first, toSha: f.second, limit: 10 }),
    ).toEqual({
      written: ['wp-content/themes/shop/new.php', 'wp-content/themes/shop/style.css'],
      deleted: ['wp-content/link.php', 'wp-content/themes/shop/old.php'],
    })
    expect(
      await f.service.changedPaths({ repo: f.repo, fromSha: f.first, toSha: f.second, limit: 2 }),
    ).toBeNull()
  })

  it('refuses a path that is not one of the repository', async () => {
    const f = await fixture()
    await expect(
      f.service.exportTree({ repo: f.repo, sha: f.first, paths: ['../etc/passwd'] }, entries),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
