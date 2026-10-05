import { randomUUID } from 'node:crypto'

import { createPrismaClient, Prisma, type PrismaClient, type User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { Context } from '../trpc.ts'
import { MAX_SITES_PER_USER } from './project.ts'

const now = new Date('2026-09-30T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна Иванова',
  lastName: null,
  email: 'project-test@example.ru',
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
const input = { name: 'Мой сайт', url: 'https://example.ru', stack: 'wordpress' } as const

beforeEach(() => vi.stubEnv('APP_ENV', 'test'))
afterEach(() => vi.unstubAllEnvs())

function context(prisma: PrismaClient, currentUser: User | null = user): Context {
  return {
    prisma,
    headers: new Headers(),
    user: currentUser,
    session: currentUser
      ? {
          id: randomUUID(),
          userId: currentUser.id,
          token: 'project-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: now,
          updatedAt: now,
        }
      : null,
  }
}

function fakeDb() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: user.id }]),
    site: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: typeof input }) => ({
        ...data,
        id: randomUUID(),
        status: 'onboarding',
        createdAt: now,
      })),
    },
    workspace: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: randomUUID() }),
    },
  }
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: { findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (db: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  return { db, tx, prisma: db as unknown as PrismaClient }
}

describe('project input and access', () => {
  it.each([
    ['production', 'test', 'client'],
    ['test', 'production', 'synthetic'],
    ['development', 'production', 'synthetic'],
  ] as const)(
    'classifies APP_ENV=%s independently of NODE_ENV=%s',
    async (appEnv, nodeEnv, dataClass) => {
      vi.stubEnv('APP_ENV', appEnv)
      vi.stubEnv('NODE_ENV', nodeEnv)
      const { prisma, tx } = fakeDb()
      await createCaller(context(prisma)).project.create(input)
      expect(tx.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dataClass }),
        }),
      )
    },
  )

  it.each([undefined, '', 'prod'])(
    'refuses a missing or invalid APP_ENV (%s) before writing',
    async (appEnv) => {
      vi.stubEnv('APP_ENV', appEnv)
      const { prisma, db } = fakeDb()
      await expect(createCaller(context(prisma)).project.create(input)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      })
      expect(db.$transaction).not.toHaveBeenCalled()
    },
  )

  it('requires authentication before reading projects or creating a workspace', async () => {
    const { prisma, db } = fakeDb()
    const caller = createCaller(context(prisma, null))
    await expect(caller.project.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(caller.project.create(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.site.findMany).not.toHaveBeenCalled()
  })

  it('requires current mandatory consents for both procedures', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    const caller = createCaller(context(prisma))
    await expect(caller.project.list()).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    await expect(caller.project.create(input)).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.site.findMany).not.toHaveBeenCalled()
  })

  it.each([
    [' HTTPS://EXAMPLE.RU:443/ ', 'https://example.ru'],
    ['http://example.ru:80/', 'http://example.ru'],
    ['https://пример.рф/', 'https://xn--e1afmkfd.xn--p1ai'],
    ['https://example.ru./', 'https://example.ru'],
    ['https://example.ru:8443', 'https://example.ru:8443'],
  ])('normalizes %s and trims the project name', async (url, normalized) => {
    const { prisma } = fakeDb()
    const result = await createCaller(context(prisma)).project.create({
      ...input,
      name: '  Студия  ',
      url,
    })
    expect(result).toMatchObject({ name: 'Студия', url: normalized, status: 'onboarding' })
    expect(Object.keys(result).sort()).toEqual([
      'createdAt',
      'host',
      'id',
      'name',
      'stack',
      'status',
      'url',
    ])
  })

  it.each([
    // What the removed decoder of the web app (lib/display-host.ts) showed for the same rows.
    ['https://xn--80ak6aa92e.xn--p1ai', 'аррӏе.рф'],
    ['https://xn--d1acpjx3f.xn--p1ai', 'яндекс.рф'],
    ['https://example.ru:8443', 'example.ru:8443'],
    ['https://xn--80aairftm.xn--e1aiboc0b6e.xn--p1ai:8443', 'магазин.кофейня.рф:8443'],
    ['https://shop.xn--80akhbyknj4f.xn--p1ai', 'shop.испытание.рф'],
    ['https://xn--bcher-kva.example', 'bücher.example'],
    ['https://example.ru', 'example.ru'],
    ['http://localhost:8080', 'localhost:8080'],
    ['http://192.168.1.10', '192.168.1.10'],
    ['http://[::1]:8080', '[::1]:8080'],
    // A label that is not Punycode and a row that is not an address stay as stored.
    ['https://xn--a-.example.ru', 'xn--a-.example.ru'],
    ['https://xn--999999999999.ru', 'xn--999999999999.ru'],
    ['not an address', 'not an address'],
  ])('lists the site %s with the host its owner reads: %s', async (url, host) => {
    const { prisma, db } = fakeDb()
    db.site.findMany.mockResolvedValue([
      { id: randomUUID(), name: 'Сайт', url, stack: 'wordpress', status: 'active', createdAt: now },
    ])
    const [project] = await createCaller(context(prisma)).project.list()
    expect(project).toMatchObject({ url, host })
  })

  it('returns the readable host of a created site and stores its ASCII address', async () => {
    const { prisma, tx } = fakeDb()
    const created = await createCaller(context(prisma)).project.create({
      ...input,
      url: 'https://Кофейня.рф:8443/',
    })
    expect(created).toMatchObject({
      url: 'https://xn--e1aiboc0b6e.xn--p1ai:8443',
      host: 'кофейня.рф:8443',
    })
    // `host` is derived for the answer only: the row has no such column.
    expect(tx.site.create.mock.calls[0]![0].data).not.toHaveProperty('host')
  })

  describe.each(['production', 'development', 'test'] as const)('with APP_ENV=%s', (appEnv) => {
    beforeEach(() => vi.stubEnv('APP_ENV', appEnv))

    it.each([
      'example.ru',
      'ftp://example.ru',
      'javascript:alert(1)',
      'https://user:password@example.ru',
      'https://example.ru/admin',
      'https://example.ru/a/..',
      'https://example.ru/%2e%2e',
      'https://example.ru/?',
      'https://example.ru#',
      'https://example.ru?token=secret',
      'https://example.ru\\admin',
      'https://exa\nmple.ru',
      'http://localhost/wp-admin',
      'http://user:password@localhost',
      // Never a site: unspecified, link-local (cloud metadata), shared, multicast, reserved.
      'http://0.0.0.0',
      'http://169.254.169.254',
      'http://100.64.0.1',
      'http://224.0.0.1',
      'http://255.255.255.255',
      'http://[::]',
      'http://[fe80::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[2001:db8::1]',
      'http://host.invalid',
      'http://site.onion',
      'http://-host',
    ])('rejects a non-origin URL or a reserved host: %s', async (url) => {
      const { prisma, db } = fakeDb()
      await expect(
        createCaller(context(prisma)).project.create({ ...input, url }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(db.$transaction).not.toHaveBeenCalled()
    })
  })

  const localOrigins = [
    ['http://localhost', 'http://localhost'],
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['http://host.localhost', 'http://host.localhost'],
    ['http://host.docker.internal:8080', 'http://host.docker.internal:8080'],
    ['http://wordpress', 'http://wordpress'],
    ['http://wordpress.test', 'http://wordpress.test'],
    ['http://printer.local', 'http://printer.local'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://127.1', 'http://127.0.0.1'],
    ['http://0x7f000001', 'http://127.0.0.1'],
    ['http://10.0.0.1', 'http://10.0.0.1'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://192.168.1.1', 'http://192.168.1.1'],
    ['http://[::1]', 'http://[::1]'],
    ['http://[fc00::1]:8080', 'http://[fc00::1]:8080'],
  ] as const

  it.each(localOrigins)(
    'refuses the local or private address %s in production with its own text',
    async (url) => {
      vi.stubEnv('APP_ENV', 'production')
      const { prisma, db } = fakeDb()
      await expect(
        createCaller(context(prisma)).project.create({ ...input, url }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Укажите адрес сайта, который открывается из интернета',
        cause: { code: 'SITE_ADDRESS_NOT_PUBLIC' },
      })
      expect(db.$transaction).not.toHaveBeenCalled()
    },
  )

  describe.each(['development', 'test'] as const)('with APP_ENV=%s', (appEnv) => {
    it.each(localOrigins)(
      'accepts the local or private address %s for a local site',
      async (url, normalized) => {
        vi.stubEnv('APP_ENV', appEnv)
        const { prisma, tx } = fakeDb()
        await expect(
          createCaller(context(prisma)).project.create({ ...input, url }),
        ).resolves.toMatchObject({ url: normalized, status: 'onboarding' })
        // A local site never lands in a workspace cleared for real client data.
        expect(tx.workspace.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ dataClass: 'synthetic' }) }),
        )
      },
    )
  })

  it.each([
    { name: '   ' },
    { name: 'x'.repeat(256) },
    { name: 'Мой\u0000сайт' },
    { name: 'Мой\nсайт' },
    { name: 'Мой\u009bсайт' },
    { stack: 'unknown' },
    { workspaceId: randomUUID() },
    { status: 'active' },
  ])('rejects invalid fields or client-selected ownership: %o', async (overrides) => {
    const { prisma, db } = fakeDb()
    await expect(
      createCaller(context(prisma)).project.create({ ...input, ...overrides } as typeof input),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('stops at the site ceiling of one user before writing', async () => {
    const { prisma, tx } = fakeDb()
    tx.site.count.mockResolvedValue(MAX_SITES_PER_USER)
    await expect(createCaller(context(prisma)).project.create(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Вы добавили максимальное число сайтов. Напишите нам, если нужно больше',
      cause: { code: 'PROJECT_LIMIT_REACHED' },
    })
    expect(tx.site.count).toHaveBeenCalledExactlyOnceWith({
      where: { workspace: { createdById: user.id } },
    })
    expect(tx.workspace.create).not.toHaveBeenCalled()
    expect(tx.site.create).not.toHaveBeenCalled()

    tx.site.count.mockResolvedValue(MAX_SITES_PER_USER - 1)
    await expect(createCaller(context(prisma)).project.create(input)).resolves.toMatchObject({
      url: input.url,
    })
  })

  it('serializes on the user row without blocking writes that reference the user', async () => {
    const { prisma, tx } = fakeDb()
    await createCaller(context(prisma)).project.create(input)
    const [sql] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray]
    expect(sql.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM users WHERE id = ?::uuid FOR NO KEY UPDATE',
    )
  })

  it('maps a unique constraint conflict to a useful Russian error', async () => {
    const { prisma, tx } = fakeDb()
    tx.site.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    await expect(createCaller(context(prisma)).project.create(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Сайт с таким адресом уже добавлен',
      cause: { code: 'PROJECT_ALREADY_EXISTS' },
    })
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL project ownership and concurrency', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    const owned = { createdById: { in: ids } }
    await db.site.deleteMany({ where: { workspace: owned } })
    await db.workspace.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function account() {
    const owner = await db.user.create({
      data: { name: 'Project verification', email: `${randomUUID()}@projects.example.ru` },
    })
    userIds.push(owner.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({
        ...consent,
        userId: owner.id,
        source: 'sign_up',
      })),
    })
    return { user: owner, caller: createCaller(context(db, owner)) }
  }

  it('creates a single personal workspace with one owner for concurrent distinct sites', async () => {
    const { user: owner, caller } = await account()
    const projects = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        caller.project.create({ ...input, url: `https://site-${index}.example.ru` }),
      ),
    )
    expect(projects).toHaveLength(5)
    const workspaces = await db.workspace.findMany({
      where: { createdById: owner.id },
      include: { members: true, sites: true },
    })
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({
      dataClass: 'synthetic',
      members: [{ userId: owner.id, role: 'owner' }],
    })
    expect(workspaces[0]!.sites).toHaveLength(5)
    expect((await caller.project.list()).map((project) => project.id).sort()).toEqual(
      projects.map((project) => project.id).sort(),
    )
  })

  it('creates exactly one site for simultaneous submissions of the same normalized origin', async () => {
    const { user: owner, caller } = await account()
    const results = await Promise.allSettled([
      caller.project.create(input),
      caller.project.create({ ...input, url: 'https://EXAMPLE.ru:443/' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'CONFLICT' } })
    expect(await caller.project.list()).toHaveLength(1)
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(1)
  })

  it('does not wait for an uncommitted write that references the user', async () => {
    const { user: owner, caller } = await account()
    let pending: Promise<unknown> = Promise.resolve()
    const outcome = await db.$transaction(async (holder) => {
      // What an INSERT with a foreign key to users (a session, a consent) holds until commit.
      await holder.$queryRaw`SELECT 1 FROM users WHERE id = ${owner.id}::uuid FOR KEY SHARE`
      pending = caller.project.create(input)
      return Promise.race([
        pending.then(
          () => 'created',
          () => 'failed',
        ),
        new Promise<string>((resolve) => setTimeout(resolve, 1500, 'blocked')),
      ])
    })
    await pending.catch(() => undefined)
    expect(outcome).toBe('created')
  })

  it('counts the site ceiling under the user lock for concurrent submissions', async () => {
    const { user: owner, caller } = await account()
    const first = await caller.project.create(input)
    const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: first.id } })
    await db.site.createMany({
      data: Array.from({ length: MAX_SITES_PER_USER - 3 }, (_, index) => ({
        workspaceId,
        name: 'Filler',
        url: `https://filler-${index}.example.ru`,
        stack: 'wordpress' as const,
        status: 'onboarding' as const,
      })),
    })

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        caller.project.create({ ...input, url: `https://last-${index}.example.ru` }),
      ),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    for (const result of results.filter((result) => result.status === 'rejected')) {
      expect(result).toMatchObject({ reason: { cause: { code: 'PROJECT_LIMIT_REACHED' } } })
    }
    expect(await db.site.count({ where: { workspace: { createdById: owner.id } } })).toBe(
      MAX_SITES_PER_USER,
    )
  })

  it('isolates other users sites and does not disclose their duplicate URLs', async () => {
    const first = await account()
    const second = await account()
    const projectA = await first.caller.project.create(input)
    expect(await second.caller.project.list()).toEqual([])
    const projectB = await second.caller.project.create(input)
    expect(projectB.id).not.toBe(projectA.id)
    expect(await first.caller.project.list()).toEqual([projectA])
    expect(await second.caller.project.list()).toEqual([projectB])
  })

  it('lists shared sites only while membership exists and never creates into that workspace', async () => {
    const first = await account()
    const second = await account()
    const shared = await first.caller.project.create(input)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: first.user.id } })
    const member = await db.member.create({
      data: { workspaceId: workspace.id, userId: second.user.id, role: 'member' },
    })
    expect(await second.caller.project.list()).toEqual([shared])
    await expect(second.caller.project.create(input)).rejects.toMatchObject({ code: 'CONFLICT' })
    const own = await second.caller.project.create({ ...input, url: 'https://own.example.ru' })
    expect(await db.site.findUniqueOrThrow({ where: { id: own.id } })).not.toMatchObject({
      workspaceId: workspace.id,
    })
    await db.member.delete({ where: { id: member.id } })
    expect(await second.caller.project.list()).toEqual([own])
  })

  it('does not treat a shared owner workspace or revoked owner membership as personal', async () => {
    const first = await account()
    const second = await account()
    await first.caller.project.create(input)
    const original = await db.workspace.findFirstOrThrow({ where: { createdById: first.user.id } })
    await db.member.create({
      data: { workspaceId: original.id, userId: second.user.id, role: 'member' },
    })
    const project = await first.caller.project.create({
      ...input,
      url: 'https://private.example.ru',
    })
    const site = await db.site.findUniqueOrThrow({ where: { id: project.id } })
    expect(site.workspaceId).not.toBe(original.id)
    await db.member.updateMany({
      where: { workspaceId: site.workspaceId },
      data: { role: 'member' },
    })
    const next = await first.caller.project.create({ ...input, url: 'https://next.example.ru' })
    const nextSite = await db.site.findUniqueOrThrow({ where: { id: next.id } })
    expect(nextSite.workspaceId).not.toBe(site.workspaceId)
    expect(nextSite.workspaceId).not.toBe(original.id)
  })
})
