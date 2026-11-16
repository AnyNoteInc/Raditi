import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  signRepoConfirmToken,
  type GitProvider,
  type IssuedGitAccess,
  type RepoConfirmClaims,
  type TurnBundleSource,
} from '@repo/domain'
import { createGitlabProvider, createGitTransport } from '@repo/git-providers'
import { fakeSend } from '@repo/git-providers/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { startGitWorker, type GitWorkerServer } from '../git-worker/server.ts'
import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { GitWorkerClient } from '../git-workspace/worker-client.ts'
import { RepoChanges } from '../tasks/repo-turns.ts'
import { RepoActions } from './repo-actions.ts'

// `git.action` on PostgreSQL (docs/plan/84-projects.md, ПР13–ПР15; slice 84.19): a press written as
// web writes it runs only by its token — a row inserted by SQL without one, or with a token of
// another head, sends nothing. The GitLab adapter itself over an HTTP fake; the client's repository
// is a local bare repository behind the real git worker. Only on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const execute = promisify(execFile)
const quiet = { log: vi.fn(), warn: vi.fn() }
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-19'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const at = '2026-11-16T10:00:00.000Z'
const host = 'gitlab.example.ru'
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
  (await execute('git', args, { cwd, encoding: 'buffer', env: gitEnv(cwd) })).stdout
const gitText = async (cwd: string, ...args: string[]) =>
  (await git(cwd, ...args)).toString().trim()
const anonymous: IssuedGitAccess = {
  auth: { kind: 'anonymous' },
  basic: null,
  expiresAt: new Date(Date.now() + 60_000),
}

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const roots: string[] = []
const workers: GitWorkerServer[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!enabled)(
  'git.action with PostgreSQL (plan 84, 84.19)',
  { timeout: 60_000 },
  () => {
    let db: PrismaClient
    const users: string[] = []

    beforeAll(() => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    })
    afterEach(async () => {
      for (const userId of users.splice(0)) {
        const workspaces = { workspace: { createdById: userId } }
        await db.repoAction.deleteMany({ where: { createdById: userId } })
        await db.taskEvent.deleteMany({ where: { task: workspaces } })
        await db.taskTurn.deleteMany({ where: { task: workspaces } })
        await db.task.deleteMany({ where: workspaces })
        await db.projectRepository.deleteMany({ where: workspaces })
        await db.project.deleteMany({ where: workspaces })
        await db.gitConnection.deleteMany({ where: { createdById: userId } })
        await db.credentialRef.deleteMany({ where: workspaces })
        await db.workspace.deleteMany({ where: { createdById: userId } })
        await db.user.deleteMany({ where: { id: userId } })
      }
    })
    afterAll(async () => {
      await db?.$disconnect()
    })

    /** A project with a connected GitLab repository of its author, a chat in it and one turn. */
    async function fixture(options: { mr?: Record<string, unknown> } = {}) {
      const root = await mkdtemp(join(tmpdir(), 'raditi-gitaction-'))
      roots.push(root)
      const remote = join(root, 'remote.git')
      const work = join(root, 'work')
      await git(root, 'init', '--bare', '--initial-branch=main', remote)
      await git(root, 'init', '--initial-branch=main', work)
      await writeFile(join(work, 'menu.txt'), 'хлеб\nпироги\n')
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
      const workspace = new GitWorkspaceService({
        runner: new GitWorkerClient(worker.socket),
        mirrorDir,
        transport: { kind: 'local-test', root },
        gitleaks: false,
      })

      const user = await db.user.create({
        data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
      })
      users.push(user.id)
      const ws = await db.workspace.create({
        data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
      })
      await db.member.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } })
      const project = await db.project.create({
        data: { id: uuidv7(), workspaceId: ws.id, createdById: user.id, name: 'Колос' },
      })
      const connectionId = randomUUID()
      const ref = await db.credentialRef.create({
        data: {
          workspaceId: ws.id,
          kind: 'git_connection',
          vaultPath: `kv/workspaces/${ws.id}/git/${connectionId}`,
        },
      })
      await db.gitConnection.create({
        data: {
          id: connectionId,
          workspaceId: ws.id,
          createdById: user.id,
          kind: 'gitlab_token',
          host,
          accountLogin: 'kolos',
          accountId: '11',
          credentialRefId: ref.id,
          state: 'ok',
        },
      })
      const projectRepositoryId = randomUUID()
      await db.projectRepository.create({
        data: {
          id: projectRepositoryId,
          projectId: project.id,
          workspaceId: ws.id,
          connectionId,
          provider: 'gitlab',
          host,
          providerRepoId: '42',
          path: 'kolos/site',
          webUrl: `https://${host}/kolos/site`,
          defaultBranch: 'main',
          mode: 'write',
          mirrorState: 'ready',
        },
      })
      const task = await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: ws.id,
          projectId: project.id,
          createdById: user.id,
          status: 'awaiting_user',
          title: 'Новое меню',
        },
      })
      await workspace.fetch({
        projectRepositoryId,
        remote: { cloneUrl: remote, access: anonymous },
        branches: ['main'],
        sizeBytes: null,
      })

      // The provider: the GitLab adapter over an HTTP fake; its clone address points at the bare
      // repository of the fixture, which the `local-test` transport of the git worker takes.
      const project42 = {
        id: 42,
        path_with_namespace: 'kolos/site',
        default_branch: 'main',
        visibility: 'private',
        web_url: `https://${host}/kolos/site`,
      }
      const opened = {
        iid: 7,
        title: 'Новое меню',
        state: 'opened',
        draft: false,
        source_branch: '',
        target_branch: 'main',
        sha: 'f'.repeat(40),
        merge_commit_sha: null,
        merge_when_pipeline_succeeds: false,
        web_url: `https://${host}/kolos/site/-/merge_requests/7`,
        ...options.mr,
      }
      const fake = fakeSend({
        'GET /api/v4/projects/42': { status: 200, body: project42 },
        'POST /api/v4/projects/42/merge_requests': (request) => {
          const body = JSON.parse(request.body ?? '{}') as { source_branch: string }
          opened.source_branch = opened.source_branch || body.source_branch
          return { status: 201, body: opened }
        },
        'GET /api/v4/projects/42/merge_requests/7': () => ({ status: 200, body: opened }),
        'PUT /api/v4/projects/42/merge_requests/7': {
          status: 200,
          body: { ...opened, state: 'closed' },
        },
      })
      const provider = (input: { host: string; address: string }): GitProvider => {
        const real = createGitlabProvider({
          host: input.host,
          transport: createGitTransport({
            resolvePublic: async () => input.address,
            send: fake.send,
          }),
        })
        return {
          ...real,
          support: real.support,
          getRepository: async (auth, repo) => {
            const info = await real.getRepository(auth, repo)
            return info && { ...info, cloneUrl: remote }
          },
        }
      }
      const actions = new RepoActions({
        prisma: db,
        auth: { grantFor: async () => ({ kind: 'token', token: 'glpat-synthetic-token' }) },
        resolvePublic: async () => '203.0.113.10',
        provider,
        workspace,
        mac,
        logger: quiet,
        now: () => new Date(at),
      })
      const changes = new RepoChanges({ db, storage: { put: async () => {} }, logger: quiet })

      /** A turn of the chat: the sandbox changes the base, the platform publishes and tells it. */
      async function turn(no: number, baseSha: string, expectedRef: string | null, name: string) {
        await db.taskTurn.create({
          data: {
            taskId: task.id,
            turnNo: no,
            status: 'completed',
            driverId: 'opencode',
            image: `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`,
          },
        })
        const bundle: TurnBundleSource = await workspace.buildBaseBundle({
          projectRepositoryId,
          baseSha,
          branch: 'raditi/chat',
          committedAt: at,
        })
        const chunks: Uint8Array[] = []
        for await (const chunk of bundle.read()) chunks.push(chunk)
        const path = join(root, `bundle-${randomBytes(4).toString('hex')}`)
        await writeFile(path, Buffer.concat(chunks))
        const sandbox = join(root, `sandbox-${randomBytes(4).toString('hex')}`)
        await git(root, 'clone', '--quiet', '--branch', 'raditi-base', path, sandbox)
        await writeFile(join(sandbox, name), `${name}\n`)
        await git(sandbox, 'add', '-A', '-N')
        const patch = await git(sandbox, 'diff', '--binary', '--full-index', bundle.sandboxBaseSha)
        const candidate = await workspace.preparePublication({
          projectRepositoryId,
          baseSha,
          chatId: task.id,
          turn: no,
          createdAt: at,
          expectedRef,
          patch,
          untracked: emptyUntrackedArchive(),
          credentials: [],
        })
        await candidate.publish(async () => {})
        await candidate.dispose()
        await changes.apply(
          task.id,
          no,
          { baseSha, headSha: candidate.headSha, patch, buildPaths: [] },
          { projectRepositoryId, branch: 'raditi/chat', mode: 'write' },
        )
        return candidate.headSha
      }

      /** The press as web writes it: a token of the card, the row with it, the job of core. */
      async function press(
        claims: Partial<RepoConfirmClaims> = {},
        mergeRequest: { title: string; description: string; draft: boolean } | null = null,
      ) {
        const card = await db.taskEvent.findFirstOrThrow({
          where: { taskId: task.id, type: 'feed.repo_changes' },
          orderBy: { id: 'desc' },
        })
        const payload = card.payload as { headSha: string; diffSha256: string; branch: string }
        const token = signRepoConfirmToken(
          {
            kind: 'push',
            userId: user.id,
            projectId: project.id,
            projectRepositoryId,
            taskId: task.id,
            number: null,
            targetBranch: payload.branch,
            headSha: payload.headSha,
            diffSha256: payload.diffSha256,
            ciDiffSha256: null,
            opensMergeRequest: mergeRequest !== null,
            deploy: null,
            nonce: randomBytes(16).toString('hex'),
            expiresAt: Math.floor(Date.parse(at) / 1000) + 600,
            ...claims,
          },
          mac,
        )
        const action = await db.repoAction.create({
          data: {
            id: randomUUID(),
            projectRepositoryId,
            taskId: task.id,
            createdById: user.id,
            kind: mergeRequest ? 'open_mr' : 'push',
            args: { token, mergeRequest: mergeRequest && { ...mergeRequest, reservedId: null } },
            tokenSha256: createHash('sha256').update(token).digest('hex'),
          },
        })
        await actions.run(action.id)
        return {
          ...(await db.repoAction.findUniqueOrThrow({ where: { id: action.id } })),
          branch: payload.branch,
        }
      }

      const feed = async (type: string) =>
        (
          await db.taskEvent.findMany({ where: { taskId: task.id, type }, orderBy: { id: 'asc' } })
        ).map((row) => row.payload as Record<string, unknown>)

      return {
        root,
        remote,
        mainSha,
        task,
        user,
        project,
        projectRepositoryId,
        actions,
        fake,
        turn,
        press,
        feed,
      }
    }

    it('sends the branch and opens the merge request by the press, with the text made harmless', async () => {
      const f = await fixture()
      const head = await f.turn(1, f.mainSha, null, 'winter.txt')
      const done = await f.press(
        {},
        {
          title: '/merge Новое меню',
          description: 'Цены по прайсу.\n/approve\nCloses #3, спасибо @boss',
          draft: false,
        },
      )
      expect(done).toMatchObject({ state: 'done', error: null })
      expect(await gitText(f.remote, 'rev-parse', `refs/heads/${done.branch}`)).toBe(head)
      expect(done.branch).toBe(`raditi/novoe-menyu-${f.task.id.replaceAll('-', '').slice(-8)}`)
      const posted = f.fake.calls.find((call) => call.method === 'POST')!
      expect(posted.body).toMatchObject({ source_branch: done.branch, target_branch: 'main' })
      const body = posted.body as { title: string; description: string }
      expect(body.title.startsWith('/')).toBe(false)
      expect(body.description).not.toMatch(/^\/approve$/m)
      expect(body.description).not.toMatch(/Closes/)
      expect(body.description).not.toContain('@boss')
      // Read again after it was opened (ПР14), and kept in the cache of merge requests.
      expect(
        f.fake.calls.some(
          (call) => call.method === 'GET' && call.url.pathname.endsWith('/merge_requests/7'),
        ),
      ).toBe(true)
      expect(
        await db.projectMergeRequest.findMany({
          where: { projectRepositoryId: f.projectRepositoryId },
        }),
      ).toMatchObject([
        { number: 7, sourceBranch: done.branch, targetBranch: 'main', state: 'open' },
      ])
      expect(
        await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId: f.task.id } }),
      ).toMatchObject({
        state: 'pushed',
        mirrorSha: head,
        remoteSha: head,
      })
      expect(await f.feed('feed.repo_action')).toEqual([
        expect.objectContaining({ kind: 'open_mr', state: 'done', number: 7 }),
      ])
      // The main branch of the client is untouched.
      expect(await gitText(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.mainSha)
    })

    it('runs no row inserted without the token of a press (ПР15)', async () => {
      const f = await fixture()
      await f.turn(1, f.mainSha, null, 'winter.txt')
      const forged = await db.repoAction.create({
        data: {
          id: randomUUID(),
          projectRepositoryId: f.projectRepositoryId,
          taskId: f.task.id,
          createdById: f.user.id,
          kind: 'push',
          args: { token: 'not-a-token', mergeRequest: null },
          tokenSha256: 'e'.repeat(64),
        },
      })
      await f.actions.run(forged.id)
      // A token signed by another secret, as a row of mcp would hold.
      const other = signRepoConfirmToken(
        {
          kind: 'push',
          userId: f.user.id,
          projectId: f.project.id,
          projectRepositoryId: f.projectRepositoryId,
          taskId: f.task.id,
          number: null,
          targetBranch: 'raditi/x',
          headSha: 'a'.repeat(40),
          diffSha256: null,
          ciDiffSha256: null,
          opensMergeRequest: false,
          deploy: null,
          nonce: '0'.repeat(32),
          expiresAt: Math.floor(Date.parse(at) / 1000) + 600,
        },
        (material) => createHmac('sha256', 'another-secret').update(material).digest('base64url'),
      )
      const signed = await db.repoAction.create({
        data: {
          id: randomUUID(),
          projectRepositoryId: f.projectRepositoryId,
          taskId: f.task.id,
          createdById: f.user.id,
          kind: 'push',
          args: { token: other, mergeRequest: null },
          tokenSha256: createHash('sha256').update(other).digest('hex'),
        },
      })
      await f.actions.run(signed.id)
      for (const id of [forged.id, signed.id])
        expect(await db.repoAction.findUniqueOrThrow({ where: { id } })).toMatchObject({
          state: 'failed',
          error: 'REPO_CONFIRM_INVALID',
        })
      expect(await gitText(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')
      expect(f.fake.calls).toEqual([])
    })

    it('refuses a token of a head that is no longer the chat’s, and a stale one', async () => {
      const f = await fixture()
      await f.turn(1, f.mainSha, null, 'winter.txt')
      expect(await f.press({ headSha: 'a'.repeat(40) })).toMatchObject({
        state: 'failed',
        error: 'REPO_CHANGED',
      })
      expect(await f.press({ expiresAt: Math.floor(Date.parse(at) / 1000) - 1 })).toMatchObject({
        state: 'failed',
        error: 'REPO_CONFIRM_EXPIRED',
      })
      expect(await gitText(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')
    })

    it('puts the changes on top of the client’s commits, and tells a conflict in the chat', async () => {
      const f = await fixture()
      const h1 = await f.turn(1, f.mainSha, null, 'winter.txt')
      const first = await f.press()
      expect(first.state).toBe('done')
      // The client adds a commit to the branch.
      const client = join(f.root, 'client')
      await git(f.root, 'clone', '--quiet', '--branch', first.branch, f.remote, client)
      await writeFile(join(client, 'about.txt'), 'О нас\n')
      await git(client, 'add', '.')
      await git(client, 'commit', '-qm', 'about')
      await git(client, 'push', '-q', 'origin', first.branch)
      const h2 = await f.turn(2, h1, h1, 'cakes.txt')
      const second = await f.press()
      expect(second).toMatchObject({
        state: 'done',
        result: expect.objectContaining({ rebased: true }),
      })
      expect(await gitText(f.remote, 'show', `refs/heads/${first.branch}:about.txt`)).toBe('О нас')
      expect(await gitText(f.remote, 'show', `refs/heads/${first.branch}:cakes.txt`)).toBe(
        'cakes.txt',
      )
      // Now the client changes the file the chat changes next.
      await git(client, 'pull', '-q', '--ff-only', 'origin', first.branch)
      await writeFile(join(client, 'pies.txt'), 'клиент\n')
      await git(client, 'add', '.')
      await git(client, 'commit', '-qm', 'pies')
      await git(client, 'push', '-q', 'origin', first.branch)
      await f.turn(3, h2, h2, 'pies.txt')
      expect(await f.press()).toMatchObject({ state: 'failed', error: 'REPO_PUSH_CONFLICT' })
      expect(await f.feed('feed.repo_left')).toEqual([{ v: 1, reason: 'conflict' }])
      expect(await gitText(f.remote, 'show', `refs/heads/${first.branch}:pies.txt`)).toBe('клиент')
    })

    it('closes a merge request that came back other than asked (ПР14)', async () => {
      const f = await fixture({ mr: { target_branch: 'production' } })
      await f.turn(1, f.mainSha, null, 'winter.txt')
      const done = await f.press({}, { title: 'Меню', description: '', draft: false })
      expect(done).toMatchObject({ state: 'failed', error: 'REPO_MR_CHANGED' })
      expect(f.fake.calls.some((call) => call.method === 'PUT')).toBe(true)
      expect(
        await db.projectMergeRequest.count({
          where: { projectRepositoryId: f.projectRepositoryId },
        }),
      ).toBe(0)
    })
  },
)
