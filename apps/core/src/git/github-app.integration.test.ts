import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  REPO_CONFIRM_TTL_SECONDS,
  signRepoConfirmToken,
  type GitProvider,
  type RepoConfirmClaims,
} from '@repo/domain'
import { createGithubProvider, createGitTransport } from '@repo/git-providers'
import { fakeSend } from '@repo/git-providers/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GitAuthSource } from './git-auth-source.ts'
import { GitJobs } from './git-jobs.ts'
import { RepoActions } from './repo-actions.ts'
import { RepoCi } from './repo-ci.ts'

// The GitHub App in core on PostgreSQL (docs/plan/84-projects.md, ПР10, ПР15; slice 84.25): the
// access of an operation is a token of one installation narrowed to the repository — no token is
// stored — and the person who connected the installation is checked before every action: a member
// who only reads cannot have a repository of the organisation offered, nor merge into its main
// branch; «Принять, когда сборка пройдёт» is the platform's own wait over the required checks; a
// deploy is a `workflow_dispatch` of the head of the main branch. The real adapter of
// @repo/git-providers over an HTTP fake of GitHub. Only on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const quiet = { log: vi.fn(), warn: vi.fn() }
const R = '/repos/acme/site'
const head = 'b'.repeat(40)
const mainSha = 'c'.repeat(40)
const mergeSha = 'd'.repeat(40)
const branch = 'raditi/novoe-menyu-12345678'
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-25'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const noWorkspace = {
  pushChatBranch: () => Promise.reject(new Error('no push here')),
  moveChatRef: () => Promise.reject(new Error('no push here')),
  readChatRef: () => Promise.reject(new Error('no push here')),
  buildSettingsChange: () => Promise.reject(new Error('no push here')),
  revertMerge: () => Promise.reject(new Error('no push here')),
}

const repository = (id: number, fullName: string) => ({
  id,
  full_name: fullName,
  default_branch: 'main',
  private: true,
  html_url: `https://github.com/${fullName}`,
  size: 10,
})

describe.skipIf(!enabled)('the GitHub App in core with PostgreSQL (plan 84, 84.25)', () => {
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
      await db.task.deleteMany({ where: workspaces })
      await db.projectRepository.deleteMany({ where: workspaces })
      await db.project.deleteMany({ where: workspaces })
      await db.gitConnection.deleteMany({ where: { createdById: userId } })
      await db.workspace.deleteMany({ where: { createdById: userId } })
      await db.user.deleteMany({ where: { id: userId } })
    }
  })
  afterAll(async () => {
    await db?.$disconnect()
  })

  async function fixture() {
    let now = new Date(Math.floor(Date.now() / 1000) * 1000)
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
    await db.gitConnection.create({
      data: {
        id: connectionId,
        workspaceId: ws.id,
        createdById: user.id,
        kind: 'github_app',
        host: 'github.com',
        accountLogin: 'acme',
        accountId: '500',
        installationId: 77n,
        githubUserId: '9',
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
        provider: 'github',
        host: 'github.com',
        providerRepoId: '42',
        path: 'acme/site',
        webUrl: 'https://github.com/acme/site',
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
    await db.projectRepoBranch.create({
      data: {
        taskId: task.id,
        projectRepositoryId,
        branch,
        baseSha: mainSha,
        mirrorSha: head,
        remoteSha: head,
        state: 'pushed',
      },
    })
    await db.projectMergeRequest.create({
      data: {
        id: randomUUID(),
        projectRepositoryId,
        taskId: task.id,
        number: 7,
        sourceBranch: branch,
        targetBranch: 'main',
        title: 'Новое меню',
        state: 'open',
        headSha: head,
        webUrl: 'https://github.com/acme/site/pull/7',
        syncedAt: now,
      },
    })

    const github = {
      /** What the person who connected may do in acme/site. */
      rights: { permission: 'write', role_name: 'maintain', push: true, maintain: true },
      protectedMain: true,
      required: ['build'] as string[],
      /** The check run `build` of the head: its status and conclusion. */
      build: { status: 'in_progress', conclusion: null as string | null },
      pull: {
        number: 7,
        title: 'Новое меню',
        state: 'open',
        draft: false,
        merged_at: null as string | null,
        merge_commit_sha: null as string | null,
        html_url: 'https://github.com/acme/site/pull/7',
        head: { ref: branch, sha: head, repo: { full_name: 'acme/site' } },
        base: { ref: 'main' },
        auto_merge: null,
      },
      mainHead: mainSha,
      installationRepos: [repository(42, 'acme/site'), repository(43, 'acme/billing')],
      /** The repositories where the person may push; the others answer read. */
      pushable: new Set(['acme/site']),
      /** The runs of the deploy workflow that `workflow_dispatch` started, newest first. */
      dispatched: [] as Record<string, unknown>[],
    }
    const checks = (sha: string) => ({
      [`GET ${R}/commits/${sha}/check-suites`]: () => ({
        status: 200,
        body: {
          check_suites: [
            {
              status: github.build.status,
              conclusion: github.build.conclusion,
              latest_check_runs_count: 1,
            },
          ],
        },
      }),
      [`GET ${R}/commits/${sha}/check-runs`]: () => ({
        status: 200,
        body: { check_runs: [{ name: 'build', ...github.build }] },
      }),
      [`GET ${R}/commits/${sha}/status`]: { status: 200, body: { statuses: [] } },
    })
    const permissionOf = (path: string) => {
      const may = github.pushable.has(path)
      return {
        status: 200,
        body: {
          permission: may ? github.rights.permission : 'read',
          role_name: may ? github.rights.role_name : 'read',
          user: {
            id: 9,
            permissions: {
              pull: true,
              push: may && github.rights.push,
              maintain: may && github.rights.maintain,
              admin: false,
            },
          },
        },
      }
    }
    const fake = fakeSend({
      'POST /app/installations/77/access_tokens': {
        status: 201,
        body: { token: 'ghs_synthetic_84_25', expires_at: '2099-01-01T00:00:00Z' },
      },
      'DELETE /installation/token': { status: 204 },
      [`GET ${R}`]: { status: 200, body: repository(42, 'acme/site') },
      'GET /repos/acme/billing': { status: 200, body: repository(43, 'acme/billing') },
      'GET /user/9': { status: 200, body: { id: 9, login: 'member' } },
      [`GET ${R}/collaborators/member/permission`]: () => permissionOf('acme/site'),
      'GET /repos/acme/billing/collaborators/member/permission': () => permissionOf('acme/billing'),
      [`GET ${R}/branches/main`]: () => ({
        status: 200,
        body: {
          commit: { sha: github.mainHead },
          protected: github.protectedMain,
          protection: { required_status_checks: { contexts: github.required, checks: [] } },
        },
      }),
      [`GET ${R}/rules/branches/main`]: { status: 200, body: [] },
      [`GET ${R}/pulls/7`]: () => ({ status: 200, body: github.pull }),
      [`PUT ${R}/pulls/7/merge`]: (request) => {
        const body = JSON.parse(request.body ?? '{}') as { sha?: string }
        if (body.sha !== github.pull.head.sha)
          return { status: 409, body: { message: 'Head branch was modified' } }
        github.pull.state = 'closed'
        github.pull.merged_at = '2026-11-16T10:00:00Z'
        github.pull.merge_commit_sha = mergeSha
        return { status: 200, body: { merged: true, sha: mergeSha } }
      },
      [`DELETE ${R}/git/refs/heads/${branch}`]: { status: 204 },
      ...checks(head),
      ...checks('e'.repeat(40)),
      [`GET ${R}/actions/runs`]: { status: 200, body: { workflow_runs: [] } },
      [`GET ${R}/actions/workflows`]: {
        status: 200,
        body: {
          workflows: [
            { id: 3, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' },
          ],
        },
      },
      [`GET ${R}/contents/.github/workflows/deploy.yml`]: {
        status: 200,
        body: {
          encoding: 'base64',
          content: Buffer.from('on:\n  workflow_dispatch:\n').toString('base64'),
        },
      },
      [`POST ${R}/actions/workflows/3/dispatches`]: { status: 204 },
      [`GET ${R}/actions/workflows/3/runs`]: () => ({
        status: 200,
        body: { workflow_runs: github.dispatched },
      }),
      [`POST ${R}/actions/runs/91/cancel`]: { status: 202, body: {} },
      'GET /installation/repositories': () => ({
        status: 200,
        body: {
          total_count: github.installationRepos.length,
          repositories: github.installationRepos,
        },
      }),
    })
    const provider = (input: { address: string }): GitProvider =>
      createGithubProvider({
        transport: createGitTransport({
          resolvePublic: async () => input.address,
          send: fake.send,
        }),
      })
    const auth = new GitAuthSource({
      prisma: db,
      secrets: {
        kvRead: () => Promise.reject(new Error('a GitHub App keeps nothing in Vault')),
        kvWrite: () => Promise.reject(new Error('a GitHub App keeps nothing in Vault')),
      },
      connect: () => {
        throw new Error('no sign-in')
      },
      gitlabOauth: null,
      githubApp: { appId: '1001', privateKey: () => pem },
    })
    const options = {
      prisma: db,
      auth,
      resolvePublic: async () => '140.82.112.6',
      provider,
      logger: quiet,
      now: () => now,
    }
    const actions = new RepoActions({
      ...options,
      workspace: noWorkspace,
      mac,
      sleep: () => Promise.resolve(),
    })
    const ci = new RepoCi({
      ...options,
      secrets: { kvRead: async () => null },
      waits: (id) => actions.continueWaits(id),
    })
    const jobs = new GitJobs({
      ...options,
      workspace: {
        fetch: () => Promise.reject(new Error('no fetch here')),
        findSecrets: () => Promise.reject(new Error('no fetch here')),
        buildSettingsChange: () => Promise.reject(new Error('no fetch here')),
        dropMirror: () => Promise.reject(new Error('no fetch here')),
        removeOrphans: () => Promise.reject(new Error('no fetch here')),
        listPaths: () => Promise.reject(new Error('no fetch here')),
      },
    })

    const claimsOf = (over: Partial<RepoConfirmClaims>): RepoConfirmClaims => ({
      kind: 'merge',
      userId: user.id,
      projectId: project.id,
      projectRepositoryId,
      taskId: task.id,
      number: 7,
      targetBranch: 'main',
      headSha: head,
      diffSha256: null,
      ciDiffSha256: null,
      opensMergeRequest: false,
      deploy: null,
      nonce: randomBytes(16).toString('hex'),
      expiresAt: Math.floor(now.getTime() / 1000) + REPO_CONFIRM_TTL_SECONDS,
      ...over,
    })
    async function press(
      kind: 'merge' | 'deploy' | 'open_mr',
      claims: RepoConfirmClaims,
      extra: {
        merge?: { mode: 'now' | 'when_green'; deleteBranch: boolean } | null
        mergeRequest?: unknown
      } = {},
    ) {
      const token = signRepoConfirmToken(claims, mac)
      const id = randomUUID()
      await db.repoAction.create({
        data: {
          id,
          projectRepositoryId,
          taskId: claims.taskId,
          createdById: user.id,
          kind,
          args: { token, mergeRequest: extra.mergeRequest ?? null, merge: extra.merge ?? null },
          tokenSha256: createHash('sha256').update(token).digest('hex'),
        },
      })
      return id
    }
    const rowOf = (id: string) => db.repoAction.findUniqueOrThrow({ where: { id } })
    const sent = (method: string, path: string) =>
      fake.calls.filter((call) => call.method === method && call.url.pathname === path)
    return {
      connectionId,
      projectRepositoryId,
      github,
      actions,
      ci,
      jobs,
      claimsOf,
      press,
      rowOf,
      sent,
      fake,
      later: (ms: number) => (now = new Date(now.getTime() + ms)),
      now: () => now,
    }
  }

  it('merges by a token of the installation narrowed to the repository, revoked after', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'now', deleteBranch: true },
    })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'done', error: null })
    const [token] = f.sent('POST', '/app/installations/77/access_tokens')
    expect(token!.body).toMatchObject({
      repository_ids: [42],
      permissions: { contents: 'write', pull_requests: 'write', actions: 'write' },
    })
    expect(
      (token!.body as { permissions: Record<string, string> }).permissions.workflows,
    ).toBeUndefined()
    expect(f.sent('PUT', `${R}/pulls/7/merge`)[0]!.body).toEqual({
      sha: head,
      merge_method: 'merge',
    })
    expect(f.sent('GET', `${R}/collaborators/member/permission`)).toHaveLength(1)
    expect(f.sent('DELETE', '/installation/token')).toHaveLength(1)
    expect(f.sent('DELETE', `${R}/git/refs/heads/${branch}`)).toHaveLength(1)
    expect(
      await db.projectMergeRequest.findFirst({
        where: { projectRepositoryId: f.projectRepositoryId },
      }),
    ).toMatchObject({ state: 'merged', mergeSha })
  })

  it('a member who may only push cannot merge into the protected main branch', async () => {
    const f = await fixture()
    f.github.rights = { permission: 'write', role_name: 'write', push: true, maintain: false }
    const id = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'now', deleteBranch: true },
    })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_NOT_ALLOWED' })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)).toHaveLength(0)
    // The token of the refused operation is revoked all the same.
    expect(f.sent('DELETE', '/installation/token')).toHaveLength(1)
  })

  it('a member who only reads: no repository offered, no merge, no merge request', async () => {
    const f = await fixture()
    f.github.pushable = new Set()
    await f.jobs.syncConnection(f.connectionId)
    expect(
      await db.gitConnectionRepository.findMany({ where: { connectionId: f.connectionId } }),
    ).toEqual([])
    // The account stays the one the installation was verified with: no `GET /user` by its token.
    expect(
      await db.gitConnection.findUniqueOrThrow({ where: { id: f.connectionId } }),
    ).toMatchObject({ state: 'ok', accountLogin: 'acme', accountId: '500' })
    expect(f.sent('GET', '/user')).toHaveLength(0)
    const merge = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'now', deleteBranch: true },
    })
    await f.actions.run(merge)
    expect(await f.rowOf(merge)).toMatchObject({ state: 'failed', error: 'REPO_NOT_ALLOWED' })
    // «Открыть запрос на слияние» of a branch sent already: refused before GitHub is asked.
    await db.projectMergeRequest.deleteMany({
      where: { projectRepositoryId: f.projectRepositoryId },
    })
    const open = await f.press(
      'open_mr',
      f.claimsOf({
        kind: 'push',
        number: null,
        targetBranch: branch,
        opensMergeRequest: true,
      }),
      { mergeRequest: { title: 'Новое меню', description: '', draft: false, reservedId: null } },
    )
    await f.actions.run(open)
    expect(await f.rowOf(open)).toMatchObject({ state: 'failed', error: 'REPO_NOT_ALLOWED' })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)).toHaveLength(0)
    expect(f.sent('POST', `${R}/pulls`)).toHaveLength(0)
  })

  it('a sync offers only the repositories of the installation the person may push to', async () => {
    const f = await fixture()
    await f.jobs.syncConnection(f.connectionId)
    const rows = await db.gitConnectionRepository.findMany({
      where: { connectionId: f.connectionId },
    })
    expect(rows.map((row) => row.path)).toEqual(['acme/site'])
    // A token of the whole installation for the list, reading only.
    const [token] = f.sent('POST', '/app/installations/77/access_tokens')
    expect((token!.body as Record<string, unknown>).repository_ids).toBeUndefined()
    expect((token!.body as { permissions: Record<string, string> }).permissions.contents).toBe(
      'read',
    )
  })

  it('«Принять, когда сборка пройдёт» waits for the required checks and merges after them', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'when_green', deleteBranch: false },
    })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'waiting', finishedAt: null })
    expect((await f.rowOf(id)).result).toMatchObject({ wait: 'platform', headSha: head })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)).toHaveLength(0)
    // The token expires; the press it confirmed waits on, and a poll reads the checks again.
    f.later(REPO_CONFIRM_TTL_SECONDS * 1000 + 60_000)
    expect(await f.ci.poll(f.projectRepositoryId)).toBe(true)
    expect(await f.rowOf(id)).toMatchObject({ state: 'waiting' })
    f.github.build = { status: 'completed', conclusion: 'success' }
    f.later(60_000)
    expect(await f.ci.poll(f.projectRepositoryId)).toBe(true)
    expect(await f.rowOf(id)).toMatchObject({ state: 'done', error: null })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)[0]!.body).toEqual({
      sha: head,
      merge_method: 'merge',
    })
  })

  it('a wait ends without a merge when the build fails or the branch gets another head', async () => {
    const f = await fixture()
    const failing = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'when_green', deleteBranch: false },
    })
    await f.actions.run(failing)
    f.github.build = { status: 'completed', conclusion: 'failure' }
    f.later(60_000)
    await f.ci.poll(f.projectRepositoryId)
    expect(await f.rowOf(failing)).toMatchObject({ state: 'failed', error: 'REPO_CHECKS_FAILED' })

    f.github.build = { status: 'in_progress', conclusion: null }
    const moved = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'when_green', deleteBranch: false },
    })
    await f.actions.run(moved)
    expect(await f.rowOf(moved)).toMatchObject({ state: 'waiting' })
    f.github.pull.head = { ...f.github.pull.head, sha: 'e'.repeat(40) }
    f.later(60_000)
    await f.ci.poll(f.projectRepositoryId)
    expect(await f.rowOf(moved)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)).toHaveLength(0)
  })

  it('without a required check of the main branch the wait is refused', async () => {
    const f = await fixture()
    f.github.required = []
    const id = await f.press('merge', f.claimsOf({}), {
      merge: { mode: 'when_green', deleteBranch: false },
    })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_NO_REQUIRED_CHECKS' })
    expect(f.sent('PUT', `${R}/pulls/7/merge`)).toHaveLength(0)
  })

  it("«Выкатить» starts the workflow of the head of the main branch, only while it is the card's", async () => {
    const f = await fixture()
    const deploy = (headSha: string) =>
      f.claimsOf({
        kind: 'deploy',
        taskId: null,
        number: null,
        headSha,
        deploy: { kind: 'workflow_dispatch', id: '3', ref: 'main' },
      })
    const id = await f.press('deploy', deploy(mainSha))
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'done' })
    expect(f.sent('POST', `${R}/actions/workflows/3/dispatches`)[0]!.body).toEqual({ ref: 'main' })
    f.github.mainHead = 'f'.repeat(40)
    const stale = await f.press('deploy', deploy(mainSha))
    await f.actions.run(stale)
    expect(await f.rowOf(stale)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(f.sent('POST', `${R}/actions/workflows/3/dispatches`)).toHaveLength(1)
  })

  it('stops a dispatched run that got a commit newer than the card, and says the changes moved', async () => {
    // §4.6: GitHub runs `workflow_dispatch` by the name of the branch. A commit that reached the
    // main branch between the read of its head and the dispatch is the run's — it is cancelled.
    const f = await fixture()
    const deploy = () =>
      f.claimsOf({
        kind: 'deploy',
        taskId: null,
        number: null,
        headSha: mainSha,
        deploy: { kind: 'workflow_dispatch', id: '3', ref: 'main' },
      })
    const runOf = (id: number, sha: string, at: Date, event = 'workflow_dispatch') => ({
      id,
      name: 'Deploy',
      head_sha: sha,
      head_branch: 'main',
      status: 'queued',
      conclusion: null,
      event,
      html_url: `https://github.com/acme/site/actions/runs/${id}`,
      created_at: at.toISOString(),
    })
    const newer = 'f'.repeat(40)
    // An older run and a push run are not the dispatch's; the oldest dispatch since it is.
    f.github.dispatched = [
      runOf(92, mainSha, new Date(f.now().getTime() + 5_000)),
      runOf(91, newer, new Date(f.now().getTime() + 1_000)),
      runOf(90, mainSha, new Date(f.now().getTime() - 60_000)),
      runOf(89, mainSha, new Date(f.now().getTime() + 1_000), 'push'),
    ]
    const id = await f.press('deploy', deploy())
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(f.sent('POST', `${R}/actions/runs/91/cancel`)).toHaveLength(1)
    const [read] = f.sent('GET', `${R}/actions/workflows/3/runs`)
    expect(Object.fromEntries(read!.url.searchParams)).toMatchObject({
      event: 'workflow_dispatch',
      branch: 'main',
    })
    expect(read!.url.searchParams.get('created')).toMatch(/^>=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

    // The run of the card's commit stands: done, with its id; nothing is cancelled.
    f.github.dispatched = [runOf(93, mainSha, new Date(f.now().getTime() + 1_000))]
    const ok = await f.press('deploy', deploy())
    await f.actions.run(ok)
    expect(await f.rowOf(ok)).toMatchObject({ state: 'done' })
    expect((await f.rowOf(ok)).result).toMatchObject({ runId: '93' })
    expect(f.sent('POST', `${R}/actions/runs/91/cancel`)).toHaveLength(1)

    // GitHub made no run in time: the press stands, the next poll shows the run.
    f.github.dispatched = []
    const reads = f.sent('GET', `${R}/actions/workflows/3/runs`).length
    const late = await f.press('deploy', deploy())
    await f.actions.run(late)
    expect(await f.rowOf(late)).toMatchObject({ state: 'done' })
    expect(f.sent('GET', `${R}/actions/workflows/3/runs`)).toHaveLength(reads + 5)
  })
})
