import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { Context } from '../trpc.ts'

const now = new Date('2026-10-10T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна Иванова',
  lastName: null,
  email: 'site-page-test@example.ru',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const siteId = randomUUID()
const row = {
  id: siteId,
  name: 'Кофейня «Крошка»',
  url: 'https://xn--e1aiboc0b6e.xn--p1ai',
  stack: 'wordpress',
  status: 'active',
  createdAt: now,
}

/**
 * A site from before the wizard: no stage of its first import, no first version — and its
 * repository, as a connected site has one.
 */
const legacy = { provisioningStages: [], initialVersion: null, gitRepositories: [{ id: 'repo' }] }

const sessionOf = (userId: string) => ({
  id: randomUUID(),
  userId,
  token: `site-page-test-${randomUUID()}`,
  expiresAt: new Date('2030-01-01'),
  createdAt: now,
  updatedAt: now,
})

function setup(currentUser: User | null = user) {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: { findFirst: vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue(null) },
  }
  const context: Context = {
    prisma: db as unknown as PrismaClient,
    headers: new Headers(),
    user: currentUser,
    session: currentUser
      ? {
          id: randomUUID(),
          userId: currentUser.id,
          token: 'site-page-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: now,
          updatedAt: now,
        }
      : null,
    billing: null,
  }
  return { db, caller: createCaller(context) }
}

describe('project.get', () => {
  it('returns the site with its readable host and whether an operation holds it', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({ ...row, ...legacy, lease: null })
    await expect(caller.project.get({ id: siteId })).resolves.toEqual({
      ...row,
      host: 'кофейня.рф',
      state: 'free',
      // A site from before the wizard lives as it did.
      setup: null,
      initialVersion: null,
      // No browser is set up in this context: the repository alone.
      capabilities: { repository: 'ready', browser: 'not_configured' },
    })
  })

  const imported = { tag: 'v0.0.0', commitSha: 'a'.repeat(40), importedAt: now }
  it.each([
    ['queued', 'pending', { ...imported, importedAt: null }, null],
    ['running', 'pending', null, null],
    ['failed', 'failed', null, null],
    ['succeeded', 'done', imported, imported],
  ] as const)(
    'tells the setup of a site whose first import is %s, and its first version once confirmed',
    async (status, setupState, stored, initialVersion) => {
      const { db, caller } = setup()
      db.site.findFirst.mockResolvedValue({
        ...row,
        lease: null,
        provisioningStages: [{ status }],
        initialVersion: stored,
        gitRepositories: [],
      })
      await expect(caller.project.get({ id: siteId })).resolves.toMatchObject({
        setup: setupState,
        initialVersion,
      })
    },
  )

  it('looks the site up only among the workspaces the user is a member of', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({ ...row, ...legacy, lease: null })
    await caller.project.get({ id: siteId })
    expect(db.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: siteId, workspace: { members: { some: { userId: user.id } } } },
      }),
    )
  })

  it('answers «not found» for a site of someone else and for one that does not exist', async () => {
    const { caller } = setup()
    await expect(caller.project.get({ id: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Не нашли то, что вы ищете',
    })
  })

  const free = { operation: null, expiresAt: null, heldForOperator: false, inflightMcpCallId: null }
  const expired = { ...free, operation: 'turn', expiresAt: new Date('2000-01-01') }
  it.each([
    [
      'a running operation',
      { ...free, operation: 'turn', expiresAt: new Date('2999-01-01') },
      'busy',
    ],
    ['an operation without an expiry', { ...free, operation: 'deploy' }, 'busy'],
    ['a hold after an unknown outcome', { ...free, heldForOperator: true }, 'held'],
    // The barrier of an unconfirmed content write outlives the lease that set it.
    [
      'an unconfirmed write under an expired lease',
      { ...expired, inflightMcpCallId: 'call' },
      'held',
    ],
    ['an expired lease', expired, 'free'],
    ['a free lease row', free, 'free'],
  ] as const)('reports %s', async (_name, lease, state) => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({ ...row, ...legacy, lease })
    await expect(caller.project.get({ id: siteId })).resolves.toMatchObject({ state })
  })

  it('rejects an id that is not a UUID before reading', async () => {
    const { db, caller } = setup()
    await expect(caller.project.get({ id: '1 OR 1=1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })

  it('requires a session and the mandatory consents', async () => {
    const anonymous = setup(null)
    await expect(anonymous.caller.project.get({ id: siteId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await expect(anonymous.caller.project.credentials({ id: siteId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    const noConsents = setup()
    noConsents.db.userConsent.findMany.mockResolvedValue([])
    await expect(noConsents.caller.project.get({ id: siteId })).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })
    expect(noConsents.db.site.findFirst).not.toHaveBeenCalled()
  })
})

describe('project.credentials', () => {
  it('lists kind, version and date and nothing that leads to the secret', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({
      credentialRefs: [
        // A careless select must not leak: the output schema strips what it does not name.
        { kind: 'wp', keyVersion: 2, updatedAt: now, vaultPath: `kv/sites/${siteId}/wp`, id: 'x' },
      ],
    })
    const result = await caller.project.credentials({ id: siteId })
    expect(result).toEqual([{ kind: 'wp', version: 2, updatedAt: now }])
    expect(JSON.stringify(result)).not.toContain('kv/sites')
  })

  it('does not select the Vault path at all', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({ credentialRefs: [] })
    await expect(caller.project.credentials({ id: siteId })).resolves.toEqual([])
    const query = JSON.stringify(db.site.findFirst.mock.calls[0])
    expect(query).not.toContain('vaultPath')
    // Only the accesses of the site itself: never a git, model or subscription credential.
    expect(query).toContain('"in":["ssh","ftp","wp","browser","db"]')
    expect(db.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: siteId, workspace: { members: { some: { userId: user.id } } } },
      }),
    )
  })

  it('answers «not found» for a site the user cannot open', async () => {
    const { caller } = setup()
    await expect(caller.project.credentials({ id: siteId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the page of a site and whose it is', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    const owned = { createdById: { in: ids } }
    await db.credentialRef.deleteMany({ where: { workspace: owned } })
    await db.site.deleteMany({ where: { workspace: owned } })
    await db.workspace.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function account() {
    const person = await db.user.create({
      data: { name: 'Site page verification', email: `${randomUUID()}@site-page.example.ru` },
    })
    userIds.push(person.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({
        ...consent,
        userId: person.id,
        source: 'sign_up',
      })),
    })
    const session = { ...sessionOf(person.id) }
    const caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user: person,
      session,
      billing: null,
    })
    return { person, caller }
  }

  async function siteOf(ownerId: string, memberIds: string[] = []) {
    const workspace = await db.workspace.create({
      data: {
        name: 'Мои проекты',
        createdById: ownerId,
        dataClass: 'synthetic',
        members: {
          create: [
            { userId: ownerId, role: 'owner' },
            ...memberIds.map((userId) => ({ userId, role: 'member' as const })),
          ],
        },
      },
    })
    const created = await db.site.create({
      data: {
        name: 'Кофейня',
        url: `https://${randomUUID()}.example.ru`,
        stack: 'wordpress',
        workspaceId: workspace.id,
      },
    })
    for (const kind of ['wp', 'git'] as const) {
      await db.credentialRef.create({
        data: {
          kind,
          workspaceId: workspace.id,
          siteId: created.id,
          vaultPath: `kv/sites/${created.id}/${kind}`,
          keyVersion: 3,
        },
      })
    }
    return created
  }

  it('shows the site and its accesses to the owner and to a member of the workspace', async () => {
    const owner = await account()
    const member = await account()
    const created = await siteOf(owner.person.id, [member.person.id])
    for (const { caller } of [owner, member]) {
      await expect(caller.project.get({ id: created.id })).resolves.toMatchObject({
        id: created.id,
        state: 'free',
        setup: null,
        initialVersion: null,
      })
      const accesses = await caller.project.credentials({ id: created.id })
      // The git credential of the repository is not an access of the site.
      expect(accesses.map((access) => [access.kind, access.version])).toEqual([['wp', 3]])
      expect(JSON.stringify(accesses)).not.toContain('kv/sites')
    }
  })

  it('answers a stranger exactly as it answers for a site that does not exist', async () => {
    const owner = await account()
    const stranger = await account()
    const created = await siteOf(owner.person.id)
    const refusals = await Promise.all(
      [created.id, randomUUID()].flatMap((id) => [
        stranger.caller.project.get({ id }).catch((error: unknown) => error),
        stranger.caller.project.credentials({ id }).catch((error: unknown) => error),
      ]),
    )
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'NOT_FOUND', message: 'Не нашли то, что вы ищете' })
    }
  })
})
