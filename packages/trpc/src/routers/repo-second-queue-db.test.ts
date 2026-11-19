import { createHmac, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  readRepoConfirmToken,
  repoTreeKey,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { dropGitJobsOf, gitJobsOf } from '../testing/git-jobs.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { GitServices } from '../services/git/connections.ts'

// The cards of the second queue on PostgreSQL (docs/plan/84-projects.md, ПР15, ПР17, ПР24; slice
// 84.26): «Запустить снова» and «Остановить» of a build — a rerun of the main branch or of a build
// with deploy jobs is a card of a deploy —, «Отменить» of a merged request, and the paths of the
// main branch for `@`, read from what core keeps.

const databaseUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-repo-confirm-secret-of-the-second-queue'
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

describe.skipIf(!databaseUrl)('PostgreSQL: the cards of the second queue (plan 84, 84.26)', () => {
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

  /** The paths core keeps in `raditi-artifacts`, by their key. */
  const kept = new Map<string, Buffer>()
  const trees = {
    get: async (_bucket: string, key: string) => {
      const body = kept.get(key)
      return body === undefined
        ? null
        : (async function* () {
            yield body
          })()
    },
  }

  /** How many S3 clients the procedures made: `@` makes one only to read a kept list. */
  let storageClients = 0
  const chatContext: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () => {
      storageClients += 1
      return trees as unknown as ObjectStorage
    },
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

  const jobs = async (f: { workspaceId: string }, type: string) =>
    (await gitJobsOf(db, [f.workspaceId], type)).map(({ payload }) => payload)

  const run = (f: { projectRepositoryId: string }, over: Record<string, unknown>) =>
    db.projectCiRun.create({
      data: {
        projectRepositoryId: f.projectRepositoryId,
        providerRunId: '482',
        ref: 'raditi/novoe-menyu-12345678',
        sha: head,
        name: 'pipeline',
        status: 'failed',
        webUrl: 'https://gitlab.example.ru/kolos/site/-/pipelines/482',
        createdAt: new Date(),
        syncedAt: new Date(),
        ...over,
      },
    })

  it('a build of the chat’s branch: a plain card; a build of main or with a deploy job: a deploy', async () => {
    const f = await fixture()
    await run(f, {})
    await run(f, { providerRunId: '481', ref: 'main', sha: mainSha, status: 'success' })
    await run(f, {
      providerRunId: '480',
      status: 'success',
      jobs: [{ id: '1', name: 'deploy', stage: 'deploy', status: 'manual', manual: true }],
    })
    await run(f, { providerRunId: '479', status: 'success' })
    const plain = await f.caller.projectRepo.prepareRunAction({
      projectId: f.projectId,
      runId: '482',
      kind: 'rerun',
    })
    expect(plain).toMatchObject({
      kind: 'rerun',
      deploy: false,
      repeats: false,
      ref: 'raditi/novoe-menyu-12345678',
    })
    expect(readRepoConfirmToken(plain.confirmToken, mac, new Date())).toMatchObject({
      kind: 'rerun',
      headSha: head,
      targetBranch: 'raditi/novoe-menyu-12345678',
      run: { id: '482', ref: 'raditi/novoe-menyu-12345678', deploy: false },
      taskId: null,
    })
    for (const runId of ['481', '480'])
      expect(
        await f.caller.projectRepo.prepareRunAction({
          projectId: f.projectId,
          runId,
          kind: 'rerun',
        }),
      ).toMatchObject({ deploy: true, repeats: false })
    // A build of the branch that passed (ПР36): the plain card warns of a new build.
    expect(
      await f.caller.projectRepo.prepareRunAction({
        projectId: f.projectId,
        runId: '479',
        kind: 'rerun',
      }),
    ).toMatchObject({ deploy: false, repeats: true })
    // A cancel of a build that ended, a rerun of one that goes: refused before any card.
    expect(
      await refusal(() =>
        f.caller.projectRepo.prepareRunAction({
          projectId: f.projectId,
          runId: '482',
          kind: 'cancel',
        }),
      ),
    ).toBe('REPO_RUN_GONE')
    // The press is written once, with the job of core.
    const { actionId } = await f.caller.projectRepo.confirmRunAction({
      confirmToken: plain.confirmToken,
    })
    const row = await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })
    expect([row.kind, row.state, row.taskId]).toEqual(['rerun', 'queued', null])
    expect(await jobs(f, 'git.action')).toEqual([{ actionId }])
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmRunAction({ confirmToken: plain.confirmToken }),
      ),
    ).toBe('REPO_CONFIRM_USED')
    // A token of another kind is not a card of a build.
    const merge = await f.caller.projectRepo.prepareMerge({ projectId: f.projectId, number: 7 })
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmRunAction({ confirmToken: merge.confirmToken }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
  })

  it('«Отменить» only of a request merged into main, bound to its merge commit', async () => {
    const merged = 'd'.repeat(40)
    const open = await fixture()
    expect(
      await refusal(() =>
        open.caller.projectRepo.prepareRevert({ projectId: open.projectId, number: 7 }),
      ),
    ).toBe('REPO_NOT_MERGED')
    const f = await fixture({ mr: { state: 'merged', mergeSha: merged } })
    const card = await f.caller.projectRepo.prepareRevert({ projectId: f.projectId, number: 7 })
    expect(card).toMatchObject({ number: 7, target: 'main', mergeSha: merged })
    expect(readRepoConfirmToken(card.confirmToken, mac, new Date())).toMatchObject({
      kind: 'revert',
      number: 7,
      targetBranch: 'main',
      headSha: merged,
      taskId: f.task.id,
    })
    const { actionId } = await f.caller.projectRepo.confirmRevert({
      confirmToken: card.confirmToken,
    })
    const row = await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })
    expect([row.kind, row.taskId]).toEqual(['revert', f.task.id])
    // A repository read only: no card.
    const read = await fixture({ mode: 'read', mr: { state: 'merged', mergeSha: merged } })
    expect(
      await refusal(() =>
        read.caller.projectRepo.prepareRevert({ projectId: read.projectId, number: 7 }),
      ),
    ).toBe('REPO_READ_ONLY')
  })

  it('`@` of a project without a repository is none, and makes no S3 client', async () => {
    const user = await person()
    const caller = callerOf(user)
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Без репозитория' })
    storageClients = 0
    expect(await caller.projectRepo.paths({ projectId })).toEqual({ state: 'none' })
    expect(storageClients).toBe(0)
  })

  it('`@` gets the paths core keeps; a newer head asks core for its own, once a minute', async () => {
    const f = await fixture()
    storageClients = 0
    expect(await f.caller.projectRepo.paths({ projectId: f.projectId })).toEqual({ state: 'none' })
    await db.projectRepository.update({
      where: { id: f.projectRepositoryId },
      data: { lastFetchedSha: mainSha },
    })
    expect(await f.caller.projectRepo.paths({ projectId: f.projectId })).toEqual({
      state: 'loading',
    })
    await f.caller.projectRepo.paths({ projectId: f.projectId })
    expect(await jobs(f, 'git.repo.tree')).toEqual([
      { projectRepositoryId: f.projectRepositoryId, sha: mainSha },
    ])
    // No list kept yet, and before that no ready repository: no S3 client was made (a process
    // without S3 logged an invalid configuration on every look, plan 84, §10).
    expect(storageClients).toBe(0)
    await db.projectRepository.update({
      where: { id: f.projectRepositoryId },
      data: { treeSha: mainSha },
    })
    // A list of an earlier version (v1 of 84.26 offered the files gitleaks flags, ПР35) is not
    // read: the look asks core for one again, though `tree_sha` names this head.
    kept.set(
      `repo-trees/${f.projectRepositoryId}/${mainSha}.json`,
      Buffer.from(JSON.stringify({ v: 1, sha: mainSha, paths: ['config.ts'], truncated: false })),
    )
    await dropGitJobsOf(db, [f.workspaceId])
    expect(await f.caller.projectRepo.paths({ projectId: f.projectId })).toEqual({
      state: 'loading',
    })
    expect(await jobs(f, 'git.repo.tree')).toEqual([
      { projectRepositoryId: f.projectRepositoryId, sha: mainSha },
    ])
    kept.set(
      repoTreeKey(f.projectRepositoryId, mainSha),
      Buffer.from(JSON.stringify({ v: 2, sha: mainSha, paths: ['src/app.ts'], truncated: false })),
    )
    expect(await f.caller.projectRepo.paths({ projectId: f.projectId })).toEqual({
      state: 'ready',
      sha: mainSha,
      paths: ['src/app.ts'],
      truncated: false,
    })
    // One client for each look that read a kept list, and only those.
    expect(storageClients).toBe(2)
    // Another person reads nothing of it.
    const other = callerOf(await person())
    expect(await refusal(() => other.projectRepo.paths({ projectId: f.projectId }))).toBe(
      'PROJECT_NOT_FOUND',
    )
  })
})
