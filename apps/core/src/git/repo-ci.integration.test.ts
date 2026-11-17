import { createHmac, randomUUID } from 'node:crypto'

import { createPrismaClient, requestCiLog, type PrismaClient } from '@repo/db'
import {
  ENV_VALUE_MASK,
  signRepoConfirmToken,
  type GitProvider,
  type KvSecret,
  type RepoConfirmClaims,
} from '@repo/domain'
import { createGitlabProvider, createGitTransport } from '@repo/git-providers'
import { fakeSend } from '@repo/git-providers/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { RepoActions, REPO_ACTION_LOST_MS } from './repo-actions.ts'
import { RepoCi } from './repo-ci.ts'

// The builds of a repository on PostgreSQL (docs/plan/84-projects.md, ПР17, ПР25; slice 84.21):
// `git.poll` over the GitLab adapter and an HTTP fake — runs and jobs, a job gitlab.com did not
// start, a merged merge request that marks the chat's branch, the manual jobs of the main branch;
// `git.log` masks what it keeps; the sweeper ends presses a core left behind, once. Only on a
// disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const quiet = { log: vi.fn(), warn: vi.fn() }
const host = 'gitlab.example.ru'
const P = '/api/v4/projects/42'
const head = 'b'.repeat(40)
const mainSha = 'c'.repeat(40)
const TOKEN = 'glpat-SyntheticToken0123456789'
const SECRET_VALUE = 'synthetic-deploy-password-84-21'
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-21'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe.skipIf(!enabled)('git.poll and git.log with PostgreSQL (plan 84, 84.21)', () => {
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
      await db.workspaceEnvVar.deleteMany({ where: workspaces })
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
    await db.workspaceEnvVar.create({ data: { workspaceId: ws.id, name: 'DEPLOY_PASSWORD' } })
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
        branch: 'raditi/novoe-menyu-12345678',
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
        sourceBranch: 'raditi/novoe-menyu-12345678',
        targetBranch: 'main',
        title: 'Новое меню',
        state: 'open',
        headSha: head,
        webUrl: `https://${host}/kolos/site/-/merge_requests/7`,
        syncedAt: now,
      },
    })

    const gitlab = {
      pipelines: [
        {
          id: 482,
          sha: head,
          ref: 'raditi/novoe-menyu-12345678',
          status: 'running',
          source: 'push',
          web_url: `https://${host}/kolos/site/-/pipelines/482`,
          created_at: '2026-11-16T09:59:00Z',
        },
        {
          id: 481,
          sha: mainSha,
          ref: 'main',
          status: 'success',
          source: 'push',
          web_url: `https://${host}/kolos/site/-/pipelines/481`,
          created_at: '2026-11-16T09:00:00Z',
        },
      ] as Record<string, unknown>[],
      jobs: {
        482: [
          { id: 4822, name: 'unit-tests', stage: 'test', status: 'running' },
          { id: 4821, name: 'lint', stage: 'check', status: 'success' },
        ],
        481: [
          { id: 4812, name: 'deploy-production', stage: 'deploy', status: 'manual' },
          { id: 4811, name: 'build', stage: 'build', status: 'success' },
        ],
      } as Record<string, Record<string, unknown>[]>,
      mr: {
        iid: 7,
        title: 'Новое меню',
        state: 'opened',
        draft: false,
        source_branch: 'raditi/novoe-menyu-12345678',
        target_branch: 'main',
        sha: head,
        merge_commit_sha: null as string | null,
        merge_when_pipeline_succeeds: false,
        web_url: `https://${host}/kolos/site/-/merge_requests/7`,
        head_pipeline: { id: 482, status: 'running' },
      },
      log:
        '\x1b[32;1m$ npm test\x1b[0;m\n' +
        `export DEPLOY_PASSWORD=${SECRET_VALUE}\n` +
        `git clone https://oauth2:${TOKEN}@${host}/kolos/site.git\n` +
        'ERROR: Job failed: exit code 1\n',
    }
    const fake = fakeSend({
      [`GET ${P}/pipelines`]: (request) => {
        const ref = request.url.searchParams.get('ref')
        const list = gitlab.pipelines.filter((p) => ref === null || p.ref === ref)
        return { status: 200, body: list }
      },
      [`GET ${P}/pipelines/482/jobs`]: () => ({ status: 200, body: gitlab.jobs[482] }),
      [`GET ${P}/pipelines/481/jobs`]: () => ({ status: 200, body: gitlab.jobs[481] }),
      [`GET ${P}/pipelines/483/jobs`]: () => ({ status: 200, body: gitlab.jobs[483] ?? [] }),
      [`GET ${P}/merge_requests/7`]: () => ({ status: 200, body: gitlab.mr }),
      [`GET ${P}/jobs/4822/trace`]: () => ({ status: 200, text: gitlab.log }),
    })
    const provider = (input: { host: string; address: string }): GitProvider =>
      createGitlabProvider({
        host: input.host,
        transport: createGitTransport({
          resolvePublic: async () => input.address,
          send: fake.send,
        }),
      })
    const secrets = {
      kvRead: async (path: string): Promise<KvSecret | null> =>
        path === `kv/workspaces/${ws.id}/env/DEPLOY_PASSWORD`
          ? { data: { value: SECRET_VALUE }, version: 1 }
          : null,
    }
    const ci = new RepoCi({
      prisma: db,
      auth: { grantFor: async () => ({ kind: 'token', token: TOKEN }) },
      resolvePublic: async () => '203.0.113.10',
      provider,
      secrets,
      logger: quiet,
      now: () => now,
    })
    const actions = new RepoActions({
      prisma: db,
      auth: { grantFor: async () => ({ kind: 'token', token: TOKEN }) },
      resolvePublic: async () => '203.0.113.10',
      provider,
      workspace: {
        pushChatBranch: vi.fn(),
        moveChatRef: vi.fn(),
        readChatRef: vi.fn(),
        buildSettingsChange: vi.fn(),
      } as never,
      mac,
      logger: quiet,
      now: () => now,
    })
    return {
      ci,
      actions,
      gitlab,
      calls: fake.calls,
      userId: user.id,
      workspaceId: ws.id,
      projectId: project.id,
      projectRepositoryId,
      taskId: task.id,
      at: () => now,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms)
      },
    }
  }

  it('polls the runs and their jobs, coalesced, and the change shows without a reload', async () => {
    const f = await fixture()
    expect(await f.ci.tick()).toEqual({ polled: 1 })
    const runs = await db.projectCiRun.findMany({
      where: { projectRepositoryId: f.projectRepositoryId },
      orderBy: { createdAt: 'desc' },
    })
    expect(runs.map((r) => [r.providerRunId, r.ref, r.status, r.event])).toEqual([
      ['482', 'raditi/novoe-menyu-12345678', 'running', 'push'],
      ['481', 'main', 'success', 'push'],
    ])
    expect((runs[0]!.jobs as { name: string }[]).map((j) => j.name)).toEqual(['unit-tests', 'lint'])
    // Again in the same tick: nobody reads it twice.
    expect(await f.ci.poll(f.projectRepositoryId)).toBe(false)
    const reads = f.calls.length
    expect(await f.ci.tick()).toEqual({ polled: 0 })
    expect(f.calls.length).toBe(reads)
    // The run ends at the provider: the next tick reads it.
    f.gitlab.pipelines[0]!.status = 'failed'
    f.gitlab.jobs[482]![0]!.status = 'failed'
    f.advance(30_000)
    expect(await f.ci.tick()).toEqual({ polled: 1 })
    const ended = await db.projectCiRun.findUniqueOrThrow({
      where: {
        projectRepositoryId_providerRunId: {
          projectRepositoryId: f.projectRepositoryId,
          providerRunId: '482',
        },
      },
    })
    expect(ended.status).toBe('failed')
    expect(ended.refusal).toBeNull()
    // Nothing goes and nothing was sent lately: no more polls.
    await db.projectRepoBranch.updateMany({
      where: { taskId: f.taskId },
      data: { updatedAt: new Date(f.at().getTime() - 60 * 60_000) },
    })
    await db.projectMergeRequest.updateMany({
      where: { projectRepositoryId: f.projectRepositoryId },
      data: { syncedAt: f.at() },
    })
    f.advance(30_000)
    expect(await f.ci.tick()).toEqual({ polled: 0 })
  })

  it('says a run gitlab.com did not start for an unverified account in its own words', async () => {
    const f = await fixture()
    f.gitlab.pipelines.unshift({
      id: 483,
      sha: head,
      ref: 'raditi/novoe-menyu-12345678',
      status: 'failed',
      web_url: `https://${host}/kolos/site/-/pipelines/483`,
      created_at: '2026-11-16T09:59:30Z',
    })
    f.gitlab.jobs[483] = [
      {
        id: 4831,
        name: 'unit-tests',
        stage: 'test',
        status: 'failed',
        failure_reason: 'user_not_verified',
      },
    ]
    await f.ci.tick()
    const run = await db.projectCiRun.findUniqueOrThrow({
      where: {
        projectRepositoryId_providerRunId: {
          projectRepositoryId: f.projectRepositoryId,
          providerRunId: '483',
        },
      },
    })
    expect(run.status).toBe('failed')
    expect(run.refusal).toBe('account_unverified')
    expect((run.jobs as { refusal: string | null }[])[0]!.refusal).toBe('account_unverified')
    // A later poll reads the run unchanged and not its jobs: GitLab's pipeline has no
    // `failure_reason`, and the refusal stays (the live check of 17.11.2026).
    const reads = f.calls.length
    f.advance(30_000)
    expect(await f.ci.tick()).toEqual({ polled: 1 })
    expect(
      f.calls.slice(reads).some((call) => call.url.pathname.endsWith('/pipelines/483/jobs')),
    ).toBe(false)
    const again = await db.projectCiRun.findUniqueOrThrow({
      where: {
        projectRepositoryId_providerRunId: {
          projectRepositoryId: f.projectRepositoryId,
          providerRunId: '483',
        },
      },
    })
    expect(again.refusal).toBe('account_unverified')
  })

  it('marks the chat’s branch merged when its merge request is accepted (ПР25)', async () => {
    const f = await fixture()
    f.gitlab.mr.state = 'merged'
    f.gitlab.mr.merge_commit_sha = 'd'.repeat(40)
    await f.ci.tick()
    const mr = await db.projectMergeRequest.findFirstOrThrow({
      where: { projectRepositoryId: f.projectRepositoryId, number: 7 },
    })
    expect(mr.state).toBe('merged')
    expect(mr.mergeSha).toBe('d'.repeat(40))
    expect(mr.checks).toBe('pending')
    const branch = await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId: f.taskId } })
    expect(branch.state).toBe('merged')
  })

  it('keeps the manual jobs of the head of the main branch', async () => {
    const f = await fixture()
    await f.ci.tick()
    const actions = await db.projectDeployAction.findMany({
      where: { projectRepositoryId: f.projectRepositoryId },
    })
    expect(actions.map((a) => [a.kind, a.providerActionId, a.name, a.ref, a.sha])).toEqual([
      ['manual_job', '4812', 'deploy-production', 'main', mainSha],
    ])
  })

  it('fetches a log once asked, masks it, keeps it a day', async () => {
    const f = await fixture()
    await f.ci.tick()
    const ask = {
      projectRepositoryId: f.projectRepositoryId,
      runId: '482',
      jobId: '4822',
      now: f.at(),
    }
    expect(await requestCiLog(db, ask)).toEqual({ state: 'loading' })
    await f.ci.fetchLog(f.projectRepositoryId, '4822')
    const answer = await requestCiLog(db, ask)
    expect(answer.state).toBe('ready')
    const text = answer.state === 'ready' ? answer.text : ''
    expect(text).toContain('$ npm test')
    expect(text).toContain('ERROR: Job failed: exit code 1')
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain(SECRET_VALUE)
    expect(text).not.toContain(TOKEN)
    expect(text).toContain(ENV_VALUE_MASK)
    const calls = f.calls.filter((c) => c.url.pathname.endsWith('/trace'))
    expect(calls).toHaveLength(1)
    // Past its day the row goes.
    f.advance(24 * 60 * 60 * 1000 + 1)
    expect(await f.ci.purgeLogs()).toBe(1)
  })

  it('ends a press a core left behind, once, and puts again a queued one', async () => {
    const f = await fixture()
    const claims: RepoConfirmClaims = {
      kind: 'push',
      userId: f.userId,
      projectId: f.projectId,
      projectRepositoryId: f.projectRepositoryId,
      taskId: f.taskId,
      number: null,
      targetBranch: null,
      headSha: head,
      diffSha256: null,
      ciDiffSha256: null,
      opensMergeRequest: false,
      deploy: null,
      nonce: 'n'.repeat(32),
      expiresAt: Math.floor(f.at().getTime() / 1000) + 600,
    }
    const press = async (state: string, ageMs: number, nonce: string) => {
      const token = signRepoConfirmToken({ ...claims, nonce }, mac)
      const row = await db.repoAction.create({
        data: {
          id: randomUUID(),
          projectRepositoryId: f.projectRepositoryId,
          taskId: f.taskId,
          createdById: f.userId,
          kind: 'push',
          args: { token, mergeRequest: null },
          tokenSha256: createHmac('sha256', nonce).update(token).digest('hex'),
          state,
          createdAt: new Date(f.at().getTime() - ageMs),
        },
      })
      return row.id
    }
    const lost = await press('running', REPO_ACTION_LOST_MS + 1000, 'a'.repeat(32))
    const fresh = await press('running', 60_000, 'b'.repeat(32))
    const waiting = await press('queued', 3 * 60_000, 'c'.repeat(32))
    const expired = await press('queued', 11 * 60_000, 'd'.repeat(32))
    expect(await f.actions.sweep()).toEqual({ requeued: 1, expired: 1, lost: 1 })
    const state = async (id: string) =>
      db.repoAction.findUniqueOrThrow({ where: { id }, select: { state: true, error: true } })
    expect(await state(lost)).toEqual({ state: 'failed', error: 'REPO_ACTION_LOST' })
    expect(await state(fresh)).toEqual({ state: 'running', error: null })
    expect(await state(waiting)).toEqual({ state: 'queued', error: null })
    expect(await state(expired)).toEqual({ state: 'failed', error: 'REPO_CONFIRM_EXPIRED' })
    const again = await db.outboxEvent.findMany({
      where: { type: 'git.action', payload: { path: ['actionId'], equals: waiting } },
    })
    expect(again).toHaveLength(1)
    // A second sweep ends nothing twice and tells the chat nothing twice.
    expect(await f.actions.sweep()).toEqual({ requeued: 1, expired: 0, lost: 0 })
    const told = await db.taskEvent.findMany({
      where: { taskId: f.taskId, type: 'feed.repo_action' },
      select: { payload: true },
    })
    expect(told.map((row) => (row.payload as { error: string }).error).sort()).toEqual([
      'REPO_ACTION_LOST',
      'REPO_CONFIRM_EXPIRED',
    ])
    expect(
      await db.outboxEvent.count({
        where: { type: 'git.action', payload: { path: ['actionId'], equals: waiting } },
      }),
    ).toBe(1)
  })
})
