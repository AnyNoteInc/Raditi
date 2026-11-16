import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  gitAccessDenied,
  gitHostRefused,
  repositoryTooLarge,
  type GitProvider,
  type RepositoryInfo,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GitJobs, ownCiPath } from './git-jobs.ts'

// The jobs of the queue `git` (docs/plan/84-projects.md, §4.3; slice 84.17) on PostgreSQL, with a
// fake adapter and a fake trusted git: the check and the list of a connection, the branches, the
// first fetch of a link and of a connected repository, and what each failure leaves in the rows.
// Only on a disposable database (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const SHA = 'a'.repeat(40)

/** A UUID of version 7, as the browser makes the id of a project. */
function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const quiet = { log: vi.fn(), warn: vi.fn() }

function info(overrides: Partial<RepositoryInfo> & { path?: string; id?: string } = {}) {
  const { path = 'kolos/site', id = '7', ...rest } = overrides
  return {
    ref: { provider: 'gitlab' as const, host: 'gitlab.example.ru', path, providerRepoId: id },
    defaultBranch: 'main',
    private: true,
    webUrl: `https://gitlab.example.ru/${path}`,
    cloneUrl: `https://gitlab.example.ru/${path}.git`,
    sizeBytes: 1024,
    ciConfigPath: null,
    ...rest,
  } satisfies RepositoryInfo
}

/** The adapter calls a job makes, answered by `answers`. */
function fakeProvider(answers: Partial<GitProvider>) {
  const calls: string[] = []
  const provider = new Proxy({} as GitProvider, {
    get: (_target, name: string) => {
      const answer = (answers as Record<string, unknown>)[name]
      if (name === 'then') return undefined
      return async (...args: unknown[]) => {
        calls.push(name)
        if (typeof answer !== 'function') throw new Error(`unexpected call ${name}`)
        return (answer as (...a: unknown[]) => unknown)(...args)
      }
    },
  })
  return { provider, calls }
}

describe.skipIf(!enabled)('GitJobs with PostgreSQL (plan 84, 84.17)', () => {
  let db: PrismaClient
  const users: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const userId of users.splice(0)) {
      await db.projectRepository.deleteMany({ where: { project: { createdById: userId } } })
      await db.project.deleteMany({ where: { createdById: userId } })
      const refs = await db.gitConnection.findMany({
        where: { createdById: userId },
        select: { credentialRefId: true },
      })
      await db.gitConnection.deleteMany({ where: { createdById: userId } })
      await db.credentialRef.deleteMany({
        where: { id: { in: refs.flatMap((r) => (r.credentialRefId ? [r.credentialRefId] : [])) } },
      })
      await db.workspace.deleteMany({ where: { createdById: userId } })
      await db.user.deleteMany({ where: { id: userId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    users.push(user.id)
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    const project = await db.project.create({
      data: {
        id: uuidv7(),
        workspaceId: workspace.id,
        createdById: user.id,
        name: 'Сайт пекарни',
        activityAt: new Date(),
      },
    })
    return { userId: user.id, workspaceId: workspace.id, projectId: project.id }
  }

  async function tokenConnection(
    own: Awaited<ReturnType<typeof owner>>,
    fields: { accountId?: string; state?: string } = {},
  ) {
    const id = randomUUID()
    const ref = await db.credentialRef.create({
      data: {
        workspaceId: own.workspaceId,
        kind: 'git_connection',
        vaultPath: `kv/workspaces/${own.workspaceId}/git/${id}`,
      },
    })
    await db.gitConnection.create({
      data: {
        id,
        workspaceId: own.workspaceId,
        createdById: own.userId,
        kind: 'gitlab_token',
        host: 'gitlab.example.ru',
        accountLogin: 'gitlab.example.ru',
        accountId: fields.accountId ?? id,
        credentialRefId: ref.id,
        state: fields.state ?? 'checking',
      },
    })
    return id
  }

  function jobs(answers: Partial<GitProvider>) {
    const fake = fakeProvider(answers)
    const fetch = vi.fn(async (_input: unknown) => new Map([['main', SHA]]))
    const findSecrets = vi.fn(async () => ['config/prod.env'])
    const resolvePublic = vi.fn(async () => '203.0.113.7')
    const provider = vi.fn(() => fake.provider)
    const made = new GitJobs({
      prisma: db,
      auth: { grantFor: async () => ({ kind: 'token', token: 'synthetic-token' }) },
      resolvePublic,
      provider,
      workspace: { fetch, findSecrets },
      logger: quiet,
    })
    return { jobs: made, calls: fake.calls, fetch, findSecrets, resolvePublic, provider }
  }

  it('a sync names the account and lists the repositories; a repeat drops the ones gone', async () => {
    const own = await owner()
    const id = await tokenConnection(own)
    let listed = [info(), info({ path: 'kolos/bot', id: '8', private: false })]
    const run = jobs({
      whoAmI: async () => ({ login: 'elena.k', id: '42' }),
      listRepositories: async () => ({ items: listed, next: null }),
    })
    await run.jobs.syncConnection(id)
    const row = await db.gitConnection.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ state: 'ok', accountLogin: 'elena.k', accountId: '42' })
    const repos = await db.gitConnectionRepository.findMany({
      where: { connectionId: id },
      orderBy: { providerRepoId: 'asc' },
    })
    expect(repos.map((r) => [r.path, r.visibility])).toEqual([
      ['kolos/site', 'private'],
      ['kolos/bot', 'public'],
    ])
    expect(run.resolvePublic).toHaveBeenCalledWith('gitlab.example.ru')
    listed = [info()]
    await run.jobs.syncConnection(id)
    expect(await db.gitConnectionRepository.count({ where: { connectionId: id } })).toBe(1)
  })

  it('a refused token and a host that turned private are said on the connection', async () => {
    const own = await owner()
    const id = await tokenConnection(own)
    await jobs({
      whoAmI: async () => {
        throw gitAccessDenied()
      },
    }).jobs.syncConnection(id)
    expect(await db.gitConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: 'refused',
      stateReason: 'access_denied',
    })
    const other = await tokenConnection(own)
    const run = jobs({})
    run.resolvePublic.mockRejectedValueOnce(gitHostRefused())
    await run.jobs.syncConnection(other)
    const row = await db.gitConnection.findUniqueOrThrow({ where: { id: other } })
    expect(row).toMatchObject({ state: 'refused', stateReason: 'host_refused' })
    // Nothing reached the adapter: the address was refused first.
    expect(run.calls).toEqual([])
  })

  it('the same account connected twice by the user is refused on the second', async () => {
    const own = await owner()
    await tokenConnection(own, { accountId: '42', state: 'ok' })
    const second = await tokenConnection(own)
    await jobs({
      whoAmI: async () => ({ login: 'elena.k', id: '42' }),
      listRepositories: async () => ({ items: [], next: null }),
    }).jobs.syncConnection(second)
    expect(await db.gitConnection.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
      state: 'refused',
      stateReason: 'already_connected',
    })
  })

  it('the branches of a repository are kept with the main one first', async () => {
    const own = await owner()
    const id = await tokenConnection(own, { state: 'ok' })
    await db.gitConnectionRepository.create({
      data: {
        connectionId: id,
        providerRepoId: '7',
        path: 'kolos/site',
        name: 'site',
        visibility: 'private',
        defaultBranch: 'main',
        canPush: true,
        canHook: false,
        syncedAt: new Date(),
      },
    })
    await jobs({
      listBranches: async () => ['develop', 'main', 'winter-2026'],
    }).jobs.inspectRepository(id, '7')
    const row = await db.gitConnectionRepository.findUniqueOrThrow({
      where: { connectionId_providerRepoId: { connectionId: id, providerRepoId: '7' } },
    })
    expect(row.branches).toEqual(['main', 'develop', 'winter-2026'])
  })

  async function linkRepository(own: Awaited<ReturnType<typeof owner>>, connectionId?: string) {
    const id = randomUUID()
    await db.projectRepository.create({
      data: {
        id,
        projectId: own.projectId,
        workspaceId: own.workspaceId,
        connectionId: connectionId ?? null,
        provider: 'gitlab',
        host: 'gitlab.example.ru',
        ...(connectionId ? { providerRepoId: '7' } : {}),
        path: 'kolos/site',
        webUrl: 'https://gitlab.example.ru/kolos/site',
        defaultBranch: connectionId ? 'develop' : 'main',
        mode: connectionId ? 'write' : 'read',
      },
    })
    return id
  }

  it('an open link is fetched: ready, its head, the files like secrets and the own CI path', async () => {
    const own = await owner()
    const id = await linkRepository(own)
    const run = jobs({
      getRepository: async () =>
        info({ private: false, defaultBranch: 'trunk', ciConfigPath: 'ci/pipeline.yml' }),
      issueCredentials: async () => ({
        auth: { kind: 'anonymous' },
        basic: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    })
    run.fetch.mockResolvedValueOnce(new Map([['trunk', SHA]]))
    await run.jobs.attachRepository(id)
    const row = await db.projectRepository.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({
      mirrorState: 'ready',
      lastFetchedSha: SHA,
      providerRepoId: '7',
      defaultBranch: 'trunk',
      secretsFound: [{ path: 'config/prod.env', rule: 'gitleaks' }],
      ciPaths: ['ci/pipeline.yml'],
    })
    const fetched = run.fetch.mock.calls[0]![0] as unknown as {
      remote: { pin: unknown; cloneUrl: string }
      branches: string[]
    }
    expect(fetched.remote.pin).toEqual({ host: 'gitlab.example.ru', address: '203.0.113.7' })
    expect(fetched.branches).toEqual(['trunk'])
  })

  it('a private or missing link is `unreachable` (REPO_LINK_PRIVATE), nothing is fetched', async () => {
    const own = await owner()
    const id = await linkRepository(own)
    const run = jobs({ getRepository: async () => null })
    await run.jobs.attachRepository(id)
    expect((await db.projectRepository.findUniqueOrThrow({ where: { id } })).mirrorState).toBe(
      'unreachable',
    )
    expect(run.fetch).not.toHaveBeenCalled()
  })

  it('a repository too large at the provider or in the fetch is `too_large`', async () => {
    const own = await owner()
    const conn = await tokenConnection(own, { state: 'ok' })
    const id = await linkRepository(own, conn)
    const huge = jobs({ getRepository: async () => info({ sizeBytes: 2 * 1024 ** 3 }) })
    await huge.jobs.attachRepository(id)
    expect((await db.projectRepository.findUniqueOrThrow({ where: { id } })).mirrorState).toBe(
      'too_large',
    )
    expect(huge.fetch).not.toHaveBeenCalled()
    const pack = jobs({
      getRepository: async () => info(),
      issueCredentials: async () => ({
        auth: { kind: 'bearer', token: 'synthetic-token' },
        basic: { username: 'oauth2', password: 'synthetic-token' },
        expiresAt: new Date(Date.now() + 60_000),
      }),
    })
    pack.fetch.mockRejectedValueOnce(repositoryTooLarge())
    await db.projectRepository.update({ where: { id }, data: { mirrorState: 'syncing' } })
    await pack.jobs.attachRepository(id)
    const row = await db.projectRepository.findUniqueOrThrow({ where: { id } })
    expect(row.mirrorState).toBe('too_large')
    // By a connection, the branch the client chose is fetched, not the provider's default.
    expect((pack.fetch.mock.calls[0]![0] as unknown as { branches: string[] }).branches).toEqual([
      'develop',
    ])
  })

  it('a repository of a connection that is not `ok` is not fetched', async () => {
    const own = await owner()
    const conn = await tokenConnection(own, { state: 'reauth_needed' })
    const id = await linkRepository(own, conn)
    const run = jobs({})
    await run.jobs.attachRepository(id)
    expect((await db.projectRepository.findUniqueOrThrow({ where: { id } })).mirrorState).toBe(
      'failed',
    )
    expect(run.calls).toEqual([])
  })
})

describe('ownCiPath', () => {
  it('keeps a file of the repository, never another project or an address', () => {
    expect(ownCiPath('ci/pipeline.yml')).toBe('ci/pipeline.yml')
    for (const value of [
      null,
      '',
      '.gitlab-ci.yml@group/other',
      'https://evil.example/ci.yml',
      '/abs.yml',
      '../up.yml',
      'a//b.yml',
    ])
      expect(ownCiPath(value)).toBeNull()
  })
})
