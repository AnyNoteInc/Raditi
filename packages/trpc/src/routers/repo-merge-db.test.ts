import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  readRepoConfirmToken,
  signRepoConfirmToken,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { dropGitJobsOf, gitJobsOf } from '../testing/git-jobs.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { GitServices } from '../services/git/connections.ts'

// «Принять в основную ветку» and «Выкатить» on PostgreSQL (docs/plan/84-projects.md, ПР15; slice
// 84.22): the token binds the merge request, its target branch and its head — or a manual job of
// the head of the main branch —, the press is written once with the token itself and the job of
// core, and only the author of the project with a connection of their own may press.

const databaseUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-repo-confirm-secret-of-the-merge-test'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const head = 'c'.repeat(40)
const mainSha = 'a'.repeat(40)
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function refusal(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError)
      return (error.cause as { code?: string } | undefined)?.code ?? error.code
    throw error
  }
  throw new Error('The procedure was not refused')
}

describe.skipIf(!databaseUrl)('PostgreSQL: merge and deploy cards (plan 84, 84.22)', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await dropGitJobsOf(db, owned.workspaceId.in)
    await db.repoAction.deleteMany({ where: { createdById: { in: users } } })
    await db.task.deleteMany({ where: owned })
    await db.projectRepository.deleteMany({ where: owned })
    await db.gitConnection.deleteMany({ where: owned })
    await db.credentialRef.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const chatContext: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () => ({}) as ObjectStorage,
    secrets: () => ({}) as SecretStore,
  }

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Merge verification', email: `${randomUUID()}@git.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User, confirmMac: GitServices['confirmMac'] | null = mac) {
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `merge-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat: chatContext,
      git: {
        appEnv: 'test',
        secrets: { kvWrite: async () => ({ version: 1 }), kvMetadata: async () => null },
        checkHost: async () => {},
        gitlabComConfigured: false,
        confirmMac: confirmMac as GitServices['confirmMac'],
      },
    })
  }

  /** A project with a connected GitLab repository, a chat and its open merge request !7. */
  async function fixture(options: { mode?: 'read' | 'write'; mr?: Record<string, unknown> } = {}) {
    const user = await person()
    const caller = callerOf(user)
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Колос' })
    const { workspaceId } = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const connectionId = randomUUID()
    const ref = await db.credentialRef.create({
      data: {
        workspaceId,
        kind: 'git_connection',
        vaultPath: `kv/workspaces/${workspaceId}/git/${connectionId}`,
      },
    })
    await db.gitConnection.create({
      data: {
        id: connectionId,
        workspaceId,
        createdById: user.id,
        kind: 'gitlab_token',
        host: 'gitlab.example.ru',
        accountLogin: 'kolos',
        accountId: `acc-${connectionId.slice(0, 8)}`,
        credentialRefId: ref.id,
        state: 'ok',
      },
    })
    const projectRepositoryId = randomUUID()
    await db.projectRepository.create({
      data: {
        id: projectRepositoryId,
        projectId,
        workspaceId,
        connectionId,
        provider: 'gitlab',
        host: 'gitlab.example.ru',
        providerRepoId: '42',
        path: 'kolos/site',
        webUrl: 'https://gitlab.example.ru/kolos/site',
        defaultBranch: 'main',
        mode: options.mode ?? 'write',
        mirrorState: 'ready',
      },
    })
    const task = await db.task.create({
      data: {
        id: v7(),
        workspaceId,
        projectId,
        createdById: user.id,
        status: 'awaiting_user',
        title: 'Новое меню',
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
        checks: 'success',
        headSha: head,
        webUrl: 'https://gitlab.example.ru/kolos/site/-/merge_requests/7',
        syncedAt: new Date(),
        ...options.mr,
      },
    })
    return { user, caller, projectId, projectRepositoryId, task, workspaceId }
  }

  /** The jobs `git.action` of the presses of this fixture (other files queue theirs meanwhile). */
  const gitActions = async (f: { workspaceId: string }) =>
    (await gitJobsOf(db, [f.workspaceId], 'git.action')).map(({ payload }) => ({ payload }))

  it('binds the token to the request, its target and its head, and writes the press once', async () => {
    const f = await fixture()
    const prepared = await f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 })
    expect(prepared).toMatchObject({
      number: 7,
      title: 'Новое меню',
      source: 'raditi/novoe-menyu-12345678',
      target: 'main',
      headSha: head,
      checks: 'success',
      deleteBranch: true,
      whenGreen: true,
    })
    expect(readRepoConfirmToken(prepared.confirmToken, mac, new Date())).toMatchObject({
      kind: 'merge',
      userId: f.user.id,
      projectId: f.projectId,
      projectRepositoryId: f.projectRepositoryId,
      taskId: f.task.id,
      number: 7,
      targetBranch: 'main',
      headSha: head,
      deploy: null,
    })
    const { actionId } = await f.caller.projectRepo.confirmMerge({
      confirmToken: prepared.confirmToken,
      mode: 'when_green',
      deleteBranch: false,
    })
    expect(await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({
      kind: 'merge',
      state: 'queued',
      taskId: f.task.id,
      createdById: f.user.id,
      args: {
        token: prepared.confirmToken,
        mergeRequest: null,
        merge: { mode: 'when_green', deleteBranch: false },
      },
      tokenSha256: createHash('sha256').update(prepared.confirmToken).digest('hex'),
    })
    expect(await gitActions(f)).toEqual([{ payload: { actionId } }])
    // Once: the same token again is «Это уже подтверждено», and nothing more is queued.
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmMerge({
          confirmToken: prepared.confirmToken,
          mode: 'now',
          deleteBranch: true,
        }),
      ),
    ).toBe('REPO_CONFIRM_USED')
    expect(await gitActions(f)).toHaveLength(1)
    expect(await f.caller.projectRepo.action({ projectId: f.projectId, actionId })).toMatchObject({
      kind: 'merge',
      state: 'queued',
      error: null,
    })
  })

  it('a token past its time, of another person or of another kind is refused', async () => {
    const f = await fixture()
    const prepared = await f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 })
    const claims = readRepoConfirmToken(prepared.confirmToken, mac, new Date())
    const stale = signRepoConfirmToken(
      {
        ...claims,
        nonce: randomBytes(16).toString('hex'),
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      },
      mac,
    )
    const press = (confirmToken: string) =>
      refusal(() =>
        f.caller.projectRepo.confirmMerge({ confirmToken, mode: 'now', deleteBranch: true }),
      )
    expect(await press(stale)).toBe('REPO_CONFIRM_EXPIRED')
    const other = await person()
    expect(
      await refusal(() =>
        callerOf(other).projectRepo.confirmMerge({
          confirmToken: prepared.confirmToken,
          mode: 'now',
          deleteBranch: true,
        }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmDeploy({ confirmToken: prepared.confirmToken }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
    expect(await press(`${prepared.confirmToken.split('.')[0]}.forged`)).toBe(
      'REPO_CONFIRM_INVALID',
    )
    expect(await gitActions(f)).toHaveLength(0)
  })

  it('offers no card for a request that cannot be merged now, or to anyone but the author', async () => {
    const draft = await fixture({ mr: { state: 'draft' } })
    const prepare = (f: Awaited<ReturnType<typeof fixture>>) =>
      refusal(() => f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 }))
    expect(await prepare(draft)).toBe('REPO_NOT_MERGEABLE')
    expect(await prepare(await fixture({ mr: { state: 'merged' } }))).toBe('REPO_ALREADY_MERGED')
    expect(await prepare(await fixture({ mr: { targetBranch: 'release' } }))).toBe(
      'REPO_MR_TARGET_CHANGED',
    )
    expect(await prepare(await fixture({ mode: 'read' }))).toBe('REPO_READ_ONLY')
    const f = await fixture()
    const other = await person()
    expect(
      await refusal(() =>
        callerOf(other).projectRepo.prepareMerge({ projectId: f.projectId, number: 7 }),
      ),
    ).toBe('PROJECT_NOT_FOUND')
    expect(
      await refusal(() =>
        callerOf(f.user, null).projectRepo.prepareMerge({ projectId: f.projectId, number: 7 }),
      ),
    ).toBe('GIT_CONNECT_UNAVAILABLE')
  })

  it('offers no card when the branch has commits Радити did not send (ревью, безопасность 4)', async () => {
    const f = await fixture()
    await db.projectRepoBranch.create({
      data: {
        taskId: f.task.id,
        projectRepositoryId: f.projectRepositoryId,
        branch: 'raditi/novoe-menyu-12345678',
        baseSha: 'c'.repeat(40),
        mirrorSha: 'd'.repeat(40),
        remoteSha: 'e'.repeat(40),
        state: 'pushed',
      },
    })
    expect(
      await refusal(() => f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 })),
    ).toBe('REPO_FOREIGN_COMMITS')
    await db.projectRepoBranch.update({ where: { taskId: f.task.id }, data: { remoteSha: head } })
    await expect(
      f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 }),
    ).resolves.toMatchObject({ number: 7 })
  })

  it('«Выкатить»: loading until core polled, then a token per manual job of the head of main', async () => {
    const f = await fixture()
    expect(await f.caller.projectRepo.prepareDeploy({ projectId: f.projectId })).toEqual({
      state: 'loading',
    })
    expect(await gitJobsOf(db, [f.workspaceId], 'git.poll')).toEqual([
      { type: 'git.poll', payload: { projectRepositoryId: f.projectRepositoryId } },
    ])
    await db.projectRepository.update({
      where: { id: f.projectRepositoryId },
      data: { ciPolledAt: new Date() },
    })
    expect(await f.caller.projectRepo.prepareDeploy({ projectId: f.projectId })).toMatchObject({
      state: 'ready',
      ref: 'main',
      sha: null,
      actions: [],
    })
    await db.projectDeployAction.create({
      data: {
        projectRepositoryId: f.projectRepositoryId,
        ref: 'main',
        sha: mainSha,
        kind: 'manual_job',
        providerActionId: '4812',
        name: 'deploy-production',
        syncedAt: new Date(),
      },
    })
    const ready = await f.caller.projectRepo.prepareDeploy({ projectId: f.projectId })
    if (ready.state !== 'ready') throw new Error('not ready')
    expect(ready).toMatchObject({ ref: 'main', sha: mainSha })
    expect(ready.actions).toMatchObject([
      { id: '4812', kind: 'manual_job', name: 'deploy-production' },
    ])
    expect(readRepoConfirmToken(ready.actions[0]!.confirmToken, mac, new Date())).toMatchObject({
      kind: 'deploy',
      taskId: null,
      targetBranch: 'main',
      headSha: mainSha,
      deploy: { kind: 'manual_job', id: '4812', ref: 'main' },
    })
    const { actionId } = await f.caller.projectRepo.confirmDeploy({
      confirmToken: ready.actions[0]!.confirmToken,
    })
    expect(await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({
      kind: 'deploy',
      taskId: null,
      args: { token: ready.actions[0]!.confirmToken, mergeRequest: null, merge: null },
    })
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmDeploy({ confirmToken: ready.actions[0]!.confirmToken }),
      ),
    ).toBe('REPO_CONFIRM_USED')
    // The job is not kept any more (core read the build again): the card is stale.
    const again = await f.caller.projectRepo.prepareDeploy({ projectId: f.projectId })
    await db.projectDeployAction.deleteMany({
      where: { projectRepositoryId: f.projectRepositoryId },
    })
    if (again.state !== 'ready') throw new Error('not ready')
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmDeploy({ confirmToken: again.actions[0]!.confirmToken }),
      ),
    ).toBe('REPO_DEPLOY_GONE')
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmMerge({
          confirmToken: again.actions[0]!.confirmToken,
          mode: 'now',
          deleteBranch: true,
        }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
  })

  it('keeps a workflow of GitHub that runs on workflow_dispatch: its kind fits the column', async () => {
    const f = await fixture()
    await db.projectDeployAction.create({
      data: {
        projectRepositoryId: f.projectRepositoryId,
        ref: 'main',
        sha: mainSha,
        kind: 'workflow_dispatch',
        providerActionId: '91',
        name: 'Выкладка',
        syncedAt: new Date(),
      },
    })
    const kept = await db.projectDeployAction.findMany({
      where: { projectRepositoryId: f.projectRepositoryId },
    })
    expect(kept.map((row) => row.kind)).toEqual(['workflow_dispatch'])
  })
})
