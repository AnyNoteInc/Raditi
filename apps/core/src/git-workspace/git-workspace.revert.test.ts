import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { IssuedGitAccess } from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'

import { startGitWorker, type GitWorkerServer } from '../git-worker/server.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GitWorkerClient } from './worker-client.ts'

// «Отменить» of a merged request and the paths for `@` (docs/plan/84-projects.md, ПР15, ПР24;
// slice 84.26): real git in a real git worker over its socket, a local bare repository as the
// client's remote (`local-test`). The remote takes a want of any commit, as GitHub and GitLab do.

const execute = promisify(execFile)
const roots: string[] = []
const workers: GitWorkerServer[] = []
const gitEnv = (cwd: string) => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Client',
  GIT_AUTHOR_EMAIL: 'client@example.test',
  GIT_COMMITTER_NAME: 'Client',
  GIT_COMMITTER_EMAIL: 'client@example.test',
})
const git = async (cwd: string, ...args: string[]) =>
  (await execute('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) })).stdout.trim()

const anonymous: IssuedGitAccess = {
  auth: { kind: 'anonymous' },
  basic: null,
  expiresAt: new Date(Date.now() + 60_000),
}
const at = '2026-11-17T10:00:00.000Z'

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** main: menu.txt, then a merge of a branch that changes it, then a commit of another file. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-gitrevert-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  await git(root, 'init', '--initial-branch=main', work)
  await writeFile(join(work, 'menu.txt'), 'хлеб\nпироги\nторты\n')
  await writeFile(join(work, '.env'), 'SECRET=1\n')
  await mkdir(join(work, 'src'))
  await writeFile(join(work, 'src', 'app.ts'), 'export {}\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'first')
  await git(work, 'checkout', '-b', 'raditi/menyu-12345678')
  await writeFile(join(work, 'menu.txt'), 'хлеб\nпироги зимние\nторты\n')
  await git(work, 'commit', '-am', 'зимние пироги')
  await git(work, 'checkout', 'main')
  await git(work, 'merge', '--no-ff', '-m', 'Merge !7', 'raditi/menyu-12345678')
  const mergeSha = await git(work, 'rev-parse', 'HEAD')
  await writeFile(join(work, 'about.txt'), 'о нас\n')
  await git(work, 'add', 'about.txt')
  await git(work, 'commit', '-m', 'about')
  await git(work, 'push', remote, 'main:refs/heads/main')
  const headSha = await git(work, 'rev-parse', 'HEAD')
  const mirrorDir = join(root, 'mirrors')
  await mkdir(mirrorDir, { mode: 0o770 })
  const worker = await startGitWorker({
    root: mirrorDir,
    allowLoopback: false,
    refusedSubnets: [],
    allowFileProtocol: true,
    gitleaksBinary: process.execPath,
  })
  workers.push(worker)
  const client = new GitWorkerClient(worker.socket)
  const service = new GitWorkspaceService({
    runner: { run: (request) => client.run(request) },
    mirrorDir,
    transport: { kind: 'local-test', root },
    gitleaks: false,
  })
  const projectRepositoryId = randomUUID()
  const source = { cloneUrl: remote, access: anonymous }
  // The mirror as a turn leaves it: the head of main, one commit deep.
  await service.fetch({ projectRepositoryId, remote: source, branches: ['main'], sizeBytes: null })
  return { root, remote, work, mergeSha, headSha, service, projectRepositoryId, source }
}

const revert = (f: Awaited<ReturnType<typeof fixture>>, branch: string) =>
  f.service.revertMerge({
    projectRepositoryId: f.projectRepositoryId,
    remote: f.source,
    defaultBranch: 'main',
    mergeSha: f.mergeSha,
    branch,
    message: 'Revert !7\n\nThis reverts the merge.\n',
    committedAt: at,
  })

describe('GitWorkspaceService.revertMerge', { timeout: 60_000 }, () => {
  it('sends a new branch whose one commit on top of main takes the merge out', async () => {
    const f = await fixture()
    const branch = 'raditi/revert-7-abcd1234'
    const result = await revert(f, branch)
    expect(result).toMatchObject({ kind: 'pushed', base: f.headSha })
    const sha = (result as { sha: string }).sha
    expect(await git(f.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    // One commit of the platform on top of the head: the merged change is gone, later work stays.
    expect(await git(f.remote, 'rev-parse', `${sha}^`)).toBe(f.headSha)
    expect(await git(f.remote, 'show', `${sha}:menu.txt`)).toBe('хлеб\nпироги\nторты')
    expect(await git(f.remote, 'show', `${sha}:about.txt`)).toBe('о нас')
    expect(await git(f.remote, 'log', '-1', '--format=%an', sha)).toBe('Радити')
    // main itself did not move: the revert reaches it only through the new merge request.
    expect(await git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.headSha)
    // A branch of that name is there now: never overwritten.
    expect(await revert(f, branch)).toEqual({ kind: 'name_taken' })
  })

  it('says a conflict when main changed the same lines, and nothing when they are gone', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'menu.txt'), 'хлеб\nпироги весенние\nторты\n')
    await git(f.work, 'commit', '-am', 'весенние')
    await git(f.work, 'push', f.remote, 'main:refs/heads/main')
    expect(await revert(f, 'raditi/revert-7-conflict1')).toEqual({ kind: 'conflict' })
    await writeFile(join(f.work, 'menu.txt'), 'хлеб\nпироги\nторты\n')
    await git(f.work, 'commit', '-am', 'как было')
    await git(f.work, 'push', f.remote, 'main:refs/heads/main')
    expect(await revert(f, 'raditi/revert-7-nothing1')).toEqual({ kind: 'nothing' })
    expect(await git(f.remote, 'branch', '--list', 'raditi/*')).toBe('')
  })

  it('refuses a branch that is not the platform’s and a merge commit that is not a SHA', async () => {
    const f = await fixture()
    await expect(revert(f, 'main')).rejects.toMatchObject({ code: 'REPO_PROTECTED_BRANCH' })
    await expect(
      f.service.revertMerge({
        projectRepositoryId: f.projectRepositoryId,
        remote: f.source,
        defaultBranch: 'main',
        mergeSha: 'HEAD~1',
        branch: 'raditi/revert-7-x',
        message: 'Revert',
        committedAt: at,
      }),
    ).rejects.toMatchObject({ code: 'REPO_PROTECTED_BRANCH' })
  })
})

describe('GitWorkspaceService.listPaths', { timeout: 60_000 }, () => {
  it('lists the files of a commit of the mirror, without the ones that look like a secret', async () => {
    const f = await fixture()
    const listed = await f.service.listPaths(f.projectRepositoryId, f.headSha, 100)
    expect(listed).toEqual({ paths: ['about.txt', 'menu.txt', 'src/app.ts'], truncated: false })
    expect(await f.service.listPaths(f.projectRepositoryId, f.headSha, 2)).toEqual({
      paths: ['about.txt', 'menu.txt'],
      truncated: true,
    })
    await expect(
      f.service.listPaths(f.projectRepositoryId, 'f'.repeat(40), 10),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the address of an operation', () => {
  it('takes the access only to a repository’s own git address (§4.6; slice 84.26)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-gitaddress-'))
    roots.push(root)
    const mirrorDir = join(root, 'mirrors')
    await mkdir(mirrorDir, { mode: 0o770 })
    const ran: string[] = []
    const service = new GitWorkspaceService({
      runner: {
        run: async (request) => {
          ran.push(request.args[0] ?? '')
          throw new Error('no git here')
        },
      },
      mirrorDir,
      transport: { kind: 'https' },
      gitleaks: false,
    })
    const pin = { host: 'gitlab.example.ru', address: '203.0.113.7' }
    for (const cloneUrl of [
      'https://gitlab.example.ru/api/v4/projects/42.git',
      'https://gitlab.example.ru/group/project',
      'https://gitlab.example.ru/group/-/project.git',
      'https://gitlab.example.ru/group/../project.git',
      'https://gitlab.example.ru/project.git',
    ])
      await expect(
        service.fetch({
          projectRepositoryId: randomUUID(),
          remote: { cloneUrl, pin, access: anonymous },
          branches: ['main'],
          sizeBytes: null,
        }),
        cloneUrl,
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ran).toEqual([])
  })
})
