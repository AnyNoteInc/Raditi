import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { leaseLost, type GitProvider } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitWorkspaceService } from './git-workspace.service.ts'
import { releaseCommit, revertCommit, undoCommit } from './release-git.ts'

// The git of a release on real repositories (docs/plan/53-chat-preview-release.md, Р27): the
// release commit and its revert are the same SHA on every retry, reach `main` only by CAS, and
// the manifest's digests are of the contents on each side.

const execute = promisify(execFile)
const roots: string[] = []
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
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
  ).stdout.trim()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const committedAt = new Date('2026-10-17T12:00:00.000Z')

/** A site repository: `main` installed, and a candidate on `agent/<task>` changing it. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-release-git-test-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  await writeFile(join(work, 'index.php'), 'hello\n')
  await writeFile(join(work, 'delete.txt'), 'delete me\n')
  await writeFile(join(work, 'run.sh'), 'echo 1\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'installed')
  const installed = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  await git(work, 'checkout', '-b', 'agent/task')
  await writeFile(join(work, 'index.php'), 'hello, world\n')
  await rm(join(work, 'delete.txt'))
  await writeFile(join(work, 'added.css'), 'body{}\n')
  await chmod(join(work, 'run.sh'), 0o755)
  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', 'candidate')
  const head = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'push', remote, 'HEAD:refs/heads/agent/task')
  const repo = { provider: 'gitea' as const, owner: 'sites', name: 'site' }
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
    mirrorDir: join(root, 'mirrors'),
  })
  const release = releaseCommit(repo, {
    releaseId: '0196abcd-0000-7000-8000-00000000000a',
    taskId: '0196abcd-0000-7000-8000-00000000000b',
    candidateId: '0196abcd-0000-7000-8000-00000000000c',
    candidateRevision: 2,
    version: 'v1.2.0',
    headSha: head,
    mainBeforeSha: installed,
    committedAt,
  })
  const remoteMain = () => git(remote, 'rev-parse', 'refs/heads/main')
  return { root, remote, work, repo, service, installed, head, release, remoteMain }
}

describe('git of a release', { timeout: 30_000 }, () => {
  it('builds the same release commit every time: the candidate tree on main, by the bot', async () => {
    const f = await fixture()
    const sha = await f.service.trustedCommit(f.release)
    expect(await f.service.trustedCommit(f.release)).toBe(sha)
    // Nothing is pushed by building it.
    expect(await f.remoteMain()).toBe(f.installed)
    // A fresh mirror elsewhere builds the same SHA: the commit depends on its input only.
    const other = new GitWorkspaceService(
      {
        kind: 'gitea',
        getRepository: async () => ({
          ref: f.repo,
          cloneUrl: f.remote,
          defaultBranch: 'main',
          private: true,
        }),
      } as unknown as GitProvider,
      { transport: { kind: 'local-test', root: f.root }, mirrorDir: join(f.root, 'mirrors-2') },
    )
    expect(await other.trustedCommit(f.release)).toBe(sha)
    expect(
      await f.service.trustedCommit({ ...f.release, committedAt: '2026-10-17T12:00:01.000Z' }),
    ).not.toBe(sha)

    const fence = vi.fn(async () => {})
    await expect(
      f.service.pushTrustedCommit({ ...f.release, branch: 'main', expected: f.installed }, fence),
    ).resolves.toEqual({ status: 'pushed', sha })
    expect(fence).toHaveBeenCalledOnce()
    expect(await f.remoteMain()).toBe(sha)
    expect(await git(f.remote, 'rev-parse', `${sha}^{tree}`)).toBe(
      await git(f.remote, 'rev-parse', `${f.head}^{tree}`),
    )
    expect(await git(f.remote, 'rev-parse', `${sha}^`)).toBe(f.installed)
    const meta = await git(f.remote, 'log', '-1', '--format=%an <%ae>|%cn|%ct|%s', sha)
    expect(meta).toBe(
      `Raditi Bot <bot@raditi.ru>|Raditi Bot|${committedAt.getTime() / 1000}|Raditi release v1.2.0`,
    )
    const body = await git(f.remote, 'log', '-1', '--format=%b', sha)
    expect(body).toContain('Raditi-Release: 0196abcd-0000-7000-8000-00000000000a')
  })

  it('a push repeated after a lost answer finds the commit there and pushes nothing', async () => {
    const f = await fixture()
    const fence = vi.fn(async () => {})
    const first = await f.service.pushTrustedCommit(
      { ...f.release, branch: 'main', expected: f.installed },
      fence,
    )
    await expect(
      f.service.pushTrustedCommit({ ...f.release, branch: 'main', expected: f.installed }, fence),
    ).resolves.toEqual({ status: 'present', sha: first.sha })
    // The fence guards a push only: none was needed.
    expect(fence).toHaveBeenCalledOnce()
  })

  it('pushes main only by CAS: moved main is reported and left as it is', async () => {
    const f = await fixture()
    await git(f.work, 'checkout', '-q', 'main')
    await writeFile(join(f.work, 'other.txt'), 'someone else\n')
    await git(f.work, 'add', '.')
    await git(f.work, 'commit', '-m', 'foreign')
    const foreign = await git(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
    const fence = vi.fn(async () => {})
    const pushed = await f.service.pushTrustedCommit(
      { ...f.release, branch: 'main', expected: f.installed },
      fence,
    )
    expect(pushed).toMatchObject({ status: 'moved', remote: foreign })
    expect(fence).not.toHaveBeenCalled()
    expect(await f.remoteMain()).toBe(foreign)
  })

  it('a fence that fails stops the push', async () => {
    const f = await fixture()
    const lost = leaseLost()
    await expect(
      f.service.pushTrustedCommit(
        { ...f.release, branch: 'main', expected: f.installed },
        async () => {
          throw lost
        },
      ),
    ).rejects.toBe(lost)
    expect(await f.remoteMain()).toBe(f.installed)
  })

  it('never pushes a task branch, a tag or a malformed message, and needs a fence', async () => {
    const f = await fixture()
    const fence = async () => {}
    for (const branch of ['agent/task', 'refs/tags/v1.0.0', '../main'])
      await expect(
        f.service.pushTrustedCommit({ ...f.release, branch, expected: f.installed }, fence),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(f.service.trustedCommit({ ...f.release, message: 'a\0b' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      f.service.pushTrustedCommit(
        { ...f.release, branch: 'main', expected: f.installed },
        undefined as unknown as () => Promise<void>,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('the revert commit puts main back to the installed tree on top of the release commit', async () => {
    const f = await fixture()
    const fence = async () => {}
    const released = await f.service.pushTrustedCommit(
      { ...f.release, branch: 'main', expected: f.installed },
      fence,
    )
    const revert = revertCommit(f.repo, {
      releaseId: '0196abcd-0000-7000-8000-00000000000a',
      version: 'v1.2.0',
      approvedSha: released.sha,
      installedSha: f.installed,
      committedAt,
    })
    const sha = await f.service.trustedCommit(revert)
    await expect(
      f.service.pushTrustedCommit({ ...revert, branch: 'main', expected: released.sha }, fence),
    ).resolves.toEqual({ status: 'pushed', sha })
    // Retried after a lost answer: the same commit, already there.
    await expect(
      f.service.pushTrustedCommit({ ...revert, branch: 'main', expected: released.sha }, fence),
    ).resolves.toEqual({ status: 'present', sha })
    expect(await f.remoteMain()).toBe(sha)
    expect(await git(f.remote, 'rev-parse', `${sha}^{tree}`)).toBe(
      await git(f.remote, 'rev-parse', `${f.installed}^{tree}`),
    )
    expect(await git(f.remote, 'rev-parse', `${sha}^`)).toBe(released.sha)
    expect(await git(f.remote, 'log', '-1', '--format=%s', sha)).toBe('Raditi revert of v1.2.0')
  })

  it('digests every changed path by the SHA-256 of its content on each side', async () => {
    const f = await fixture()
    const digests = await f.service.changeDigests({
      repo: f.repo,
      baseSha: f.installed,
      headSha: f.head,
    })
    expect([...digests].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      {
        path: 'added.css',
        change: 'added',
        before: null,
        after: sha256('body{}\n'),
        sizeBytes: 7,
        executable: false,
      },
      {
        path: 'delete.txt',
        change: 'deleted',
        before: sha256('delete me\n'),
        after: null,
        sizeBytes: 0,
        executable: false,
      },
      {
        path: 'index.php',
        change: 'modified',
        before: sha256('hello\n'),
        after: sha256('hello, world\n'),
        sizeBytes: 13,
        executable: false,
      },
      {
        path: 'run.sh',
        change: 'modified',
        before: sha256('echo 1\n'),
        after: sha256('echo 1\n'),
        sizeBytes: 7,
        executable: true,
      },
    ])
  })

  it('builds the undo of a release: the tree before it with its media kept, the same every time', async () => {
    const f = await fixture()
    // The release adds a medium on top of the candidate.
    await git(f.work, 'checkout', 'agent/task')
    await execute('mkdir', ['-p', join(f.work, 'wp-content/uploads/raditi')])
    await writeFile(join(f.work, 'wp-content/uploads/raditi/a.png'), 'png\n')
    await git(f.work, 'add', '-A')
    await git(f.work, 'commit', '-m', 'media')
    const head = await git(f.work, 'rev-parse', 'HEAD')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/agent/task')
    const release = { ...f.release, treeOf: head }
    const released = await f.service.trustedCommit(release)
    await f.service.pushTrustedCommit(
      { ...release, branch: 'main', expected: f.installed },
      async () => {},
    )
    const undo = undoCommit(f.repo, {
      undoId: '0196abcd-0000-7000-8000-00000000000d',
      undoneVersion: 'v1.2.0',
      undoneSha: released,
      version: 'v1.2.1',
      returnsToSha: f.installed,
      keep: ['wp-content/uploads/raditi/a.png'],
      mainBeforeSha: released,
      committedAt,
    })
    const tree = await f.service.treeWith({
      repo: f.repo,
      treeOf: f.installed,
      overlay: undo.overlay!,
    })
    const sha = await f.service.trustedCommit(undo)
    expect(await f.service.trustedCommit(undo)).toBe(sha)
    await expect(
      f.service.pushTrustedCommit({ ...undo, branch: 'main', expected: released }, async () => {}),
    ).resolves.toEqual({ status: 'pushed', sha })
    expect(await git(f.remote, 'rev-parse', `${sha}^{tree}`)).toBe(tree)
    expect(await git(f.remote, 'rev-parse', `${sha}^`)).toBe(released)
    // The files of the version before, and the medium the release added.
    expect(await git(f.remote, 'show', `${sha}:index.php`)).toBe('hello')
    expect(await git(f.remote, 'show', `${sha}:delete.txt`)).toBe('delete me')
    expect(await git(f.remote, 'show', `${sha}:wp-content/uploads/raditi/a.png`)).toBe('png')
    expect((await git(f.remote, 'ls-tree', '--name-only', '-r', sha)).split('\n').sort()).toEqual([
      'delete.txt',
      'index.php',
      'run.sh',
      'wp-content/uploads/raditi/a.png',
    ])
    expect(await git(f.remote, 'log', '-1', '--format=%s', sha)).toBe(
      'Raditi undo of v1.2.0 as v1.2.1',
    )
    // A path the release does not have is refused, not guessed.
    await expect(
      f.service.treeWith({
        repo: f.repo,
        treeOf: f.installed,
        overlay: { from: released, paths: ['wp-content/uploads/raditi/b.png'] },
      }),
    ).rejects.toThrow()
  })
})
