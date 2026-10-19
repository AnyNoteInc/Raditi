import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'

import {
  isWorkingSetTooLarge,
  siteWorkspaceRules,
  type GitProvider,
  type SiteFacts,
  type TurnBundleSource,
  type TurnPublication,
} from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { pack } from 'tar-stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from './archive.ts'
import { bundleHead } from './base-bundle.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { mirrorPath } from './mirror-store.ts'
import { runProcess } from './process.ts'

// The agent's working set, add-only media and the mirror (docs/plan/53-chat-preview-release.md,
// Р10–Р12) on real repositories: the WordPress rules of the adapter, real git everywhere.
vi.mock('./process.ts', async (importOriginal) => {
  const actual = await importOriginal<{ runProcess: typeof runProcess }>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})

const actualRunProcess = (await vi.importActual<{ runProcess: typeof runProcess }>('./process.ts'))
  .runProcess
const execute = promisify(execFile)
const roots: string[] = []
const candidates: TurnPublication[] = []
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    })
  ).stdout
const out = async (cwd: string, ...args: string[]) => (await git(cwd, ...args)).toString().trim()
/** Git with `input` on stdin. */
const gitWith = (cwd: string, input: string | Buffer, ...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: cwd } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
    child.stdin!.end(input)
  })

afterEach(async () => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcess).mockImplementation(actualRunProcess)
  await Promise.all(candidates.splice(0).map((candidate) => candidate.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const png = (extra = 'pixels') =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(extra)])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('jpeg data')])
const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/shop',
  extras: {},
}
const committedAt = '2026-10-17T10:00:00.000Z'

async function archive(files: { name: string; content: Buffer | string; mode?: number }[]) {
  const stream = pack()
  for (const file of files)
    stream.entry({ name: file.name, mode: file.mode ?? 0o644, type: 'file' }, file.content)
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}

async function write(root: string, files: Record<string, Buffer | string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/**
 * A WordPress site with its core and media in git, as plan 39 imports it; with `gitignore`, a
 * root .gitignore of the site's own that ignores the media library — the import adds none of its
 * own (plan 39), and the library stays in git all the same.
 */
async function fixture(options: { gitignore?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-working-set-test-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  await write(work, {
    'index.php': '<?php require "wp-blog-header.php";\n',
    'wp-config.php': "<?php define('DB_NAME', 'shop');\n",
    'wp-login.php': '<?php // core\n',
    'robots.txt': 'User-agent: *\n',
    '.htaccess': 'RewriteEngine On\n',
    'wp-admin/admin.php': '<?php // admin\n',
    'wp-includes/version.php': "<?php $wp_version = '7.1';\n",
    'wp-content/themes/shop/style.css': 'body { color: black; }\n',
    'wp-content/themes/shop/functions.php': '<?php // theme\n',
    'wp-content/plugins/forms/forms.php': '<?php // forms\n',
    'wp-content/mu-plugins/raditi-content.php': '<?php // platform\n',
    'wp-content/uploads/2026/10/photo.jpg': jpeg,
    'wp-content/uploads/raditi/old.png': png('old'),
  })
  if (options.gitignore) await write(work, { '.gitignore': '/wp-content/uploads/\n*.log\n' })
  // A link outside the working set: the agent never sees it, so it does not stop a turn.
  await mkdir(join(work, 'wp-content/cache'), { recursive: true })
  await symlink('../../index.php', join(work, 'wp-content/cache/index.php'))
  await git(work, 'add', '--force', '.')
  await git(work, 'commit', '-m', 'site')
  const baseSha = await out(work, 'rev-parse', 'HEAD')
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  const scanner = join(root, 'scanner.mjs')
  await writeFile(
    scanner,
    `#!${process.execPath}
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const data = readdirSync(args[1]).map((name) => readFileSync(join(args[1], name), 'latin1')).join('\\n')
const finding = Number(args.find((arg) => arg.startsWith('--exit-code='))?.slice(12) ?? 1)
process.exit(data.includes('synthetic-secret-marker') ? finding : 0)
`,
    { mode: 0o700 },
  )
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
  const mirrorDir = join(root, 'mirrors')
  const service = new GitWorkspaceService(provider, {
    transport: { kind: 'local-test', root },
    gitleaksBinary: scanner,
    mirrorDir,
  })
  const source = {
    repo,
    branch: 'agent/task1',
    expectedBaseSha: baseSha,
    ...siteWorkspaceRules(getSiteAdapter('wordpress'), site),
  }
  /** The sandbox's side: the bundle cloned into a working copy on the task branch. */
  const sandbox = async (bundle: TurnBundleSource) => {
    const dir = await mkdtemp(join(root, 'sandbox-'))
    const file = join(dir, '..', `${dir.split('/').at(-1)}.bundle`)
    const chunks: Uint8Array[] = []
    for await (const chunk of bundle.read()) chunks.push(chunk)
    await writeFile(file, Buffer.concat(chunks))
    await git(root, 'clone', '--quiet', '--branch', 'raditi-base', file, join(dir, 'repo'))
    const repoDir = join(dir, 'repo')
    await git(repoDir, 'checkout', '--quiet', '-b', 'agent/task1')
    return repoDir
  }
  /**
   * What capture takes (sandbox-snapshot.ts): the patch against the commit the sandbox holds,
   * the new files its ignore files let through and every new file below the add-only paths.
   */
  const capture = async (repoDir: string, base: string) => {
    const patch = await git(repoDir, 'diff', '--binary', '--no-renames', base, '--')
    const listed = (await out(repoDir, 'ls-files', '--others', '--exclude-standard', '-z'))
      .split('\0')
      .filter(Boolean)
    const media = (
      await out(
        repoDir,
        '--literal-pathspecs',
        'ls-files',
        '--others',
        '-z',
        '--',
        ...source.addOnlyPaths,
      )
    )
      .split('\0')
      .filter(Boolean)
    const names = [...new Set([...listed, ...media])]
    const untracked = names.length
      ? await archive(
          await Promise.all(
            names.map(async (name) => ({
              name,
              content: await readFile(join(repoDir, name)),
              mode: (await stat(join(repoDir, name))).mode & 0o777,
            })),
          ),
        )
      : emptyUntrackedArchive()
    return { patch, untracked }
  }
  const prepare = async (
    patch: Uint8Array,
    untracked: Uint8Array,
    overrides: Record<string, unknown> = {},
  ) => {
    const candidate = await service.preparePublication({
      ...source,
      taskId: 'task1',
      turn: 1,
      createdAt: committedAt,
      credentials: [],
      ...overrides,
      patch,
      untracked,
    })
    candidates.push(candidate)
    return candidate
  }
  const calls = (name: string) =>
    vi.mocked(runProcess).mock.calls.filter(([, argv]) => argv.includes(name)).length
  return {
    root,
    remote,
    work,
    mirrorDir,
    repo,
    provider,
    service,
    source,
    baseSha,
    sandbox,
    capture,
    prepare,
    calls,
  }
}

// Real git and dozens of child processes per test: a shared CI runner needs more than 5 s.
describe('the agent working set (plan 53, Р11)', { timeout: 60_000 }, () => {
  it('bundles the working set alone as a deterministic root commit of the bot', async () => {
    const f = await fixture()
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    expect(bundle.baseSha).toBe(f.baseSha)
    const sandboxBaseSha = bundle.sandboxBaseSha!
    expect(sandboxBaseSha).toMatch(/^[a-f0-9]{40}$/)
    expect(sandboxBaseSha).not.toBe(f.baseSha)
    // The same base, set and instant give the same commit; another instant another one.
    expect((await f.service.buildBaseBundle(f.source, committedAt)).sandboxBaseSha).toBe(
      sandboxBaseSha,
    )
    await expect(f.service.sandboxBase(f.source, committedAt)).resolves.toBe(sandboxBaseSha)
    expect(
      (await f.service.buildBaseBundle(f.source, '2026-10-17T10:00:01.000Z')).sandboxBaseSha,
    ).not.toBe(sandboxBaseSha)
    const repoDir = await f.sandbox(bundle)
    // Not the agent's media folder either: it only grows (below).
    expect((await out(repoDir, 'ls-files')).split('\n')).toEqual([
      '.htaccess',
      'robots.txt',
      'wp-content/plugins/forms/forms.php',
      'wp-content/themes/shop/functions.php',
      'wp-content/themes/shop/style.css',
    ])
    expect(await out(repoDir, 'rev-list', '--count', '--all')).toBe('1')
    const commit = await out(repoDir, 'cat-file', '-p', sandboxBaseSha)
    expect(commit).not.toMatch(/^parent /m)
    const epoch = Date.parse(committedAt) / 1000
    expect(commit).toContain(`author Raditi Bot <bot@raditi.ru> ${epoch} +0000`)
    expect(commit).toContain(`committer Raditi Bot <bot@raditi.ru> ${epoch} +0000`)
    expect(commit).toContain(`Raditi-Base: ${f.baseSha}`)
    // The blobs are the site's own: a path keeps its content in both trees.
    expect(
      await out(repoDir, 'rev-parse', `${sandboxBaseSha}:wp-content/themes/shop/style.css`),
    ).toBe(await out(f.work, 'rev-parse', `${f.baseSha}:wp-content/themes/shop/style.css`))
  })

  it('refuses a working set without the turn time, and a planned commit it does not make', async () => {
    const f = await fixture()
    await expect(f.service.buildBaseBundle(f.source)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      f.service.buildBaseBundle({ ...f.source, sandboxBaseSha: 'c'.repeat(40) }, committedAt),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const { workingSet: _set, ...withoutSet } = f.source
    await expect(
      f.service.buildBaseBundle({ ...withoutSet, sandboxBaseSha: 'c'.repeat(40) }, committedAt),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const { media: _media, ...withoutMedia } = f.source
    await expect(f.service.buildBaseBundle(withoutMedia, committedAt)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('refuses a working set over its limit as working_set_too_large', async () => {
    const f = await fixture()
    const source = { ...f.source, workingSet: { ...f.source.workingSet, maxBytes: 16 } }
    const error = await f.service.buildBaseBundle(source, committedAt).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'REPOSITORY_TOO_LARGE', httpStatus: 413 })
    expect(isWorkingSetTooLarge(error)).toBe(true)
  })

  it('keeps the old full tree for plans without a working set, links and all refused', async () => {
    const f = await fixture()
    const { workingSet: _set, ...full } = f.source
    // The full tree holds a link: as before, the whole repository is what the agent gets.
    await expect(f.service.buildBaseBundle(full)).rejects.toMatchObject({
      code: 'REPOSITORY_UNSUPPORTED',
    })
  })

  it('applies a patch made against the working set to the full base', async () => {
    const f = await fixture()
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    const repoDir = await f.sandbox(bundle)
    await write(repoDir, {
      'wp-content/themes/shop/style.css': 'body { color: navy; }\n',
      'wp-content/plugins/forms/extra.php': '<?php // new\n',
      'wp-content/uploads/raditi/2026/hero.png': png('hero'),
    })
    await rm(join(repoDir, 'wp-content/themes/shop/functions.php'))
    // A media file the agent added to its index travels in the patch, not in the archive.
    await write(repoDir, { 'wp-content/uploads/raditi/logo.png': png('logo') })
    await git(repoDir, 'add', 'wp-content/uploads/raditi/logo.png')
    const { patch, untracked } = await f.capture(repoDir, bundle.sandboxBaseSha!)
    const candidate = await f.prepare(patch, untracked)
    expect(candidate.baseSha).toBe(f.baseSha)
    expect(candidate.sandboxBaseSha).toBe(bundle.sandboxBaseSha)
    await candidate.publish(async () => {})
    const head = await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')
    expect(head).toBe(candidate.headSha)
    expect(await out(f.remote, 'rev-parse', `${head}^`)).toBe(f.baseSha)
    const tree = await out(f.remote, 'ls-tree', '-r', '--name-only', head)
    expect(tree.split('\n')).toEqual(
      expect.arrayContaining([
        'index.php',
        'wp-config.php',
        'wp-admin/admin.php',
        'wp-includes/version.php',
        'wp-content/uploads/2026/10/photo.jpg',
        'wp-content/cache/index.php',
        'wp-content/mu-plugins/raditi-content.php',
        'wp-content/plugins/forms/extra.php',
        'wp-content/uploads/raditi/2026/hero.png',
        'wp-content/uploads/raditi/logo.png',
      ]),
    )
    expect(tree).not.toContain('wp-content/themes/shop/functions.php')
    expect(
      (await git(f.remote, 'show', `${head}:wp-content/themes/shop/style.css`)).toString(),
    ).toBe('body { color: navy; }\n')
    // The link outside the set is untouched.
    expect(await out(f.remote, 'ls-tree', head, 'wp-content/cache/index.php')).toMatch(/^120000 /)
  })

  it.each([
    ['the core', 'wp-admin/evil.php'],
    ['a new core file', 'wp-includes/new.php'],
    ['the media library outside its own folder', 'wp-content/uploads/2026/10/new.png'],
    ['a folder of the root', 'old-site/index.html'],
    ['the configuration of the server at any depth', 'wp-content/themes/shop/.htaccess'],
    ['the plugin of the platform', 'wp-content/mu-plugins/raditi-preview.php'],
  ])('refuses a new file in %s', async (_, path) => {
    const f = await fixture()
    const untracked = await archive([
      { name: path, content: path.endsWith('.png') ? png() : 'x\n' },
    ])
    await expect(f.prepare(Buffer.alloc(0), untracked)).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
  })

  it('refuses a patch that changes the full tree outside the working set', async () => {
    const f = await fixture()
    // Made against the full base: it applies there, the sandbox could have sent it.
    await write(f.work, { 'wp-includes/version.php': "<?php $wp_version = '0';\n" })
    const patch = await git(f.work, 'diff', '--binary', 'HEAD', '--')
    await expect(f.prepare(patch, emptyUntrackedArchive())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
    await git(f.work, 'checkout', '--', '.')
    await write(f.work, { 'wp-content/uploads/2026/10/photo.jpg': jpeg.subarray(0, 4) })
    const media = await git(f.work, 'diff', '--binary', 'HEAD', '--')
    await expect(f.prepare(media, emptyUntrackedArchive())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
  })
})

describe('add-only media (plan 53, Р12)', { timeout: 60_000 }, () => {
  it('refuses to change or delete media the folder already holds', async () => {
    const f = await fixture()
    // The sandbox never holds them: a patch that changes them was made against the full base.
    await write(f.work, { 'wp-content/uploads/raditi/old.png': png('new') })
    const edit = await git(f.work, 'diff', '--binary', 'HEAD', '--')
    await expect(f.prepare(edit, emptyUntrackedArchive())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
      message: expect.stringContaining('only be added'),
    })
    await rm(join(f.work, 'wp-content/uploads/raditi/old.png'))
    const removal = await git(f.work, 'diff', '--binary', 'HEAD', '--')
    await expect(f.prepare(removal, emptyUntrackedArchive())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
      message: expect.stringContaining('only be added'),
    })
    // A new file of the sandbox under a name the folder already has is no addition.
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    const repoDir = await f.sandbox(bundle)
    await write(repoDir, { 'wp-content/uploads/raditi/old.png': png('again') })
    const again = await f.capture(repoDir, bundle.sandboxBaseSha!)
    await expect(f.prepare(again.patch, again.untracked)).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
    })
  })

  it('leaves the folder out of the sandbox and of its limit, however much it holds', async () => {
    const f = await fixture()
    // Media of earlier releases far above the working set's limit.
    await write(f.work, { 'wp-content/uploads/raditi/video.mp4': Buffer.alloc(256 * 1024, 1) })
    await git(f.work, 'add', 'wp-content/uploads/raditi/video.mp4')
    await git(f.work, 'commit', '-qm', 'media')
    const baseSha = await out(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
    const source = {
      ...f.source,
      expectedBaseSha: baseSha,
      workingSet: { ...f.source.workingSet, maxBytes: 4096 },
    }
    const bundle = await f.service.buildBaseBundle(source, committedAt)
    const repoDir = await f.sandbox(bundle)
    expect(await out(repoDir, 'ls-files', 'wp-content/uploads')).toBe('')
    // New media do not count against the set either: only the sandbox's files do.
    await write(repoDir, { 'wp-content/uploads/raditi/new.png': png('x'.repeat(8192)) })
    const { patch, untracked } = await f.capture(repoDir, bundle.sandboxBaseSha!)
    const candidate = await f.prepare(patch, untracked, {
      expectedBaseSha: baseSha,
      workingSet: source.workingSet,
    })
    expect(candidate.sandboxBaseSha).toBe(bundle.sandboxBaseSha)
  })

  it('takes new media a .gitignore of the site hides, as capture lists them', async () => {
    const f = await fixture({ gitignore: true })
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    const repoDir = await f.sandbox(bundle)
    await write(repoDir, { 'wp-content/uploads/raditi/2026/hero.png': png('hero') })
    // The site's own rules ignore the media library.
    expect(await out(repoDir, 'ls-files', '--others', '--exclude-standard')).toBe('')
    const { patch, untracked } = await f.capture(repoDir, bundle.sandboxBaseSha!)
    const candidate = await f.prepare(patch, untracked)
    await candidate.publish(async () => {})
    expect(
      await out(
        f.remote,
        'ls-tree',
        '--name-only',
        candidate.headSha,
        'wp-content/uploads/raditi/',
      ),
    ).toContain('wp-content/uploads/raditi/2026')
  })

  it.each([
    ['a script behind a picture name', 'fake.png', Buffer.from('<?php system($_GET["c"]);')],
    ['a script name', 'shell.php.png', png()],
    ['a hidden file', '.hidden.png', png()],
    ['SVG', 'logo.svg', Buffer.from('<svg onload="alert(1)"/>')],
    ['a page', 'page.html', Buffer.from('<html></html>')],
  ])('refuses %s', async (_, name, content) => {
    const f = await fixture()
    const untracked = await archive([{ name: `wp-content/uploads/raditi/${name}`, content }])
    await expect(f.prepare(Buffer.alloc(0), untracked)).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
  })

  it('refuses executable media and media over 8 MiB', async () => {
    const f = await fixture()
    const executable = await archive([
      { name: 'wp-content/uploads/raditi/run.png', content: png(), mode: 0o755 },
    ])
    await expect(f.prepare(Buffer.alloc(0), executable)).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    jpeg.copy(big)
    const large = await archive([{ name: 'wp-content/uploads/raditi/big.jpg', content: big }])
    await expect(f.prepare(Buffer.alloc(0), large)).rejects.toMatchObject({
      code: 'PUBLICATION_TOO_LARGE',
    })
  })

  it('takes new media of every allowed kind', async () => {
    const f = await fixture()
    const untracked = await archive([
      { name: 'wp-content/uploads/raditi/a.png', content: png() },
      { name: 'wp-content/uploads/raditi/b.JPG', content: jpeg },
      { name: 'wp-content/uploads/raditi/c.webp', content: Buffer.from('RIFF\0\0\0\0WEBPVP8 ') },
      { name: 'wp-content/uploads/raditi/fonts/d.woff2', content: Buffer.from('wOF2data') },
      { name: 'wp-content/uploads/raditi/e.pdf', content: Buffer.from('%PDF-1.7\n') },
    ])
    const candidate = await f.prepare(Buffer.alloc(0), untracked)
    expect(candidate.sandboxBaseSha).toMatch(/^[a-f0-9]{40}$/)
  })
})

describe('the mirror of a site repository (plan 53, Р10)', { timeout: 60_000 }, () => {
  it('fetches only what it lacks and bundles a commit once', async () => {
    const f = await fixture()
    const first = await f.service.buildBaseBundle(f.source, committedAt)
    expect(f.calls('fetch')).toBe(1)
    expect(f.calls('clone')).toBe(0)
    const created = f.calls('bundle')
    const again = await f.service.buildBaseBundle(f.source, committedAt)
    expect(f.calls('fetch')).toBe(1)
    expect(f.calls('bundle')).toBe(created)
    expect(again.sha256).toBe(first.sha256)
    const candidate = await f.prepare(Buffer.alloc(0), emptyUntrackedArchive())
    expect(f.calls('fetch')).toBe(1)
    // The next turn starts from the candidate the last one pushed: the mirror fetches it.
    await candidate.publish(async () => {})
    await f.service.buildBaseBundle(
      { ...f.source, expectedBaseSha: candidate.headSha },
      committedAt,
    )
    expect(f.calls('fetch')).toBe(2)
    const repos = await readdir(join(f.mirrorDir, 'repos'))
    // The local transport clones from the real path of the fixture.
    const url = await realpath(f.remote)
    expect(repos).toEqual([mirrorPath(f.mirrorDir, f.repo, url).split('/').at(-1)])
  })

  it('refuses a commit the repository does not have', async () => {
    const f = await fixture()
    await expect(
      f.service.buildBaseBundle({ ...f.source, expectedBaseSha: 'e'.repeat(40) }, committedAt),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('fetches once for operations that wait on the same mirror', async () => {
    const f = await fixture()
    const bundles = await Promise.all([
      f.service.buildBaseBundle(f.source, committedAt),
      f.service.buildBaseBundle(f.source, committedAt),
      f.service.sandboxBase(f.source, committedAt),
    ])
    expect(f.calls('fetch')).toBe(1)
    expect(new Set(bundles.map((b) => (typeof b === 'string' ? b : b?.sandboxBaseSha))).size).toBe(
      1,
    )
  })

  it('rebuilds a damaged bundle of its cache and a damaged mirror', async () => {
    const f = await fixture()
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    await writeFile(join(f.mirrorDir, 'bundles', `${bundle.sandboxBaseSha}.bundle`), 'junk')
    const rebuilt = await f.service.buildBaseBundle(f.source, committedAt)
    const bytes: Uint8Array[] = []
    for await (const chunk of rebuilt.read()) bytes.push(chunk)
    expect(bundleHead(Buffer.concat(bytes))).toBe(bundle.sandboxBaseSha)
    await rm(join(mirrorPath(f.mirrorDir, f.repo, await realpath(f.remote)), 'HEAD'))
    await expect(f.service.sandboxBase(f.source, committedAt)).resolves.toBe(bundle.sandboxBaseSha)
    expect(f.calls('fetch')).toBe(2)
  })

  it('fills a mirror of a repository with thousands of branches on the first operation', async () => {
    const f = await fixture()
    // Task branches stay and release tags accumulate: a mature site has many refs.
    const refs = Array.from(
      { length: 1200 },
      (_, i) => `create refs/heads/agent/${randomUUID()}-${i} ${f.baseSha}\n`,
    )
    await gitWith(f.remote, refs.join(''), 'update-ref', '--stdin')
    expect((await out(f.remote, 'for-each-ref', '--count=2000')).split('\n').length).toBe(1201)
    await expect(f.service.treeOf({ repo: f.repo, sha: f.baseSha })).resolves.toMatch(
      /^[a-f0-9]{40}$/,
    )
    expect(f.calls('fetch')).toBe(1)
  })

  it('makes a mirror again when its configuration or alternates were changed', async () => {
    const f = await fixture()
    await f.service.sandboxBase(f.source, committedAt)
    const mirror = mirrorPath(f.mirrorDir, f.repo, await realpath(f.remote))
    const pristine = await readFile(join(mirror, 'config'))
    await appendFile(join(mirror, 'config'), '[http]\n\tsslVerify = false\n')
    await f.service.sandboxBase(f.source, committedAt)
    expect(f.calls('fetch')).toBe(2)
    expect(await readFile(join(mirror, 'config'))).toEqual(pristine)
    await writeFile(join(mirror, 'objects', 'info', 'alternates'), `${f.root}/elsewhere\n`)
    await f.service.sandboxBase(f.source, committedAt)
    expect(f.calls('fetch')).toBe(3)
    await expect(stat(join(mirror, 'objects', 'info', 'alternates'))).rejects.toThrow()
  })

  it('keeps its mirrors in a private directory and refuses a link in its place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-mirror-root-test-'))
    roots.push(root)
    const options = (mirrorDir: string) => ({
      transport: { kind: 'local-test' as const, root },
      mirrorDir,
    })
    const open = join(root, 'open')
    await mkdir(open, { mode: 0o755 })
    await chmod(open, 0o755)
    new GitWorkspaceService({ kind: 'gitea' } as GitProvider, options(open))
    expect((await stat(open)).mode & 0o777).toBe(0o700)
    const made = join(root, 'made', 'mirrors')
    new GitWorkspaceService({ kind: 'gitea' } as GitProvider, options(made))
    expect((await stat(made)).mode & 0o777).toBe(0o700)
    const link = join(root, 'link')
    await symlink(open, link)
    expect(() => new GitWorkspaceService({ kind: 'gitea' } as GitProvider, options(link))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })

  it('takes the working set of a full tree far above the file limit of a repository', async () => {
    const f = await fixture()
    // The media library of a shop: more files than publicationLimits.repositoryFiles.
    const blob = (await gitWith(f.work, jpeg, 'hash-object', '-w', '--stdin')).trim()
    const rows = Array.from(
      { length: 100_001 },
      (_, i) => `100644 ${blob}\twp-content/uploads/2025/thumbs/f${i}.jpg\0`,
    ).join('')
    await gitWith(f.work, rows, 'update-index', '-z', '--index-info')
    await git(f.work, 'commit', '-qm', 'thumbnails')
    const baseSha = await out(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
    const bundle = await f.service.buildBaseBundle(
      { ...f.source, expectedBaseSha: baseSha },
      committedAt,
    )
    const repoDir = await f.sandbox(bundle)
    expect((await out(repoDir, 'ls-files')).split('\n')).toHaveLength(5)
  })

  it('tells the tree of a commit', async () => {
    const f = await fixture()
    await expect(f.service.treeOf({ repo: f.repo, sha: f.baseSha })).resolves.toBe(
      await out(f.work, 'rev-parse', `${f.baseSha}^{tree}`),
    )
    await expect(f.service.treeOf({ repo: f.repo, sha: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})

describe('«Обновить»: the candidate onto a new base (plan 53, Р27)', { timeout: 60_000 }, () => {
  const fence = async () => {}
  /**
   * A published candidate of turn 1 (by default it changes style.css) and a main that moved on
   * with `change`.
   */
  async function moved(
    change: Record<string, string> | ((work: string) => Promise<void>),
    agent: (repoDir: string) => Promise<void> = (repoDir) =>
      write(repoDir, { 'wp-content/themes/shop/style.css': 'body { color: navy; }\n' }),
  ) {
    const f = await fixture()
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    const repoDir = await f.sandbox(bundle)
    await agent(repoDir)
    const { patch, untracked } = await f.capture(repoDir, bundle.sandboxBaseSha!)
    const candidate = await f.prepare(patch, untracked)
    await candidate.publish(fence)
    if (typeof change === 'function') await change(f.work)
    else await write(f.work, change)
    await git(f.work, 'commit', '-qam', 'main moved')
    const toBase = await out(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
    const input = {
      repo: f.repo,
      branch: 'agent/task1',
      fromBase: f.baseSha,
      toBase,
      head: candidate.headSha,
      committedAt: '2026-10-18T09:00:00.000Z',
    }
    return { ...f, input, toBase, head: candidate.headSha }
  }

  it('carries the changes onto the new base as one deterministic commit of the bot', async () => {
    const f = await moved({ 'robots.txt': 'User-agent: *\nDisallow: /tmp\n' })
    const assertFence = vi.fn(fence)
    const { addOnlyPaths, media, protectedPaths, workingSet } = f.source
    const rules = { addOnlyPaths, media, protectedPaths, workingSet }
    const result = await f.service.rebaseCandidate({ ...f.input, rules }, assertFence)
    expect(result).toMatchObject({ status: 'rebased' })
    if (result.status !== 'rebased') throw new Error('expected a rebase')
    expect(assertFence).toHaveBeenCalledOnce()
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(result.headSha)
    expect(await out(f.remote, 'rev-parse', `${result.headSha}^`)).toBe(f.toBase)
    expect(await out(f.remote, 'rev-parse', `${result.headSha}^{tree}`)).toBe(result.treeSha)
    expect((await git(f.remote, 'show', `${result.headSha}:robots.txt`)).toString()).toContain(
      'Disallow',
    )
    expect(
      (
        await git(f.remote, 'show', `${result.headSha}:wp-content/themes/shop/style.css`)
      ).toString(),
    ).toBe('body { color: navy; }\n')
    expect(await out(f.remote, 'log', '-1', '--format=%an %ae', result.headSha)).toBe(
      'Raditi Bot bot@raditi.ru',
    )
    // A retry makes the same commit and finds it published.
    await expect(f.service.rebaseCandidate(f.input, fence)).resolves.toEqual(result)
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: the dialog kept its candidate after a failed pass.
  it('replaces a refused turn the branch stands on and carries the candidate alone', async () => {
    const f = await moved({ 'robots.txt': 'User-agent: *\nDisallow: /tmp\n' })
    await git(f.work, 'fetch', '--quiet', f.remote, 'refs/heads/agent/task1')
    await git(f.work, 'checkout', '--quiet', '-B', 'refused', 'FETCH_HEAD')
    await write(f.work, { 'wp-content/themes/shop/refused.php': '<?php // refused\n' })
    await git(f.work, 'add', 'wp-content/themes/shop/refused.php')
    await git(f.work, 'commit', '-qm', 'a turn the platform refused')
    const refused = await out(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', '--quiet', f.remote, 'HEAD:refs/heads/agent/task1')
    await git(f.work, 'checkout', '--quiet', 'main')

    // Leased on the head of the candidate alone, the update finds the branch moved.
    await expect(f.service.rebaseCandidate(f.input, fence)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(refused)
    const result = await f.service.rebaseCandidate({ ...f.input, branchHead: refused }, fence)
    expect(result).toMatchObject({ status: 'rebased' })
    if (result.status !== 'rebased') throw new Error('expected a rebase')
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(result.headSha)
    expect(await out(f.remote, 'rev-parse', `${result.headSha}^`)).toBe(f.toBase)
    const paths = await out(f.remote, 'ls-tree', '-r', '--name-only', result.headSha)
    expect(paths.split('\n')).not.toContain('wp-content/themes/shop/refused.php')
    expect(
      (
        await git(f.remote, 'show', `${result.headSha}:wp-content/themes/shop/style.css`)
      ).toString(),
    ).toBe('body { color: navy; }\n')
  })

  it('reports the paths both sides changed and writes nothing', async () => {
    const f = await moved({ 'wp-content/themes/shop/style.css': 'body { color: red; }\n' })
    await expect(f.service.rebaseCandidate(f.input, fence)).resolves.toEqual({
      status: 'conflict',
      paths: ['wp-content/themes/shop/style.css'],
    })
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(f.head)
  })

  it('never carries a change after a file main moved, into the media library say', async () => {
    const f = await moved(
      async (work) => {
        await mkdir(join(work, 'wp-content/uploads/2026'), { recursive: true })
        await git(
          work,
          'mv',
          'wp-content/themes/shop/functions.php',
          'wp-content/uploads/2026/functions.php',
        )
      },
      (repoDir) =>
        write(repoDir, {
          'wp-content/themes/shop/functions.php': '<?php // theme, changed\n',
          'wp-content/themes/shop/new.php': '<?php // new\n',
        }),
    )
    await expect(f.service.rebaseCandidate(f.input, fence)).resolves.toEqual({
      status: 'conflict',
      paths: ['wp-content/themes/shop/functions.php'],
    })
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(f.head)
  })

  it('refuses a result that changes a path the candidate never changed', async () => {
    const f = await moved({ 'robots.txt': 'changed\n' })
    // The merge as git might one day make it: one more path than the candidate's own.
    vi.mocked(runProcess).mockImplementation(async (binary, argv, options) => {
      const result = await actualRunProcess(binary, argv, options)
      if (argv.includes('diff-tree') && argv.at(-2) === f.toBase)
        return {
          ...result,
          stdout: Buffer.concat([
            result.stdout,
            Buffer.from(`:000000 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} A\0wp-admin/x.php\0`),
          ]),
        }
      return result
    })
    await expect(f.service.rebaseCandidate(f.input, fence)).resolves.toEqual({
      status: 'conflict',
      paths: ['wp-admin/x.php'],
    })
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(f.head)
  })

  it('holds the result to the rules of the site when it gets them', async () => {
    const f = await moved({ 'robots.txt': 'changed\n' })
    const { addOnlyPaths, media, workingSet } = f.source
    const rules = { addOnlyPaths, media, workingSet, protectedPaths: ['wp-content/themes/'] }
    await expect(f.service.rebaseCandidate({ ...f.input, rules }, fence)).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
    expect(await out(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toBe(f.head)
  })

  it('refuses a head that does not stand on its base, a branch that moved and no fence', async () => {
    const f = await moved({ 'robots.txt': 'changed\n' })
    await expect(
      f.service.rebaseCandidate({ ...f.input, fromBase: f.toBase, toBase: f.baseSha }, fence),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.service.rebaseCandidate(f.input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await git(f.work, 'push', '--force', f.remote, `${f.toBase}:refs/heads/agent/task1`)
    const assertFence = vi.fn(fence)
    await expect(f.service.rebaseCandidate(f.input, assertFence)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(assertFence).not.toHaveBeenCalled()
  })
})

describe('the change of a candidate (plan 53, Р5: compareCommits)', { timeout: 60_000 }, () => {
  it('gives both trees, the patch publication wrote, each path and the added media', async () => {
    const f = await fixture()
    const bundle = await f.service.buildBaseBundle(f.source, committedAt)
    const repoDir = await f.sandbox(bundle)
    await write(repoDir, {
      'wp-content/themes/shop/style.css': 'body { color: navy; }\n',
      'wp-content/plugins/forms/run.sh': '#!/bin/sh\n',
      'wp-content/uploads/raditi/hero.png': png('hero'),
    })
    await chmod(join(repoDir, 'wp-content/plugins/forms/run.sh'), 0o755)
    await rm(join(repoDir, 'wp-content/themes/shop/functions.php'))
    const { patch, untracked } = await f.capture(repoDir, bundle.sandboxBaseSha!)
    const candidate = await f.prepare(patch, untracked)
    await candidate.publish(async () => {})
    const comparison = await f.service.compareCommits({
      repo: f.repo,
      baseSha: f.baseSha,
      headSha: candidate.headSha,
      addOnlyPaths: f.source.addOnlyPaths,
    })
    expect(comparison.baseTree).toBe(await out(f.work, 'rev-parse', `${f.baseSha}^{tree}`))
    expect(comparison.headTree).toBe(
      await out(f.remote, 'rev-parse', `${candidate.headSha}^{tree}`),
    )
    expect(Buffer.from(comparison.patch).equals(Buffer.from(candidate.patch))).toBe(true)
    expect(comparison.files).toEqual([
      { path: 'wp-content/plugins/forms/run.sh', change: 'added', sizeBytes: 10, executable: true },
      {
        path: 'wp-content/themes/shop/functions.php',
        change: 'deleted',
        sizeBytes: 0,
        executable: false,
      },
      {
        path: 'wp-content/themes/shop/style.css',
        change: 'modified',
        sizeBytes: 22,
        executable: false,
      },
      {
        path: 'wp-content/uploads/raditi/hero.png',
        change: 'added',
        sizeBytes: png('hero').byteLength,
        executable: false,
      },
    ])
    expect(comparison.added).toEqual([
      { path: 'wp-content/uploads/raditi/hero.png', bytes: Uint8Array.from(png('hero')) },
    ])
    // Two candidate heads: only what changed between them.
    await expect(
      f.service.compareCommits({
        repo: f.repo,
        baseSha: candidate.headSha,
        headSha: candidate.headSha,
        addOnlyPaths: [],
      }),
    ).resolves.toMatchObject({ files: [], added: [], patch: new Uint8Array() })
    await expect(
      f.service.compareCommits({
        repo: f.repo,
        baseSha: 'x',
        headSha: f.baseSha,
        addOnlyPaths: [],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
