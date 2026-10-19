import { randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  ensurePersonalWorkspace,
  Prisma,
  type PrismaClient,
  type User,
} from '@repo/db'
import { legalDocuments, siteConnectionLimits, type SiteConnectionServices } from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import { resetSiteConnectionGate } from '../services/site-connection-gate.ts'
import {
  createdProject,
  deleteSiteConnectionRows,
  fakeSiteConnections,
  finishImports,
  siteCreateInput,
} from '../testing/site-connections.ts'
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
const SITE_URL = 'https://example.ru'
/** A valid request of `project.create` with a key of its own: every call is another request. */
const input = (overrides: Parameters<typeof siteCreateInput>[0] = {}) => siteCreateInput(overrides)

// The limits of the checks count per process: every test starts with all of them.
beforeEach(() => {
  resetSiteConnectionGate()
  // The orphaned secrets of a refused creation are logged; the tests that care spy on it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function context(
  prisma: PrismaClient,
  currentUser: User | null = user,
  siteConnections: SiteConnectionServices | null = fakeSiteConnections().services,
): Context {
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
    billing: null,
    siteConnections,
  }
}

/** The services of an environment; in production a name must resolve to a public address. */
const servicesOf = (appEnv: 'production' | 'development' | 'test') =>
  fakeSiteConnections({ appEnv, address: appEnv === 'production' ? '203.0.113.10' : '127.0.0.1' })
    .services

/**
 * The client outside the transaction answers the read-only checks before it: no site, no workspace,
 * nothing in progress. The transaction client is what the tests below give a tariff, a ceiling or a
 * duplicate: what `project.create` decides under the lock of the user's row.
 */
function fakeDb() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: user.id }]),
    site: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        status: 'onboarding',
        createdAt: now,
      })),
    },
    workspace: {
      // The personal workspace is looked up by its creator: none unless a test gives one. The
      // gift of the registration then asks, by the id, whether the user owns the workspace.
      findFirst: vi.fn<(query: { where: { id?: string } }) => Promise<{ id: string } | null>>(
        async ({ where }) => (where.id === undefined ? null : { id: where.id }),
      ),
      create: vi.fn().mockResolvedValue({ id: randomUUID() }),
    },
    // The gift of the registration stands in the ledger already: it is asked for by the key of
    // the user and nothing is written. What it writes is checked on PostgreSQL below.
    creditLedger: {
      findUnique: vi.fn().mockResolvedValue({ kind: 'grant', unit: 'credit_gift' }),
    },
    // No tariff unless a test gives the workspace one.
    subscription: {
      findFirst: vi
        .fn<
          () => Promise<{
            plan: { maxSites: number | null }
            nextPlan: { maxSites: number | null } | null
          } | null>
        >()
        .mockResolvedValue(null),
    },
    // No unfinished checkout of a tariff unless a test starts one.
    order: {
      findFirst: vi
        .fn<() => Promise<{ plan: { maxSites: number | null } | null } | null>>()
        .mockResolvedValue(null),
    },
    siteCreationClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    siteProvisioningStage: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    },
    credentialRef: {
      create: vi.fn(async () => ({ id: randomUUID() })),
    },
    siteCodeSource: { create: vi.fn().mockResolvedValue({}) },
    siteDatabase: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: {
      findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    workspace: { findFirst: vi.fn().mockResolvedValue(null) },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    siteProvisioningStage: { count: vi.fn().mockResolvedValue(0) },
    // The claim of the site id is taken, and given back on every way out but the commit.
    $queryRaw: vi.fn().mockResolvedValue([{ token: 'claimed' }]),
    siteCreationClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
    'classifies the environment %s of the site connections independently of NODE_ENV=%s and of process.env',
    async (appEnv, nodeEnv, dataClass) => {
      // The procedure reads the environment the app gave its services, never the process.
      vi.stubEnv('APP_ENV', appEnv === 'production' ? 'test' : 'production')
      vi.stubEnv('NODE_ENV', nodeEnv)
      const { prisma, tx } = fakeDb()
      await createCaller(context(prisma, user, servicesOf(appEnv))).project.create(input())
      expect(tx.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dataClass }),
        }),
      )
    },
  )

  it.each([null, undefined])(
    'refuses with its own text when web has no site connections (%s), before reading or writing',
    async (siteConnections) => {
      const { prisma, db, tx } = fakeDb()
      const ctx = { ...context(prisma), siteConnections }
      await expect(createCaller(ctx).project.create(input())).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Подключение сайтов сейчас недоступно. Попробуйте ещё раз немного позже',
        cause: { code: 'SITE_CONNECTION_UNAVAILABLE' },
      })
      expect(db.site.findUnique).not.toHaveBeenCalled()
      expect(db.$queryRaw).not.toHaveBeenCalled()
      expect(db.$transaction).not.toHaveBeenCalled()
      expect(tx.site.create).not.toHaveBeenCalled()
    },
  )

  it('requires authentication before reading projects or creating a workspace', async () => {
    const { prisma, db } = fakeDb()
    const caller = createCaller(context(prisma, null))
    await expect(caller.project.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(caller.project.create(input())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.site.findMany).not.toHaveBeenCalled()
  })

  it('requires current mandatory consents for both procedures', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    const caller = createCaller(context(prisma))
    await expect(caller.project.list()).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    await expect(caller.project.create(input())).rejects.toMatchObject({
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
    const result = await createdProject(
      createCaller(context(prisma)).project.create(input({ name: '  Студия  ', url })),
    )
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
      {
        id: randomUUID(),
        name: 'Сайт',
        url,
        stack: 'wordpress',
        status: 'active',
        createdAt: now,
        provisioningStages: [],
      },
    ])
    const [project] = await createCaller(context(prisma)).project.list()
    expect(project).toMatchObject({ url, host })
  })

  it('returns the readable host of a created site and stores its ASCII address', async () => {
    const { prisma, tx } = fakeDb()
    const created = await createdProject(
      createCaller(context(prisma)).project.create(input({ url: 'https://Кофейня.рф:8443/' })),
    )
    expect(created).toMatchObject({
      url: 'https://xn--e1aiboc0b6e.xn--p1ai:8443',
      host: 'кофейня.рф:8443',
    })
    // `host` is derived for the answer only: the row has no such column.
    expect(tx.site.create.mock.calls[0]![0].data).not.toHaveProperty('host')
  })

  describe.each(['production', 'development', 'test'] as const)('with APP_ENV=%s', (appEnv) => {
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
        createCaller(context(prisma, user, servicesOf(appEnv))).project.create(input({ url })),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(db.site.findUnique).not.toHaveBeenCalled()
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
      const { prisma, db } = fakeDb()
      const connections = fakeSiteConnections({ appEnv: 'production', address: '203.0.113.10' })
      await expect(
        createCaller(context(prisma, user, connections.services)).project.create(input({ url })),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Укажите адрес сайта, который открывается из интернета',
        cause: { code: 'SITE_ADDRESS_NOT_PUBLIC' },
      })
      // Refused before any server is asked or any claim is taken.
      expect(connections.sourceChecks).toEqual([])
      expect(db.$queryRaw).not.toHaveBeenCalled()
      expect(db.$transaction).not.toHaveBeenCalled()
    },
  )

  describe.each(['development', 'test'] as const)('with APP_ENV=%s', (appEnv) => {
    it.each(localOrigins)(
      'accepts the local or private address %s for a local site',
      async (url, normalized) => {
        const { prisma, tx } = fakeDb()
        await expect(
          createCaller(context(prisma, user, servicesOf(appEnv))).project.create(input({ url })),
        ).resolves.toMatchObject({
          outcome: 'created',
          project: { url: normalized, status: 'onboarding' },
        })
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
    { id: randomUUID() },
    { requestKey: 'not-a-uuid' },
    { source: undefined },
    { database: undefined },
  ])('rejects invalid fields or client-selected ownership: %o', async (overrides) => {
    const { prisma, db } = fakeDb()
    await expect(
      createCaller(context(prisma)).project.create({ ...input(), ...overrides } as ReturnType<
        typeof input
      >),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('stops at the site ceiling of one user before writing', async () => {
    const { prisma, tx } = fakeDb()
    tx.site.count.mockResolvedValue(MAX_SITES_PER_USER)
    await expect(createCaller(context(prisma)).project.create(input())).rejects.toMatchObject({
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
    await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
      outcome: 'created',
      project: { url: SITE_URL },
    })
  })

  describe('the site limit of a tariff', () => {
    const WORKSPACE = randomUUID()
    const another = 'Чтобы добавить ещё один, выберите другой тариф в настройках'

    /** A user whose personal workspace has `sites` sites and a tariff for `maxSites`. */
    function subscribed(maxSites: number | null, sites: number) {
      const fake = fakeDb()
      fake.tx.workspace.findFirst.mockResolvedValue({ id: WORKSPACE })
      fake.tx.subscription.findFirst.mockResolvedValue({ plan: { maxSites }, nextPlan: null })
      fake.tx.site.count.mockResolvedValue(sites)
      return fake
    }

    it.each([
      [1, 1, `В ваш тариф входит один сайт. ${another}`],
      [3, 3, `В ваш тариф входит до 3 сайтов. ${another}`],
      // More sites than the tariff holds: they were added before it.
      [3, 7, `В ваш тариф входит до 3 сайтов. ${another}`],
    ])(
      'refuses a site beyond a tariff for %i with %i added and names the limit',
      async (maxSites, sites, message) => {
        const { prisma, tx } = subscribed(maxSites, sites)

        await expect(createCaller(context(prisma)).project.create(input())).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message,
          cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites } },
        })
        expect(tx.site.create).not.toHaveBeenCalled()
        expect(tx.workspace.create).not.toHaveBeenCalled()
      },
    )

    it('adds a site while the tariff has room, counting the sites of the personal workspace', async () => {
      const { prisma, tx } = subscribed(3, 2)

      await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
        outcome: 'created',
        project: { url: SITE_URL },
      })

      // A tariff whose payment is overdue is still a tariff; an ended one is none.
      expect(tx.subscription.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { workspaceId: WORKSPACE, status: { in: ['trial', 'active', 'past_due'] } },
        // The tariff that is on and the one chosen for the next period.
        select: {
          plan: { select: { maxSites: true } },
          nextPlan: { select: { maxSites: true } },
        },
      })
      // The unfinished order of a tariff is read first: a settlement that commits between the
      // two reads is seen by one of them.
      expect(tx.order.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { workspaceId: WORKSPACE, kind: 'subscription', status: 'pending' },
        select: { plan: { select: { maxSites: true } } },
      })
      expect(tx.order.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        tx.subscription.findFirst.mock.invocationCallOrder[0]!,
      )
      // The ceiling counts what the user created, the tariff what its workspace holds.
      expect(tx.site.count.mock.calls).toEqual([
        [{ where: { workspace: { createdById: user.id } } }],
        [{ where: { workspaceId: WORKSPACE } }],
      ])
      expect(tx.site.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ data: expect.objectContaining({ workspaceId: WORKSPACE }) }),
      )
    })

    it('leaves a user without a tariff to the ceiling alone', async () => {
      const { prisma, tx } = fakeDb()
      tx.workspace.findFirst.mockResolvedValue({ id: WORKSPACE })
      tx.site.count.mockResolvedValue(MAX_SITES_PER_USER - 1)

      await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
        outcome: 'created',
        project: { url: SITE_URL },
      })
      expect(tx.subscription.findFirst).toHaveBeenCalledOnce()
      // Without a tariff the sites of the workspace are not counted.
      expect(tx.site.count).toHaveBeenCalledOnce()
    })

    it('reports the ceiling before the tariff when both are reached', async () => {
      const { prisma, tx } = subscribed(15, MAX_SITES_PER_USER)

      await expect(createCaller(context(prisma)).project.create(input())).rejects.toMatchObject({
        cause: { code: 'PROJECT_LIMIT_REACHED' },
      })
      expect(tx.subscription.findFirst).not.toHaveBeenCalled()
    })

    it('does not limit a tariff whose plan names no number of sites', async () => {
      const { prisma, tx } = subscribed(null, 30)

      await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
        outcome: 'created',
        project: { url: SITE_URL },
      })
      expect(tx.site.count).toHaveBeenCalledOnce()
    })

    describe('while a tariff is being paid for', () => {
      const paying = 'В тариф, который вы оплачиваете,'

      /**
       * A user whose personal workspace has `sites` sites and an unfinished order of a tariff
       * for `unpaidMax`; `liveMax` — the tariff that is on, when there is one.
       */
      function payingFor(unpaidMax: number | null, sites: number, liveMax?: number) {
        const fake = fakeDb()
        fake.tx.workspace.findFirst.mockResolvedValue({ id: WORKSPACE })
        fake.tx.order.findFirst.mockResolvedValue({ plan: { maxSites: unpaidMax } })
        if (liveMax !== undefined) {
          fake.tx.subscription.findFirst.mockResolvedValue({
            plan: { maxSites: liveMax },
            nextPlan: null,
          })
        }
        fake.tx.site.count.mockResolvedValue(sites)
        return fake
      }

      /** The refusal of `project.create`, or a failure of the test when the site is added. */
      async function refusal(prisma: PrismaClient) {
        const outcome: unknown = await createCaller(context(prisma))
          .project.create(input())
          .then(
            () => null,
            (error: unknown) => error,
          )
        if (outcome === null) throw new Error('The site was added')
        return outcome as { code: string; message: string; cause: { details: unknown } }
      }

      it.each([
        [1, 1, `${paying} входит один сайт. ${another}`],
        [3, 3, `${paying} входит до 3 сайтов. ${another}`],
        // A checkout takes a tariff the sites just fit; more of them is a race it lost.
        [3, 4, `${paying} входит до 3 сайтов. ${another}`],
      ])(
        'refuses a site beyond a tariff for %i that is not paid yet, with %i added',
        async (maxSites, sites, message) => {
          const { prisma, tx } = payingFor(maxSites, sites)

          const error = await refusal(prisma)

          expect(error).toMatchObject({
            code: 'FORBIDDEN',
            message,
            cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' },
          })
          expect(error.cause.details).toEqual({ maxSites, unpaid: true })
          expect(tx.site.create).not.toHaveBeenCalled()
        },
      )

      it('adds a site while that tariff has room, counting the sites of the workspace', async () => {
        const { prisma, tx } = payingFor(3, 2)

        await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
          outcome: 'created',
          project: { url: SITE_URL },
        })
        expect(tx.site.count.mock.calls).toEqual([
          [{ where: { workspace: { createdById: user.id } } }],
          [{ where: { workspaceId: WORKSPACE } }],
        ])
      })

      it.each([
        // A renewal to a smaller tariff is being charged: the smaller one already limits.
        ['the smaller tariff that is being paid for', 1, 3, 1, { maxSites: 1, unpaid: true }],
        // A payment for a larger tariff does not lift the limit of the one that is on.
        ['the tariff that is on, when it is the smaller', 3, 1, 1, { maxSites: 1 }],
        ['the tariff that is on, when both take the same', 2, 2, 2, { maxSites: 2 }],
      ])('limits by %s', async (_case, unpaidMax, liveMax, sites, details) => {
        const { prisma, tx } = payingFor(unpaidMax, sites, liveMax)

        const error = await refusal(prisma)

        expect(error.cause.details).toEqual(details)
        expect(error.message.startsWith(paying)).toBe('unpaid' in details)
        expect(tx.site.create).not.toHaveBeenCalled()
      })

      it.each([
        ['names no number of sites', { plan: { maxSites: null } }],
        ['is gone', { plan: null }],
      ])('does not limit by an order whose plan %s', async (_case, order) => {
        const { prisma, tx } = fakeDb()
        tx.workspace.findFirst.mockResolvedValue({ id: WORKSPACE })
        tx.order.findFirst.mockResolvedValue(order)
        tx.site.count.mockResolvedValue(30)

        await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
          outcome: 'created',
          project: { url: SITE_URL },
        })
        // Nothing limits: the sites of the workspace are not counted.
        expect(tx.site.count).toHaveBeenCalledOnce()
      })
    })

    describe('while another tariff is chosen for the next period', () => {
      const chosen = 'В тариф, который вы выбрали на следующий период,'
      const takeBack =
        'Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках'

      /**
       * A user on a tariff for `liveMax` sites who chose a tariff for `scheduledMax` for the
       * next period, with `sites` sites; `unpaidMax` — an unfinished order of a tariff as well.
       */
      function scheduled(
        liveMax: number,
        scheduledMax: number | null,
        sites: number,
        unpaidMax?: number,
      ) {
        const fake = fakeDb()
        fake.tx.workspace.findFirst.mockResolvedValue({ id: WORKSPACE })
        fake.tx.subscription.findFirst.mockResolvedValue({
          plan: { maxSites: liveMax },
          nextPlan: { maxSites: scheduledMax },
        })
        if (unpaidMax !== undefined) {
          fake.tx.order.findFirst.mockResolvedValue({ plan: { maxSites: unpaidMax } })
        }
        fake.tx.site.count.mockResolvedValue(sites)
        return fake
      }

      const refusalOf = (prisma: PrismaClient) =>
        createCaller(context(prisma))
          .project.create(input())
          .then(
            () => {
              throw new Error('The site was added')
            },
            (error: unknown) =>
              error as { code: string; message: string; cause: { details: unknown } },
          )

      it.each([
        // «Агентство» today, «Старт» from the next period: the second site would not fit it.
        [15, 1, 1, `${chosen} входит один сайт. ${takeBack}`],
        [15, 3, 3, `${chosen} входит до 3 сайтов. ${takeBack}`],
        [15, 3, 5, `${chosen} входит до 3 сайтов. ${takeBack}`],
      ])(
        'refuses a site beyond the smaller tariff: %i today, %i chosen, %i added',
        async (liveMax, scheduledMax, sites, message) => {
          const { prisma, tx } = scheduled(liveMax, scheduledMax, sites)

          const error = await refusalOf(prisma)

          expect(error).toMatchObject({
            code: 'FORBIDDEN',
            message,
            cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' },
          })
          expect(error.cause.details).toEqual({ maxSites: scheduledMax, scheduled: true })
          expect(tx.site.create).not.toHaveBeenCalled()
        },
      )

      it('adds a site while the chosen tariff has room', async () => {
        const { prisma, tx } = scheduled(15, 3, 2)

        await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
          outcome: 'created',
          project: { url: SITE_URL },
        })
        expect(tx.site.create).toHaveBeenCalledOnce()
      })

      it.each([
        // A larger tariff from the next period does not lift the limit of today.
        ['the tariff that is on, when it is the smaller', 1, 15, undefined, 1, { maxSites: 1 }],
        ['the tariff that is on, when both take the same', 3, 3, undefined, 3, { maxSites: 3 }],
        [
          'the tariff that is being paid for, when it is the smallest',
          15,
          3,
          1,
          1,
          { maxSites: 1, unpaid: true },
        ],
        // The renewal to the chosen tariff is being charged: the choice cannot be taken back.
        [
          'the tariff that is being paid for, when it is the chosen one',
          15,
          1,
          1,
          1,
          { maxSites: 1, unpaid: true },
        ],
        [
          'the chosen tariff, when it is smaller than the one being paid for',
          15,
          1,
          3,
          1,
          { maxSites: 1, scheduled: true },
        ],
      ])('limits by %s', async (_case, liveMax, scheduledMax, unpaidMax, sites, details) => {
        const { prisma, tx } = scheduled(liveMax, scheduledMax, sites, unpaidMax)

        const error = await refusalOf(prisma)

        expect(error.cause.details).toEqual(details)
        expect(error.message.startsWith(chosen)).toBe('scheduled' in details)
        expect(tx.site.create).not.toHaveBeenCalled()
      })

      it('does not limit by a chosen tariff that names no number of sites', async () => {
        const { prisma, tx } = scheduled(3, null, 2)

        await expect(createCaller(context(prisma)).project.create(input())).resolves.toMatchObject({
          outcome: 'created',
          project: { url: SITE_URL },
        })
        expect(tx.site.create).toHaveBeenCalledOnce()
        // The tariff that is on still limits.
        const full = scheduled(3, null, 3)
        expect((await refusalOf(full.prisma)).cause.details).toEqual({ maxSites: 3 })
      })
    })
  })

  it('serializes on the user row without blocking writes that reference the user', async () => {
    const { prisma, tx } = fakeDb()
    await createCaller(context(prisma)).project.create(input())
    const [sql] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray]
    expect(sql.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM users WHERE id = ?::uuid FOR NO KEY UPDATE',
    )
  })

  it('asks for the gift of the registration once the workspace is known, before the site is written', async () => {
    const { prisma, tx } = fakeDb()
    await createCaller(context(prisma)).project.create(input())
    expect(tx.creditLedger.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { idempotencyKey: `user:${user.id}:signup-gift` },
    })
    const asked = tx.creditLedger.findUnique.mock.invocationCallOrder[0]!
    expect(tx.workspace.create.mock.invocationCallOrder[0]).toBeLessThan(asked)
    expect(asked).toBeLessThan(tx.site.create.mock.invocationCallOrder[0]!)
  })

  it('maps a unique constraint conflict to a useful Russian error', async () => {
    const { prisma, tx } = fakeDb()
    tx.site.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    await expect(createCaller(context(prisma)).project.create(input())).rejects.toMatchObject({
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
  const planIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    const owned = { createdById: { in: ids } }
    // What the creation wrote beside each site holds it with Restrict keys.
    const created = await db.workspace.findMany({ where: owned, select: { id: true } })
    await deleteSiteConnectionRows(
      db,
      created.map(({ id }) => id),
    )
    await db.site.deleteMany({ where: { workspace: owned } })
    // An order refers to its subscription, its workspace and its plan.
    await db.order.deleteMany({ where: { workspace: owned } })
    await db.subscription.deleteMany({ where: { workspace: owned } })
    // The first site grants the gift of the registration: its journal row, the credit accounts
    // of the workspace and the audit entry of the grant refer to the workspace.
    const workspaces = await db.workspace.findMany({ where: owned, select: { id: true } })
    const inWorkspaces = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.creditLedger.deleteMany({ where: { account: inWorkspaces } })
    await db.billingAccount.deleteMany({ where: inWorkspaces })
    await db.auditLog.deleteMany({ where: inWorkspaces })
    await db.workspace.deleteMany({ where: owned })
    await db.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } })
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

  const noGift = { workspaceIds: [], granted: [], balance: null, accounts: [], audit: [] }

  /**
   * The gift of the registration of a user as the database holds it: where the rows under the
   * key of the user stand and for how much, the gift account of those workspaces, the credit
   * accounts made with it and the audit entries of the grant.
   */
  async function giftOf(userId: string) {
    const rows = await db.creditLedger.findMany({
      where: { idempotencyKey: `user:${userId}:signup-gift` },
      include: { account: { select: { workspaceId: true, unit: true, balance: true } } },
    })
    const workspaceIds = [...new Set(rows.map((row) => row.account.workspaceId))]
    const accounts = await db.billingAccount.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { unit: true },
    })
    const audit = await db.auditLog.findMany({
      where: { workspaceId: { in: workspaceIds }, action: 'billing.gift.grant' },
      select: { meta: true },
    })
    return {
      workspaceIds,
      granted: rows.map((row) => row.amount.toFixed(2)),
      balance: rows[0]?.account.balance.toFixed(2) ?? null,
      accounts: accounts.map(({ unit }) => unit).sort(),
      audit: audit.map(({ meta }) => meta),
    }
  }

  it('creates a single personal workspace with one owner for concurrent distinct sites', async () => {
    const { user: owner, caller } = await account()
    // As many as one user may have importing at once.
    const count = siteConnectionLimits.connectionsInProgressPerUser
    const projects = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createdProject(caller.project.create(input({ url: `https://site-${index}.example.ru` }))),
      ),
    )
    expect(projects).toHaveLength(count)
    const workspaces = await db.workspace.findMany({
      where: { createdById: owner.id },
      include: { members: true, sites: true },
    })
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({
      dataClass: 'synthetic',
      members: [{ userId: owner.id, role: 'owner' }],
    })
    expect(workspaces[0]!.sites).toHaveLength(count)
    expect((await caller.project.list()).map((project) => project.id).sort()).toEqual(
      projects.map((project) => project.id).sort(),
    )
    // The requests that raced for the workspace granted its gift once.
    expect(await giftOf(owner.id)).toEqual({
      workspaceIds: [workspaces[0]!.id],
      granted: ['35.00'],
      balance: '35.00',
      accounts: ['credit_gift', 'credit_pack', 'credit_tariff'],
      audit: [{ userId: owner.id, credits: 35 }],
    })
  })

  it('grants the gift of the registration with the first site and never again', async () => {
    const { user: owner, caller } = await account()
    expect(await giftOf(owner.id)).toEqual(noGift)

    const first = await createdProject(caller.project.create(input()))
    const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: first.id } })
    const granted = {
      workspaceIds: [workspaceId],
      granted: ['35.00'],
      balance: '35.00',
      accounts: ['credit_gift', 'credit_pack', 'credit_tariff'],
      audit: [{ userId: owner.id, credits: 35 }],
    }
    expect(await giftOf(owner.id)).toEqual(granted)

    // More sites, a repeated address and a refused one change nothing about the gift.
    await caller.project.create(input({ url: 'https://second.example.ru' }))
    await expect(caller.project.create(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await giftOf(owner.id)).toEqual(granted)
  })

  it('leaves no workspace and no gift behind a first site that is refused', async () => {
    const { user: owner, caller } = await account()
    // The address is taken by a site in a workspace the user is a member of.
    const other = await account()
    const shared = await createdProject(other.caller.project.create(input()))
    const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: shared.id } })
    await db.member.create({ data: { workspaceId, userId: owner.id, role: 'member' } })

    await expect(caller.project.create(input())).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)
    expect(await giftOf(owner.id)).toEqual(noGift)
    // The site that goes through makes the workspace and grants the gift.
    await caller.project.create(input({ url: 'https://own.example.ru' }))
    expect((await giftOf(owner.id)).granted).toEqual(['35.00'])
  })

  it('grants the gift to a workspace that was made before it, at its next site', async () => {
    const { user: owner, caller } = await account()
    const legacy = await db.$transaction((tx) =>
      ensurePersonalWorkspace(tx, { userId: owner.id, appEnv: 'test' }),
    )
    expect(await giftOf(owner.id)).toEqual(noGift)

    await caller.project.create(input())

    expect(await giftOf(owner.id)).toMatchObject({
      workspaceIds: [legacy.id],
      granted: ['35.00'],
      balance: '35.00',
    })
  })

  it('creates exactly one site for simultaneous submissions of the same normalized origin', async () => {
    const { user: owner, caller } = await account()
    const results = await Promise.allSettled([
      caller.project.create(input()),
      caller.project.create(input({ url: 'https://EXAMPLE.ru:443/' })),
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
      pending = caller.project.create(input())
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
    const first = await createdProject(caller.project.create(input()))
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
        caller.project.create(input({ url: `https://last-${index}.example.ru` })),
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

  describe('the site limit of a tariff', () => {
    const periodStart = new Date('2026-09-18T09:00:00Z')

    /** A tariff for `maxSites` sites. It is not on sale: no list of tariffs shows it. */
    async function tariffFor(maxSites: number) {
      const plan = await db.plan.create({
        data: {
          slug: `project-test-${randomUUID()}`,
          name: 'Проверочный',
          kind: 'quota',
          price: '4900.00',
          creditsPerMonth: 30,
          tasksPerDay: 5,
          maxSites,
          isActive: false,
        },
      })
      planIds.push(plan.id)
      return plan
    }

    /** The personal workspace of the user, which exists once they have a site or a checkout. */
    const workspaceOf = (owner: User) =>
      db.$transaction((tx) => ensurePersonalWorkspace(tx, { userId: owner.id, appEnv: 'test' }))

    /** A tariff for `maxSites` sites in the personal workspace of the user. */
    async function subscribe(
      owner: User,
      maxSites: number,
      status: 'active' | 'past_due' | 'cancelled' | 'expired' = 'active',
    ) {
      const workspace = await workspaceOf(owner)
      const plan = await tariffFor(maxSites)
      const subscription = await db.subscription.create({
        data: {
          workspaceId: workspace.id,
          planId: plan.id,
          status,
          currentPeriodStart: periodStart,
          currentPeriodEnd: new Date('2026-10-18T09:00:00Z'),
          periodAnchor: periodStart,
        },
      })
      return { workspaceId: workspace.id, subscriptionId: subscription.id }
    }

    /**
     * An unfinished order of a tariff for `maxSites` sites, as a checkout leaves it while the
     * customer is on the payment page; `subscriptionId` makes it the charge of a renewal.
     */
    async function checkout(owner: User, maxSites: number, subscriptionId?: string) {
      const workspace = await workspaceOf(owner)
      const plan = await tariffFor(maxSites)
      const order = await db.order.create({
        data: {
          workspaceId: workspace.id,
          userId: owner.id,
          kind: 'subscription',
          planId: plan.id,
          amount: plan.price,
          status: 'pending',
          idempotenceKey: randomUUID(),
          ...(subscriptionId === undefined ? {} : { subscriptionId }),
        },
      })
      return { workspaceId: workspace.id, orderId: order.id, planId: plan.id }
    }

    const siteAt = (index: number) => input({ url: `https://site-${index}.example.ru` })
    const planLimit = (maxSites: number) => ({
      code: 'FORBIDDEN',
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites } },
    })

    it('adds sites up to the limit of the tariff and refuses the next one', async () => {
      const { user: owner, caller } = await account()
      // The tariff was paid before the first site: the site lands in the same workspace.
      const { workspaceId } = await subscribe(owner, 2)

      const first = await createdProject(caller.project.create(siteAt(1)))
      await caller.project.create(siteAt(2))
      await expect(caller.project.create(siteAt(3))).rejects.toMatchObject({
        ...planLimit(2),
        message:
          'В ваш тариф входит до 2 сайтов. Чтобы добавить ещё один, выберите другой тариф в настройках',
      })

      expect(await db.site.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
        workspaceId,
      })
      expect(await db.site.count({ where: { workspaceId } })).toBe(2)
      expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(1)
    })

    it('takes the gift back with a site the tariff refuses: it is written by the same transaction', async () => {
      const { user: owner, caller } = await account()
      // A workspace made before the gift, with a tariff for one site and that site on it: the
      // gift would be granted by the next site, and the limit of the tariff — the one refusal
      // that comes after the gift is asked for — refuses that site.
      const { workspaceId, subscriptionId } = await subscribe(owner, 1)
      await db.site.create({
        data: { workspaceId, name: 'Первый', url: siteAt(1).url, stack: 'wordpress' },
      })
      expect(await giftOf(owner.id)).toEqual(noGift)

      await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(planLimit(1))

      // Neither the grant, nor the accounts made for it, nor its audit entry outlived the refusal.
      expect(await giftOf(owner.id)).toEqual(noGift)
      expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(0)
      expect(
        await db.auditLog.count({ where: { workspaceId, action: 'billing.gift.grant' } }),
      ).toBe(0)
      expect(await db.site.count({ where: { workspaceId } })).toBe(1)

      // The site that goes through grants it: the same request, once the tariff has ended.
      await db.subscription.update({ where: { id: subscriptionId }, data: { status: 'cancelled' } })
      await caller.project.create(siteAt(2))
      expect(await giftOf(owner.id)).toMatchObject({
        workspaceIds: [workspaceId],
        granted: ['35.00'],
        balance: '35.00',
      })
    })

    it('counts a site of any status against the limit', async () => {
      const { user: owner, caller } = await account()
      const { workspaceId } = await subscribe(owner, 1)
      const first = await createdProject(caller.project.create(siteAt(1)))
      await db.site.update({ where: { id: first.id }, data: { status: 'archived' } })

      await expect(caller.project.create(siteAt(2))).rejects.toMatchObject({
        ...planLimit(1),
        message:
          'В ваш тариф входит один сайт. Чтобы добавить ещё один, выберите другой тариф в настройках',
      })
      expect(await db.site.count({ where: { workspaceId } })).toBe(1)
    })

    it('keeps the limit while the payment of the tariff is overdue', async () => {
      const { user: owner, caller } = await account()
      await subscribe(owner, 1, 'past_due')
      await caller.project.create(siteAt(1))

      await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(planLimit(1))
    })

    it.each(['cancelled', 'expired'] as const)(
      'goes back to the ceiling alone once the tariff is %s',
      async (status) => {
        const { user: owner, caller } = await account()
        const { subscriptionId, workspaceId } = await subscribe(owner, 1)
        await caller.project.create(siteAt(1))
        await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(planLimit(1))

        await db.subscription.update({ where: { id: subscriptionId }, data: { status } })

        await caller.project.create(siteAt(2))
        await caller.project.create(siteAt(3))
        expect(await db.site.count({ where: { workspaceId } })).toBe(3)
      },
    )

    it('takes the limit from the tariff that is live, not from one that ended', async () => {
      const { user: owner, caller } = await account()
      await subscribe(owner, 1, 'expired')
      const { workspaceId } = await subscribe(owner, 3)

      for (const index of [1, 2, 3]) await caller.project.create(siteAt(index))
      await expect(caller.project.create(siteAt(4))).rejects.toMatchObject(planLimit(3))
      expect(await db.site.count({ where: { workspaceId } })).toBe(3)
    })

    it('does not limit a user without a tariff below the ceiling', async () => {
      const { user: owner, caller } = await account()

      // More than the largest tariff holds. Nothing runs the imports here: each is finished as core
      // would finish it, and the limits of the checks start again, so only the sites are counted.
      for (let index = 0; index < 16; index += 1) {
        await createdProject(caller.project.create(siteAt(index)))
        await finishImports(db, owner.id)
        resetSiteConnectionGate()
      }

      expect(await db.site.count({ where: { workspace: { createdById: owner.id } } })).toBe(16)
    })

    it('does not count the tariff of another user against this one', async () => {
      const first = await account()
      const second = await account()
      await subscribe(first.user, 1)
      await first.caller.project.create(siteAt(1))

      await second.caller.project.create(siteAt(1))
      await second.caller.project.create(siteAt(2))

      await expect(first.caller.project.create(siteAt(2))).rejects.toMatchObject(planLimit(1))
      expect(await second.caller.project.list()).toHaveLength(2)
    })

    it('counts the limit under the user lock for concurrent submissions', async () => {
      const { user: owner, caller } = await account()
      const { workspaceId } = await subscribe(owner, 3)
      await caller.project.create(siteAt(0))

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) => caller.project.create(siteAt(index + 1))),
      )

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
      for (const result of results.filter((result) => result.status === 'rejected')) {
        expect(result).toMatchObject({ reason: planLimit(3) })
      }
      expect(await db.site.count({ where: { workspaceId } })).toBe(3)
    })

    describe('while another tariff is chosen for the next period', () => {
      const scheduledLimit = (maxSites: number) => ({
        code: 'FORBIDDEN',
        cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites, scheduled: true } },
      })

      /** What `schedulePlanChange` leaves: a tariff for `maxSites` sites in `next_plan_id`. */
      async function schedule(subscriptionId: string, maxSites: number) {
        const next = await tariffFor(maxSites)
        await db.subscription.update({
          where: { id: subscriptionId },
          data: { nextPlanId: next.id },
        })
      }

      it('holds the sites to a smaller tariff from the moment it is chosen, and to the tariff that is on again once the choice is taken back', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId, workspaceId } = await subscribe(owner, 15)
        await caller.project.create(siteAt(1))
        await schedule(subscriptionId, 1)

        const refused: unknown = await caller.project.create(siteAt(2)).catch((error) => error)
        expect(refused).toMatchObject({
          ...scheduledLimit(1),
          message:
            'В тариф, который вы выбрали на следующий период, входит один сайт. Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках',
        })
        expect((refused as { cause: { details: unknown } }).cause.details).toEqual({
          maxSites: 1,
          scheduled: true,
        })
        expect(await db.site.count({ where: { workspaceId } })).toBe(1)

        // «Отменить переход».
        await db.subscription.update({ where: { id: subscriptionId }, data: { nextPlanId: null } })

        await caller.project.create(siteAt(2))
        await caller.project.create(siteAt(3))
        expect(await db.site.count({ where: { workspaceId } })).toBe(3)
      })

      it('keeps the limit of the chosen tariff while the payment of the tariff is overdue: that payment applies it', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId } = await subscribe(owner, 15, 'past_due')
        await caller.project.create(siteAt(1))
        await schedule(subscriptionId, 1)

        await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(scheduledLimit(1))
      })

      it('does not lift the limit of the tariff that is on by a larger one chosen for the next period', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId } = await subscribe(owner, 1)
        await caller.project.create(siteAt(1))
        await schedule(subscriptionId, 15)

        const refused: unknown = await caller.project.create(siteAt(2)).catch((error) => error)
        expect(refused).toMatchObject(planLimit(1))
        expect((refused as { cause: { details: unknown } }).cause.details).toEqual({ maxSites: 1 })
      })

      it('counts the limit of the chosen tariff under the user lock for concurrent submissions', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId, workspaceId } = await subscribe(owner, 15)
        await schedule(subscriptionId, 3)
        await caller.project.create(siteAt(0))

        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, index) => caller.project.create(siteAt(index + 1))),
        )

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
        for (const result of results.filter((result) => result.status === 'rejected')) {
          expect(result).toMatchObject({ reason: scheduledLimit(3) })
        }
        expect(await db.site.count({ where: { workspaceId } })).toBe(3)
      })

      it('is not limited by the choice of a tariff that has ended', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId, workspaceId } = await subscribe(owner, 15, 'cancelled')
        await schedule(subscriptionId, 1)

        await caller.project.create(siteAt(1))
        await caller.project.create(siteAt(2))
        expect(await db.site.count({ where: { workspaceId } })).toBe(2)
      })
    })

    describe('while a tariff is being paid for', () => {
      const unpaidLimit = (maxSites: number) => ({
        code: 'FORBIDDEN',
        cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites, unpaid: true } },
      })

      it('holds the sites to the tariff of an unfinished checkout, and to the tariff it starts', async () => {
        const { user: owner, caller } = await account()
        const { workspaceId, orderId, planId } = await checkout(owner, 1)

        await caller.project.create(siteAt(1))
        await expect(caller.project.create(siteAt(2))).rejects.toMatchObject({
          ...unpaidLimit(1),
          message:
            'В тариф, который вы оплачиваете, входит один сайт. Чтобы добавить ещё один, выберите другой тариф в настройках',
        })

        // The money arrives: the order is paid and the tariff starts in one commit.
        await db.$transaction(async (tx) => {
          const subscription = await tx.subscription.create({
            data: {
              workspaceId,
              planId,
              status: 'active',
              currentPeriodStart: periodStart,
              currentPeriodEnd: new Date('2026-10-18T09:00:00Z'),
              periodAnchor: periodStart,
            },
          })
          await tx.order.update({
            where: { id: orderId },
            data: { status: 'paid', paidAt: periodStart, subscriptionId: subscription.id },
          })
        })

        // No more sites than the tariff takes got in before the payment.
        expect(await db.site.count({ where: { workspaceId } })).toBe(1)
        const refused: unknown = await caller.project.create(siteAt(2)).catch((error) => error)
        expect(refused).toMatchObject({
          ...planLimit(1),
          message:
            'В ваш тариф входит один сайт. Чтобы добавить ещё один, выберите другой тариф в настройках',
        })
        expect((refused as { cause: { details: unknown } }).cause.details).toEqual({ maxSites: 1 })
      })

      it.each(['cancelled', 'failed'] as const)(
        'goes back to the ceiling alone once the order is %s',
        async (status) => {
          const { user: owner, caller } = await account()
          const { workspaceId, orderId } = await checkout(owner, 1)
          await caller.project.create(siteAt(1))
          await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(unpaidLimit(1))

          await db.order.update({ where: { id: orderId }, data: { status } })

          await caller.project.create(siteAt(2))
          await caller.project.create(siteAt(3))
          expect(await db.site.count({ where: { workspaceId } })).toBe(3)
        },
      )

      it('takes the limit from the order that is unfinished, not from one that was replaced', async () => {
        const { user: owner, caller } = await account()
        // The customer chose a tariff for one site, then a tariff for three instead.
        const first = await checkout(owner, 1)
        await db.order.update({ where: { id: first.orderId }, data: { status: 'cancelled' } })
        const { workspaceId } = await checkout(owner, 3)

        for (const index of [1, 2, 3]) await caller.project.create(siteAt(index))
        await expect(caller.project.create(siteAt(4))).rejects.toMatchObject(unpaidLimit(3))
        expect(await db.site.count({ where: { workspaceId } })).toBe(3)
      })

      it('limits by the smaller tariff while a renewal to it is being charged', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId, workspaceId } = await subscribe(owner, 3)
        await caller.project.create(siteAt(1))
        const { orderId } = await checkout(owner, 1, subscriptionId)

        await expect(caller.project.create(siteAt(2))).rejects.toMatchObject(unpaidLimit(1))

        // The charge did not go through: the tariff that is on limits again.
        await db.order.update({ where: { id: orderId }, data: { status: 'failed' } })
        await caller.project.create(siteAt(2))
        expect(await db.site.count({ where: { workspaceId } })).toBe(2)
      })

      it('does not lift the limit of the tariff that is on by a payment for a larger one', async () => {
        const { user: owner, caller } = await account()
        const { subscriptionId } = await subscribe(owner, 1)
        await caller.project.create(siteAt(1))
        await checkout(owner, 3, subscriptionId)

        const refused: unknown = await caller.project.create(siteAt(2)).catch((error) => error)
        expect(refused).toMatchObject(planLimit(1))
        expect((refused as { cause: { details: unknown } }).cause.details).toEqual({ maxSites: 1 })
      })

      it('is not limited by a pack that is being paid for', async () => {
        const { user: owner, caller } = await account()
        const workspace = await workspaceOf(owner)
        const pack = await db.plan.create({
          data: {
            slug: `project-test-${randomUUID()}`,
            name: 'Проверочный пакет',
            kind: 'pack',
            price: '1990.00',
            packCredits: 10,
            isActive: false,
          },
        })
        planIds.push(pack.id)
        await db.order.create({
          data: {
            workspaceId: workspace.id,
            userId: owner.id,
            kind: 'pack',
            planId: pack.id,
            amount: pack.price,
            status: 'pending',
            idempotenceKey: randomUUID(),
          },
        })

        for (const index of [1, 2]) await caller.project.create(siteAt(index))
        expect(await db.site.count({ where: { workspaceId: workspace.id } })).toBe(2)
      })

      it('does not count the checkout of another user against this one', async () => {
        const first = await account()
        const second = await account()
        await checkout(first.user, 1)
        await first.caller.project.create(siteAt(1))

        await second.caller.project.create(siteAt(1))
        await second.caller.project.create(siteAt(2))

        await expect(first.caller.project.create(siteAt(2))).rejects.toMatchObject(unpaidLimit(1))
        expect(await second.caller.project.list()).toHaveLength(2)
      })
    })
  })

  it('isolates other users sites and does not disclose their duplicate URLs', async () => {
    const first = await account()
    const second = await account()
    const projectA = await createdProject(first.caller.project.create(input()))
    expect(await second.caller.project.list()).toEqual([])
    const projectB = await createdProject(second.caller.project.create(input()))
    expect(projectB.id).not.toBe(projectA.id)
    expect(await first.caller.project.list()).toEqual([{ ...projectA, setup: 'pending' }])
    expect(await second.caller.project.list()).toEqual([{ ...projectB, setup: 'pending' }])
  })

  it('lists shared sites only while membership exists and never creates into that workspace', async () => {
    const first = await account()
    const second = await account()
    const shared = await createdProject(first.caller.project.create(input()))
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: first.user.id } })
    const member = await db.member.create({
      data: { workspaceId: workspace.id, userId: second.user.id, role: 'member' },
    })
    expect(await second.caller.project.list()).toEqual([{ ...shared, setup: 'pending' }])
    await expect(second.caller.project.create(input())).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'PROJECT_ALREADY_EXISTS' },
    })
    const own = await createdProject(
      second.caller.project.create(input({ url: 'https://own.example.ru' })),
    )
    expect(await db.site.findUniqueOrThrow({ where: { id: own.id } })).not.toMatchObject({
      workspaceId: workspace.id,
    })
    await db.member.delete({ where: { id: member.id } })
    expect(await second.caller.project.list()).toEqual([{ ...own, setup: 'pending' }])
  })

  it('does not treat a shared owner workspace or revoked owner membership as personal', async () => {
    const first = await account()
    const second = await account()
    await first.caller.project.create(input())
    const original = await db.workspace.findFirstOrThrow({ where: { createdById: first.user.id } })
    await db.member.create({
      data: { workspaceId: original.id, userId: second.user.id, role: 'member' },
    })
    const project = await createdProject(
      first.caller.project.create(input({ url: 'https://private.example.ru' })),
    )
    const site = await db.site.findUniqueOrThrow({ where: { id: project.id } })
    expect(site.workspaceId).not.toBe(original.id)
    await db.member.updateMany({
      where: { workspaceId: site.workspaceId },
      data: { role: 'member' },
    })
    const next = await createdProject(
      first.caller.project.create(input({ url: 'https://next.example.ru' })),
    )
    const nextSite = await db.site.findUniqueOrThrow({ where: { id: next.id } })
    expect(nextSite.workspaceId).not.toBe(site.workspaceId)
    expect(nextSite.workspaceId).not.toBe(original.id)
  })
})
