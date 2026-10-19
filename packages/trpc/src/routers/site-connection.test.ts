import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  siteConnectionLimits,
  siteProvisionDedupeKey,
  type CodeSourceInput,
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
import {
  createdProject,
  deleteSiteConnectionRows,
  FAKE_HOST_KEY,
  fakeSiteConnections,
  ftpSource,
  OTHER_HOST_KEY,
  SECRET_VALUES,
  sftpSource,
  siteCreateInput,
} from '../testing/site-connections.ts'
import type { Context } from '../trpc.ts'
import { MAX_SITES_PER_USER } from './project.ts'

const now = new Date('2026-10-17T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна Иванова',
  lastName: null,
  email: 'site-connection-test@example.ru',
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
const basics = { name: '  Кофейня  ', url: 'https://Кофейня.рф/', stack: 'wordpress' } as const

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
    headers: new Headers(),
    user: currentUser,
    session: {
      id: randomUUID(),
      userId: currentUser.id,
      token: 'site-connection-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
    siteConnections,
  }
}

/** Reads only: anything that writes is absent, so a write fails the test. */
function fakeDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    workspace: { findFirst: vi.fn().mockResolvedValue(null) },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    siteProvisioningStage: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { count: vi.fn().mockResolvedValue(0) },
  }
  return { db, prisma: db as unknown as PrismaClient }
}

describe('siteConnection.checkBasics', () => {
  it('answers the name and the address as they will be stored, reading only', async () => {
    const { prisma, db } = fakeDb()
    const fake = fakeSiteConnections()
    await expect(
      createCaller(context(prisma, fake.services)).siteConnection.checkBasics(basics),
    ).resolves.toEqual({
      name: 'Кофейня',
      url: 'https://xn--e1aiboc0b6e.xn--p1ai',
      host: 'кофейня.рф',
      stack: 'wordpress',
    })
    // The rules of project.create, without the personal workspace being made.
    expect(db.site.findFirst).toHaveBeenCalledOnce()
    expect(db.site.count).toHaveBeenCalledExactlyOnceWith({
      where: { workspace: { createdById: user.id } },
    })
    expect(db.workspace.findFirst).toHaveBeenCalledOnce()
    expect(db.siteProvisioningStage.count).toHaveBeenCalledExactlyOnceWith({
      where: {
        stage: 'code_import',
        status: { in: ['queued', 'running'] },
        site: { workspace: { createdById: user.id } },
      },
    })
    expect(fake.lookup).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a duplicate',
      'duplicate',
      'CONFLICT',
      'PROJECT_ALREADY_EXISTS',
      'Сайт с таким адресом уже добавлен',
    ],
    [
      'the ceiling',
      'ceiling',
      'FORBIDDEN',
      'PROJECT_LIMIT_REACHED',
      'Вы добавили максимальное число сайтов. Напишите нам, если нужно больше',
    ],
    [
      'three imports in progress',
      'busy',
      'TOO_MANY_REQUESTS',
      'SITE_CONNECTIONS_BUSY',
      'Сейчас подключаются три ваших сайта. Дождитесь, пока закончится хотя бы одно подключение',
    ],
  ] as const)('refuses %s', async (_case, what, code, domainCode, message) => {
    const { prisma, db } = fakeDb()
    if (what === 'duplicate') db.site.findFirst.mockResolvedValue({ id: randomUUID() })
    if (what === 'ceiling') db.site.count.mockResolvedValue(MAX_SITES_PER_USER)
    if (what === 'busy')
      db.siteProvisioningStage.count.mockResolvedValue(
        siteConnectionLimits.connectionsInProgressPerUser,
      )
    await expect(
      createCaller(context(prisma, fakeSiteConnections().services)).siteConnection.checkBasics(
        basics,
      ),
    ).rejects.toMatchObject({ code, message, cause: { code: domainCode } })
  })

  it('holds the sites to the tariff of the personal workspace, with the same details as create', async () => {
    const { prisma, db } = fakeDb()
    const workspaceId = randomUUID()
    db.workspace.findFirst.mockResolvedValue({ id: workspaceId })
    db.subscription.findFirst.mockResolvedValue({
      plan: { maxSites: 1 },
      nextPlan: { maxSites: 1 },
    })
    db.site.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1)
    await expect(
      createCaller(context(prisma, fakeSiteConnections().services)).siteConnection.checkBasics(
        basics,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites: 1 } },
    })
    expect(db.site.count).toHaveBeenLastCalledWith({ where: { workspaceId } })
  })

  it('refuses a local address in production and a platform that is not connected', async () => {
    const { prisma } = fakeDb()
    const production = fakeSiteConnections({ appEnv: 'production' }).services
    await expect(
      createCaller(context(prisma, production)).siteConnection.checkBasics({
        ...basics,
        url: 'http://localhost:8080',
      }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ADDRESS_NOT_PUBLIC' } })
    await expect(
      createCaller(context(prisma, fakeSiteConnections().services)).siteConnection.checkBasics({
        ...basics,
        stack: 'laravel',
      }),
    ).rejects.toMatchObject({
      message: 'Эту платформу мы пока не подключаем',
      cause: { code: 'SITE_STACK_NOT_CONNECTABLE' },
    })
  })

  it('is unavailable without the site connections of web', async () => {
    const { prisma, db } = fakeDb()
    await expect(
      createCaller(context(prisma, null)).siteConnection.checkBasics(basics),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'SITE_CONNECTION_UNAVAILABLE' },
    })
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })
})

describe('siteConnection.checkSource', () => {
  const checkOf = (
    fake: ReturnType<typeof fakeSiteConnections>,
    source: CodeSourceInput = sftpSource(),
  ) =>
    createCaller(context(fakeDb().prisma, fake.services)).siteConnection.checkSource({
      stack: 'wordpress',
      source,
    })

  it('answers the first sftp check without a key with the key the server presented, and logs in nowhere', async () => {
    const fake = fakeSiteConnections()
    const { hostKey: _hostKey, ...withoutKey } = sftpSource()

    await expect(checkOf(fake, withoutKey as never)).resolves.toEqual({
      ok: false,
      reason: 'host_key_unknown',
      hostKey: FAKE_HOST_KEY,
    })
    expect(fake.sourceChecks[0]!.context).toMatchObject({
      pinRequired: false,
      markers: ['wp-content', 'wp-includes'],
    })
    expect(fake.lookup).toHaveBeenCalledWith('files.example.ru', expect.any(AbortSignal))
  })

  it('passes with the confirmed key, and answers host_key_changed with the key of a server that changed', async () => {
    const fake = fakeSiteConnections()
    await expect(checkOf(fake)).resolves.toEqual({ ok: true, hostKey: FAKE_HOST_KEY, entries: 12 })
    fake.presentHostKey(OTHER_HOST_KEY)
    await expect(checkOf(fake)).resolves.toEqual({
      ok: false,
      reason: 'host_key_changed',
      hostKey: OTHER_HOST_KEY,
    })
  })

  it('answers an ftp check, and a folder one level down when the root is not the site', async () => {
    const fake = fakeSiteConnections()
    await expect(checkOf(fake, ftpSource())).resolves.toEqual({
      ok: true,
      hostKey: null,
      entries: 12,
    })
    fake.answerSource({ ok: false, reason: 'not_site_root', suggestedRoot: 'public_html' })
    await expect(checkOf(fake, ftpSource())).resolves.toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: 'public_html',
    })
  })

  it('does not offer git: unsupported, without a check', async () => {
    const fake = fakeSiteConnections()
    await expect(
      checkOf(fake, {
        kind: 'git',
        url: 'https://git.example.ru/site.git',
        username: 'x-access-token',
        token: SECRET_VALUES.sourcePassword,
      } as never),
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    expect(fake.sourceChecks).toEqual([])
    expect(fake.lookup).not.toHaveBeenCalled()
  })

  it('refuses in production a name that resolves to a non-public address, as one that does not exist', async () => {
    const fake = fakeSiteConnections({ appEnv: 'production', address: '10.0.0.5' })
    await expect(checkOf(fake)).resolves.toEqual({ ok: false, reason: 'host_not_found' })
    expect(fake.sourceChecks).toEqual([])
  })

  it('stops a check that does not end in checkMs with unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fake = fakeSiteConnections()
    let entered!: () => void
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    fake.answerSource(() => {
      entered()
      return new Promise(() => undefined)
    })
    const check = checkOf(fake)
    await checking
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.checkMs)
    await expect(check).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('counts a check as one unit and refuses past the window', async () => {
    const fake = fakeSiteConnections()
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow; index += 1) {
      await checkOf(fake)
    }
    await expect(checkOf(fake)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      cause: { code: 'SITE_CHECKS_LIMITED' },
    })
  })

  it('stops trying a server after refusedLoginsPerWindow refused logins, and still tries another', async () => {
    const fake = fakeSiteConnections()
    fake.answerSource({ ok: false, reason: 'auth_failed' })
    for (let index = 0; index < siteConnectionLimits.refusedLoginsPerWindow; index += 1) {
      await expect(checkOf(fake)).resolves.toEqual({ ok: false, reason: 'auth_failed' })
    }
    await expect(checkOf(fake)).rejects.toMatchObject({ cause: { code: 'SITE_CHECKS_LIMITED' } })
    await expect(checkOf(fake, sftpSource({ host: 'other.example.ru' }))).resolves.toMatchObject({
      reason: 'auth_failed',
    })
  })

  it('does not count a server that requires encryption as a refused login', async () => {
    const fake = fakeSiteConnections()
    fake.answerSource({ ok: false, reason: 'tls_required' })
    // Well past refusedLoginsPerWindow: the user must still be able to choose FTPS for this server.
    for (let index = 0; index <= siteConnectionLimits.refusedLoginsPerWindow * 2; index += 1) {
      await expect(checkOf(fake, ftpSource({ tls: 'plain' }))).resolves.toEqual({
        ok: false,
        reason: 'tls_required',
      })
    }
    fake.answerSource({
      ok: true,
      hostKey: null,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 3,
    })
    await expect(checkOf(fake, ftpSource())).resolves.toEqual({
      ok: true,
      hostKey: null,
      entries: 3,
    })
    expect(fake.sourceChecks).toHaveLength(siteConnectionLimits.refusedLoginsPerWindow * 2 + 2)
  })

  it('never answers or logs what the server or the adapter said', async () => {
    const fake = fakeSiteConnections()
    fake.answerSource(() => {
      throw new Error(
        `530 Login incorrect: ${SECRET_VALUES.sourceUser}/${SECRET_VALUES.sourcePassword}`,
      )
    })
    const error: unknown = await checkOf(fake).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Подключение сайтов сейчас недоступно. Попробуйте ещё раз немного позже',
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'site_connection_check_failed kind=sftp error=Error',
    )
  })

  it('is unavailable without the site connections of web, and refuses a platform that is not connected', async () => {
    await expect(
      createCaller(context(fakeDb().prisma, null)).siteConnection.checkSource({
        stack: 'wordpress',
        source: sftpSource(),
      }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_CONNECTION_UNAVAILABLE' } })
    await expect(
      createCaller(
        context(fakeDb().prisma, fakeSiteConnections().services),
      ).siteConnection.checkSource({ stack: 'bitrix', source: sftpSource() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_STACK_NOT_CONNECTABLE' } })
  })
})

describe('siteConnection.setup, read model', () => {
  const siteId = randomUUID()
  const row = (stage: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
    id: siteId,
    status: 'onboarding',
    provisioningStages: stage
      ? [
          {
            status: 'queued',
            step: null,
            errorCode: null,
            attempt: 1,
            updatedAt: now,
            summary: null,
            ...stage,
          },
        ]
      : [],
    codeSource: {
      kind: 'sftp',
      host: 'files.example.ru',
      port: 22,
      rootPath: '/var/www/site',
      tls: null,
      hostKey: FAKE_HOST_KEY,
    },
    initialVersion: null,
    ...extra,
  })
  const setupOf = async (site: unknown, retries = 0) => {
    const { prisma, db } = fakeDb()
    db.site.findFirst.mockResolvedValue(site)
    db.auditLog.count.mockResolvedValue(retries)
    return createCaller(context(prisma, null)).siteConnection.setup({ id: siteId })
  }

  it('reads an unknown error code as internal, an unknown step as none and a summary that does not parse as none', async () => {
    await expect(
      setupOf(row({ status: 'failed', errorCode: 'something_new', summary: { files: -1 } })),
    ).resolves.toMatchObject({ state: 'failed', errorCode: 'internal', summary: null })
    await expect(setupOf(row({ status: 'running', step: 'mystery' }))).resolves.toMatchObject({
      state: 'pending',
      step: null,
    })
  })

  it('shows the counts of a summary only', async () => {
    await expect(
      setupOf(
        row({
          status: 'succeeded',
          summary: { files: 120, bytes: 4096, skipped: { excluded: 3, secret: 1 }, recheck: true },
        }),
      ),
    ).resolves.toMatchObject({
      summary: { files: 120, bytes: 4096, skipped: { excluded: 3, secret: 1 } },
    })
  })

  it('offers neither action while the budget of the hour is spent, and tells it apart from no retry at all', async () => {
    const failed = row({ status: 'failed', errorCode: 'auth_failed' })
    await expect(setupOf(failed, siteConnectionLimits.retriesPerHour - 1)).resolves.toMatchObject({
      retry: 'available',
      replaceAccess: true,
    })
    // «Изменить доступ» spends the same budget: the procedure would refuse it.
    await expect(setupOf(failed, siteConnectionLimits.retriesPerHour)).resolves.toMatchObject({
      retry: 'limited',
      replaceAccess: false,
    })
    // A site that is no longer being connected is not set up again.
    await expect(setupOf({ ...failed, status: 'active' })).resolves.toMatchObject({
      retry: 'unavailable',
      replaceAccess: false,
    })
  })

  it('works without the site connections of web: it reads PostgreSQL only', async () => {
    await expect(setupOf(row(null))).resolves.toMatchObject({ state: null })
  })
})

describe('siteConnection.replaceAccess, before any server is asked', () => {
  const siteId = randomUUID()
  /** A failed import of an sftp site pinned to FAKE_HOST_KEY; nothing past the reads exists. */
  function failedSite() {
    const { prisma, db } = fakeDb()
    db.site.findFirst.mockResolvedValue({
      id: siteId,
      status: 'onboarding',
      stack: 'wordpress',
      workspaceId: randomUUID(),
      provisioningStages: [{ status: 'failed' }],
      codeSource: { kind: 'sftp', host: 'files.example.ru', port: 22, hostKey: FAKE_HOST_KEY },
    })
    return prisma
  }

  it('refuses another key for the pinned host and port as changed, with the key the client sent, and asks nobody', async () => {
    const fake = fakeSiteConnections()
    fake.presentHostKey(OTHER_HOST_KEY)

    await expect(
      createCaller(context(failedSite(), fake.services)).siteConnection.replaceAccess({
        id: siteId,
        source: sftpSource({ hostKey: OTHER_HOST_KEY }),
      }),
    ).resolves.toEqual({
      outcome: 'source_refused',
      reason: 'host_key_changed',
      hostKey: OTHER_HOST_KEY,
    })
    expect(fake.lookup).not.toHaveBeenCalled()
    expect(fake.sourceChecks).toEqual([])
    expect(fake.secrets.writes).toEqual([])
  })

  it('refuses an sftp access without a key for the pinned host as changed, with no key to offer', async () => {
    const fake = fakeSiteConnections()
    const { hostKey: _hostKey, ...withoutKey } = sftpSource()

    await expect(
      createCaller(context(failedSite(), fake.services)).siteConnection.replaceAccess({
        id: siteId,
        source: withoutKey as never,
      }),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'host_key_changed' })
    expect(fake.sourceChecks).toEqual([])
  })

  it('refuses a kind the registry does not offer as unsupported, before any check or write', async () => {
    const fake = fakeSiteConnections()

    await expect(
      createCaller(context(failedSite(), fake.services)).siteConnection.replaceAccess({
        id: siteId,
        source: {
          kind: 'git',
          url: 'https://git.example.ru/site.git',
          username: 'x-access-token',
          token: SECRET_VALUES.sourcePassword,
        },
      }),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'unsupported' })
    expect(fake.lookup).not.toHaveBeenCalled()
    expect(fake.sourceChecks).toEqual([])
    expect(fake.secrets.writes).toEqual([])
  })

  it('takes another kind of access to the pinned server as a new access, not as a changed key', async () => {
    const fake = fakeSiteConnections()

    // The fake database has no transaction: what matters is that the access got past the key and
    // was checked on the server, as a new one.
    const answer = await createCaller(context(failedSite(), fake.services))
      .siteConnection.replaceAccess({
        id: siteId,
        source: ftpSource({ host: 'files.example.ru', port: 22 }),
      })
      .catch((error: unknown) => error)
    expect(answer).not.toMatchObject({ reason: 'host_key_changed' })
    expect(fake.sourceChecks).toHaveLength(1)
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the setup of a connected site', () => {
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
    await db.gitRepository.deleteMany({ where: { site: inWorkspaces } })
    await db.site.deleteMany({ where: inWorkspaces })
    await db.creditLedger.deleteMany({ where: { account: inWorkspaces } })
    await db.billingAccount.deleteMany({ where: inWorkspaces })
    await db.auditLog.deleteMany({ where: inWorkspaces })
    await db.workspace.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function account() {
    const owner = await db.user.create({
      data: { name: 'Site setup', email: `${randomUUID()}@site-setup.example.ru` },
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

  /** A site made by the wizard, with an sftp source; its import queued. */
  async function connected(who: Awaited<ReturnType<typeof account>>) {
    return createdProject(who.caller.project.create(siteCreateInput()))
  }

  /** What a worker of core leaves when the import fails. */
  const fail = (siteId: string, errorCode = 'auth_failed') =>
    db.siteProvisioningStage.update({
      where: { siteId_stage: { siteId, stage: 'code_import' } },
      data: {
        status: 'failed',
        step: null,
        errorCode,
        startedAt: new Date(),
        finishedAt: new Date(),
        leaseEpoch: 1,
        summary: { files: 10 },
      },
    })

  /** «Повторить» or «Изменить доступ» as many times as the audit log says, within the hour. */
  const spend = (siteId: string, workspaceId: string, count: number) =>
    db.auditLog.createMany({
      data: Array.from({ length: count }, () => ({
        actorType: 'user' as const,
        action: 'site.setup.retry',
        targetType: 'site',
        targetId: siteId,
        workspaceId,
      })),
    })

  const stageOf = (siteId: string) =>
    db.siteProvisioningStage.findUniqueOrThrow({
      where: { siteId_stage: { siteId, stage: 'code_import' } },
    })

  it('tells each state of the first import, and nothing of the access but its public columns', async () => {
    const who = await account()
    const project = await connected(who)

    const pending = await who.caller.siteConnection.setup({ id: project.id })
    expect(pending).toEqual({
      state: 'pending',
      status: 'queued',
      step: null,
      errorCode: null,
      attempt: 1,
      updatedAt: expect.any(Date),
      retry: 'unavailable',
      replaceAccess: false,
      source: {
        kind: 'sftp',
        host: 'files.example.ru',
        port: 22,
        rootPath: '/var/www/site',
        tls: null,
        hostKey: FAKE_HOST_KEY,
      },
      initialVersion: null,
      summary: null,
    })
    const text = JSON.stringify(pending)
    for (const value of Object.values(SECRET_VALUES)) expect(text).not.toContain(value)
    expect(text).not.toContain('kv/sites')

    await db.siteProvisioningStage.update({
      where: { siteId_stage: { siteId: project.id, stage: 'code_import' } },
      data: { status: 'running', step: 'fetch', startedAt: new Date(), leaseEpoch: 1 },
    })
    await expect(who.caller.siteConnection.setup({ id: project.id })).resolves.toMatchObject({
      state: 'pending',
      status: 'running',
      step: 'fetch',
    })

    await fail(project.id, 'source_too_large')
    await expect(who.caller.siteConnection.setup({ id: project.id })).resolves.toMatchObject({
      state: 'failed',
      status: 'failed',
      step: null,
      errorCode: 'source_too_large',
      retry: 'available',
      replaceAccess: true,
      summary: { files: 10 },
    })

    // Succeeded, with the first version written before the push and confirmed after it.
    const repository = await db.gitRepository.create({
      data: {
        siteId: project.id,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${project.id}`,
        url: `https://git.example.ru/sites/site-${project.id}`,
      },
    })
    await db.siteInitialVersion.create({
      data: {
        siteId: project.id,
        gitRepositoryId: repository.id,
        commitSha: 'c'.repeat(40),
        tag: 'v0.0.0',
        files: 10,
        bytes: 2048,
        leaseEpoch: 1,
      },
    })
    await db.siteProvisioningStage.update({
      where: { siteId_stage: { siteId: project.id, stage: 'code_import' } },
      data: { status: 'succeeded', step: null, errorCode: null, finishedAt: new Date() },
    })
    // Not confirmed yet: no first version to show.
    await expect(who.caller.siteConnection.setup({ id: project.id })).resolves.toMatchObject({
      state: 'done',
      initialVersion: null,
    })
    const importedAt = new Date('2026-10-17T12:30:00Z')
    await db.siteInitialVersion.update({ where: { siteId: project.id }, data: { importedAt } })
    const initialVersion = { tag: 'v0.0.0', commitSha: 'c'.repeat(40), importedAt }
    await expect(who.caller.siteConnection.setup({ id: project.id })).resolves.toMatchObject({
      state: 'done',
      retry: 'unavailable',
      initialVersion,
    })
    // The page and the list of the cabinet tell the same.
    await expect(who.caller.project.get({ id: project.id })).resolves.toMatchObject({
      setup: 'done',
      initialVersion,
    })
    await expect(who.caller.project.list()).resolves.toEqual([
      expect.objectContaining({ id: project.id, setup: 'done' }),
    ])
  })

  it('checks the basics of a first site without making the personal workspace, and of the next ones by the same rules', async () => {
    const who = await account()
    await expect(who.caller.siteConnection.checkBasics(basics)).resolves.toMatchObject({
      url: 'https://xn--e1aiboc0b6e.xn--p1ai',
    })
    expect(await db.workspace.count({ where: { createdById: who.owner.id } })).toBe(0)

    const project = await createdProject(
      who.caller.project.create(siteCreateInput({ url: 'https://xn--e1aiboc0b6e.xn--p1ai' })),
    )
    await expect(who.caller.siteConnection.checkBasics(basics)).rejects.toMatchObject({
      cause: { code: 'PROJECT_ALREADY_EXISTS' },
    })
    for (const index of [1, 2]) {
      await createdProject(
        who.caller.project.create(siteCreateInput({ url: `https://more-${index}.example.ru` })),
      )
    }
    await expect(
      who.caller.siteConnection.checkBasics({ ...basics, url: 'https://next.example.ru' }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_CONNECTIONS_BUSY' } })
    // An import that failed is not in progress.
    await fail(project.id)
    await expect(
      who.caller.siteConnection.checkBasics({ ...basics, url: 'https://next.example.ru' }),
    ).resolves.toMatchObject({ url: 'https://next.example.ru' })
  })

  it('answers null for a site from before the wizard: it lives as it did', async () => {
    const who = await account()
    const workspace = await db.workspace.create({
      data: {
        name: 'Мои проекты',
        createdById: who.owner.id,
        dataClass: 'synthetic',
        members: { create: { userId: who.owner.id, role: 'owner' } },
      },
    })
    const legacy = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Старый',
        url: 'https://old.example.ru',
        stack: 'wordpress',
      },
    })
    await expect(who.caller.siteConnection.setup({ id: legacy.id })).resolves.toEqual({
      state: null,
      status: null,
      step: null,
      errorCode: null,
      attempt: null,
      updatedAt: null,
      retry: 'unavailable',
      replaceAccess: false,
      source: null,
      initialVersion: null,
      summary: null,
    })
    await expect(who.caller.project.list()).resolves.toEqual([
      expect.objectContaining({ id: legacy.id, setup: null }),
    ])
  })

  it('answers «not found» for a site of someone else, for setup, retry and replaceAccess alike', async () => {
    const owner = await account()
    const stranger = await account()
    const project = await connected(owner)
    await fail(project.id)

    for (const id of [project.id, randomUUID()]) {
      for (const call of [
        () => stranger.caller.siteConnection.setup({ id }),
        () => stranger.caller.siteConnection.retry({ id }),
        () => stranger.caller.siteConnection.replaceAccess({ id, source: sftpSource() }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Не нашли то, что вы ищете',
        })
      }
    }
    // Nothing was checked for the stranger.
    expect(stranger.fake.sourceChecks).toEqual([])
    expect((await stageOf(project.id)).status).toBe('failed')
  })

  it('queues a failed import again as its next attempt, with an event and an audit entry', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)

    const setup = await who.caller.siteConnection.retry({ id: project.id })

    expect(setup).toMatchObject({ state: 'pending', status: 'queued', attempt: 2, errorCode: null })
    expect(await stageOf(project.id)).toMatchObject({
      status: 'queued',
      attempt: 2,
      enqueues: 1,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
      heartbeatAt: null,
      step: null,
      // The fencing token goes on; the summary of the run before is kept.
      leaseEpoch: 1,
      summary: { files: 10 },
    })
    const events = await db.outboxEvent.findMany({
      where: { dedupeKey: { startsWith: `site-provisioning:${project.id}:` } },
      orderBy: { createdAt: 'asc' },
    })
    expect(events.map(({ dedupeKey, payload }) => [dedupeKey, payload])).toEqual([
      [
        siteProvisionDedupeKey(project.id, 'code_import', 1, 1),
        { siteId: project.id, stage: 'code_import' },
      ],
      [
        siteProvisionDedupeKey(project.id, 'code_import', 2, 1),
        { siteId: project.id, stage: 'code_import' },
      ],
    ])
    expect(
      await db.auditLog.findMany({
        where: { targetId: project.id, action: 'site.setup.retry' },
        select: { actorType: true, actorId: true, meta: true },
      }),
    ).toEqual([{ actorType: 'user', actorId: who.owner.id, meta: {} }])
  })

  it.each(['queued', 'running', 'succeeded'] as const)(
    'does not retry an import that is %s',
    async (status) => {
      const who = await account()
      const project = await connected(who)
      await db.siteProvisioningStage.update({
        where: { siteId_stage: { siteId: project.id, stage: 'code_import' } },
        data: {
          status,
          finishedAt: status === 'succeeded' ? new Date() : null,
          startedAt: status === 'queued' ? null : new Date(),
        },
      })
      for (const call of [
        () => who.caller.siteConnection.retry({ id: project.id }),
        () => who.caller.siteConnection.replaceAccess({ id: project.id, source: sftpSource() }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: 'CONFLICT',
          message:
            'Настройку сейчас нельзя повторить. Обновите страницу, чтобы увидеть, как она идёт',
          cause: { code: 'SITE_SETUP_NOT_FAILED' },
        })
      }
      expect(who.fake.sourceChecks).toHaveLength(1)
    },
  )

  it('does not retry the import of a site that is no longer being connected', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)
    await db.site.update({ where: { id: project.id }, data: { status: 'paused' } })
    await expect(who.caller.siteConnection.retry({ id: project.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'SITE_SETUP_UNAVAILABLE' },
    })
  })

  it('lets one of two concurrent retries through', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)

    const results = await Promise.allSettled([
      who.caller.siteConnection.retry({ id: project.id }),
      who.caller.siteConnection.retry({ id: project.id }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { cause: { code: 'SITE_SETUP_NOT_FAILED' } },
    })
    expect(await stageOf(project.id)).toMatchObject({ status: 'queued', attempt: 2 })
  })

  it('retries at most retriesPerHour times an hour, «Изменить доступ» included', async () => {
    const who = await account()
    const project = await connected(who)
    const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: project.id } })
    await fail(project.id)
    await spend(project.id, workspaceId, siteConnectionLimits.retriesPerHour - 2)

    // One «Повторить» and one «Изменить доступ» spend the rest.
    await who.caller.siteConnection.retry({ id: project.id })
    await fail(project.id)
    await expect(
      who.caller.siteConnection.replaceAccess({ id: project.id, source: sftpSource() }),
    ).resolves.toEqual({ outcome: 'replaced' })
    await fail(project.id)

    await expect(who.caller.siteConnection.setup({ id: project.id })).resolves.toMatchObject({
      retry: 'limited',
      replaceAccess: false,
    })
    for (const call of [
      () => who.caller.siteConnection.retry({ id: project.id }),
      () => who.caller.siteConnection.replaceAccess({ id: project.id, source: sftpSource() }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: 'Повторять настройку можно не чаще шести раз в час. Попробуйте немного позже',
        cause: { code: 'SITE_SETUP_RETRIES_LIMITED' },
      })
    }
    // An entry older than an hour no longer counts.
    await db.auditLog.updateMany({
      where: { targetId: project.id },
      data: { createdAt: new Date(Date.now() - 61 * 60_000) },
    })
    await expect(who.caller.siteConnection.retry({ id: project.id })).resolves.toMatchObject({
      status: 'queued',
    })
  })

  it('replaces an sftp access by an ftp one: a new reference and source, the old reference gone, the import queued', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)
    const before = await db.credentialRef.findMany({ where: { siteId: project.id } })

    await expect(
      who.caller.siteConnection.replaceAccess({ id: project.id, source: ftpSource() }),
    ).resolves.toEqual({ outcome: 'replaced' })

    // Checked like at creation, then written as the first version of its own path.
    expect(who.fake.sourceChecks.at(-1)!.context.pinRequired).toBe(true)
    expect(who.fake.secrets.writes.at(-1)).toMatchObject({
      path: `kv/sites/${project.id}/ftp`,
      cas: 0,
      version: 1,
    })
    const refs = await db.credentialRef.findMany({ where: { siteId: project.id } })
    expect(
      refs.map(({ kind, vaultPath, keyVersion }) => ({ kind, vaultPath, keyVersion })),
    ).toEqual([{ kind: 'ftp', vaultPath: `kv/sites/${project.id}/ftp`, keyVersion: 1 }])
    expect(refs[0]!.id).not.toBe(before[0]!.id)
    expect(
      await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
    ).toMatchObject({
      kind: 'ftp',
      host: 'files.example.ru',
      port: 21,
      rootPath: 'public_html',
      tls: 'verified',
      hostKey: null,
      credentialRefId: refs[0]!.id,
    })
    expect(await stageOf(project.id)).toMatchObject({ status: 'queued', attempt: 2, enqueues: 1 })
    expect(
      await db.outboxEvent.count({
        where: { dedupeKey: siteProvisionDedupeKey(project.id, 'code_import', 2, 1) },
      }),
    ).toBe(1)
    expect(
      await db.auditLog.findMany({
        where: { targetId: project.id, action: 'site.access.replace' },
        select: { meta: true },
      }),
    ).toEqual([{ meta: { kind: 'ftp', version: 1 } }])
    // The secret of the sftp access stays in Vault without a reference.
    expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${project.id}`)
    const written = JSON.stringify(
      await db.siteCodeSource.findMany({ where: { siteId: project.id } }),
    )
    for (const value of Object.values(SECRET_VALUES)) expect(written).not.toContain(value)
  })

  it('replaces an access of the same kind as the next version of its secret', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)
    const [ref] = await db.credentialRef.findMany({ where: { siteId: project.id } })

    await expect(
      who.caller.siteConnection.replaceAccess({
        id: project.id,
        source: sftpSource({ rootPath: '/home/site/www' }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })

    expect(who.fake.secrets.writes.at(-1)).toMatchObject({
      path: `kv/sites/${project.id}/ssh`,
      cas: 1,
      version: 2,
    })
    expect(await db.credentialRef.findMany({ where: { siteId: project.id } })).toEqual([
      expect.objectContaining({ id: ref!.id, kind: 'ssh', keyVersion: 2 }),
    ])
    expect(
      await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
    ).toMatchObject({
      rootPath: '/home/site/www',
      credentialRefId: ref!.id,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a refused login',
      { ok: false, reason: 'auth_failed' } as const,
      sftpSource(),
      { reason: 'auth_failed' },
    ],
    [
      // To a server the site is not pinned to: the adapter refuses before it connects, with no key.
      'an sftp access without the confirmed key',
      null,
      (() => {
        const { hostKey: _hostKey, ...withoutKey } = sftpSource({ host: 'new.example.ru' })
        return withoutKey as never
      })(),
      { reason: 'host_key_changed' },
    ],
    [
      'another key for the pinned server, not accepted',
      null,
      sftpSource({ hostKey: OTHER_HOST_KEY }),
      { reason: 'host_key_changed', hostKey: OTHER_HOST_KEY },
    ],
  ])('writes nothing on %s and answers source_refused', async (_case, answer, source, refusal) => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)
    const writes = who.fake.secrets.writes.length
    if (answer) who.fake.answerSource(answer)

    await expect(
      who.caller.siteConnection.replaceAccess({ id: project.id, source }),
    ).resolves.toEqual({ outcome: 'source_refused', ...refusal })

    expect(who.fake.secrets.writes).toHaveLength(writes)
    expect(await stageOf(project.id)).toMatchObject({ status: 'failed', attempt: 1 })
    expect(
      await db.auditLog.count({ where: { targetId: project.id, action: 'site.access.replace' } }),
    ).toBe(0)
  })

  /** Every check of the files passes with the key the input sent, as a server presenting it would. */
  const passWithSentKey = (input: CodeSourceInput) => ({
    ok: true as const,
    hostKey: input.kind === 'sftp' ? (input.hostKey ?? null) : null,
    canonicalUrl: null,
    defaultBranch: null,
    entries: 3,
  })

  describe('the key of the pinned server', () => {
    it('refuses another key without a connection or a write, and pins it once the user accepts it', async () => {
      const who = await account()
      const project = await connected(who)
      await fail(project.id)
      const checks = who.fake.sourceChecks.length
      const writes = who.fake.secrets.writes.length
      who.fake.presentHostKey(OTHER_HOST_KEY)
      const changed = sftpSource({ hostKey: OTHER_HOST_KEY })

      await expect(
        who.caller.siteConnection.replaceAccess({ id: project.id, source: changed }),
      ).resolves.toEqual({
        outcome: 'source_refused',
        reason: 'host_key_changed',
        hostKey: OTHER_HOST_KEY,
      })
      expect(who.fake.sourceChecks).toHaveLength(checks)
      expect(who.fake.secrets.writes).toHaveLength(writes)
      // Only `true` accepts it.
      await expect(
        who.caller.siteConnection.replaceAccess({
          id: project.id,
          source: changed,
          acceptNewHostKey: false,
        }),
      ).resolves.toMatchObject({ outcome: 'source_refused', reason: 'host_key_changed' })

      await expect(
        who.caller.siteConnection.replaceAccess({
          id: project.id,
          source: changed,
          acceptNewHostKey: true,
        }),
      ).resolves.toEqual({ outcome: 'replaced' })
      // Checked against the new key, then pinned in the secret and in the row.
      expect(who.fake.sourceChecks.at(-1)).toMatchObject({
        input: { hostKey: OTHER_HOST_KEY },
        context: { pinRequired: true },
      })
      expect(who.fake.secrets.writes.at(-1)!.data).toMatchObject({ hostKey: OTHER_HOST_KEY })
      expect(
        await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
      ).toMatchObject({ hostKey: OTHER_HOST_KEY })
    })

    it('takes the key of another port as the first key of a server it was never pinned to', async () => {
      const who = await account()
      const project = await connected(who)
      await fail(project.id)
      who.fake.presentHostKey(OTHER_HOST_KEY)

      await expect(
        who.caller.siteConnection.replaceAccess({
          id: project.id,
          source: sftpSource({ port: 2222, hostKey: OTHER_HOST_KEY }),
        }),
      ).resolves.toEqual({ outcome: 'replaced' })
      expect(
        await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
      ).toMatchObject({ port: 2222, hostKey: OTHER_HOST_KEY })
    })

    it('compares under the lock with the key a concurrent replacement pinned, and logs the version it wrote', async () => {
      const who = await account()
      const project = await connected(who)
      await fail(project.id)
      let concurrent: Promise<unknown> | null = null
      who.fake.answerSource(async (input) => {
        // While this check runs, another tab accepts a new key; its import then fails again.
        if (concurrent === null) {
          concurrent = who.caller.siteConnection
            .replaceAccess({
              id: project.id,
              source: sftpSource({ hostKey: OTHER_HOST_KEY }),
              acceptNewHostKey: true,
            })
            .then(async (outcome) => {
              await fail(project.id)
              return outcome
            })
          await concurrent
        }
        return passWithSentKey(input)
      })

      // Sent with the key this tab saw pinned: under the lock it is another than the pinned one.
      await expect(
        who.caller.siteConnection.replaceAccess({ id: project.id, source: sftpSource() }),
      ).resolves.toEqual({
        outcome: 'source_refused',
        reason: 'host_key_changed',
        hostKey: FAKE_HOST_KEY,
      })
      await expect(concurrent).resolves.toEqual({ outcome: 'replaced' })
      expect(
        await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
      ).toMatchObject({ hostKey: OTHER_HOST_KEY })
      // Version 3 of the secret is in Vault, the reference names version 2.
      expect(who.fake.secrets.writes.map(({ version }) => version)).toEqual([1, 2, 3])
      expect(await db.credentialRef.findMany({ where: { siteId: project.id } })).toEqual([
        expect.objectContaining({ kind: 'ssh', keyVersion: 2 }),
      ])
      expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${project.id}`)
      expect(await stageOf(project.id)).toMatchObject({ status: 'failed' })
    })
  })

  it('replaces the reference the source has at the commit, not the one it had when the request came', async () => {
    const who = await account()
    const project = await connected(who)
    await fail(project.id)
    let concurrent: Promise<unknown> | null = null
    who.fake.answerSource(async (input) => {
      // While this check runs, another tab replaces the sftp access by an ftp one, and its import fails.
      if (concurrent === null) {
        concurrent = who.caller.siteConnection
          .replaceAccess({ id: project.id, source: ftpSource() })
          .then(async (outcome) => {
            await fail(project.id)
            return outcome
          })
        await concurrent
      }
      return passWithSentKey(input)
    })

    await expect(
      who.caller.siteConnection.replaceAccess({
        id: project.id,
        source: sftpSource({ rootPath: '/home/site/www' }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })
    await expect(concurrent).resolves.toEqual({ outcome: 'replaced' })

    // The ftp reference of the other tab goes; no reference is left that nothing uses.
    const refs = await db.credentialRef.findMany({ where: { siteId: project.id } })
    expect(refs.map(({ kind, keyVersion }) => ({ kind, keyVersion }))).toEqual([
      { kind: 'ssh', keyVersion: 2 },
    ])
    expect(
      await db.siteCodeSource.findUniqueOrThrow({ where: { siteId: project.id } }),
    ).toMatchObject({ kind: 'sftp', rootPath: '/home/site/www', credentialRefId: refs[0]!.id })
    await expect(who.caller.project.credentials({ id: project.id })).resolves.toEqual([
      expect.objectContaining({ kind: 'ssh', version: 2 }),
    ])
  })

  describe('the imports in progress of the user', () => {
    /** connectionsInProgressPerUser sites queued, and one more whose import failed. */
    async function busyWithOneFailed() {
      const who = await account()
      const failed = await connected(who)
      await fail(failed.id)
      for (let index = 0; index < siteConnectionLimits.connectionsInProgressPerUser; index += 1) {
        await createdProject(
          who.caller.project.create(siteCreateInput({ url: `https://busy-${index}.example.ru` })),
        )
      }
      return { who, failed }
    }
    const busy = {
      code: 'TOO_MANY_REQUESTS',
      message:
        'Сейчас подключаются три ваших сайта. Дождитесь, пока закончится хотя бы одно подключение',
      cause: { code: 'SITE_CONNECTIONS_BUSY' },
    }

    it('refuses «Повторить» and «Изменить доступ» at the limit, before any server is asked, and lets them through below it', async () => {
      const { who, failed } = await busyWithOneFailed()
      const checks = who.fake.sourceChecks.length
      const writes = who.fake.secrets.writes.length

      await expect(who.caller.siteConnection.retry({ id: failed.id })).rejects.toMatchObject(busy)
      await expect(
        who.caller.siteConnection.replaceAccess({ id: failed.id, source: sftpSource() }),
      ).rejects.toMatchObject(busy)
      expect(who.fake.sourceChecks).toHaveLength(checks)
      expect(who.fake.secrets.writes).toHaveLength(writes)
      expect(await stageOf(failed.id)).toMatchObject({ status: 'failed', attempt: 1 })
      // A refused one does not spend the budget of the hour.
      expect(await db.auditLog.count({ where: { targetId: failed.id } })).toBe(1)

      // One import ends: there is room for the failed one again.
      const one = await db.siteProvisioningStage.findFirstOrThrow({
        where: { status: 'queued', site: { workspace: { createdById: who.owner.id } } },
      })
      await db.siteProvisioningStage.update({
        where: { siteId_stage: { siteId: one.siteId, stage: 'code_import' } },
        data: { status: 'succeeded', finishedAt: new Date() },
      })
      await expect(who.caller.siteConnection.retry({ id: failed.id })).resolves.toMatchObject({
        status: 'queued',
        attempt: 2,
      })
    })

    it('counts again under the lock of the user: an import queued while the access was checked fills the room', async () => {
      const who = await account()
      const failed = await connected(who)
      await fail(failed.id)
      for (let index = 1; index < siteConnectionLimits.connectionsInProgressPerUser; index += 1) {
        await createdProject(
          who.caller.project.create(siteCreateInput({ url: `https://busy-${index}.example.ru` })),
        )
      }
      let created = false
      who.fake.answerSource(async (input) => {
        // The last free place is taken while «Изменить доступ» checks the new access.
        if (!created) {
          created = true
          await createdProject(
            who.caller.project.create(siteCreateInput({ url: 'https://last.example.ru' })),
          )
        }
        return passWithSentKey(input)
      })

      await expect(
        who.caller.siteConnection.replaceAccess({ id: failed.id, source: sftpSource() }),
      ).rejects.toMatchObject(busy)
      expect(await stageOf(failed.id)).toMatchObject({ status: 'failed', attempt: 1 })
      // The version written before the transaction has no reference.
      expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${failed.id}`)
      expect(await db.credentialRef.findMany({ where: { siteId: failed.id } })).toEqual([
        expect.objectContaining({ kind: 'ssh', keyVersion: 1 }),
      ])
    })
  })
})
