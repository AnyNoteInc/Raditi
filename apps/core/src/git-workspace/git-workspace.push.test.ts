import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { IssuedGitAccess, TurnBundleSource } from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'

import { startGitWorker, type GitWorkerServer } from '../git-worker/server.ts'
import { emptyUntrackedArchive } from './archive.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GitWorkerClient, type GitRunner } from './worker-client.ts'

// The push of a chat's branch to the client (docs/plan/84-projects.md, ПР13, ПР25, ПР26; slice
// 84.19): real git in a real git worker over its socket, a local bare repository as the client's
// remote (`local-test`). The fixture git is the test's own, standing for the client.

const execute = promisify(execFile)
const roots: string[] = []
const workers: GitWorkerServer[] = []
const env = (cwd: string) => ({
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
  (await execute('git', args, { cwd, encoding: 'buffer', env: env(cwd) })).stdout
const gitText = async (cwd: string, ...args: string[]) =>
  (await git(cwd, ...args)).toString().trim()

const anonymous: IssuedGitAccess = {
  auth: { kind: 'anonymous' },
  basic: null,
  expiresAt: new Date(Date.now() + 60_000),
}
const at = '2026-11-16T10:00:00.000Z'

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-gitpush-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  await writeFile(join(work, 'menu.txt'), 'хлеб\nпироги\nторты\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'first')
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  const mainSha = await gitText(work, 'rev-parse', 'HEAD')
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
  const commands: string[] = []
  const runner: GitRunner = {
    run: (request) => {
      commands.push(`${request.tool} ${request.args[0]}`)
      return client.run(request)
    },
  }
  const service = new GitWorkspaceService({
    runner,
    mirrorDir,
    transport: { kind: 'local-test', root },
    gitleaks: false,
  })
  const projectRepositoryId = randomUUID()
  const source = { cloneUrl: remote, access: anonymous }
  await service.fetch({ projectRepositoryId, remote: source, branches: ['main'], sizeBytes: null })
  return { root, remote, work, mainSha, service, projectRepositoryId, source, commands }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

const bytesOf = async (bundle: TurnBundleSource) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of bundle.read()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** One turn of a chat: the sandbox changes the base, the platform publishes it to the chat ref. */
async function turnOf(
  f: Fixture,
  input: { chatId: string; turn: number; baseSha: string; expectedRef: string | null },
  change: (work: string) => Promise<void>,
): Promise<string> {
  const bundle = await f.service.buildBaseBundle({
    projectRepositoryId: f.projectRepositoryId,
    baseSha: input.baseSha,
    branch: 'raditi/chat',
    committedAt: at,
  })
  const path = join(f.root, `bundle-${randomBytes(4).toString('hex')}`)
  await writeFile(path, await bytesOf(bundle))
  const work = join(f.root, `sandbox-${randomBytes(4).toString('hex')}`)
  await git(f.root, 'clone', '--quiet', '--branch', 'raditi-base', path, work)
  await change(work)
  // A new file goes into the patch as the sandbox's capture takes it: intent to add.
  await git(work, 'add', '-A', '-N')
  const patch = await git(
    work,
    'diff',
    '--binary',
    '--full-index',
    '--no-renames',
    bundle.sandboxBaseSha,
  )
  const candidate = await f.service.preparePublication({
    projectRepositoryId: f.projectRepositoryId,
    baseSha: input.baseSha,
    chatId: input.chatId,
    turn: input.turn,
    createdAt: at,
    expectedRef: input.expectedRef,
    patch,
    untracked: emptyUntrackedArchive(),
    credentials: [],
  })
  try {
    await candidate.publish(async () => {})
    return candidate.headSha
  } finally {
    await candidate.dispose()
  }
}

const write = (name: string, content: string) => (work: string) =>
  writeFile(join(work, name), content)

/** What the branch holds at the client: a file of its head. */
const remoteFile = (f: Fixture, branch: string, name: string) =>
  gitText(f.remote, 'show', `refs/heads/${branch}:${name}`)

describe('GitWorkspaceService.pushChatBranch', { timeout: 60_000 }, () => {
  it('sends a new branch, then fast-forwards it with the next turn', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const branch = `raditi/menyu-${chatId.slice(-8)}`
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('menu.txt', 'хлеб\nпироги зимние\nторты\n'),
    )
    const push = (head: string, sent: { remote: string; mirror: string } | null) =>
      f.service.pushChatBranch({
        projectRepositoryId: f.projectRepositoryId,
        chatId,
        remote: f.source,
        branch,
        defaultBranch: 'main',
        head,
        sent,
        committedAt: at,
      })
    expect(await push(h1, null)).toEqual({ kind: 'pushed', sha: h1, rebased: false })
    expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(h1)
    // The commit of the platform: its author and the chat it came from (ПР13).
    expect(await gitText(f.remote, 'log', '-1', '--format=%an <%ae>%n%B', h1)).toContain(
      'Радити <noreply@raditi.ru>',
    )
    expect(await gitText(f.remote, 'log', '-1', '--format=%B', h1)).toContain(
      `Raditi-Chat: ${chatId}`,
    )
    // The main branch at the client is untouched.
    expect(await gitText(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.mainSha)
    const h2 = await turnOf(
      f,
      { chatId, turn: 2, baseSha: h1, expectedRef: h1 },
      write('cakes.txt', 'наполеон\n'),
    )
    expect(await push(h2, { remote: h1, mirror: h1 })).toEqual({
      kind: 'pushed',
      sha: h2,
      rebased: false,
    })
    expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch}^`)).toBe(h1)
  })

  it('puts the changes on top of commits the client added, and says a conflict', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const branch = `raditi/menyu-${chatId.slice(-8)}`
    const push = (head: string, sent: { remote: string; mirror: string } | null) =>
      f.service.pushChatBranch({
        projectRepositoryId: f.projectRepositoryId,
        chatId,
        remote: f.source,
        branch,
        defaultBranch: 'main',
        head,
        sent,
        committedAt: at,
      })
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('menu.txt', 'хлеб\nпироги зимние\nторты\n'),
    )
    await push(h1, null)
    // The client adds a commit to the branch in their repository.
    const client = join(f.root, 'client')
    await git(f.root, 'clone', '--quiet', '--branch', branch, f.remote, client)
    await writeFile(join(client, 'about.txt'), 'О нас\n')
    await git(client, 'add', '.')
    await git(client, 'commit', '-m', 'about')
    await git(client, 'push', 'origin', branch)
    const theirs = await gitText(client, 'rev-parse', 'HEAD')
    const h2 = await turnOf(
      f,
      { chatId, turn: 2, baseSha: h1, expectedRef: h1 },
      write('cakes.txt', 'наполеон\n'),
    )
    const result = await push(h2, { remote: h1, mirror: h1 })
    expect(result).toMatchObject({ kind: 'pushed', rebased: true })
    const sha = result.kind === 'pushed' ? result.sha : ''
    expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(await gitText(f.remote, 'rev-parse', `${sha}^`)).toBe(theirs)
    expect(await remoteFile(f, branch, 'about.txt')).toBe('О нас')
    expect(await remoteFile(f, branch, 'cakes.txt')).toBe('наполеон')
    expect(await remoteFile(f, branch, 'menu.txt')).toContain('пироги зимние')

    // Now the client changes the very line the chat changes next: nothing is sent.
    await git(client, 'pull', '--quiet', '--ff-only', 'origin', branch)
    await writeFile(join(client, 'cakes.txt'), 'медовик\n')
    await git(client, 'commit', '-qam', 'cakes')
    await git(client, 'push', 'origin', branch)
    const before = await gitText(f.remote, 'rev-parse', `refs/heads/${branch}`)
    const h3 = await turnOf(
      f,
      { chatId, turn: 3, baseSha: h2, expectedRef: h2 },
      write('cakes.txt', 'прага\n'),
    )
    expect(await push(h3, { remote: sha, mirror: h2 })).toEqual({ kind: 'conflict' })
    expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(before)
  })

  it('sends a branch /undo took back as a commit on top, never a rewrite (ПР25)', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const branch = `raditi/menyu-${chatId.slice(-8)}`
    const push = (head: string, sent: { remote: string; mirror: string } | null) =>
      f.service.pushChatBranch({
        projectRepositoryId: f.projectRepositoryId,
        chatId,
        remote: f.source,
        branch,
        defaultBranch: 'main',
        head,
        sent,
        committedAt: at,
      })
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('a.txt', 'a\n'),
    )
    const h2 = await turnOf(
      f,
      { chatId, turn: 2, baseSha: h1, expectedRef: h1 },
      write('b.txt', 'b\n'),
    )
    await push(h2, null)
    const result = await push(h1, { remote: h2, mirror: h2 })
    expect(result).toMatchObject({ kind: 'pushed', rebased: true })
    const sha = result.kind === 'pushed' ? result.sha : ''
    expect(await gitText(f.remote, 'rev-parse', `${sha}^`)).toBe(h2)
    expect(await gitText(f.remote, 'rev-parse', `${sha}^{tree}`)).toBe(
      await gitText(f.remote, 'rev-parse', `${h1}^{tree}`),
    )
  })

  it('never pushes to the main branch or a branch that is not the agent’s', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('a.txt', 'a\n'),
    )
    const pushes = f.commands.length
    for (const branch of ['main', 'feature/x', 'raditi/../main', 'refs/heads/main'])
      await expect(
        f.service.pushChatBranch({
          projectRepositoryId: f.projectRepositoryId,
          chatId,
          remote: f.source,
          branch,
          defaultBranch: 'main',
          head: h1,
          sent: null,
          committedAt: at,
        }),
      ).rejects.toMatchObject({ code: 'REPO_PROTECTED_BRANCH' })
    await expect(
      f.service.pushChatBranch({
        projectRepositoryId: f.projectRepositoryId,
        chatId,
        remote: f.source,
        branch: 'raditi/main',
        defaultBranch: 'raditi/main',
        head: h1,
        sent: null,
        committedAt: at,
      }),
    ).rejects.toMatchObject({ code: 'REPO_PROTECTED_BRANCH' })
    expect(f.commands.slice(pushes)).toEqual([])
    expect(await gitText(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.mainSha)
  })

  it('says a name in use at the client before the first push', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const branch = `raditi/menyu-${chatId.slice(-8)}`
    await git(f.work, 'push', f.remote, `HEAD:refs/heads/${branch}`)
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('a.txt', 'a\n'),
    )
    expect(
      await f.service.pushChatBranch({
        projectRepositoryId: f.projectRepositoryId,
        chatId,
        remote: f.source,
        branch,
        defaultBranch: 'main',
        head: h1,
        sent: null,
        committedAt: at,
      }),
    ).toEqual({ kind: 'name_taken' })
    expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(f.mainSha)
  })

  it('sends the branches of two chats of one repository at once, each its own (ПР26)', async () => {
    const f = await fixture()
    const chats = [randomUUID(), randomUUID()]
    const heads = await Promise.all(
      chats.map((chatId, i) =>
        turnOf(
          f,
          { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
          write(`chat-${i}.txt`, `${i}\n`),
        ),
      ),
    )
    const results = await Promise.all(
      chats.map((chatId, i) =>
        f.service.pushChatBranch({
          projectRepositoryId: f.projectRepositoryId,
          chatId,
          remote: f.source,
          branch: `raditi/chat-${chatId.slice(-8)}`,
          defaultBranch: 'main',
          head: heads[i]!,
          sent: null,
          committedAt: at,
        }),
      ),
    )
    expect(results).toEqual(heads.map((sha) => ({ kind: 'pushed', sha, rebased: false })))
    for (const [i, chatId] of chats.entries()) {
      expect(await remoteFile(f, `raditi/chat-${chatId.slice(-8)}`, `chat-${i}.txt`)).toBe(
        String(i),
      )
      await expect(
        remoteFile(f, `raditi/chat-${chatId.slice(-8)}`, `chat-${1 - i}.txt`),
      ).rejects.toThrow()
    }
  })

  it('moves the ref of a chat by CAS only (ПР25)', async () => {
    const f = await fixture()
    const chatId = randomUUID()
    const h1 = await turnOf(
      f,
      { chatId, turn: 1, baseSha: f.mainSha, expectedRef: null },
      write('a.txt', 'a\n'),
    )
    const h2 = await turnOf(
      f,
      { chatId, turn: 2, baseSha: h1, expectedRef: h1 },
      write('b.txt', 'b\n'),
    )
    expect(await f.service.moveChatRef(f.projectRepositoryId, chatId, h1, f.mainSha)).toBe(false)
    expect(await f.service.moveChatRef(f.projectRepositoryId, chatId, h2, h1)).toBe(true)
    expect(await f.service.readChatRef(f.projectRepositoryId, chatId)).toBe(h1)
    expect(await f.service.moveChatRef(f.projectRepositoryId, chatId, h1, null)).toBe(true)
    expect(await f.service.readChatRef(f.projectRepositoryId, chatId)).toBeNull()
  })
})
