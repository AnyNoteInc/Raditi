import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  SiteConnectionError,
  siteConnectionLimits,
  siteProvisionDedupeKey,
  type SiteConnectionServices,
} from '@repo/domain'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import { createCaller } from '../router.ts'
import { resetSiteConnectionGate } from '../services/site-connection-gate.ts'
import { siteIdForRequest } from '../services/site-request-id.ts'
import {
  createdProject,
  deleteSiteConnectionRows,
  FAKE_HOST_KEY,
  fakeSiteConnections,
  ftpSource,
  mysqlDatabase,
  OTHER_HOST_KEY,
  SECRET_VALUES,
  sftpSource,
  siteCreateInput,
  vaultUnavailable,
} from '../testing/site-connections.ts'
import type { Context } from '../trpc.ts'
import { MAX_SITES_PER_USER } from './project.ts'

// `project.create` as the last step of the wizard (docs/plan/39-site-connection-wizard.md, «Создание»): the
// id from the request key, the claim, the second checks, Vault before the transaction and the rows of one
// transaction. The rules of the room for a site under the lock are tested in project.test.ts.

const now = new Date('2026-10-17T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна Иванова',
  lastName: null,
  email: 'project-create-test@example.ru',
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

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  resetSiteConnectionGate()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function context(
  prisma: PrismaClient,
  siteConnections: SiteConnectionServices | null,
  currentUser: User = user,
): Context {
  return {
    prisma,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
    user: currentUser,
    session: {
      id: randomUUID(),
      userId: currentUser.id,
      token: 'project-create-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
    siteConnections,
  }
}

/** The outside reads find nothing; the transaction writes everything it is asked to. */
function fakeDb() {
  const order: string[] = []
  const tx = {
    $queryRaw: vi.fn(async () => {
      order.push('lock')
      return [{ id: user.id }]
    }),
    siteCreationClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    site: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push('site')
        return { ...data, createdAt: now }
      }),
    },
    workspace: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === undefined ? null : { id: where.id },
      ),
      create: vi.fn().mockResolvedValue({ id: randomUUID() }),
    },
    creditLedger: {
      findUnique: vi.fn().mockResolvedValue({ kind: 'grant', unit: 'credit_gift' }),
    },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    siteProvisioningStage: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    },
    credentialRef: {
      create: vi.fn(async (_query: { data: Record<string, unknown> }) => ({ id: randomUUID() })),
    },
    siteCodeSource: { create: vi.fn().mockResolvedValue({}) },
    siteDatabase: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    workspace: { findFirst: vi.fn().mockResolvedValue(null) },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    siteProvisioningStage: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(async () => {
      order.push('claim')
      return [{ token: 'claimed' }]
    }),
    siteCreationClaim: {
      deleteMany: vi.fn(async () => {
        order.push('release')
        return { count: 1 }
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction')
      return callback(tx)
    }),
  }
  return { db, tx, order, prisma: db as unknown as PrismaClient }
}

/** A fake of the servers whose checks and writes join the order of the database calls. */
function connections(order: string[], options: Parameters<typeof fakeSiteConnections>[0] = {}) {
  const fake = fakeSiteConnections(options)
  const write = fake.secrets.kvWrite.getMockImplementation()!
  fake.secrets.kvWrite.mockImplementation(async (...args) => {
    order.push(`vault ${args[0].split('/').at(-1)}`)
    return write(...args)
  })
  return fake
}

const sitePayload = (siteId: string, overrides: Record<string, unknown> = {}) => ({
  id: siteId,
  name: 'Мой сайт',
  url: 'https://example.ru',
  stack: 'wordpress',
  status: 'onboarding',
  createdAt: now,
  workspace: { members: [{ userId: user.id }] },
  ...overrides,
})

describe('project.create, the last step of the wizard', () => {
  it('checks both accesses again with the confirmed key, writes Vault, then the transaction', async () => {
    const { prisma, order, tx } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput({ database: mysqlDatabase() })

    const outcome = await createCaller(context(prisma, fake.services)).project.create(input)

    const siteId = siteIdForRequest(user.id, input.requestKey)
    expect(outcome).toEqual({
      outcome: 'created',
      project: {
        id: siteId,
        name: 'Мой сайт',
        url: 'https://example.ru',
        host: 'example.ru',
        stack: 'wordpress',
        status: 'onboarding',
        createdAt: now,
      },
    })
    // The lock of the user's row is taken again by the personal workspace: the steps, not the calls.
    const steps = order.filter((step, index) => step !== order[index - 1])
    expect(steps).toEqual(['claim', 'vault ssh', 'vault db', 'transaction', 'lock', 'site'])
    // A passed step of the wizard proves nothing now: create requires the key it confirmed.
    expect(fake.sourceChecks).toHaveLength(1)
    expect(fake.sourceChecks[0]!.context).toMatchObject({
      pinRequired: true,
      markers: ['wp-content', 'wp-includes'],
    })
    expect(fake.sourceChecks[0]!.context.address).toMatchObject({
      host: 'files.example.ru',
      address: '127.0.0.1',
    })
    expect(fake.databaseChecks).toHaveLength(1)
    expect(fake.secrets.writes.map(({ path, cas, version }) => [path, cas, version])).toEqual([
      [`kv/sites/${siteId}/ssh`, 0, 1],
      [`kv/sites/${siteId}/db`, 0, 1],
    ])
    expect(tx.site.create.mock.calls[0]![0].data).toMatchObject({
      id: siteId,
      status: 'onboarding',
    })
  })

  it('writes the references with the versions Vault gave and the canonical paths', async () => {
    const { prisma, order, tx } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput({ database: mysqlDatabase() })
    const siteId = siteIdForRequest(user.id, input.requestKey)
    // A version left by an earlier attempt of the same request: CAS finds it and writes the next one.
    fake.secrets.preset(`kv/sites/${siteId}/ssh`, 3)

    await createCaller(context(prisma, fake.services)).project.create(input)

    expect(fake.secrets.writes.map(({ cas, version }) => [cas, version])).toEqual([
      [3, 4],
      [0, 1],
    ])
    expect(tx.credentialRef.create.mock.calls.map(([{ data }]) => data)).toEqual([
      expect.objectContaining({
        kind: 'ssh',
        siteId,
        vaultPath: `kv/sites/${siteId}/ssh`,
        keyVersion: 4,
      }),
      expect.objectContaining({
        kind: 'db',
        siteId,
        vaultPath: `kv/sites/${siteId}/db`,
        keyVersion: 1,
      }),
    ])
  })

  it('queues the first import with an outbox event of ids only and audits kinds only', async () => {
    const { prisma, order, tx } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput({ source: ftpSource() })
    const siteId = siteIdForRequest(user.id, input.requestKey)

    await createCaller(context(prisma, fake.services)).project.create(input)

    expect(tx.siteProvisioningStage.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        siteId,
        stage: 'code_import',
        status: 'queued',
        attempt: 1,
        enqueues: 1,
        step: null,
      },
    })
    expect(tx.outboxEvent.createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        {
          topic: 'site-import',
          type: 'site.provision',
          payload: { siteId, stage: 'code_import' },
          dedupeKey: siteProvisionDedupeKey(siteId, 'code_import', 1, 1),
          availableAt: undefined,
        },
      ],
      skipDuplicates: true,
    })
    expect(tx.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        actorType: 'user',
        actorId: user.id,
        action: 'site.create',
        targetType: 'site',
        targetId: siteId,
        meta: { source: 'ftp', database: null },
        ip: '203.0.113.7',
      }),
    })
    // Without a database: no check of one, no secret, no row.
    expect(fake.databaseChecks).toEqual([])
    expect(tx.siteDatabase.create).not.toHaveBeenCalled()
    expect(tx.credentialRef.create).toHaveBeenCalledOnce()
    expect(tx.siteCodeSource.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        siteId,
        kind: 'ftp',
        host: 'files.example.ru',
        port: 21,
        rootPath: 'public_html',
        repositoryUrl: null,
        branch: null,
        tls: 'verified',
        hostKey: null,
        credentialRefId: expect.any(String),
      },
    })
  })

  it.each([
    [{ ok: false, reason: 'auth_failed' }, { reason: 'auth_failed' }],
    [
      { ok: false, reason: 'not_site_root', suggestedRoot: 'public_html' },
      { reason: 'not_site_root', suggestedRoot: 'public_html' },
    ],
    [
      { ok: false, reason: 'host_key_changed', hostKey: OTHER_HOST_KEY },
      { reason: 'host_key_changed', hostKey: OTHER_HOST_KEY },
    ],
  ] as const)(
    'answers a files check refused now with source_refused and writes nothing: %o',
    async (answer, refusal) => {
      const { prisma, order, db } = fakeDb()
      const fake = connections(order)
      fake.answerSource(answer)
      const input = siteCreateInput()

      await expect(
        createCaller(context(prisma, fake.services)).project.create(input),
      ).resolves.toEqual({ outcome: 'source_refused', ...refusal })

      expect(fake.secrets.writes).toEqual([])
      expect(db.$transaction).not.toHaveBeenCalled()
      // The claim is given back: the next press of the button is not refused as «in progress».
      expect(order).toEqual(['claim', 'release'])
      expect(db.siteCreationClaim.deleteMany).toHaveBeenCalledExactlyOnceWith({
        where: { siteId: siteIdForRequest(user.id, input.requestKey), token: expect.any(String) },
      })
    },
  )

  it('requires the key the user confirmed: an sftp source without one is refused, with no key to offer', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    const { hostKey: _hostKey, ...withoutKey } = sftpSource()

    // The adapter refuses before it connects: no server presented a key.
    await expect(
      createCaller(context(prisma, fake.services)).project.create(
        siteCreateInput({ source: withoutKey as never }),
      ),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'host_key_changed' })
    expect(fake.sourceChecks[0]!.context.pinRequired).toBe(true)
    expect(fake.secrets.writes).toEqual([])
  })

  it('answers a database check refused now with database_refused and writes nothing', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    fake.answerDatabase({ ok: false, reason: 'host_not_allowed' })

    await expect(
      createCaller(context(prisma, fake.services)).project.create(
        siteCreateInput({ database: mysqlDatabase() }),
      ),
    ).resolves.toEqual({ outcome: 'database_refused', reason: 'host_not_allowed' })
    expect(fake.secrets.writes).toEqual([])
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(order).toEqual(['claim', 'release'])
  })

  it('refuses a git source as not offered, before a claim or a check', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    const source = {
      kind: 'git',
      url: 'https://git.example.ru/site.git',
      username: 'x-access-token',
      token: SECRET_VALUES.sourcePassword,
    } as const

    await expect(
      createCaller(context(prisma, fake.services)).project.create(siteCreateInput({ source })),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'unsupported' })
    expect(order).toEqual([])
    expect(fake.sourceChecks).toEqual([])
  })

  it('answers a repeated request with the site it made, without a check, a claim or a write', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput()
    const siteId = siteIdForRequest(user.id, input.requestKey)
    db.site.findUnique.mockResolvedValue(sitePayload(siteId))

    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).resolves.toMatchObject({ outcome: 'created', project: { id: siteId, url: input.url } })
    expect(db.site.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: siteId } }),
    )
    expect(order).toEqual([])
    expect(fake.sourceChecks).toEqual([])
    expect(fake.lookup).not.toHaveBeenCalled()
    // Not even the rules of the room: the site is there already.
    expect(db.site.count).not.toHaveBeenCalled()
  })

  it.each([
    ['the duplicate', 'PROJECT_ALREADY_EXISTS'],
    ['the imports in progress', 'SITE_CONNECTIONS_BUSY'],
  ] as const)(
    'answers an identical request whose first copy committed just before the room check, refused by %s, with that site',
    async (what, domainCode) => {
      const { prisma, order, db } = fakeDb()
      const fake = connections(order)
      const input = siteCreateInput()
      const siteId = siteIdForRequest(user.id, input.requestKey)
      // The first copy commits between the replay and the room check: its site is the duplicate, or its
      // queued import fills the room.
      db.site.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(sitePayload(siteId, { url: input.url }))
      if (what === 'the duplicate') db.site.findFirst.mockResolvedValue({ id: siteId })
      else
        db.siteProvisioningStage.count.mockResolvedValue(
          siteConnectionLimits.connectionsInProgressPerUser,
        )

      await expect(
        createCaller(context(prisma, fake.services)).project.create(input),
      ).resolves.toMatchObject({ outcome: 'created', project: { id: siteId, url: input.url } })
      expect(db.site.findUnique).toHaveBeenCalledTimes(2)
      expect(order).toEqual([])
      expect(fake.sourceChecks).toEqual([])

      // Without that site the refusal stands: the lookup ran again and found nothing.
      db.site.findUnique.mockReset().mockResolvedValue(null)
      await expect(
        createCaller(context(prisma, fake.services)).project.create(input),
      ).rejects.toMatchObject({ cause: { code: domainCode } })
      expect(db.site.findUnique).toHaveBeenCalledTimes(2)
      expect(order).toEqual([])
    },
  )

  it('refuses a request key reused for another address, and answers «not found» for a site the user cannot open', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput()
    const siteId = siteIdForRequest(user.id, input.requestKey)

    db.site.findUnique.mockResolvedValue(sitePayload(siteId, { url: 'https://other.example.ru' }))
    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'Из этого окна уже добавлен проект с другим адресом. Откройте список проектов или начните добавление заново',
      cause: { code: 'PROJECT_REQUEST_CONFLICT' },
    })

    db.site.findUnique.mockResolvedValue(sitePayload(siteId, { workspace: { members: [] } }))
    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(order).toEqual([])
  })

  it('refuses a second identical request while the first holds the claim', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    db.$queryRaw.mockResolvedValue([])

    await expect(
      createCaller(context(prisma, fake.services)).project.create(siteCreateInput()),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Проект уже добавляется. Подождите несколько секунд',
      cause: { code: 'PROJECT_CREATION_IN_PROGRESS' },
    })
    expect(fake.sourceChecks).toEqual([])
    expect(fake.secrets.writes).toEqual([])
  })

  it('claims the id by the clock of PostgreSQL for createClaimMs, taking over only an expired claim', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    const input = siteCreateInput()

    await createCaller(context(prisma, fake.services)).project.create(input)

    const [sql, ...values] = db.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ]
    const text = sql.join('?').replace(/\s+/g, ' ')
    expect(text).toContain('INSERT INTO site_creation_claims (site_id, user_id, token, expires_at)')
    expect(text).toContain('ON CONFLICT (site_id) DO UPDATE')
    expect(text).toContain('WHERE site_creation_claims.expires_at < now()')
    expect(values).toEqual([
      siteIdForRequest(user.id, input.requestKey),
      user.id,
      expect.any(String),
      siteConnectionLimits.createClaimMs,
    ])
  })

  it('refuses when the claim was taken over before the transaction, and logs the secrets it left', async () => {
    const { prisma, order, tx } = fakeDb()
    const fake = connections(order)
    tx.siteCreationClaim.deleteMany.mockResolvedValue({ count: 0 })
    const input = siteCreateInput()

    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).rejects.toMatchObject({ cause: { code: 'PROJECT_CREATION_IN_PROGRESS' } })
    expect(tx.site.create).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `site_connection_orphan site=${siteIdForRequest(user.id, input.requestKey)}`,
    )
  })

  it('logs one line with the site id alone when the transaction fails after Vault, and rethrows', async () => {
    const { prisma, order, tx } = fakeDb()
    const fake = connections(order)
    tx.siteCodeSource.create.mockRejectedValue(new Error('connection to the database lost'))
    const input = siteCreateInput({ database: mysqlDatabase() })

    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `site_connection_orphan site=${siteIdForRequest(user.id, input.requestKey)}`,
    )
    expect(order.at(-1)).toBe('release')
  })

  it('answers SITE_CONNECTION_UNAVAILABLE when Vault fails, before the transaction, and never logs what it said', async () => {
    const { prisma, order, db } = fakeDb()
    const fake = connections(order)
    fake.secrets.failure = vaultUnavailable()

    await expect(
      createCaller(context(prisma, fake.services)).project.create(siteCreateInput()),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'SITE_CONNECTION_UNAVAILABLE' },
    })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(order.at(-1)).toBe('release')
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain('site_connection_secret_failed error=VaultError')
    expect(logged).not.toContain('ECONNREFUSED')
    expect(logged).not.toContain('10.0.0.5')
  })

  it('answers SITE_CONNECTION_UNAVAILABLE when another writer moved the version between the read and the write', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    fake.secrets.kvMetadata.mockResolvedValueOnce(null)
    const input = siteCreateInput()
    fake.secrets.preset(`kv/sites/${siteIdForRequest(user.id, input.requestKey)}/ssh`, 1)

    await expect(
      createCaller(context(prisma, fake.services)).project.create(input),
    ).rejects.toMatchObject({ cause: { code: 'SITE_CONNECTION_UNAVAILABLE' } })
    expect(fake.secrets.writes).toEqual([])
  })

  it('maps a check that throws its reason, and hides one that throws anything else', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    fake.answerSource(() => {
      throw new SiteConnectionError('transfer_failed')
    })
    await expect(
      createCaller(context(prisma, fake.services)).project.create(siteCreateInput()),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'transfer_failed' })

    fake.answerSource(() => {
      throw new Error(`530 Login incorrect for ${SECRET_VALUES.sourceUser}`)
    })
    const error: unknown = await createCaller(context(prisma, fake.services))
      .project.create(siteCreateInput())
      .catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ cause: { code: 'SITE_CONNECTION_UNAVAILABLE' } })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET_VALUES.sourceUser)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Login incorrect')
  })

  it('stops a check that does not end at the deadline of the checks with unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    let entered!: () => void
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    fake.answerSource(() => {
      entered()
      return new Promise(() => undefined)
    })

    const creation = createCaller(context(prisma, fake.services)).project.create(siteCreateInput())
    await checking
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.createChecksMs - 1)
    expect(fake.sourceChecks[0]!.context.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(creation).resolves.toEqual({ outcome: 'source_refused', reason: 'unreachable' })
    expect(fake.sourceChecks[0]!.context.signal.aborted).toBe(true)
  })

  describe('refuses before any server is asked', () => {
    it.each([
      ['the ceiling', 'site', 'PROJECT_LIMIT_REACHED', 'FORBIDDEN'],
      ['the imports in progress', 'stage', 'SITE_CONNECTIONS_BUSY', 'TOO_MANY_REQUESTS'],
      ['a duplicate', 'duplicate', 'PROJECT_ALREADY_EXISTS', 'CONFLICT'],
    ] as const)('at %s', async (_case, what, domainCode, code) => {
      const { prisma, order, db } = fakeDb()
      const fake = connections(order)
      if (what === 'site') db.site.count.mockResolvedValue(MAX_SITES_PER_USER)
      if (what === 'stage')
        db.siteProvisioningStage.count.mockResolvedValue(
          siteConnectionLimits.connectionsInProgressPerUser,
        )
      if (what === 'duplicate') db.site.findFirst.mockResolvedValue({ id: randomUUID() })

      await expect(
        createCaller(context(prisma, fake.services)).project.create(siteCreateInput()),
      ).rejects.toMatchObject({ code, cause: { code: domainCode } })
      expect(order).toEqual([])
      expect(fake.sourceChecks).toEqual([])
      expect(fake.lookup).not.toHaveBeenCalled()
    })

    it('at a platform the wizard does not connect', async () => {
      const { prisma, order } = fakeDb()
      const fake = connections(order)
      await expect(
        createCaller(context(prisma, fake.services)).project.create({
          ...siteCreateInput(),
          stack: 'bitrix',
        } as never),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Эту платформу мы пока не подключаем',
        cause: { code: 'SITE_STACK_NOT_CONNECTABLE' },
      })
      expect(order).toEqual([])
    })
  })

  it('spends two units of the checks per creation and refuses past the window', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    const caller = createCaller(context(prisma, fake.services))
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow / 2; index += 1) {
      await createdProject(caller.project.create(siteCreateInput()))
    }
    await expect(caller.project.create(siteCreateInput())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Слишком много проверок подряд. Подождите несколько минут и попробуйте снова',
      cause: { code: 'SITE_CHECKS_LIMITED' },
    })
    // Given back like every other way out before the transaction.
    expect(order.at(-1)).toBe('release')
  })

  it('stops trying an endpoint that refused the login refusedLoginsPerWindow times', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    fake.answerSource({ ok: false, reason: 'auth_failed' })
    const caller = createCaller(context(prisma, fake.services))
    for (let index = 0; index < siteConnectionLimits.refusedLoginsPerWindow; index += 1) {
      await expect(caller.project.create(siteCreateInput())).resolves.toMatchObject({
        reason: 'auth_failed',
      })
    }
    await expect(caller.project.create(siteCreateInput())).rejects.toMatchObject({
      cause: { code: 'SITE_CHECKS_LIMITED' },
    })
    expect(fake.sourceChecks).toHaveLength(siteConnectionLimits.refusedLoginsPerWindow)
  })

  it('does not count a database that requires encryption as a refused login', async () => {
    const { prisma, order } = fakeDb()
    const fake = connections(order)
    fake.answerDatabase({ ok: false, reason: 'tls_required' })
    const caller = createCaller(context(prisma, fake.services))
    const input = () => siteCreateInput({ database: mysqlDatabase({ tls: 'plain' }) })
    for (let index = 0; index <= siteConnectionLimits.refusedLoginsPerWindow; index += 1) {
      await expect(caller.project.create(input())).resolves.toEqual({
        outcome: 'database_refused',
        reason: 'tls_required',
      })
    }
    // The same server is still asked: with encryption it may well let the user in.
    fake.answerDatabase({ ok: true, tables: 12 })
    await expect(
      caller.project.create(siteCreateInput({ database: mysqlDatabase() })),
    ).resolves.toMatchObject({ outcome: 'created' })
    expect(fake.databaseChecks).toHaveLength(siteConnectionLimits.refusedLoginsPerWindow + 2)
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: project.create writes one connected site', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    const owned = { createdById: { in: ids } }
    const workspaces = await db.workspace.findMany({ where: owned, select: { id: true } })
    const workspaceIds = workspaces.map(({ id }) => id)
    const inWorkspaces = { workspaceId: { in: workspaceIds } }
    await deleteSiteConnectionRows(db, workspaceIds)
    await db.site.deleteMany({ where: inWorkspaces })
    await db.creditLedger.deleteMany({ where: { account: inWorkspaces } })
    await db.billingAccount.deleteMany({ where: inWorkspaces })
    await db.auditLog.deleteMany({ where: inWorkspaces })
    await db.member.deleteMany({ where: inWorkspaces })
    await db.workspace.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function account() {
    const owner = await db.user.create({
      data: { name: 'Project creation', email: `${randomUUID()}@project-create.example.ru` },
    })
    userIds.push(owner.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({
        ...consent,
        userId: owner.id,
        source: 'sign_up',
      })),
    })
    const fake = fakeSiteConnections()
    return { owner, fake, caller: createCaller(context(db, fake.services, owner)) }
  }

  /** Every row this site has in the tables `project.create` writes, besides the workspace. */
  async function rowsOf(siteId: string) {
    const [site, refs, source, database, stages, outbox, audit, claims] = await Promise.all([
      db.site.findUnique({ where: { id: siteId } }),
      db.credentialRef.findMany({ where: { siteId }, orderBy: { kind: 'asc' } }),
      db.siteCodeSource.findUnique({ where: { siteId } }),
      db.siteDatabase.findUnique({ where: { siteId } }),
      db.siteProvisioningStage.findMany({ where: { siteId } }),
      db.outboxEvent.findMany({
        where: { dedupeKey: { startsWith: `site-provisioning:${siteId}:` } },
      }),
      db.auditLog.findMany({ where: { targetType: 'site', targetId: siteId } }),
      db.siteCreationClaim.findMany({ where: { siteId } }),
    ])
    return { site, refs, source, database, stages, outbox, audit, claims }
  }

  it('writes the site, its references, its source and database, the queued import and one event', async () => {
    const { owner, fake, caller } = await account()
    const input = siteCreateInput({ database: mysqlDatabase() })
    const siteId = siteIdForRequest(owner.id, input.requestKey)

    const project = await createdProject(caller.project.create(input))

    expect(project.id).toBe(siteId)
    const rows = await rowsOf(siteId)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: owner.id } })
    expect(rows.site).toMatchObject({
      workspaceId: workspace.id,
      name: 'Мой сайт',
      url: 'https://example.ru',
      stack: 'wordpress',
      status: 'onboarding',
    })
    expect(
      rows.refs.map(({ kind, vaultPath, keyVersion, workspaceId }) => ({
        kind,
        vaultPath,
        keyVersion,
        workspaceId,
      })),
    ).toEqual([
      {
        kind: 'ssh',
        vaultPath: `kv/sites/${siteId}/ssh`,
        keyVersion: 1,
        workspaceId: workspace.id,
      },
      { kind: 'db', vaultPath: `kv/sites/${siteId}/db`, keyVersion: 1, workspaceId: workspace.id },
    ])
    const ref = (kind: string) => rows.refs.find((row) => row.kind === kind)!.id
    expect(rows.source).toMatchObject({
      kind: 'sftp',
      host: 'files.example.ru',
      port: 22,
      rootPath: '/var/www/site',
      repositoryUrl: null,
      branch: null,
      tls: null,
      hostKey: FAKE_HOST_KEY,
      credentialRefId: ref('ssh'),
    })
    expect(rows.database).toMatchObject({
      engine: 'mysql',
      host: 'db.example.ru',
      port: 3306,
      databaseName: 'wordpress',
      tls: 'verified',
      credentialRefId: ref('db'),
    })
    expect(rows.stages).toEqual([
      expect.objectContaining({
        stage: 'code_import',
        status: 'queued',
        attempt: 1,
        enqueues: 1,
        leaseEpoch: 0,
        step: null,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
      }),
    ])
    expect(rows.outbox).toEqual([
      expect.objectContaining({
        topic: 'site-import',
        type: 'site.provision',
        status: 'pending',
        payload: { siteId, stage: 'code_import' },
        dedupeKey: siteProvisionDedupeKey(siteId, 'code_import', 1, 1),
      }),
    ])
    expect(rows.audit).toEqual([
      expect.objectContaining({
        actorType: 'user',
        actorId: owner.id,
        workspaceId: workspace.id,
        action: 'site.create',
        meta: { source: 'sftp', database: 'mysql' },
      }),
    ])
    // The transaction took the claim with it.
    expect(rows.claims).toEqual([])
    // Vault holds the values; the versions in the references are the ones it gave.
    expect(fake.secrets.writes.map(({ path, version }) => [path, version])).toEqual([
      [`kv/sites/${siteId}/ssh`, 1],
      [`kv/sites/${siteId}/db`, 1],
    ])
    expect(fake.secrets.writes[0]!.data).toMatchObject({
      username: SECRET_VALUES.sourceUser,
      password: SECRET_VALUES.sourcePassword,
      hostKey: FAKE_HOST_KEY,
    })
  })

  it('keeps every secret value and every user name out of every row it writes', async () => {
    const { owner, caller } = await account()
    const input = siteCreateInput({ database: mysqlDatabase() })
    const siteId = siteIdForRequest(owner.id, input.requestKey)
    await createdProject(caller.project.create(input))

    const rows = await rowsOf(siteId)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: owner.id } })
    const written = JSON.stringify({ ...rows, workspace })
    for (const value of Object.values(SECRET_VALUES)) expect(written).not.toContain(value)
    // Nothing else in the database holds them either: a row of any table of this user would.
    const patterns = Object.values(SECRET_VALUES).map((value) => `%${value}%`)
    const everything = await db.$queryRaw<{ found: number }[]>`
      SELECT count(*)::int AS found FROM (
        SELECT row_to_json(t)::text AS body FROM sites t WHERE id = ${siteId}::uuid
        UNION ALL SELECT row_to_json(t)::text FROM credential_refs t WHERE site_id = ${siteId}::uuid
        UNION ALL SELECT row_to_json(t)::text FROM site_code_sources t WHERE site_id = ${siteId}::uuid
        UNION ALL SELECT row_to_json(t)::text FROM site_databases t WHERE site_id = ${siteId}::uuid
        UNION ALL SELECT row_to_json(t)::text FROM site_provisioning_stages t WHERE site_id = ${siteId}::uuid
        UNION ALL SELECT row_to_json(t)::text FROM outbox_events t WHERE dedupe_key LIKE ${`site-provisioning:${siteId}:%`}
        UNION ALL SELECT row_to_json(t)::text FROM audit_log t WHERE target_id = ${siteId}
      ) rows
      WHERE body LIKE ANY (${patterns}::text[])
    `
    expect(everything).toEqual([{ found: 0 }])
  })

  it('writes no database row, reference or secret for a site without a database', async () => {
    const { owner, fake, caller } = await account()
    const input = siteCreateInput({ source: ftpSource() })
    const siteId = siteIdForRequest(owner.id, input.requestKey)

    await createdProject(caller.project.create(input))

    const rows = await rowsOf(siteId)
    expect(rows.database).toBeNull()
    expect(rows.refs.map(({ kind }) => kind)).toEqual(['ftp'])
    expect(rows.source).toMatchObject({ kind: 'ftp', tls: 'verified', hostKey: null })
    expect(rows.audit[0]!.meta).toEqual({ source: 'ftp', database: null })
    expect(fake.secrets.writes.map(({ path }) => path)).toEqual([`kv/sites/${siteId}/ftp`])
  })

  it('answers the same request again with the same project, without checks or writes', async () => {
    const { owner, fake, caller } = await account()
    const input = siteCreateInput({ database: mysqlDatabase() })
    const first = await caller.project.create(input)
    const before = await rowsOf(siteIdForRequest(owner.id, input.requestKey))
    const checks = fake.sourceChecks.length

    const again = await caller.project.create(input)

    expect(again).toEqual(first)
    expect(fake.sourceChecks).toHaveLength(checks)
    expect(fake.secrets.writes).toHaveLength(2)
    expect(await rowsOf(siteIdForRequest(owner.id, input.requestKey))).toEqual(before)
    expect(await caller.project.list()).toHaveLength(1)
  })

  it('refuses an identical request while the first is still checking, and makes one site', async () => {
    const { owner, fake, caller } = await account()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    fake.answerSource(async (source, context) => {
      entered()
      await held
      return {
        ok: true,
        hostKey: (source as { hostKey?: string }).hostKey ?? null,
        canonicalUrl: null,
        defaultBranch: null,
        entries: context.markers.length,
      }
    })
    const input = siteCreateInput()

    const first = caller.project.create(input)
    await checking
    await expect(caller.project.create(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'PROJECT_CREATION_IN_PROGRESS' },
    })
    release()
    await expect(first).resolves.toMatchObject({ outcome: 'created' })

    const siteId = siteIdForRequest(owner.id, input.requestKey)
    expect(fake.secrets.writes.map(({ path }) => path)).toEqual([`kv/sites/${siteId}/ssh`])
    expect((await rowsOf(siteId)).stages).toHaveLength(1)
    expect(await caller.project.list()).toHaveLength(1)
  })

  it('takes over a claim that outlived its request', async () => {
    const { owner, caller } = await account()
    const input = siteCreateInput()
    const siteId = siteIdForRequest(owner.id, input.requestKey)
    await db.siteCreationClaim.create({
      data: {
        siteId,
        userId: owner.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
      },
    })

    await expect(caller.project.create(input)).resolves.toMatchObject({ outcome: 'created' })
    expect((await rowsOf(siteId)).claims).toEqual([])
  })

  it('writes nothing, in Vault or PostgreSQL, when a check refuses now', async () => {
    const { owner, fake, caller } = await account()
    fake.answerDatabase({ ok: false, reason: 'auth_failed' })
    const input = siteCreateInput({ database: mysqlDatabase() })

    await expect(caller.project.create(input)).resolves.toEqual({
      outcome: 'database_refused',
      reason: 'auth_failed',
    })

    const rows = await rowsOf(siteIdForRequest(owner.id, input.requestKey))
    expect(rows).toEqual({
      site: null,
      refs: [],
      source: null,
      database: null,
      stages: [],
      outbox: [],
      audit: [],
      claims: [],
    })
    expect(fake.secrets.writes).toEqual([])
    // The first site makes the workspace: a refused one makes none.
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)
  })

  it('leaves the secrets without references when the transaction refuses, and the next request with the key writes a newer version', async () => {
    const { owner, fake, caller } = await account()
    const other = await account()
    const input = siteCreateInput()
    const siteId = siteIdForRequest(owner.id, input.requestKey)
    // While the files are checked, a site at the same address appears in a workspace the user is a
    // member of: the rule of the duplicate under the lock refuses this one.
    let shared: string | null = null
    fake.answerSource(async (source) => {
      if (shared === null) {
        const project = await createdProject(
          other.caller.project.create(siteCreateInput({ url: input.url })),
        )
        shared = project.id
        const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: project.id } })
        await db.member.create({ data: { workspaceId, userId: owner.id, role: 'member' } })
      }
      return {
        ok: true,
        hostKey: (source as { hostKey?: string }).hostKey ?? null,
        canonicalUrl: null,
        defaultBranch: null,
        entries: 3,
      }
    })

    await expect(caller.project.create(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'PROJECT_ALREADY_EXISTS' },
    })
    expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${siteId}`)
    expect(fake.secrets.writes.map(({ path, version }) => [path, version])).toEqual([
      [`kv/sites/${siteId}/ssh`, 1],
    ])
    const left = await rowsOf(siteId)
    expect(left.site).toBeNull()
    expect(left.refs).toEqual([])
    expect(left.claims).toEqual([])

    // The other user leaves; the same request goes through and writes version 2 over the orphan.
    await db.member.deleteMany({ where: { userId: owner.id } })
    await expect(caller.project.create(input)).resolves.toMatchObject({ outcome: 'created' })
    expect(fake.secrets.writes.at(-1)).toMatchObject({ cas: 1, version: 2 })
    expect((await rowsOf(siteId)).refs).toEqual([expect.objectContaining({ keyVersion: 2 })])
  })

  it('counts the imports in progress under the lock: of concurrent requests the one past the limit is refused', async () => {
    const { owner, caller } = await account()
    const limit = siteConnectionLimits.connectionsInProgressPerUser
    const results = await Promise.allSettled(
      Array.from({ length: limit + 1 }, (_, index) =>
        caller.project.create(siteCreateInput({ url: `https://busy-${index}.example.ru` })),
      ),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(limit)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: {
        code: 'TOO_MANY_REQUESTS',
        message:
          'Сейчас подключаются три ваших сайта. Дождитесь, пока закончится хотя бы одно подключение',
        cause: { code: 'SITE_CONNECTIONS_BUSY' },
      },
    })
    expect(await db.site.count({ where: { workspace: { createdById: owner.id } } })).toBe(limit)

    // A failed import is not in progress: the next site may be added.
    await db.siteProvisioningStage.updateMany({
      where: { site: { workspace: { createdById: owner.id } } },
      data: { status: 'failed', errorCode: 'auth_failed', finishedAt: new Date() },
    })
    await expect(
      caller.project.create(siteCreateInput({ url: 'https://after.example.ru' })),
    ).resolves.toMatchObject({ outcome: 'created' })
  })
})
