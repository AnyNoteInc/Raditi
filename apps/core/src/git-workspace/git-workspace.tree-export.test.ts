import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { siteReadBytes, siteReadEntries, type GitProvider } from '@repo/domain'
import { extract } from 'tar-stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitWorkspaceService, type ExportedTree } from './git-workspace.service.ts'

// The files of a commit for the docroot of a preview (docs/plan/53-chat-preview-release.md, Р16,
// Р22; R5c) on a real repository: the whole tree or some paths of it as a tar, the paths a tree
// lacks, the difference of two commits; one file or one folder of a commit without a working copy
// (docs/plan/62-site-stacks.md, Т14, Т17; slice Э2.6).

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
const gitWithInput = async (cwd: string, input: string, ...args: string[]) => {
  const run = execute('git', args, { cwd, env: env(cwd), maxBuffer: 16 * 1024 * 1024 })
  run.child.stdin?.end(input)
  return (await run).stdout.trim()
}

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
  // Two files at the read limit and one byte over it, off the commits the other tests export.
  const limit = Buffer.alloc(siteReadBytes, 0x61)
  await mkdir(join(work, 'wp-content/uploads'), { recursive: true })
  await writeFile(join(work, 'wp-content/uploads/limit.bin'), limit)
  await writeFile(
    join(work, 'wp-content/uploads/over.bin'),
    Buffer.concat([limit, Buffer.of(0x62)]),
  )
  // Bytes that are no UTF-8, a submodule, and two folders at the entry limit and one over it.
  const raw = Buffer.of(0xff, 0xfe, 0x00, 0x80, 0xc3)
  await writeFile(join(work, 'wp-content/uploads/raw.bin'), raw)
  await git(work, 'add', '.')
  await git(work, 'update-index', '--add', '--cacheinfo', `160000,${first},wp-content/uploads/sub`)
  const empty = await gitWithInput(work, '', 'hash-object', '-w', '--stdin')
  const folder = (name: string, count: number) =>
    Array.from({ length: count }, (_, n) => `100644 ${empty}\t${name}/f${n}\n`).join('')
  await gitWithInput(
    work,
    folder('many', siteReadEntries) + folder('more', siteReadEntries + 1),
    'update-index',
    '--add',
    '--index-info',
  )
  await git(work, 'commit', '-m', 'large')
  const third = await git(work, 'rev-parse', 'HEAD')
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
  return { service, repo, first, second, third, files, limit, raw }
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

  it('reads one regular file of a commit byte for byte, and nothing else', async () => {
    const f = await fixture()
    const read = (sha: string, path: string) => f.service.readTreeFile({ repo: f.repo, sha, path })
    expect(Buffer.from((await read(f.first, 'wp-includes/version.php'))!).toString('utf8')).toBe(
      f.files['wp-includes/version.php'],
    )
    expect(Buffer.from((await read(f.first, longPath))!).toString('utf8')).toBe(f.files[longPath])
    expect(
      Buffer.from((await read(f.second, 'wp-content/themes/shop/style.css'))!).toString(),
    ).toBe('body { color: red; }\n')
    expect(Buffer.from((await read(f.first, 'bin/tool.sh'))!).toString('utf8')).toBe(
      f.files['bin/tool.sh'],
    )
    expect(Buffer.from((await read(f.third, 'wp-content/uploads/raw.bin'))!).equals(f.raw)).toBe(
      true,
    )
    expect(await read(f.first, 'wp-content/link.php')).toBeNull()
    expect(await read(f.first, 'wp-content')).toBeNull()
    expect(await read(f.first, 'wp-content/themes/shop')).toBeNull()
    expect(await read(f.first, 'wp-load.php')).toBeNull()
    expect(await read(f.second, 'wp-content/themes/shop/old.php')).toBeNull()
  })

  it('reads a file at the read limit and gives null for one byte more', async () => {
    const f = await fixture()
    const read = (path: string) => f.service.readTreeFile({ repo: f.repo, sha: f.third, path })
    expect(Buffer.from((await read('wp-content/uploads/limit.bin'))!).equals(f.limit)).toBe(true)
    expect(await read('wp-content/uploads/over.bin')).toBeNull()
  })

  it('lists the entries of a folder of a commit with their types', async () => {
    const f = await fixture()
    const list = (sha: string, path: string) => f.service.listDirectory({ repo: f.repo, sha, path })
    const byName = <T extends { name: string }>(rows: readonly T[] | null) =>
      [...(rows ?? [])].sort((a, b) => a.name.localeCompare(b.name))
    expect(byName(await list(f.first, ''))).toEqual([
      { name: 'bin', type: 'directory' },
      { name: 'index.php', type: 'file' },
      { name: 'wp-content', type: 'directory' },
      { name: 'wp-includes', type: 'directory' },
    ])
    expect(byName(await list(f.first, 'wp-content'))).toEqual([
      { name: 'link.php', type: 'link' },
      { name: 'themes', type: 'directory' },
    ])
    expect(byName(await list(f.first, 'wp-content/themes/shop'))).toEqual([
      { name: 'deep', type: 'directory' },
      { name: 'old.php', type: 'file' },
      { name: 'style.css', type: 'file' },
    ])
    expect(await list(f.first, 'bin')).toEqual([{ name: 'tool.sh', type: 'file' }])
    expect(await list(f.first, 'index.php')).toBeNull()
    expect(await list(f.first, 'wp-content/link.php')).toBeNull()
    expect(await list(f.first, 'wp-admin')).toBeNull()
  })

  it('leaves submodules out of a folder and reads none', async () => {
    const f = await fixture()
    const at = { repo: f.repo, sha: f.third }
    expect(
      [...((await f.service.listDirectory({ ...at, path: 'wp-content/uploads' })) ?? [])].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    ).toEqual([
      { name: 'limit.bin', type: 'file' },
      { name: 'over.bin', type: 'file' },
      { name: 'raw.bin', type: 'file' },
    ])
    expect(await f.service.listDirectory({ ...at, path: 'wp-content/uploads/sub' })).toBeNull()
    expect(await f.service.readTreeFile({ ...at, path: 'wp-content/uploads/sub' })).toBeNull()
  })

  it('lists a folder at the entry limit and gives null for one entry more', async () => {
    const f = await fixture()
    const listed = await f.service.listDirectory({ repo: f.repo, sha: f.third, path: 'many' })
    expect(listed).toHaveLength(siteReadEntries)
    expect(listed?.every((entry) => entry.type === 'file')).toBe(true)
    expect(await f.service.listDirectory({ repo: f.repo, sha: f.third, path: 'more' })).toBeNull()
  })

  it('refuses a path of a read that is not one of the repository', async () => {
    const f = await fixture()
    for (const path of ['../etc/passwd', 'wp-content/../index.php', '/index.php', ''])
      await expect(
        f.service.readTreeFile({ repo: f.repo, sha: f.first, path }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    for (const path of ['..', 'wp-content/..', 'wp-content/', '/'])
      await expect(
        f.service.listDirectory({ repo: f.repo, sha: f.first, path }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      f.service.readTreeFile({ repo: { ...f.repo, provider: 'github' }, sha: f.first, path: 'a' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      f.service.listDirectory({ repo: { ...f.repo, provider: 'github' }, sha: f.first, path: '' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
