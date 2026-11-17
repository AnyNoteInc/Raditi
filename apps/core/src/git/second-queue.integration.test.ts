import { createHash, createHmac, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { signRepoConfirmToken, type GitProvider, type RepoConfirmClaims } from '@repo/domain'
import { createGitlabProvider, createGitTransport } from '@repo/git-providers'
import { fakeSend } from '@repo/git-providers/testing'
import { gitlabHookKeyId, gitlabHookSecrets } from '@repo/git-providers/webhooks'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { RepoActions } from './repo-actions.ts'
import { RepoCi } from './repo-ci.ts'
import { RepoHooks } from './repo-hooks.ts'

// The rest of the second queue on PostgreSQL (docs/plan/84-projects.md, ПР15, ПР17; slice 84.26),
// over the GitLab adapter and an HTTP fake: `git.refresh` reads the repository again and coalesces
// within the poll gap; a merge request opened at the provider for a chat's branch is adopted — by a
// hint, by the poll, and when opening one hits «already exists»; the hook of a GitLab project is
// made only for a Maintainer, signed, made again after the root secret changed, and removed; a
// rerun and a cancel of a build go by their cards, a rerun of the main branch as a deploy; «Отменить»
// of a merge opens a new merge request. Only on a disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const quiet = { log: vi.fn(), warn: vi.fn() }
const host = 'gitlab.example.ru'
const P = '/api/v4/projects/42'
const head = 'b'.repeat(40)
const mainSha = 'c'.repeat(40)
const mergeSha = 'd'.repeat(40)
const TOKEN = 'glpat-SyntheticToken8426'
const SECRET = 'synthetic-repo-confirm-secret-for-the-test-of-84-26'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const BRANCH = 'raditi/novoe-menyu-12345678'

function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const mrOf = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  title: 'Новое меню',
  state: 'opened',
  draft: false,
  source_branch: BRANCH,
  target_branch: 'main',
  sha: head,
  merge_commit_sha: null as string | null,
  merge_when_pipeline_succeeds: false,
  web_url: `https://${host}/kolos/site/-/merge_requests/7`,
  ...over,
})

describe.skipIf(!enabled)('the second queue with PostgreSQL (plan 84, 84.26)', () => {
  let db: PrismaClient
  const users: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const userId of users.splice(0)) {
      const workspaces = { workspace: { createdById: userId } }
      const repos = await db.projectRepository.findMany({ where: workspaces, select: { id: true } })
      for (const repo of repos)
        await db.outboxEvent.deleteMany({
          where: { payload: { path: ['projectRepositoryId'], equals: repo.id } },
        })
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
        lastFetchedSha: mainSha,
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
        branch: BRANCH,
        baseSha: mainSha,
        mirrorSha: head,
        remoteSha: head,
        state: 'pushed',
      },
    })

    const gitlab = {
      accessLevel: 40,
      pipelines: [
        {
          id: 482,
          sha: head,
          ref: BRANCH,
          status: 'failed',
          source: 'push',
          web_url: `https://${host}/kolos/site/-/pipelines/482`,
          created_at: '2026-11-17T09:59:00Z',
        },
        {
          id: 481,
          sha: mainSha,
          ref: 'main',
          status: 'running',
          source: 'push',
          web_url: `https://${host}/kolos/site/-/pipelines/481`,
          created_at: '2026-11-17T09:00:00Z',
        },
      ] as Record<string, unknown>[],
      mainHead: mainSha,
      branchHead: head,
      // The answer to a new pipeline (ПР36): a refusal, or the commit it builds when the branch
      // moved between the read of its head and the start.
      newPipeline: null as { status: number; body: unknown } | null,
      newPipelineSha: null as string | null,
      requests: { 7: mrOf() } as Record<number, Record<string, unknown>>,
      openStatus: 201,
      hooks: [] as Record<string, unknown>[],
    }
    const jobs: Record<string, Record<string, unknown>[]> = {
      482: [{ id: 4821, name: 'unit-tests', stage: 'test', status: 'failed' }],
      481: [{ id: 4811, name: 'deploy-production', stage: 'deploy', status: 'running' }],
    }
    const fake = fakeSend({
      [`GET ${P}`]: () => ({
        status: 200,
        body: {
          id: 42,
          path_with_namespace: 'kolos/site',
          default_branch: 'main',
          visibility: 'private',
          permissions: { project_access: { access_level: gitlab.accessLevel }, group_access: null },
        },
      }),
      [`GET ${P}/pipelines`]: () => ({ status: 200, body: gitlab.pipelines }),
      [`GET ${P}/pipelines/482`]: () => ({ status: 200, body: gitlab.pipelines[0] }),
      [`GET ${P}/pipelines/481`]: () => ({ status: 200, body: gitlab.pipelines[1] }),
      [`GET ${P}/pipelines/482/jobs`]: () => ({ status: 200, body: jobs[482] }),
      [`GET ${P}/pipelines/481/jobs`]: () => ({ status: 200, body: jobs[481] }),
      // As GitLab CE 19.5.6 answers: a failed pipeline goes again, a passed one stays as it was.
      [`POST ${P}/pipelines/482/retry`]: () => ({
        status: 201,
        body:
          gitlab.pipelines[0]!.status === 'failed'
            ? { ...gitlab.pipelines[0], status: 'running' }
            : gitlab.pipelines[0],
      }),
      [`POST ${P}/pipelines/481/retry`]: () => ({ status: 201, body: gitlab.pipelines[1] }),
      // A new pipeline of a branch builds its head (ПР36).
      [`POST ${P}/pipeline`]: (request) => {
        if (gitlab.newPipeline !== null) return gitlab.newPipeline
        const { ref } = JSON.parse(String(request.body)) as { ref: string }
        const sha = gitlab.newPipelineSha ?? (ref === 'main' ? gitlab.mainHead : gitlab.branchHead)
        return {
          status: 201,
          body: { id: 483, sha, ref, status: 'created', source: 'api' },
        }
      },
      [`POST ${P}/pipelines/481/cancel`]: () => ({ status: 201, body: { id: 481 } }),
      [`POST ${P}/pipelines/483/cancel`]: () => ({ status: 200, body: { id: 483 } }),
      [`GET ${P}/repository/branches`]: () => ({
        status: 200,
        body: [
          { name: 'main', commit: { id: gitlab.mainHead } },
          { name: BRANCH, commit: { id: gitlab.branchHead } },
        ],
      }),
      [`GET ${P}/merge_requests/7`]: () => ({ status: 200, body: gitlab.requests[7] }),
      [`GET ${P}/merge_requests/8`]: () =>
        gitlab.requests[8] ? { status: 200, body: gitlab.requests[8] } : null,
      [`GET ${P}/merge_requests/9`]: () =>
        gitlab.requests[9] ? { status: 200, body: gitlab.requests[9] } : null,
      [`GET ${P}/merge_requests`]: (request) => ({
        status: 200,
        body: Object.values(gitlab.requests).filter(
          (mr) => mr.source_branch === request.url.searchParams.get('source_branch'),
        ),
      }),
      [`POST ${P}/merge_requests`]: (request) => {
        if (gitlab.openStatus !== 201) return { status: gitlab.openStatus, body: {} }
        const body = JSON.parse(String(request.body)) as Record<string, string>
        const opened = mrOf({
          iid: 12,
          title: body.title,
          source_branch: body.source_branch,
          sha: 'e'.repeat(40),
          web_url: `https://${host}/kolos/site/-/merge_requests/12`,
        })
        gitlab.requests[12] = opened
        return { status: 201, body: opened }
      },
      [`GET ${P}/merge_requests/12`]: () => ({ status: 200, body: gitlab.requests[12] }),
      [`POST ${P}/hooks`]: (request) => {
        const hook = { id: 5 + gitlab.hooks.length, ...JSON.parse(String(request.body)) }
        gitlab.hooks.push(hook)
        return { status: 201, body: { id: hook.id, signing_token_present: true } }
      },
      [`DELETE ${P}/hooks/5`]: () => ({ status: 204 }),
    })
    const provider = (input: { host: string; address: string }): GitProvider =>
      createGitlabProvider({
        host: input.host,
        transport: createGitTransport({
          resolvePublic: async () => input.address,
          send: fake.send,
        }),
      })
    const base = {
      prisma: db,
      auth: { grantFor: async () => ({ kind: 'token' as const, token: TOKEN }) },
      resolvePublic: async () => '203.0.113.10',
      provider,
      logger: quiet,
      now: () => now,
    }
    const ci = new RepoCi({ ...base, secrets: { kvRead: async () => null } })
    const revertMerge = vi.fn(async (_input: Record<string, unknown>) => ({
      kind: 'pushed' as const,
      sha: 'e'.repeat(40),
      base: mainSha,
    }))
    const actions = new RepoActions({
      ...base,
      workspace: {
        pushChatBranch: vi.fn(),
        moveChatRef: vi.fn(),
        readChatRef: vi.fn(),
        buildSettingsChange: vi.fn(),
        revertMerge,
      } as never,
      mac,
    })
    const hooks = (rootSecret: string | null = SECRET) =>
      new RepoHooks({ ...base, rootSecret, appUrl: 'https://raditi.example' })
    const press = async (
      claims: Omit<
        RepoConfirmClaims,
        | 'userId'
        | 'projectId'
        | 'projectRepositoryId'
        | 'nonce'
        | 'expiresAt'
        | 'diffSha256'
        | 'ciDiffSha256'
        | 'opensMergeRequest'
        | 'deploy'
      > &
        Partial<RepoConfirmClaims>,
      kind: string,
    ) => {
      const token = signRepoConfirmToken(
        {
          userId: user.id,
          projectId: project.id,
          projectRepositoryId,
          diffSha256: null,
          ciDiffSha256: null,
          opensMergeRequest: false,
          deploy: null,
          nonce: randomUUID().replaceAll('-', ''),
          expiresAt: Math.floor(now.getTime() / 1000) + 600,
          ...claims,
        } as RepoConfirmClaims,
        mac,
      )
      const row = await db.repoAction.create({
        data: {
          id: randomUUID(),
          projectRepositoryId,
          taskId: claims.taskId ?? null,
          createdById: user.id,
          kind,
          args: { token, mergeRequest: null },
          tokenSha256: createHash('sha256').update(token).digest('hex'),
        },
      })
      await actions.run(row.id)
      return db.repoAction.findUniqueOrThrow({ where: { id: row.id } })
    }
    return {
      ci,
      actions,
      hooks,
      press,
      revertMerge,
      gitlab,
      calls: fake.calls,
      projectRepositoryId,
      taskId: task.id,
      userId: user.id,
      projectId: project.id,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms)
      },
      at: () => now,
    }
  }

  const sent = (f: { calls: { method: string; url: URL }[] }) =>
    f.calls.map((call) => `${call.method} ${call.url.pathname}`)

  it('a hint reads the repository again; within the poll gap it is put once, after the gap', async () => {
    const f = await fixture()
    await db.projectMergeRequest.create({
      data: {
        id: randomUUID(),
        projectRepositoryId: f.projectRepositoryId,
        taskId: f.taskId,
        number: 7,
        sourceBranch: BRANCH,
        targetBranch: 'main',
        title: 'Новое меню',
        state: 'open',
        headSha: head,
        webUrl: `https://${host}/kolos/site/-/merge_requests/7`,
        syncedAt: f.at(),
      },
    })
    const hint = {
      projectRepositoryId: f.projectRepositoryId,
      kind: 'merge_request' as const,
      number: 7,
    }
    // The provider says the request is merged: the hint reads it now, though it was read just now.
    f.gitlab.requests[7] = mrOf({ state: 'merged', merge_commit_sha: mergeSha })
    expect(await f.ci.refresh(hint)).toBe('polled')
    expect(sent(f)).toContain(`GET ${P}/merge_requests/7`)
    const mr = await db.projectMergeRequest.findUniqueOrThrow({
      where: {
        projectRepositoryId_number: { projectRepositoryId: f.projectRepositoryId, number: 7 },
      },
    })
    expect([mr.state, mr.mergeSha]).toEqual(['merged', mergeSha])
    // A storm right after: nothing read, one later read put, whatever the number of hints.
    const reads = f.calls.length
    for (let n = 0; n < 20; n++) expect(await f.ci.refresh(hint)).toBe('later')
    expect(f.calls.length).toBe(reads)
    const later = await db.outboxEvent.findMany({
      where: { dedupeKey: { startsWith: `git.refresh.later:${f.projectRepositoryId}:` } },
    })
    expect(later).toHaveLength(1)
    expect(later[0]!.availableAt.getTime()).toBeGreaterThan(f.at().getTime())
  })

  it('adopts a merge request opened at the provider for a chat’s branch, never another one', async () => {
    const f = await fixture()
    delete f.gitlab.requests[7]
    f.gitlab.requests[8] = mrOf({ iid: 8 })
    f.gitlab.requests[9] = mrOf({ iid: 9, source_branch: 'feature/client' })
    expect(
      await f.ci.refresh({
        projectRepositoryId: f.projectRepositoryId,
        kind: 'merge_request',
        number: 9,
      }),
    ).toBe('polled')
    // The client's own branch: not adopted. The chat's branch, found by the poll: adopted.
    const kept = await db.projectMergeRequest.findMany({
      where: { projectRepositoryId: f.projectRepositoryId },
      select: { number: true, taskId: true, sourceBranch: true },
    })
    expect(kept).toEqual([{ number: 8, taskId: f.taskId, sourceBranch: BRANCH }])
    expect(sent(f)).toContain(`GET ${P}/merge_requests`)
    // Known now: the next poll does not look for it by its branch again.
    f.advance(30_000)
    const before = sent(f).filter((line) => line === `GET ${P}/merge_requests`).length
    await f.ci.refresh({ projectRepositoryId: f.projectRepositoryId, kind: 'push' })
    expect(sent(f).filter((line) => line === `GET ${P}/merge_requests`).length).toBe(before)
  })

  it('«Открыть запрос» that hits «already exists» reads the request there and keeps it', async () => {
    const f = await fixture()
    f.gitlab.openStatus = 409
    delete f.gitlab.requests[7]
    f.gitlab.requests[8] = mrOf({ iid: 8 })
    const token = signRepoConfirmToken(
      {
        kind: 'push',
        userId: f.userId,
        projectId: f.projectId,
        projectRepositoryId: f.projectRepositoryId,
        taskId: f.taskId,
        number: null,
        targetBranch: BRANCH,
        headSha: head,
        diffSha256: null,
        ciDiffSha256: null,
        opensMergeRequest: true,
        deploy: null,
        nonce: 'f'.repeat(32),
        expiresAt: Math.floor(f.at().getTime() / 1000) + 600,
      },
      mac,
    )
    const press = await db.repoAction.create({
      data: {
        id: randomUUID(),
        projectRepositoryId: f.projectRepositoryId,
        taskId: f.taskId,
        createdById: f.userId,
        kind: 'open_mr',
        args: {
          token,
          mergeRequest: { title: 'Новое меню', description: '', draft: false, reservedId: null },
        },
        tokenSha256: createHash('sha256').update(token).digest('hex'),
      },
    })
    await f.actions.run(press.id)
    const done = await db.repoAction.findUniqueOrThrow({ where: { id: press.id } })
    expect([done.state, done.error]).toEqual(['done', null])
    expect(done.result).toMatchObject({ number: 8 })
    const kept = await db.projectMergeRequest.findUniqueOrThrow({
      where: {
        projectRepositoryId_number: { projectRepositoryId: f.projectRepositoryId, number: 8 },
      },
    })
    expect(kept.taskId).toBe(f.taskId)
  })

  it('makes a signed hook only for a Maintainer, again after the root secret changed, and removes it', async () => {
    const f = await fixture()
    // A Developer: no hook is tried at the provider.
    f.gitlab.accessLevel = 30
    await f.hooks().create(f.projectRepositoryId)
    let repo = await db.projectRepository.findUniqueOrThrow({
      where: { id: f.projectRepositoryId },
    })
    expect([repo.hookState, repo.hookId]).toEqual(['not_allowed', null])
    expect(sent(f)).not.toContain(`POST ${P}/hooks`)
    // A Maintainer: the tick makes it once the retry time passed.
    f.gitlab.accessLevel = 40
    await db.projectRepository.update({
      where: { id: f.projectRepositoryId },
      data: { hookCheckedAt: new Date(f.at().getTime() - 25 * 60 * 60_000) },
    })
    expect((await f.hooks().tick()).tried).toEqual([f.projectRepositoryId])
    repo = await db.projectRepository.findUniqueOrThrow({ where: { id: f.projectRepositoryId } })
    expect([repo.hookState, repo.hookId, repo.hookSigned, repo.hookKeyId]).toEqual([
      'active',
      '5',
      true,
      gitlabHookKeyId(SECRET),
    ])
    const secrets = gitlabHookSecrets(SECRET, f.projectRepositoryId, repo.hookNonce!)
    expect(f.gitlab.hooks[0]).toMatchObject({
      url: `https://raditi.example/api/webhooks/gitlab?r=${f.projectRepositoryId}`,
      token: secrets.token,
      signing_token: secrets.signingToken,
    })
    // Nothing of the secrets is in the row.
    expect(JSON.stringify(repo)).not.toContain(secrets.token)
    // Made again: nothing to do while the root is the same.
    expect((await f.hooks().tick()).tried).toEqual([])
    // Another root secret (rotated): the old hook goes, a new one is made.
    const rotated = 'another-synthetic-root-secret-for-84-26-tests'
    expect((await f.hooks(rotated).tick()).tried).toEqual([f.projectRepositoryId])
    repo = await db.projectRepository.findUniqueOrThrow({ where: { id: f.projectRepositoryId } })
    expect([repo.hookId, repo.hookKeyId]).toEqual(['6', gitlabHookKeyId(rotated)])
    expect(sent(f)).toContain(`DELETE ${P}/hooks/5`)
    // Removed by what the row held, after the row is gone.
    const before = sent(f).length
    await f.hooks().remove({
      connectionId: repo.connectionId!,
      host,
      path: 'kolos/site',
      providerRepoId: '42',
      hookId: '5',
    })
    expect(sent(f).slice(before)).toContain(`DELETE ${P}/hooks/5`)
  })

  it('reruns and cancels builds by their cards; a rerun of the main branch is a deploy', async () => {
    const f = await fixture()
    await f.ci.poll(f.projectRepositoryId)
    // A failed build of the chat's branch: a plain card.
    let row = await f.press(
      {
        kind: 'rerun',
        taskId: null,
        number: null,
        targetBranch: BRANCH,
        headSha: head,
        run: { id: '482', ref: BRANCH, deploy: false },
      },
      'rerun',
    )
    expect([row.state, row.error]).toEqual(['done', null])
    expect(sent(f)).toContain(`POST ${P}/pipelines/482/retry`)
    // A cancel of a build that ended acts on nothing.
    row = await f.press(
      {
        kind: 'cancel',
        taskId: null,
        number: null,
        targetBranch: BRANCH,
        headSha: head,
        run: { id: '482', ref: BRANCH, deploy: false },
      },
      'cancel',
    )
    expect([row.state, row.error]).toEqual(['failed', 'REPO_RUN_GONE'])
    // The build of main goes: cancelled.
    row = await f.press(
      {
        kind: 'cancel',
        taskId: null,
        number: null,
        targetBranch: 'main',
        headSha: mainSha,
        run: { id: '481', ref: 'main', deploy: true },
      },
      'cancel',
    )
    expect([row.state, row.error]).toEqual(['done', null])
    // It ended; a rerun of main by a plain card is refused — the card must be the deploy's.
    f.gitlab.pipelines[1]!.status = 'success'
    const plain = await f.press(
      {
        kind: 'rerun',
        taskId: null,
        number: null,
        targetBranch: 'main',
        headSha: mainSha,
        run: { id: '481', ref: 'main', deploy: false },
      },
      'rerun',
    )
    expect([plain.state, plain.error]).toEqual(['failed', 'REPO_CHANGED'])
    // The deploy card while main moved on: an older version would go out — refused.
    f.gitlab.mainHead = 'f'.repeat(40)
    const moved = await f.press(
      {
        kind: 'rerun',
        taskId: null,
        number: null,
        targetBranch: 'main',
        headSha: mainSha,
        run: { id: '481', ref: 'main', deploy: true },
      },
      'rerun',
    )
    expect([moved.state, moved.error]).toEqual(['failed', 'REPO_CHANGED'])
    expect(sent(f)).not.toContain(`POST ${P}/pipelines/481/retry`)
    // Its commit is the head again: the deploy card reruns it.
    f.gitlab.mainHead = mainSha
    const deployed = await f.press(
      {
        kind: 'rerun',
        taskId: null,
        number: null,
        targetBranch: 'main',
        headSha: mainSha,
        run: { id: '481', ref: 'main', deploy: true },
      },
      'rerun',
    )
    expect([deployed.state, deployed.error]).toEqual(['done', null])
    expect(sent(f)).toContain(`POST ${P}/pipelines/481/retry`)
    // It had passed: GitLab's retry ran nothing, a new pipeline of main runs its head, with the
    // ref alone in its body, and the row keeps the new run (ПР36).
    const created = f.calls.filter((call) => call.url.pathname === `${P}/pipeline`)
    expect(created.map((call) => call.body)).toEqual([{ ref: 'main' }])
    expect(deployed.result).toMatchObject({ runId: '483', rerunOf: '481', deploy: true })
  })

  it('a rerun of a passed build of a branch is a new build of its head, or words, never another commit', async () => {
    const f = await fixture()
    await f.ci.poll(f.projectRepositoryId)
    f.gitlab.pipelines[0]!.status = 'success'
    const card = {
      kind: 'rerun' as const,
      taskId: null,
      number: null,
      targetBranch: BRANCH,
      headSha: head,
      run: { id: '482', ref: BRANCH, deploy: false },
    }
    // A plain card: GitLab's retry ran nothing, a new pipeline of the branch builds its head.
    const fresh = await f.press(card, 'rerun')
    expect([fresh.state, fresh.error]).toEqual(['done', null])
    const created = f.calls.filter((call) => call.url.pathname === `${P}/pipeline`)
    expect(created.map((call) => call.body)).toEqual([{ ref: BRANCH }])
    expect(fresh.result).toMatchObject({ runId: '483', rerunOf: '482', sha: head, deploy: false })
    // Settings that give such a start no job: words, not a technical failure.
    f.gitlab.newPipeline = {
      status: 400,
      body: {
        message: {
          base: ['The resulting pipeline would have been empty. Review the rules configuration.'],
        },
      },
    }
    const empty = await f.press(card, 'rerun')
    expect([empty.state, empty.error]).toEqual(['failed', 'REPO_RUN_NOT_STARTED'])
    // The branch moved between the read of its head and the start: the new pipeline builds a
    // commit the card did not show — stopped at once, the changes moved.
    f.gitlab.newPipeline = null
    f.gitlab.newPipelineSha = 'e'.repeat(40)
    const raced = await f.press(card, 'rerun')
    expect([raced.state, raced.error]).toEqual(['failed', 'REPO_CHANGED'])
    expect(sent(f).at(-1)).toBe(`POST ${P}/pipelines/483/cancel`)
  })

  it('«Отменить» of a merge opens a new merge request of the revert, never touching main', async () => {
    const f = await fixture()
    await db.projectMergeRequest.create({
      data: {
        id: randomUUID(),
        projectRepositoryId: f.projectRepositoryId,
        taskId: f.taskId,
        number: 7,
        sourceBranch: BRANCH,
        targetBranch: 'main',
        title: 'Новое меню @all /merge',
        state: 'merged',
        headSha: head,
        mergeSha,
        webUrl: `https://${host}/kolos/site/-/merge_requests/7`,
        syncedAt: f.at(),
      },
    })
    const claims = {
      kind: 'revert' as const,
      taskId: f.taskId,
      number: 7,
      targetBranch: 'main',
      headSha: mergeSha,
    }
    // Not merged at the provider (yet): nothing is made.
    let row = await f.press(claims, 'revert')
    expect([row.state, row.error]).toEqual(['failed', 'REPO_NOT_MERGED'])
    expect(f.revertMerge).not.toHaveBeenCalled()
    f.gitlab.requests[7] = mrOf({
      state: 'merged',
      merge_commit_sha: mergeSha,
      title: 'Новое меню @all /merge',
    })
    row = await f.press(claims, 'revert')
    expect([row.state, row.error]).toEqual(['done', null])
    expect(row.result).toMatchObject({ number: 12, reverts: 7 })
    expect(f.revertMerge).toHaveBeenCalledTimes(1)
    const asked = f.revertMerge.mock.calls[0]![0]
    expect(asked).toMatchObject({ defaultBranch: 'main', mergeSha })
    expect(String(asked.branch)).toMatch(/^raditi\/revert-7-[0-9a-f]{8}$/)
    // The title is made harmless: no mention, no quick action.
    const opened = f.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === `${P}/merge_requests`,
    )
    expect((opened!.body as { title: string }).title).not.toContain('@all')
    const kept = await db.projectMergeRequest.findUniqueOrThrow({
      where: {
        projectRepositoryId_number: { projectRepositoryId: f.projectRepositoryId, number: 12 },
      },
    })
    expect(kept.taskId).toBeNull()
    // The chat of the merged request reads what the button did.
    const feed = await db.taskEvent.findMany({
      where: { taskId: f.taskId, type: 'feed.repo_action' },
      select: { payload: true },
    })
    expect(feed.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ kind: 'revert', state: 'done', number: 12 }),
    )
    // A revert that does not go on top is said, nothing opened.
    f.revertMerge.mockResolvedValueOnce({ kind: 'conflict' } as never)
    row = await f.press(claims, 'revert')
    expect([row.state, row.error]).toEqual(['failed', 'REPO_REVERT_CONFLICT'])
  })
})
