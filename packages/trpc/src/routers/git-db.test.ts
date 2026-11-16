import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  gitHostRefused,
  legalDocuments,
  type KvMetadata,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import { dropGitJobsOf } from '../testing/git-jobs.ts'
import type { ChatContext } from '../services/chat/context.ts'
import { connectGitlabOAuth, type GitServices } from '../services/git/connections.ts'

// The git connections of a user and the repository of a project on PostgreSQL
// (docs/plan/84-projects.md, ПР9, ПР10, §4.4; slice 84.17): the routers `gitConnection` and
// `projectRepo`, `project.create({ publicRepositoryUrl })`. Vault is a fake that can only write,
// as `sites-writer`; the check of a host is a fake that refuses a private address.

const databaseUrl = process.env.DATABASE_URL

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

async function refusal(act: () => Promise<unknown>): Promise<{ code: string; text: string }> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined
      return { code: cause?.code ?? error.code, text: error.message }
    }
    throw error
  }
  throw new Error('The procedure was not refused')
}

/** Vault as `sites-writer` sees it: writes with CAS, metadata, never a read. */
function writerVault() {
  const keys = new Map<string, { data: Record<string, string>; version: number }>()
  const secrets: GitServices['secrets'] = {
    kvWrite: async (path, data, options) => {
      const current = keys.get(path)
      if (options?.cas !== undefined && options.cas !== (current?.version ?? 0))
        throw new Error('cas mismatch')
      const version = (current?.version ?? 0) + 1
      keys.set(path, { data: { ...data }, version })
      return { version }
    },
    kvMetadata: async (path) => {
      const current = keys.get(path)
      return current
        ? ({
            currentVersion: current.version,
            custom: {},
            createdTime: new Date(),
            deleted: false,
            destroyed: false,
          } satisfies KvMetadata)
        : null
    },
  }
  return { keys, secrets }
}

describe.skipIf(!databaseUrl)('PostgreSQL: git connections and project repositories', () => {
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

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Git verification', email: `${randomUUID()}@git.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  const chat: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () => ({}) as ObjectStorage,
    secrets: () => ({}) as SecretStore,
  }

  /** A user with their own caller, Vault and check of hosts (private addresses refused). */
  async function owner(options: { gitlabComConfigured?: boolean } = {}) {
    const user = await person()
    const vault = writerVault()
    const checkHost = vi.fn(async (host: string) => {
      if (host.endsWith('.internal') || host === 'gitlab.private.example.ru') throw gitHostRefused()
    })
    const git: GitServices = {
      appEnv: 'test',
      secrets: vault.secrets,
      checkHost,
      gitlabComConfigured: options.gitlabComConfigured ?? true,
    }
    const caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `git-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
      git,
    })
    const project = async () => {
      const projectId = v7()
      await caller.project.create({ projectId, name: 'Сайт пекарни' })
      return projectId
    }
    return { user, caller, vault, git, checkHost, project }
  }

  /** What core's sync leaves: the connection checked and one repository it sees. */
  async function synced(connectionId: string, path = 'kolos/site') {
    await db.gitConnection.update({
      where: { id: connectionId },
      data: { state: 'ok', accountLogin: 'elena.k', accountId: `id-${connectionId.slice(0, 8)}` },
    })
    await db.gitConnectionRepository.create({
      data: {
        connectionId,
        providerRepoId: '7',
        path,
        name: path.split('/').at(-1)!,
        visibility: 'private',
        defaultBranch: 'main',
        branches: ['main', 'develop'],
        canPush: true,
        canHook: false,
        syncedAt: new Date(),
      },
    })
  }

  it('a token of an own server goes to Vault and never comes back; core is asked to check it', async () => {
    const { caller, vault, user } = await owner()
    const { connectionId } = await caller.gitConnection.addToken({
      host: 'https://git.kolos-bakery.ru',
      token: 'glpat-synthetic-token-value',
    })
    const [path] = [...vault.keys.keys()]
    expect(path).toMatch(new RegExp(`^kv/workspaces/[0-9a-f-]+/git/${connectionId}$`))
    expect(vault.keys.get(path!)!.data).toEqual({ token: 'glpat-synthetic-token-value' })
    const row = await db.gitConnection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { credentialRef: true },
    })
    expect(row).toMatchObject({
      kind: 'gitlab_token',
      host: 'git.kolos-bakery.ru',
      state: 'checking',
      createdById: user.id,
    })
    expect(row.credentialRef).toMatchObject({ kind: 'git_connection', vaultPath: path })
    // Other files of this suite queue jobs of `git` on the same base at the same time.
    const job = await db.outboxEvent.findFirstOrThrow({
      where: { topic: 'git', payload: { path: ['connectionId'], equals: connectionId } },
    })
    expect(job).toMatchObject({ type: 'git.connection.sync', payload: { connectionId } })
    // Nothing of the token is in the base, the outbox or the answer of the list.
    const list = await caller.gitConnection.list()
    expect(JSON.stringify(list)).not.toContain('glpat')
    expect(JSON.stringify(row)).not.toContain('glpat')
    expect(list.connections).toEqual([
      expect.objectContaining({ id: connectionId, login: null, state: 'checking' }),
    ])
  })

  it('a server that resolves to a private address is refused before anything is written', async () => {
    const { caller, vault, checkHost } = await owner()
    for (const host of ['gitlab.private.example.ru', 'http://git.kolos-bakery.ru', '10.0.0.1'])
      expect(
        (await refusal(() => caller.gitConnection.addToken({ host, token: 'glpat-synthetic' })))
          .code,
      ).toBe('GIT_HOST_REFUSED')
    expect(checkHost).toHaveBeenCalledTimes(1)
    expect(vault.keys.size).toBe(0)
    expect(await db.gitConnection.count({ where: { host: 'gitlab.private.example.ru' } })).toBe(0)
  })

  it('a link whose host resolves to a private address is refused, a project is not made', async () => {
    const { caller } = await owner()
    const projectId = v7()
    const refused = await refusal(() =>
      caller.project.create({
        projectId,
        name: 'Сайт пекарни',
        publicRepositoryUrl: 'https://git.corp.internal/group/site',
      }),
    )
    expect(refused.code).toBe('GIT_HOST_REFUSED')
    expect(refused.text).toBe('Этот адрес недоступен: сервер должен быть в интернете по https')
    expect(await db.project.count({ where: { id: projectId } })).toBe(0)
  })

  it('a project with a link: read only, syncing, and a private repository is REPO_LINK_PRIVATE', async () => {
    const { caller } = await owner()
    const projectId = v7()
    await caller.project.create({
      projectId,
      name: 'Сайт пекарни',
      publicRepositoryUrl: 'https://github.com/kolos/site/tree/main/src',
    })
    const repo = await caller.projectRepo.get({ projectId })
    expect(repo).toMatchObject({
      provider: 'github',
      host: 'github.com',
      path: 'kolos/site',
      mode: 'read',
      mirrorState: 'syncing',
      connection: null,
      refusal: null,
    })
    const job = await db.outboxEvent.findFirstOrThrow({
      where: {
        topic: 'git',
        type: 'git.repo.attach',
        payload: { path: ['projectRepositoryId'], equals: repo!.id },
      },
    })
    expect(job.payload).toEqual({ projectRepositoryId: repo!.id })
    // Core asked the provider anonymously and was told nothing is there.
    await db.projectRepository.update({
      where: { id: repo!.id },
      data: { mirrorState: 'unreachable' },
    })
    const read = await caller.project.get({ projectId })
    expect(read.repository?.refusal).toEqual({
      code: 'REPO_LINK_PRIVATE',
      message:
        'Репозиторий закрытый или его нет: по ссылке агент видит только открытые репозитории',
    })
    // One repository per project: a second is refused until the first is taken away.
    expect(
      (
        await refusal(() =>
          caller.projectRepo.attach({ projectId, publicUrl: 'https://gitlab.com/kolos/other' }),
        )
      ).code,
    ).toBe('PROJECT_HAS_REPOSITORY')
    const detached = await db.projectRepository.findFirstOrThrow({ where: { projectId } })
    await caller.projectRepo.detach({ projectId })
    expect(await caller.projectRepo.get({ projectId })).toBeNull()
    // Core removes its mirror once the row is gone (ПР20).
    expect(
      await db.outboxEvent.count({
        where: { type: 'git.repo.forget', dedupeKey: `git.repo.forget:${detached.id}` },
      }),
    ).toBe(1)
  })

  it('a connection of another user is neither listed nor chosen', async () => {
    const elena = await owner()
    const other = await owner()
    const { connectionId } = await other.caller.gitConnection.addToken({
      host: 'git.kolos-bakery.ru',
      token: 'glpat-synthetic-other',
    })
    await synced(connectionId)
    const projectId = await elena.project()
    expect((await elena.caller.gitConnection.list()).connections).toEqual([])
    expect(
      (await refusal(() => elena.caller.gitConnection.repositories({ connectionId }))).code,
    ).toBe('GIT_CONNECTION_NOT_FOUND')
    expect(
      (
        await refusal(() =>
          elena.caller.projectRepo.attach({
            projectId,
            connectionId,
            providerRepoId: '7',
            defaultBranch: 'main',
          }),
        )
      ).code,
    ).toBe('REPO_NOT_IN_CONNECTION')
    expect(await db.projectRepository.count({ where: { projectId } })).toBe(0)
    // Even moved into the workspace of the project, it stays the other user's.
    const elenaWorkspace = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    await db.member.create({
      data: { workspaceId: elenaWorkspace.workspaceId, userId: other.user.id, role: 'member' },
    })
    await db.$executeRaw`UPDATE git_connections SET workspace_id = ${elenaWorkspace.workspaceId}::uuid WHERE id = ${connectionId}::uuid`
    expect(
      (
        await refusal(() =>
          elena.caller.projectRepo.attach({
            projectId,
            connectionId,
            providerRepoId: '7',
            defaultBranch: 'main',
          }),
        )
      ).code,
    ).toBe('REPO_NOT_IN_CONNECTION')
    await db.member.deleteMany({
      where: { userId: other.user.id, workspaceId: elenaWorkspace.workspaceId },
    })
  })

  it('the own connection lists, branches and attaches a repository for writing', async () => {
    const { caller } = await owner()
    const { connectionId } = await caller.gitConnection.addToken({
      host: 'git.kolos-bakery.ru',
      token: 'glpat-synthetic-own',
    })
    expect((await caller.gitConnection.repositories({ connectionId })).state).toBe('syncing')
    await synced(connectionId)
    const listed = await caller.gitConnection.repositories({ connectionId, query: 'SITE' })
    expect(listed.items.map((item) => item.path)).toEqual(['kolos/site'])
    expect(await caller.projectRepo.branches({ connectionId, providerRepoId: '7' })).toEqual({
      state: 'ready',
      names: ['main', 'develop'],
    })
    const projectId = await (async () => {
      const id = v7()
      await caller.project.create({ projectId: id, name: 'Сайт' })
      return id
    })()
    expect(
      (
        await refusal(() =>
          caller.projectRepo.attach({
            projectId,
            connectionId,
            providerRepoId: '7',
            defaultBranch: 'nope',
          }),
        )
      ).code,
    ).toBe('REPO_NOT_IN_CONNECTION')
    await caller.projectRepo.attach({
      projectId,
      connectionId,
      providerRepoId: '7',
      defaultBranch: 'develop',
    })
    expect(await caller.projectRepo.get({ projectId })).toMatchObject({
      provider: 'gitlab',
      host: 'git.kolos-bakery.ru',
      path: 'kolos/site',
      defaultBranch: 'develop',
      mode: 'write',
      mirrorState: 'syncing',
      webUrl: 'https://git.kolos-bakery.ru/kolos/site',
      connection: { id: connectionId, kind: 'gitlab_token', login: 'elena.k', state: 'ok' },
    })
    // A connection a project reads through is not removed.
    expect((await refusal(() => caller.gitConnection.remove({ connectionId }))).code).toBe(
      'GIT_CONNECTION_IN_USE',
    )
    await caller.projectRepo.detach({ projectId })
    await caller.gitConnection.remove({ connectionId })
    expect(await db.gitConnection.count({ where: { id: connectionId } })).toBe(0)
  })

  it('no more than ten connections in a workspace', async () => {
    const { caller } = await owner()
    for (let i = 0; i < 10; i++)
      await caller.gitConnection.addToken({
        host: `git${i}.kolos-bakery.ru`,
        token: `glpat-${i}-synthetic`,
      })
    expect(
      (
        await refusal(() =>
          caller.gitConnection.addToken({
            host: 'git10.kolos-bakery.ru',
            token: 'glpat-10-synthetic',
          }),
        )
      ).code,
    ).toBe('GIT_CONNECTION_LIMIT')
  })

  it('a sign-in on gitlab.com again replaces the tokens of the same account; off when not offered', async () => {
    const { user, git, vault } = await owner()
    const first = await connectGitlabOAuth(db, git, {
      userId: user.id,
      account: { login: 'elena.k', id: '42' },
      tokens: { accessToken: 'a-1', refreshToken: 'r-1', expiresAt: new Date('2030-01-01') },
      ip: null,
    })
    await db.gitConnection.update({
      where: { id: first.connectionId },
      data: { state: 'reauth_needed' },
    })
    const again = await connectGitlabOAuth(db, git, {
      userId: user.id,
      account: { login: 'elena.k', id: '42' },
      tokens: { accessToken: 'a-2', refreshToken: 'r-2', expiresAt: null },
      ip: null,
    })
    expect(again.connectionId).toBe(first.connectionId)
    const row = await db.gitConnection.findUniqueOrThrow({ where: { id: first.connectionId } })
    expect(row).toMatchObject({
      kind: 'gitlab_oauth',
      host: 'gitlab.com',
      state: 'checking',
      accountId: '42',
    })
    const [kept] = [...vault.keys.values()]
    expect(kept).toEqual({ data: { accessToken: 'a-2', refreshToken: 'r-2' }, version: 2 })
    await expect(
      connectGitlabOAuth(
        db,
        { ...git, gitlabComConfigured: false },
        {
          userId: user.id,
          account: { login: 'x', id: '1' },
          tokens: { accessToken: 'a', refreshToken: null, expiresAt: null },
          ip: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'GIT_CONNECT_UNAVAILABLE' })
  })

  it('a repository is not taken away while a chat of the project is at work', async () => {
    const { caller, user } = await owner()
    const projectId = v7()
    await caller.project.create({
      projectId,
      name: 'Сайт',
      publicRepositoryUrl: 'https://gitlab.com/kolos/site',
    })
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const taskId = v7()
    await db.task.create({
      data: {
        id: taskId,
        workspaceId: project.workspaceId,
        projectId,
        createdById: user.id,
        title: 'Чат',
        status: 'running',
      },
    })
    expect((await refusal(() => caller.projectRepo.detach({ projectId }))).code).toBe(
      'TASK_PROJECT_BUSY',
    )
    await db.task.delete({ where: { id: taskId } })
    await caller.projectRepo.detach({ projectId })
  })
})
