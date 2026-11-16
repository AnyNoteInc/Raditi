import { createHmac, randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  ensureChatBranch,
  insertFeedEvent,
  type PrismaClient,
  type User,
} from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { GitServices } from '../services/git/connections.ts'

// The builds of a repository in the cabinet on PostgreSQL (docs/plan/84-projects.md, ПР17, ПР25;
// slice 84.21): the runs core polled, a look that asks core to poll once a minute, a log that is
// `loading` until core fetched it, the status of the chat's build that changes without a reload,
// and «Изменения уже приняты в основную ветку» after `/undo` of a merged branch.

const databaseUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-repo-confirm-secret-of-the-trpc-test'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`
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

describe.skipIf(!databaseUrl)('PostgreSQL: the builds of a repository (plan 84, 84.21)', () => {
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
    await db.outboxEvent.deleteMany({ where: { topic: 'git' } })
    await db.repoAction.deleteMany({ where: { createdById: { in: users } } })
    await db.taskEvent.deleteMany({ where: { task: owned } })
    await db.taskTurn.deleteMany({ where: { task: owned } })
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

  // `raditi-artifacts` as core leaves it: the diffs of the build settings (ПР16).
  const kept = new Map<string, Buffer>()
  const chatContext: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () =>
      ({
        get: async (_bucket: string, key: string) => {
          const bytes = kept.get(key)
          return bytes
            ? (async function* () {
                yield bytes
              })()
            : null
        },
      }) as unknown as ObjectStorage,
    secrets: () => ({}) as SecretStore,
  }

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Runs verification', email: `${randomUUID()}@git.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User, confirmMac: GitServices['confirmMac'] = mac) {
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `runs-test-${randomUUID()}`,
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
        confirmMac,
      },
    })
  }

  /** A project of the user with a connected repository, a chat in it and one card of a turn. */
  async function fixture(
    options: { mode?: 'read' | 'write'; ciTouched?: boolean; ciPaths?: object } = {},
  ) {
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
        ...(options.ciPaths ? { ciPaths: options.ciPaths } : {}),
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
    const head = 'c'.repeat(40)
    const turn = await db.taskTurn.create({
      data: {
        taskId: task.id,
        turnNo: 1,
        status: 'completed',
        driverId: 'opencode',
        image,
        baseSha: 'b'.repeat(40),
        headSha: head,
      },
    })
    const branch = await ensureChatBranch(db, {
      taskId: task.id,
      projectRepositoryId,
      title: task.title,
      baseSha: 'b'.repeat(40),
    })
    await insertFeedEvent(db, {
      taskId: task.id,
      turnId: turn.id,
      row: {
        type: 'feed.repo_changes',
        payload: {
          v: 1,
          branch: branch.branch,
          baseSha: 'b'.repeat(40),
          headSha: head,
          diffSha256: 'd'.repeat(64),
          files: 1,
          additions: 3,
          deletions: 1,
          list: [{ path: 'menu.html', additions: 3, deletions: 1 }],
          ciTouched: options.ciTouched ?? false,
          pushed: false,
          mergeRequest: null,
        },
      },
    })
    return { user, caller, task, head, branch, projectRepositoryId }
  }

  async function run(
    projectRepositoryId: string,
    id: string,
    ref: string,
    status: string,
    sha: string,
    at = new Date(),
  ) {
    await db.projectCiRun.upsert({
      where: { projectRepositoryId_providerRunId: { projectRepositoryId, providerRunId: id } },
      create: {
        projectRepositoryId,
        providerRunId: id,
        ref,
        sha,
        name: `#${id}`,
        status,
        webUrl: `https://gitlab.example.ru/kolos/site/-/pipelines/${id}`,
        jobs: [
          {
            id: `${id}2`,
            name: 'unit-tests',
            stage: 'test',
            status,
            manual: false,
            refusal: null,
            url: `https://gitlab.example.ru/kolos/site/-/jobs/${id}2`,
            startedAt: null,
            finishedAt: null,
          },
          {
            id: `${id}1`,
            name: 'lint',
            stage: 'check',
            status: 'success',
            manual: false,
            refusal: null,
            url: `https://gitlab.example.ru/kolos/site/-/jobs/${id}1`,
            startedAt: null,
            finishedAt: null,
          },
        ],
        createdAt: at,
        syncedAt: at,
      },
      update: { status, syncedAt: new Date() },
    })
  }

  it('lists the runs core polled with their chats and asks core to poll once a minute', async () => {
    const f = await fixture()
    await run(
      f.projectRepositoryId,
      '481',
      'main',
      'success',
      'e'.repeat(40),
      new Date(Date.now() - 60_000),
    )
    await run(f.projectRepositoryId, '482', f.branch.branch, 'running', f.head)
    const first = await f.caller.projectRepo.runs({ projectId: f.task.projectId! })
    expect(first.items.map((r) => [r.id, r.status, r.chat?.title ?? null, r.stages])).toEqual([
      ['482', 'running', 'Новое меню', ['check', 'test']],
      ['481', 'success', null, ['check', 'test']],
    ])
    expect(first.refreshing).toBe(true)
    await f.caller.projectRepo.runs({ projectId: f.task.projectId! })
    const polls = await db.outboxEvent.findMany({ where: { topic: 'git', type: 'git.poll' } })
    expect(polls.map((p) => p.payload)).toEqual([{ projectRepositoryId: f.projectRepositoryId }])
    // Core polled a moment ago: a look asks nothing.
    await db.outboxEvent.deleteMany({ where: { topic: 'git' } })
    await db.projectRepository.update({
      where: { id: f.projectRepositoryId },
      data: { ciPolledAt: new Date() },
    })
    expect((await f.caller.projectRepo.runs({ projectId: f.task.projectId! })).refreshing).toBe(
      false,
    )
    expect(await db.outboxEvent.count({ where: { topic: 'git' } })).toBe(0)
    // A page of one, then the next.
    const page = await f.caller.projectRepo.runs({ projectId: f.task.projectId!, limit: 1 })
    expect(page.items.map((r) => r.id)).toEqual(['482'])
    const next = await f.caller.projectRepo.runs({
      projectId: f.task.projectId!,
      limit: 1,
      cursor: page.next!,
    })
    expect(next.items.map((r) => r.id)).toEqual(['481'])
    // Someone else sees nothing.
    const other = callerOf(await person())
    expect(await refusal(() => other.projectRepo.runs({ projectId: f.task.projectId! }))).toBe(
      'PROJECT_NOT_FOUND',
    )
  })

  it('shows a run with its jobs, a log loading and then ready', async () => {
    const f = await fixture()
    await run(f.projectRepositoryId, '482', f.branch.branch, 'failed', f.head)
    const shown = await f.caller.projectRepo.run({ projectId: f.task.projectId!, runId: '482' })
    expect(shown.jobs.map((j) => j.name)).toEqual(['unit-tests', 'lint'])
    expect(
      await refusal(() => f.caller.projectRepo.run({ projectId: f.task.projectId!, runId: '9' })),
    ).toBe('REPO_RUN_NOT_FOUND')
    const ask = { projectId: f.task.projectId!, runId: '482', jobId: '4822' }
    expect(await f.caller.projectRepo.jobLog(ask)).toEqual({ state: 'loading' })
    expect(await f.caller.projectRepo.jobLog(ask)).toEqual({ state: 'loading' })
    expect(await db.outboxEvent.count({ where: { topic: 'git', type: 'git.log' } })).toBe(1)
    await db.projectCiLog.update({
      where: {
        projectRepositoryId_providerJobId: {
          projectRepositoryId: f.projectRepositoryId,
          providerJobId: '4822',
        },
      },
      data: { state: 'ready', text: 'Tests  1 failed | 33 passed (34)', fetchedAt: new Date() },
    })
    expect(await f.caller.projectRepo.jobLog(ask)).toMatchObject({
      state: 'ready',
      text: 'Tests  1 failed | 33 passed (34)',
      truncated: false,
    })
    expect(await refusal(() => f.caller.projectRepo.jobLog({ ...ask, jobId: '1' }))).toBe(
      'REPO_RUN_NOT_FOUND',
    )
  })

  it('the card of the chat reads the status of its build as core polls it', async () => {
    const f = await fixture()
    await db.projectRepoBranch.update({
      where: { taskId: f.task.id },
      data: { mirrorSha: f.head, remoteSha: f.head, state: 'pushed' },
    })
    await run(f.projectRepositoryId, '482', f.branch.branch, 'running', f.head)
    expect((await f.caller.projectRepo.branch({ taskId: f.task.id }))?.lastRun).toMatchObject({
      id: '482',
      status: 'running',
    })
    await run(f.projectRepositoryId, '482', f.branch.branch, 'success', f.head)
    expect((await f.caller.projectRepo.branch({ taskId: f.task.id }))?.lastRun?.status).toBe(
      'success',
    )
  })

  it('says the changes are in the main branch after /undo of a merged branch (ПР25)', async () => {
    const f = await fixture()
    const second = 'f'.repeat(40)
    const turn = await db.taskTurn.create({
      data: {
        taskId: f.task.id,
        turnNo: 2,
        status: 'completed',
        driverId: 'opencode',
        image,
        baseSha: f.head,
        headSha: second,
      },
    })
    await insertFeedEvent(db, {
      taskId: f.task.id,
      turnId: turn.id,
      row: {
        type: 'feed.repo_changes',
        payload: {
          v: 1,
          branch: f.branch.branch,
          baseSha: f.head,
          headSha: second,
          diffSha256: 'a'.repeat(64),
          files: 1,
          additions: 1,
          deletions: 0,
          list: [{ path: 'menu.html', additions: 1, deletions: 0 }],
          ciTouched: false,
          pushed: false,
          mergeRequest: null,
        },
      },
    })
    await db.projectRepoBranch.update({
      where: { taskId: f.task.id },
      data: { mirrorSha: second, remoteSha: second, state: 'merged' },
    })
    await db.taskTurn.update({ where: { id: turn.id }, data: { undoneAt: new Date() } })
    const view = await f.caller.projectRepo.branch({ taskId: f.task.id })
    expect(view).toMatchObject({ state: 'merged', rewinds: true })
    expect(await refusal(() => f.caller.projectRepo.preparePush({ taskId: f.task.id }))).toBe(
      'REPO_ALREADY_MERGED',
    )
  })
})
