import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  REPO_CONFIRM_TTL_SECONDS,
  signRepoConfirmToken,
  type GitProvider,
  type RepoConfirmClaims,
} from '@repo/domain'
import { createGitlabProvider, createGitTransport } from '@repo/git-providers'
import { fakeSend } from '@repo/git-providers/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { endWaitingMerges, RepoActions } from './repo-actions.ts'
import { RepoCi } from './repo-ci.ts'

// «Принять в основную ветку» and «Выкатить» on PostgreSQL (docs/plan/84-projects.md, ПР15; slice
// 84.22): a press runs only by its token, once and within its ten minutes; the merge request is
// read again — a target the client changed after the card is refused, a new head is the provider's
// 409 and «Изменения обновились»; «Принять, когда сборка пройдёт» waits until `git.poll` reads the
// request merged; a deploy plays a manual job of the main branch only while its head is the card's.
// The GitLab adapter itself over an HTTP fake. Only on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const quiet = { log: vi.fn(), warn: vi.fn() }
const host = 'gitlab.example.ru'
const P = '/api/v4/projects/42'
const head = 'b'.repeat(40)
const mainSha = 'c'.repeat(40)
const mergeSha = 'd'.repeat(40)
const branch = 'raditi/novoe-menyu-12345678'
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-22'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The workspace of git is never reached by a merge or a deploy. */
const noWorkspace = {
  pushChatBranch: () => Promise.reject(new Error('no push in a merge')),
  moveChatRef: () => Promise.reject(new Error('no push in a merge')),
  readChatRef: () => Promise.reject(new Error('no push in a merge')),
  buildSettingsChange: () => Promise.reject(new Error('no push in a merge')),
}

describe.skipIf(!enabled)('merge and deploy with PostgreSQL (plan 84, 84.22)', () => {
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
      await db.credentialRef.deleteMany({ where: workspaces })
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
        webUrl: `https://${host}/kolos/site/-/merge_requests/7`,
        syncedAt: now,
      },
    })

    const gitlab = {
      mr: {
        iid: 7,
        title: 'Новое меню',
        state: 'opened',
        draft: false,
        source_branch: branch,
        target_branch: 'main',
        sha: head,
        merge_commit_sha: null as string | null,
        merge_when_pipeline_succeeds: false,
        web_url: `https://${host}/kolos/site/-/merge_requests/7`,
      },
      /** What PUT …/merge answers; null — it merges. */
      mergeAnswer: null as { status: number; body?: unknown } | null,
      mainHead: mainSha,
      pipelineSha: mainSha,
      manual: [{ id: 4812, name: 'deploy-production', stage: 'deploy', status: 'manual' }],
    }
    const fake = fakeSend({
      [`GET ${P}`]: {
        status: 200,
        body: {
          id: 42,
          path_with_namespace: 'kolos/site',
          default_branch: 'main',
          visibility: 'private',
          web_url: `https://${host}/kolos/site`,
        },
      },
      [`GET ${P}/merge_requests/7`]: () => ({ status: 200, body: gitlab.mr }),
      [`PUT ${P}/merge_requests/7/merge`]: (request) => {
        if (gitlab.mergeAnswer) return gitlab.mergeAnswer
        const body = JSON.parse(request.body ?? '{}') as { auto_merge?: boolean }
        if (body.auto_merge) {
          gitlab.mr.merge_when_pipeline_succeeds = true
          return { status: 200, body: gitlab.mr }
        }
        gitlab.mr.state = 'merged'
        gitlab.mr.merge_commit_sha = mergeSha
        return { status: 200, body: gitlab.mr }
      },
      [`GET ${P}/repository/branches`]: () => ({
        status: 200,
        body: [{ name: 'main', commit: { id: gitlab.mainHead } }],
      }),
      [`GET ${P}/pipelines`]: (request) => ({
        status: 200,
        body:
          request.url.searchParams.get('ref') === 'main'
            ? [
                {
                  id: 481,
                  sha: gitlab.pipelineSha,
                  ref: 'main',
                  status: 'manual',
                  web_url: `https://${host}/kolos/site/-/pipelines/481`,
                },
              ]
            : [],
      }),
      [`GET ${P}/pipelines/481/jobs`]: () => ({ status: 200, body: gitlab.manual }),
      [`POST ${P}/jobs/4812/play`]: {
        status: 200,
        body: { id: 4812, name: 'deploy-production', status: 'pending', pipeline: { id: 481 } },
      },
    })
    const provider = (input: { host: string; address: string }): GitProvider =>
      createGitlabProvider({
        host: input.host,
        transport: createGitTransport({
          resolvePublic: async () => input.address,
          send: fake.send,
        }),
      })
    const options = {
      prisma: db,
      auth: { grantFor: async () => ({ kind: 'token' as const, token: 'glpat-synthetic-84-22' }) },
      resolvePublic: async () => '203.0.113.10',
      provider,
      logger: quiet,
      now: () => now,
    }
    const actions = new RepoActions({ ...options, workspace: noWorkspace, mac })
    const ci = new RepoCi({ ...options, secrets: { kvRead: async () => null } })

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
    /** A press as web writes it: the row with the token itself. */
    async function press(
      kind: 'merge' | 'deploy',
      claims: RepoConfirmClaims,
      merge: { mode: 'now' | 'when_green'; deleteBranch: boolean } | null,
      token = signRepoConfirmToken(claims, mac),
    ) {
      const id = randomUUID()
      await db.repoAction.create({
        data: {
          id,
          projectRepositoryId,
          taskId: claims.taskId,
          createdById: user.id,
          kind,
          args: { token, mergeRequest: null, merge },
          tokenSha256: createHash('sha256').update(token).digest('hex'),
        },
      })
      return id
    }
    const rowOf = (id: string) => db.repoAction.findUniqueOrThrow({ where: { id } })
    const feedOf = async () =>
      (
        await db.taskEvent.findMany({
          where: { taskId: task.id, type: 'feed.repo_action' },
          orderBy: { id: 'asc' },
        })
      ).map((event) => event.payload as Record<string, unknown>)
    const sent = (method: string, path: string) =>
      fake.calls.filter((call) => call.method === method && call.url.pathname === `${P}${path}`)
    return {
      task,
      projectRepositoryId,
      gitlab,
      actions,
      ci,
      claimsOf,
      press,
      rowOf,
      feedOf,
      sent,
      later: (ms: number) => (now = new Date(now.getTime() + ms)),
    }
  }

  it('merges by its token with the head expected, once, and the chat reads it', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: true })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'done', error: null })
    const [put] = f.sent('PUT', '/merge_requests/7/merge')
    expect(put!.body).toEqual({ sha: head, should_remove_source_branch: true })
    expect(
      await db.projectMergeRequest.findFirst({
        where: { projectRepositoryId: f.projectRepositoryId },
      }),
    ).toMatchObject({ state: 'merged', mergeSha, autoMerge: false })
    expect(await db.projectRepoBranch.findUnique({ where: { taskId: f.task.id } })).toMatchObject({
      state: 'merged',
    })
    expect(await f.feedOf()).toEqual([
      expect.objectContaining({
        kind: 'merge',
        state: 'done',
        number: 7,
        url: `https://${host}/kolos/site/-/merge_requests/7`,
      }),
    ])
    // The token works once: the row is taken once, and a second row of it is refused by the base.
    await f.actions.run(id)
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(1)
    const token = ((await f.rowOf(id)).args as { token: string }).token
    await expect(
      f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: true }, token),
    ).rejects.toThrow()
  })

  it('a token past its ten minutes merges nothing', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: false })
    f.later(REPO_CONFIRM_TTL_SECONDS * 1000 + 1000)
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_CONFIRM_EXPIRED' })
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(0)
  })

  it('a new head at the provider is its 409 and «Изменения обновились»', async () => {
    const f = await fixture()
    f.gitlab.mergeAnswer = {
      status: 409,
      body: { message: 'SHA does not match HEAD of source branch' },
    }
    const id = await f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: true })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(await f.feedOf()).toEqual([
      expect.objectContaining({ kind: 'merge', state: 'failed', error: 'REPO_CHANGED' }),
    ])
    // A head the card did not show is refused before the provider is asked to merge.
    f.gitlab.mergeAnswer = null
    f.gitlab.mr.sha = 'e'.repeat(40)
    const again = await f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: true })
    await f.actions.run(again)
    expect(await f.rowOf(again)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(1)
  })

  it('a target branch changed after the card is refused, nothing merged', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), { mode: 'now', deleteBranch: true })
    f.gitlab.mr.target_branch = 'release'
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_MR_TARGET_CHANGED' })
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(0)
    // A token that names another target is refused the same.
    f.gitlab.mr.target_branch = 'main'
    const other = await f.press('merge', f.claimsOf({ targetBranch: 'release' }), {
      mode: 'now',
      deleteBranch: true,
    })
    await f.actions.run(other)
    expect(await f.rowOf(other)).toMatchObject({ state: 'failed', error: 'REPO_MR_TARGET_CHANGED' })
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(0)
  })

  it('a row without a token of a merge, or with a token of another kind, merges nothing', async () => {
    const f = await fixture()
    const forged = await f.press(
      'merge',
      f.claimsOf({}),
      { mode: 'now', deleteBranch: true },
      'x.y',
    )
    const pushToken = await f.press('merge', f.claimsOf({ kind: 'push', number: null }), {
      mode: 'now',
      deleteBranch: true,
    })
    const noChoice = await f.press('merge', f.claimsOf({}), null)
    for (const id of [forged, pushToken, noChoice]) {
      await f.actions.run(id)
      expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_CONFIRM_INVALID' })
    }
    expect(f.sent('PUT', '/merge_requests/7/merge')).toHaveLength(0)
  })

  it('«Принять, когда сборка пройдёт» waits, and git.poll ends it when the provider merged', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), { mode: 'when_green', deleteBranch: true })
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'waiting', finishedAt: null })
    const [put] = f.sent('PUT', '/merge_requests/7/merge')
    expect(put!.body).toMatchObject({
      sha: head,
      auto_merge: true,
      merge_when_pipeline_succeeds: true,
    })
    expect(await f.feedOf()).toEqual([expect.objectContaining({ kind: 'merge', state: 'waiting' })])
    // The build passed; the provider merged it by itself.
    f.gitlab.mr.state = 'merged'
    f.gitlab.mr.merge_commit_sha = mergeSha
    f.later(10 * 60_000)
    expect(await f.ci.poll(f.projectRepositoryId)).toBe(true)
    expect(await f.rowOf(id)).toMatchObject({ state: 'done' })
    expect((await f.feedOf()).at(-1)).toMatchObject({ kind: 'merge', state: 'done', number: 7 })
    // A second poll ends nothing twice.
    f.later(10 * 60_000)
    await f.ci.poll(f.projectRepositoryId)
    expect(await f.feedOf()).toHaveLength(2)
  })

  it('a wait taken off ends the press without a merge (REPO_AUTO_MERGE_OFF)', async () => {
    const f = await fixture()
    const id = await f.press('merge', f.claimsOf({}), { mode: 'when_green', deleteBranch: true })
    await f.actions.run(id)
    expect(
      await endWaitingMerges(db, {
        projectRepositoryId: f.projectRepositoryId,
        number: 7,
        merged: false,
        now: new Date(),
      }),
    ).toBe(1)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_AUTO_MERGE_OFF' })
    expect((await f.feedOf()).at(-1)).toMatchObject({
      state: 'failed',
      error: 'REPO_AUTO_MERGE_OFF',
    })
  })

  const deployClaims = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.claimsOf({
      kind: 'deploy',
      taskId: null,
      number: null,
      headSha: mainSha,
      deploy: { kind: 'manual_job', id: '4812', ref: 'main' },
    })

  it('plays the manual job of the head of the main branch', async () => {
    const f = await fixture()
    const id = await f.press('deploy', deployClaims(f), null)
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({
      state: 'done',
      result: { sha: mainSha, job: '4812', name: 'deploy-production', runId: '481' },
    })
    expect(f.sent('POST', '/jobs/4812/play')).toHaveLength(1)
    expect(f.sent('GET', '/repository/branches')[0]!.url.searchParams.get('search')).toBe('^main$')
  })

  it('the main branch moved between the card and the play — «Изменения обновились», nothing played', async () => {
    const f = await fixture()
    const id = await f.press('deploy', deployClaims(f), null)
    f.gitlab.mainHead = 'e'.repeat(40)
    await f.actions.run(id)
    expect(await f.rowOf(id)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    // The head is the card's but the newest build is of another commit: refused too.
    f.gitlab.mainHead = mainSha
    f.gitlab.pipelineSha = 'e'.repeat(40)
    const again = await f.press('deploy', deployClaims(f), null)
    await f.actions.run(again)
    expect(await f.rowOf(again)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    // The job is not a manual job of the build any more.
    f.gitlab.pipelineSha = mainSha
    f.gitlab.manual = []
    const gone = await f.press('deploy', deployClaims(f), null)
    await f.actions.run(gone)
    expect(await f.rowOf(gone)).toMatchObject({ state: 'failed', error: 'REPO_DEPLOY_GONE' })
    // A deploy of a branch of the agent is never what a token can name.
    const agent = await f.press(
      'deploy',
      f.claimsOf({
        ...deployClaims(f),
        targetBranch: branch,
        deploy: { kind: 'manual_job', id: '4812', ref: branch },
      }),
      null,
    )
    await f.actions.run(agent)
    expect(await f.rowOf(agent)).toMatchObject({ state: 'failed', error: 'REPO_CHANGED' })
    expect(f.sent('POST', '/jobs/4812/play')).toHaveLength(0)
  })
})
