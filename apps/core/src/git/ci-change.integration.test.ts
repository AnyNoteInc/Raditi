import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  repoCiDiffKey,
  repoCiLintSchema,
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
import { GitJobs } from './git-jobs.ts'
import { RepoActions } from './repo-actions.ts'

// A change of build settings on PostgreSQL (docs/plan/84-projects.md, ПР16; slice 84.20): a branch
// whose change touches the build paths — the domain's, the provider's CODEOWNERS, the files of
// `include: local` — is not sent by «Отправить в ветку»; `git.ci_lint` keeps the diff of those
// files and the answer of CI Lint; «Разрешить и отправить» sends it only with a token of that very
// diff. The GitLab adapter over an HTTP fake, the client's repository a local bare repository
// behind the real git worker. Only on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const execute = promisify(execFile)
const quiet = { log: vi.fn(), warn: vi.fn() }
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-20'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const at = '2026-11-16T10:00:00.000Z'
const host = 'gitlab.example.ru'
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
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const CI = 'include:\n  - local: ci/deploy.yml\nlint:\n  script: npm run lint\n'

const roots: string[] = []
const workers: GitWorkerServer[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!enabled)(
  'build settings of a branch with PostgreSQL (plan 84, 84.20)',
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
      await db.outboxEvent.deleteMany({ where: { topic: 'git', type: 'git.ci_lint' } })
    })
    afterAll(async () => {
      await db?.$disconnect()
    })

    async function fixture(options: { ciPaths?: unknown; lintIncludes?: string[] } = {}) {
      const root = await mkdtemp(join(tmpdir(), 'raditi-cichange-'))
      roots.push(root)
      const remote = join(root, 'remote.git')
      const work = join(root, 'work')
      await git(root, 'init', '--bare', '--initial-branch=main', remote)
      await git(root, 'init', '--initial-branch=main', work)
      for (const [name, content] of Object.entries({
        'menu.txt': 'хлеб\n',
        '.gitlab-ci.yml': CI,
        'ci/deploy.yml': 'deploy:\n  script: ./deploy.sh\n',
      })) {
        await mkdir(dirname(join(work, name)), { recursive: true })
        await writeFile(join(work, name), content)
      }
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
          // `git.repo.attach` read these by CI Lint of the main branch (ПР16).
          ciPaths: (options.ciPaths ?? {
            v: 1,
            configPath: null,
            foreign: false,
            includes: ['ci/deploy.yml'],
          }) as object,
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

      const fake = fakeSend({
        'GET /api/v4/projects/42': {
          status: 200,
          body: {
            id: 42,
            path_with_namespace: 'kolos/site',
            default_branch: 'main',
            visibility: 'private',
            web_url: `https://${host}/kolos/site`,
          },
        },
        'POST /api/v4/projects/42/ci/lint': {
          status: 200,
          body: {
            valid: false,
            errors: ['jobs:lint script can not be empty'],
            includes: (options.lintIncludes ?? ['ci/deploy.yml']).map((location) => ({
              type: 'local',
              location,
            })),
          },
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
      const grantFor = async () => ({ kind: 'token' as const, token: 'glpat-synthetic-token' })
      const actions = new RepoActions({
        prisma: db,
        auth: { grantFor },
        resolvePublic: async () => '203.0.113.10',
        provider,
        workspace,
        mac,
        logger: quiet,
        now: () => new Date(at),
      })
      const kept = new Map<string, Buffer>()
      const storage = {
        put: async (_bucket: string, key: string, body: Uint8Array) => {
          kept.set(key, Buffer.from(body))
        },
      }
      const jobs = new GitJobs({
        prisma: db,
        auth: { grantFor },
        resolvePublic: async () => '203.0.113.10',
        provider,
        workspace,
        storage: storage as never,
        logger: quiet,
      })
      const changes = new RepoChanges({ db, storage: storage as never, logger: quiet })

      /** A turn of the chat that writes `files`; the platform publishes it and tells it. */
      async function turn(no: number, baseSha: string, files: Record<string, string>) {
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
        for (const [name, content] of Object.entries(files)) {
          await mkdir(dirname(join(sandbox, name)), { recursive: true })
          await writeFile(join(sandbox, name), content)
        }
        await git(sandbox, 'add', '-A', '-N')
        const patch = await git(sandbox, 'diff', '--binary', '--full-index', bundle.sandboxBaseSha)
        const expectedRef = await workspace.readChatRef(projectRepositoryId, task.id)
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
          { baseSha, headSha: candidate.headSha, patch, buildPaths: candidate.buildPaths },
          { projectRepositoryId, branch: 'raditi/chat', mode: 'write' },
        )
        return candidate.headSha
      }

      /** The press as web writes it: `push` by «Отправить в ветку», `ci_change` by the card. */
      async function press(claims: Partial<RepoConfirmClaims> = {}) {
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
            opensMergeRequest: false,
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
            kind: claims.kind === 'ci_change' ? 'ci_push' : 'push',
            args: { token, mergeRequest: null },
            tokenSha256: sha256(token),
          },
        })
        await actions.run(action.id)
        return db.repoAction.findUniqueOrThrow({ where: { id: action.id } })
      }

      const cards = async () =>
        (
          await db.taskEvent.findMany({
            where: { taskId: task.id, type: 'feed.repo_changes' },
            orderBy: { id: 'asc' },
          })
        ).map((row) => row.payload as { ciTouched: boolean; headSha: string })
      const lint = async () =>
        repoCiLintSchema.parse(
          (await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId: task.id } })).ciLint,
        )
      const remoteRefs = () => gitText(remote, 'for-each-ref', '--format=%(refname)')

      return {
        remote,
        mainSha,
        task,
        projectRepositoryId,
        fake,
        kept,
        jobs,
        turn,
        press,
        cards,
        lint,
        remoteRefs,
      }
    }

    it('sends no change of the build settings without the card, then sends it by the card', async () => {
      const f = await fixture()
      const head = await f.turn(1, f.mainSha, {
        '.gitlab-ci.yml': CI.replace('npm run lint', 'npm run lint && npx linkinator'),
      })
      expect((await f.cards())[0]!.ciTouched).toBe(true)
      // RepoChanges asks core for the diff and the lint at once; it sends nothing itself.
      expect(
        await db.outboxEvent.count({
          where: { type: 'git.ci_lint', payload: { equals: { taskId: f.task.id, headSha: head } } },
        }),
      ).toBe(1)
      expect(await f.press()).toMatchObject({ state: 'failed', error: 'REPO_CI_CHANGE' })
      // Neither a card of another kind before the lint.
      expect(await f.press({ kind: 'ci_change', ciDiffSha256: 'c'.repeat(64) })).toMatchObject({
        state: 'failed',
        error: 'REPO_CHANGED',
      })
      expect(await f.remoteRefs()).toBe('refs/heads/main')

      await f.jobs.lintBranch(f.task.id, head)
      const row = await f.lint()
      expect(row).toMatchObject({
        headSha: head,
        fromSha: f.mainSha,
        tooLarge: false,
        declined: false,
        lint: { valid: false, errors: ['jobs:lint script can not be empty'] },
        includes: ['ci/deploy.yml'],
        files: [{ path: '.gitlab-ci.yml', additions: 1, deletions: 1 }],
      })
      // CI Lint got the configuration of the head, as a dry run on the main branch (never sent).
      const posted = f.fake.calls.find((call) => call.url.pathname.endsWith('/ci/lint'))!
      expect(posted.body).toMatchObject({ dry_run: true, ref: 'main' })
      expect((posted.body as { content: string }).content).toContain('npx linkinator')
      const diff = f.kept.get(repoCiDiffKey(f.task.id, head))!
      expect(diff.toString()).toContain('+  script: npm run lint && npx linkinator')
      expect(row.ciDiffSha256).toBe(sha256(diff))
      expect(
        (await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId: f.task.id } }))
          .ciDiffSha256,
      ).toBe(row.ciDiffSha256)

      const done = await f.press({ kind: 'ci_change', ciDiffSha256: row.ciDiffSha256 })
      expect(done).toMatchObject({ state: 'done', error: null })
      const branch = await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId: f.task.id } })
      expect(branch).toMatchObject({
        state: 'pushed',
        mirrorSha: head,
        ciConfirmedSha256: row.ciDiffSha256,
      })
      expect(await gitText(f.remote, 'rev-parse', `refs/heads/${branch.branch}`)).toBe(head)
      const told = await db.taskEvent.findFirstOrThrow({
        where: { taskId: f.task.id, type: 'feed.repo_action' },
        orderBy: { id: 'desc' },
      })
      expect(told.payload).toMatchObject({ kind: 'ci_push', state: 'done' })
    })

    it('refuses a token of another diff, and a change the client declined', async () => {
      const f = await fixture()
      const head = await f.turn(1, f.mainSha, { '.gitmodules': '[submodule "x"]\n' })
      await f.jobs.lintBranch(f.task.id, head)
      const row = await f.lint()
      expect(row.files.map((file) => file.path)).toEqual(['.gitmodules'])
      expect(
        await f.press({ kind: 'ci_change', ciDiffSha256: sha256('another diff') }),
      ).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
      // A row of ci_lint someone changed in the base does not make another diff pass: core makes
      // the diff again from the mirror.
      await db.projectRepoBranch.update({
        where: { taskId: f.task.id },
        data: { ciLint: { ...row, ciDiffSha256: sha256('forged') } },
      })
      expect(await f.press({ kind: 'ci_change', ciDiffSha256: sha256('forged') })).toMatchObject({
        state: 'failed',
        error: 'REPO_CHANGED',
      })
      await db.projectRepoBranch.update({
        where: { taskId: f.task.id },
        data: { ciLint: { ...row, declined: true } },
      })
      expect(await f.press({ kind: 'ci_change', ciDiffSha256: row.ciDiffSha256 })).toMatchObject({
        state: 'failed',
        error: 'REPO_CI_DECLINED',
      })
      expect(await f.remoteRefs()).toBe('refs/heads/main')
    })

    it('takes a file of `include: local` and CODEOWNERS for build settings', async () => {
      const f = await fixture({ lintIncludes: ['ci/deploy.yml', 'ci/extra.yml'] })
      const first = await f.turn(1, f.mainSha, { 'menu.txt': 'хлеб\nпироги\n' })
      const second = await f.turn(2, first, { 'ci/deploy.yml': 'deploy:\n  script: ./x.sh\n' })
      const head = await f.turn(3, second, { CODEOWNERS: '* @kolos/team\n' })
      expect((await f.cards()).map((card) => card.ciTouched)).toEqual([false, true, true])
      expect(await f.press()).toMatchObject({ state: 'failed', error: 'REPO_CI_CHANGE' })
      // A file the branch's configuration includes now joins them by CI Lint of the branch.
      const last = await f.turn(4, head, {
        '.gitlab-ci.yml': CI.replace('ci/deploy.yml\n', 'ci/deploy.yml\n  - local: ci/extra.yml\n'),
        'ci/extra.yml': 'extra:\n  script: env\n',
      })
      await f.jobs.lintBranch(f.task.id, last)
      expect((await f.lint()).files.map((file) => file.path)).toEqual([
        '.gitlab-ci.yml',
        'CODEOWNERS',
        'ci/deploy.yml',
        'ci/extra.yml',
      ])
      expect(await f.remoteRefs()).toBe('refs/heads/main')
    })

    it('sends nothing when `ci_config_path` names another project', async () => {
      const f = await fixture({
        ciPaths: { v: 1, configPath: null, foreign: true, includes: [] },
      })
      await f.turn(1, f.mainSha, { 'menu.txt': 'хлеб\nпироги\n' })
      expect((await f.cards())[0]!.ciTouched).toBe(false)
      expect(await f.press()).toMatchObject({ state: 'failed', error: 'REPO_CI_CONFIG_FOREIGN' })
      expect(await f.remoteRefs()).toBe('refs/heads/main')
    })
  },
)
