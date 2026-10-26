import { createHash, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  type CodeSourceInput,
  type DbPlanView,
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
  fakeSiteConnections,
  finishImports,
  ftpSource,
  mysqlDatabase,
  OTHER_HOST_KEY,
  SECRET_VALUES,
  sftpSource,
  siteCreateInput,
} from '../testing/site-connections.ts'
import type { Context } from '../trpc.ts'

// «Переменные → Доступы» (owner's request of 26.10.2026): an access of a working site changed by
// siteConnection.changeSource and changeDatabase, saved only once a connection with it succeeded.

const now = new Date('2026-10-26T09:00:00Z')
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const SHA = (digit: string) => digit.repeat(40)

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  resetSiteConnectionGate()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

function context(prisma: PrismaClient, services: SiteConnectionServices, user: User): Context {
  return {
    prisma,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: 'site-access-change-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
    siteConnections: services,
  }
}

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: «Изменить» an access of a working site', () => {
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
    await db.siteLease.deleteMany({ where: { site: inWorkspaces } })
    await db.task.deleteMany({ where: inWorkspaces })
    await deleteSiteConnectionRows(db, workspaceIds)
    await db.gitRepository.deleteMany({ where: { site: inWorkspaces } })
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

  async function person(): Promise<User> {
    const user = await db.user.create({
      data: { name: 'Site access', email: `${randomUUID()}@site-access.example.ru` },
    })
    userIds.push(user.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({
        ...consent,
        userId: user.id,
        source: 'sign_up',
      })),
    })
    return user
  }

  /**
   * A site the wizard made — sftp, and the database when `withDatabase` — whose first import
   * succeeded: the site works. `imported: false` leaves the import queued, as create does.
   */
  async function workingSite(options: { withDatabase?: boolean; imported?: boolean } = {}) {
    const owner = await person()
    const fake = fakeSiteConnections()
    const caller = createCaller(context(db, fake.services, owner))
    const project = await createdProject(
      caller.project.create(
        siteCreateInput(options.withDatabase ? { database: mysqlDatabase() } : {}),
      ),
    )
    if (options.imported !== false) await finishImports(db, owner.id)
    const site = await db.site.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspaceId: true },
    })
    return { owner, fake, caller, siteId: project.id, workspaceId: site.workspaceId }
  }

  const variable = (siteId: string, name: string) =>
    db.siteEnvVar.findUnique({ where: { siteId_name: { siteId, name } } })

  /**
   * Every check of the files passes with the key the input sent, after `meanwhile` — what happens
   * while the server of the site is being asked.
   */
  const passAfter = (meanwhile: () => Promise<unknown>) => async (input: CodeSourceInput) => {
    await meanwhile()
    return {
      ok: true as const,
      hostKey: input.kind === 'sftp' ? (input.hostKey ?? null) : null,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 3,
    }
  }

  const latestWrite = (fake: ReturnType<typeof fakeSiteConnections>, path: string) =>
    fake.secrets.writes.filter((write) => write.path === path).at(-1)

  const changes = (siteId: string) =>
    db.auditLog.findMany({
      where: { targetId: siteId, action: 'site.access.change' },
      select: { meta: true },
    })

  it('changes the access to the files as the next version of its secret, and queues nothing', async () => {
    const { fake, caller, siteId } = await workingSite()
    const [ref] = await db.credentialRef.findMany({ where: { siteId } })
    const stage = await db.siteProvisioningStage.findFirstOrThrow({ where: { siteId } })
    const password = 'changed-source-password-5d21'

    await expect(
      caller.siteConnection.changeSource({
        id: siteId,
        source: sftpSource({
          rootPath: '/home/site/www',
          auth: { method: 'password', password },
        }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })

    // Checked like at creation, and only then written.
    expect(fake.sourceChecks.at(-1)!.context.pinRequired).toBe(true)
    expect(
      fake.secrets.writes.find((write) => write.path === `kv/sites/${siteId}/ssh`),
    ).toBeDefined()
    expect(await db.credentialRef.findMany({ where: { siteId } })).toEqual([
      expect.objectContaining({ id: ref!.id, kind: 'ssh', keyVersion: 2 }),
    ])
    expect(await db.siteCodeSource.findUniqueOrThrow({ where: { siteId } })).toMatchObject({
      rootPath: '/home/site/www',
      credentialRefId: ref!.id,
    })
    // The site goes on: the stage is the succeeded one, no attempt is queued.
    expect(await db.siteProvisioningStage.findFirstOrThrow({ where: { siteId } })).toMatchObject({
      status: 'succeeded',
      attempt: stage.attempt,
    })
    expect(await changes(siteId)).toEqual([{ meta: { kind: 'ssh', version: 2 } }])
    // The variable of the password follows the access.
    expect(await variable(siteId, 'SFTP_PASSWORD')).toMatchObject({ keyVersion: 2 })
    expect(fake.secrets.writes.at(-1)).toMatchObject({
      path: expect.stringMatching(new RegExp(`^kv/sites/${siteId}/env/`)),
    })
    expect(
      fake.secrets.writes.some(
        (write) =>
          write.path === `kv/sites/${siteId}/env/SFTP_PASSWORD` && write.data.value === password,
      ),
    ).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes an sftp access over by an ftp one: a new reference, and the variables of the new kind', async () => {
    const { caller, siteId } = await workingSite()
    const [before] = await db.credentialRef.findMany({ where: { siteId } })

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: ftpSource() }),
    ).resolves.toEqual({ outcome: 'replaced' })

    const refs = await db.credentialRef.findMany({ where: { siteId } })
    expect(refs.map(({ kind, keyVersion }) => ({ kind, keyVersion }))).toEqual([
      { kind: 'ftp', keyVersion: 1 },
    ])
    expect(refs[0]!.id).not.toBe(before!.id)
    expect(await db.siteCodeSource.findUniqueOrThrow({ where: { siteId } })).toMatchObject({
      kind: 'ftp',
      port: 21,
      hostKey: null,
      credentialRefId: refs[0]!.id,
    })
    expect(await variable(siteId, 'SFTP_PASSWORD')).toBeNull()
    expect(await variable(siteId, 'FTP_PASSWORD')).not.toBeNull()
    // The secret of the sftp access stays in Vault without a reference.
    expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${siteId}`)
  })

  it('writes nothing when the check with the new access fails', async () => {
    const { fake, caller, siteId } = await workingSite()
    const writes = fake.secrets.writes.length
    fake.answerSource({ ok: false, reason: 'auth_failed' })

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).resolves.toEqual({ outcome: 'source_refused', reason: 'auth_failed' })

    expect(fake.secrets.writes).toHaveLength(writes)
    expect(await db.credentialRef.findMany({ where: { siteId } })).toEqual([
      expect.objectContaining({ keyVersion: 1 }),
    ])
    expect(await changes(siteId)).toEqual([])
  })

  it('refuses another key of the pinned server without a connection, and takes it once accepted', async () => {
    const { fake, caller, siteId } = await workingSite()
    const checks = fake.sourceChecks.length

    await expect(
      caller.siteConnection.changeSource({
        id: siteId,
        source: sftpSource({ hostKey: OTHER_HOST_KEY }),
      }),
    ).resolves.toEqual({
      outcome: 'source_refused',
      reason: 'host_key_changed',
      hostKey: OTHER_HOST_KEY,
    })
    expect(fake.sourceChecks).toHaveLength(checks)

    fake.presentHostKey(OTHER_HOST_KEY)
    await expect(
      caller.siteConnection.changeSource({
        id: siteId,
        source: sftpSource({ hostKey: OTHER_HOST_KEY }),
        acceptNewHostKey: true,
      }),
    ).resolves.toEqual({ outcome: 'replaced' })
    expect(await db.siteCodeSource.findUniqueOrThrow({ where: { siteId } })).toMatchObject({
      hostKey: OTHER_HOST_KEY,
    })
  })

  it('changes the access to the database once SELECT 1 passed with it', async () => {
    const { fake, caller, siteId } = await workingSite({ withDatabase: true })
    const ref = await db.credentialRef.findFirstOrThrow({ where: { siteId, kind: 'db' } })

    fake.answerDatabase({ ok: false, reason: 'auth_failed' })
    const writes = fake.secrets.writes.length
    await expect(
      caller.siteConnection.changeDatabase({ id: siteId, database: mysqlDatabase() }),
    ).resolves.toEqual({ outcome: 'database_refused', reason: 'auth_failed' })
    expect(fake.secrets.writes).toHaveLength(writes)

    fake.answerDatabase({ ok: true, tables: 12 })
    await expect(
      caller.siteConnection.changeDatabase({
        id: siteId,
        database: mysqlDatabase({ host: 'db2.example.ru', password: 'changed-db-password-7a0c' }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })
    expect(fake.databaseChecks.at(-1)!.input.host).toBe('db2.example.ru')
    expect(await db.credentialRef.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({
      keyVersion: 2,
    })
    expect(await db.siteDatabase.findUniqueOrThrow({ where: { siteId } })).toMatchObject({
      host: 'db2.example.ru',
      credentialRefId: ref.id,
    })
    expect(await variable(siteId, 'SITE_DB_PASSWORD')).toMatchObject({ keyVersion: 2 })
    expect(await changes(siteId)).toEqual([{ meta: { kind: 'db', version: 2 } }])
    const written = JSON.stringify(await db.siteDatabase.findMany({ where: { siteId } }))
    for (const value of Object.values(SECRET_VALUES)) expect(written).not.toContain(value)
  })

  it('has nothing to change for a site without a database', async () => {
    const { caller, siteId } = await workingSite()
    await expect(
      caller.siteConnection.changeDatabase({ id: siteId, database: mysqlDatabase() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ACCESS_MISSING' } })
  })

  it('lets only an owner or an admin change an access, and tells the others nothing of it', async () => {
    const { fake, siteId, workspaceId } = await workingSite({ withDatabase: true })
    const member = await person()
    await db.member.create({ data: { workspaceId, userId: member.id, role: 'member' } })
    const caller = createCaller(context(db, fake.services, member))
    const checks = fake.sourceChecks.length

    await expect(caller.siteConnection.editableAccess({ id: siteId })).resolves.toEqual({
      canChange: false,
      busy: null,
      source: null,
      database: null,
    })
    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ACCESS_CHANGE_NOT_ALLOWED' } })
    await expect(
      caller.siteConnection.changeDatabase({ id: siteId, database: mysqlDatabase() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ACCESS_CHANGE_NOT_ALLOWED' } })
    expect(fake.sourceChecks).toHaveLength(checks)
  })

  it('gives the owner the public columns a form starts from, and never a login', async () => {
    const { caller, siteId } = await workingSite({ withDatabase: true })
    const editable = await caller.siteConnection.editableAccess({ id: siteId })
    expect(editable).toEqual({
      canChange: true,
      busy: null,
      source: {
        kind: 'sftp',
        host: 'files.example.ru',
        port: 22,
        rootPath: '/var/www/site',
        tls: null,
        hostKey: expect.any(String),
      },
      database: {
        engine: 'mysql',
        host: 'db.example.ru',
        port: 3306,
        databaseName: 'wordpress',
        tls: 'verified',
      },
    })
    for (const value of Object.values(SECRET_VALUES))
      expect(JSON.stringify(editable)).not.toContain(value)
  })

  it('refuses while the first import has not succeeded, before any server is asked', async () => {
    const { fake, caller, siteId } = await workingSite({ imported: false })
    const checks = fake.sourceChecks.length

    await expect(caller.siteConnection.editableAccess({ id: siteId })).resolves.toMatchObject({
      busy: 'setup',
    })
    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({
      cause: { code: 'SITE_ACCESS_CHANGE_BUSY', details: { reason: 'setup' } },
    })
    expect(fake.sourceChecks).toHaveLength(checks)
  })

  it('refuses while a release holds the site, and changes once it let go', async () => {
    const { fake, caller, siteId, workspaceId } = await workingSite()
    const task = await db.task.create({ data: { workspaceId, siteId, status: 'deploying' } })
    await db.siteLease.create({
      data: {
        siteId,
        holderTaskId: task.id,
        operation: 'deploy',
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    const writes = fake.secrets.writes.length

    await expect(caller.siteConnection.editableAccess({ id: siteId })).resolves.toMatchObject({
      busy: 'release',
    })
    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({
      cause: { code: 'SITE_ACCESS_CHANGE_BUSY', details: { reason: 'release' } },
    })
    expect(fake.secrets.writes).toHaveLength(writes)

    await db.siteLease.update({
      where: { siteId },
      data: { holderTaskId: null, operation: null, acquiredAt: null, expiresAt: null },
    })
    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).resolves.toEqual({ outcome: 'replaced' })
  })

  it('erases the version it wrote when the site was deleted while the access was checked', async () => {
    const { fake, caller, siteId } = await workingSite()
    const variableWrites = () => fake.secrets.writes.filter((write) => write.path.includes('/env/'))
    const before = variableWrites().length
    fake.answerSource(
      passAfter(() => db.site.update({ where: { id: siteId }, data: { deletedAt: new Date() } })),
    )

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } })

    // The password just written does not outlive the site: its key keeps a version without one.
    expect(latestWrite(fake, `kv/sites/${siteId}/ssh`)?.data).toEqual({
      removed: expect.any(String),
    })
    expect(variableWrites()).toHaveLength(before)
    expect(await changes(siteId)).toEqual([])
  })

  it('refuses under the lock a release whose outcome waits for the operator, set while the access was checked', async () => {
    const { fake, caller, siteId, workspaceId } = await workingSite()
    fake.answerSource(
      passAfter(async () => {
        const task = await db.task.create({ data: { workspaceId, siteId, status: 'deploying' } })
        await db.siteLease.create({
          data: {
            siteId,
            holderTaskId: task.id,
            operation: 'deploy',
            acquiredAt: new Date(),
            expiresAt: new Date(Date.now() - 60_000),
            heldForOperator: true,
          },
        })
      }),
    )

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({
      cause: { code: 'SITE_ACCESS_CHANGE_BUSY', details: { reason: 'unresolved' } },
    })
    expect(await db.credentialRef.findMany({ where: { siteId } })).toEqual([
      expect.objectContaining({ keyVersion: 1 }),
    ])
    await expect(caller.siteConnection.editableAccess({ id: siteId })).resolves.toMatchObject({
      busy: 'unresolved',
    })
  })

  it('names no older version than a change that committed while this one was checked', async () => {
    const { fake, caller, siteId } = await workingSite()
    fake.answerSource(
      passAfter(() =>
        db.credentialRef.updateMany({ where: { siteId, kind: 'ssh' }, data: { keyVersion: 9 } }),
      ),
    )
    const writes = () => fake.secrets.writes.filter((write) => write.path.includes('/env/'))
    const before = writes().length

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ACCESS_CHANGED' } })
    expect(await db.credentialRef.findMany({ where: { siteId } })).toEqual([
      expect.objectContaining({ keyVersion: 9 }),
    ])
    expect(writes()).toHaveLength(before)
  })

  it('reads the role again under the lock: an admin made a member meanwhile saves nothing', async () => {
    const { fake, siteId, workspaceId } = await workingSite()
    const admin = await person()
    await db.member.create({ data: { workspaceId, userId: admin.id, role: 'admin' } })
    const caller = createCaller(context(db, fake.services, admin))
    fake.answerSource(
      passAfter(() =>
        db.member.update({
          where: { workspaceId_userId: { workspaceId, userId: admin.id } },
          data: { role: 'member' },
        }),
      ),
    )

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).rejects.toMatchObject({ cause: { code: 'SITE_ACCESS_CHANGE_NOT_ALLOWED' } })
    expect(await changes(siteId)).toEqual([])
  })

  it('compares under the lock with the key a change pinned while this one was checked', async () => {
    const { fake, caller, siteId } = await workingSite()
    fake.answerSource(
      passAfter(() =>
        db.siteCodeSource.update({ where: { siteId }, data: { hostKey: OTHER_HOST_KEY } }),
      ),
    )

    await expect(
      caller.siteConnection.changeSource({ id: siteId, source: sftpSource() }),
    ).resolves.toMatchObject({ outcome: 'source_refused', reason: 'host_key_changed' })
    expect(await db.credentialRef.findMany({ where: { siteId } })).toEqual([
      expect.objectContaining({ keyVersion: 1 }),
    ])
    expect(warn).toHaveBeenCalledWith(`site_connection_orphan site=${siteId}`)
  })

  it('leaves no variable of the password once the access goes by a key', async () => {
    const { fake, caller, siteId } = await workingSite()
    expect(await variable(siteId, 'SFTP_PASSWORD')).not.toBeNull()

    await expect(
      caller.siteConnection.changeSource({
        id: siteId,
        source: sftpSource({ auth: { method: 'key', privateKey: 'synthetic-private-key-3c1d' } }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })

    expect(await variable(siteId, 'SFTP_PASSWORD')).toBeNull()
    expect(latestWrite(fake, `kv/sites/${siteId}/env/SFTP_PASSWORD`)?.data).toEqual({
      removed: expect.any(String),
    })
    expect(await variable(siteId, 'SFTP_PRIVATE_KEY')).not.toBeNull()
  })

  it('takes back the description of a database plan that holds a new value of the access', async () => {
    const { caller, siteId, workspaceId } = await workingSite()
    const password = 'changed-source-password-91fe'
    const task = await db.task.create({
      data: { workspaceId, siteId, status: 'awaiting_approval', turnNo: 1 },
    })
    const view: DbPlanView = {
      v: 1,
      planSha256: '0'.repeat(64),
      operations: [
        {
          kind: 'option_update',
          index: 0,
          objectRef: 'option:delivery_password',
          label: 'Пароль доставки',
          before: 'старый',
          after: password,
          truncated: false,
        },
      ],
      truncated: false,
      oversize: false,
    }
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task.id,
        revision: 1,
        turnNo: 1,
        baseSha: SHA('a'),
        baseTree: SHA('b'),
        headSha: SHA('c'),
        dbPlanSha256: '0'.repeat(64),
        dbView: view,
        dbViewSha256: createHash('sha256').update(JSON.stringify(view)).digest('hex'),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {
          changeType: 'content',
          risk: 'low',
          addedFiles: 0,
          modifiedFiles: 0,
          deletedFiles: 0,
          mediaFiles: 0,
          dbObjects: 1,
          newFunctionality: false,
        },
      },
    })

    await expect(
      caller.siteConnection.changeSource({
        id: siteId,
        source: sftpSource({ auth: { method: 'password', password } }),
      }),
    ).resolves.toEqual({ outcome: 'replaced' })

    expect(
      await db.taskCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { dbView: true, dbViewSha256: true },
      }),
    ).toEqual({ dbView: null, dbViewSha256: null })
  })
})
