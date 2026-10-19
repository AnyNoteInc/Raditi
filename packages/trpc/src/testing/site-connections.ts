import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  dbAccessSchema,
  ftpAccessSchema,
  sshAccessSchema,
  type AppEnv,
  type CodeSourceInput,
  type CodeSourceTarget,
  type ConnectionContext,
  type DatabaseCheckOutcome,
  type DatabaseEngine,
  type DatabaseInput,
  type DatabaseInspector,
  type DatabaseTarget,
  type FileSourceAdapter,
  type KvMetadata,
  type LookedUpAddress,
  type PreparedAccess,
  type SiteConnectionServices,
  type SiteSourceKind,
  type SourceCheckContext,
  type SourceCheckOutcome,
  type SourceCheckPassed,
} from '@repo/domain'
import { vi } from 'vitest'

// Test support of this package only (not exported from its index): the site connection services a context
// of `project.create` and `siteConnection.*` needs, without a network or Vault. The fakes behave as the
// contracts of @repo/domain describe the real adapters — an sftp check without a key answers
// `host_key_unknown`, a required key that is absent or another answers `host_key_changed` — and each can be
// told to answer otherwise. The secret store is the KV v2 of Vault as far as the procedures use it:
// versions from 1, CAS against the current version, every write recorded.

/** The key every fake sftp server presents unless a test says otherwise. */
export const FAKE_HOST_KEY = `ssh-ed25519 SHA256:${'Q'.repeat(42)}A`
export const OTHER_HOST_KEY = `ssh-ed25519 SHA256:${'Z'.repeat(42)}A`

/** Distinctive values: a test scans every written row for them. */
export const SECRET_VALUES = {
  sourceUser: 'fake-source-login-61c2',
  sourcePassword: 'fake-source-password-4b9e',
  databaseUser: 'fake-database-login-08ad',
  databasePassword: 'fake-database-password-e7f1',
} as const

export const sftpSource = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'sftp',
    host: 'files.example.ru',
    port: 22,
    username: SECRET_VALUES.sourceUser,
    auth: { method: 'password', password: SECRET_VALUES.sourcePassword },
    rootPath: '/var/www/site',
    hostKey: FAKE_HOST_KEY,
    ...overrides,
  }) as Extract<CodeSourceInput, { kind: 'sftp' }>

export const ftpSource = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'ftp',
    host: 'files.example.ru',
    port: 21,
    username: SECRET_VALUES.sourceUser,
    password: SECRET_VALUES.sourcePassword,
    rootPath: 'public_html',
    tls: 'verified',
    ...overrides,
  }) as Extract<CodeSourceInput, { kind: 'ftp' }>

export const mysqlDatabase = (overrides: Record<string, unknown> = {}) =>
  ({
    engine: 'mysql',
    host: 'db.example.ru',
    port: 3306,
    database: 'wordpress',
    username: SECRET_VALUES.databaseUser,
    password: SECRET_VALUES.databasePassword,
    tls: 'verified',
    ...overrides,
  }) as DatabaseInput

/** A valid input of `project.create`: an sftp source with the confirmed key, no database. */
export const siteCreateInput = (
  overrides: Partial<{
    requestKey: string
    name: string
    url: string
    stack: 'wordpress'
    source: CodeSourceInput
    database: DatabaseInput | null
  }> = {},
) => ({
  requestKey: randomUUID(),
  name: 'Мой сайт',
  url: 'https://example.ru',
  stack: 'wordpress' as const,
  source: sftpSource() as CodeSourceInput,
  database: null as DatabaseInput | null,
  ...overrides,
})

export interface FakeSecretWrite {
  path: string
  data: Record<string, string>
  cas: number | undefined
  version: number
}

export function fakeSecretStore() {
  const versions = new Map<string, number>()
  const writes: FakeSecretWrite[] = []
  const store = {
    writes,
    /** The next calls fail as an unreachable Vault does. */
    failure: null as Error | null,
    kvMetadata: vi.fn(async (path: string): Promise<KvMetadata | null> => {
      if (store.failure) throw store.failure
      const current = versions.get(path)
      return current === undefined
        ? null
        : {
            currentVersion: current,
            custom: {},
            createdTime: new Date('2026-10-17T00:00:00Z'),
            deleted: false,
            destroyed: false,
          }
    }),
    kvWrite: vi.fn(
      async (path: string, data: Record<string, string>, options?: { cas?: number }) => {
        if (store.failure) throw store.failure
        const current = versions.get(path) ?? 0
        if (options?.cas !== undefined && options.cas !== current) {
          throw Object.assign(new Error('check-and-set parameter did not match'), {
            name: 'VaultError',
            status: 400,
          })
        }
        const version = current + 1
        versions.set(path, version)
        writes.push({ path, data: { ...data }, cas: options?.cas, version })
        return { version }
      },
    ),
    /** A version written by someone else: the next CAS of the procedure must still find it. */
    preset(path: string, version: number) {
      versions.set(path, version)
    },
  }
  return store
}

export const vaultUnavailable = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8200'), { name: 'VaultError' })

type SourceResponder = (
  input: CodeSourceInput,
  context: SourceCheckContext,
) => SourceCheckOutcome | Promise<SourceCheckOutcome>
type DatabaseResponder = (
  input: DatabaseInput,
  context: ConnectionContext,
) => DatabaseCheckOutcome | Promise<DatabaseCheckOutcome>

const passed = (hostKey: string | null): SourceCheckOutcome => ({
  ok: true,
  hostKey,
  canonicalUrl: null,
  defaultBranch: null,
  entries: 12,
})

/**
 * What the real sftp adapter answers about the key of a server that presents `presented`. A required key
 * that is absent is refused before any connection, so that answer carries no key: none was presented.
 */
function sftpAnswer(
  input: Extract<CodeSourceInput, { kind: 'sftp' }>,
  pinRequired: boolean,
  presented: string,
): SourceCheckOutcome {
  if (input.hostKey === undefined) {
    return pinRequired
      ? { ok: false, reason: 'host_key_changed' }
      : { ok: false, reason: 'host_key_unknown', hostKey: presented }
  }
  if (input.hostKey !== presented)
    return { ok: false, reason: 'host_key_changed', hostKey: presented }
  return passed(presented)
}

function prepareSource(
  input: CodeSourceInput,
  check: SourceCheckPassed,
): PreparedAccess<CodeSourceTarget> {
  if (input.kind === 'ftp') {
    const secret = ftpAccessSchema.parse({
      v: '1',
      host: input.host,
      port: String(input.port),
      tls: input.tls,
      rootPath: input.rootPath,
      username: input.username,
      password: input.password,
    })
    return {
      accessKind: 'ftp',
      secret,
      target: {
        kind: 'ftp',
        host: input.host,
        port: input.port,
        rootPath: input.rootPath,
        repositoryUrl: null,
        branch: null,
        tls: input.tls,
        hostKey: null,
      },
    }
  }
  if (input.kind !== 'sftp' || check.hostKey === null) throw new Error('Not a checked sftp source')
  const auth =
    input.auth.method === 'password'
      ? { auth: 'password', password: input.auth.password }
      : {
          auth: 'key',
          privateKey: input.auth.privateKey,
          ...(input.auth.passphrase === undefined ? {} : { passphrase: input.auth.passphrase }),
        }
  const secret = sshAccessSchema.parse({
    v: '1',
    host: input.host,
    port: String(input.port),
    hostKey: check.hostKey,
    rootPath: input.rootPath,
    username: input.username,
    ...auth,
  })
  return {
    accessKind: 'ssh',
    secret: secret as Record<string, string>,
    target: {
      kind: 'sftp',
      host: input.host,
      port: input.port,
      rootPath: input.rootPath,
      repositoryUrl: null,
      branch: null,
      tls: null,
      hostKey: check.hostKey,
    },
  }
}

function prepareDatabase(input: DatabaseInput): PreparedAccess<DatabaseTarget> {
  const secret = dbAccessSchema.parse({
    v: '1',
    engine: input.engine,
    host: input.host,
    port: String(input.port),
    tls: input.tls,
    database: input.database,
    username: input.username,
    password: input.password,
  })
  return {
    accessKind: 'db',
    secret,
    target: {
      engine: input.engine,
      host: input.host,
      port: input.port,
      databaseName: input.database,
      tls: input.tls,
    },
  }
}

const unused = () => {
  throw new Error('Not used by the procedures of the transport')
}

export interface FakeSiteConnectionsOptions {
  appEnv?: AppEnv
  /** What every name resolves to; 127.0.0.1 by default (a local address: refused in production). */
  address?: string
}

/** The services, the store behind them and the controls of the fake servers. */
export function fakeSiteConnections(options: FakeSiteConnectionsOptions = {}) {
  const { appEnv = 'test', address = '127.0.0.1' } = options
  const secrets = fakeSecretStore()
  const lookup = vi.fn(async (_name: string, _signal: AbortSignal): Promise<LookedUpAddress[]> => [
    { address, family: address.includes(':') ? 6 : 4 },
  ])
  const control = {
    presentedHostKey: FAKE_HOST_KEY,
    sourceResponder: null as SourceResponder | null,
    databaseResponder: null as DatabaseResponder | null,
  }
  const sourceChecks: { input: CodeSourceInput; context: SourceCheckContext }[] = []
  const databaseChecks: { input: DatabaseInput; context: ConnectionContext }[] = []

  const sourceAdapter = (kind: 'ftp' | 'sftp'): FileSourceAdapter => ({
    kind,
    transfer: 'files',
    accessKind: kind === 'ftp' ? 'ftp' : 'ssh',
    accessSchema: kind === 'ftp' ? ftpAccessSchema : sshAccessSchema,
    defaultPort: kind === 'ftp' ? 21 : 22,
    endpoint: (input) => ({
      host: (input as { host: string }).host,
      port: (input as { port: number }).port,
    }),
    async check(input, context) {
      sourceChecks.push({ input, context })
      if (control.sourceResponder) return control.sourceResponder(input, context)
      return input.kind === 'sftp'
        ? sftpAnswer(input, context.pinRequired, control.presentedHostKey)
        : passed(null)
    },
    prepare: prepareSource,
    endpointOf: unused,
    matchesTarget: unused,
    scanValues: unused,
    open: unused,
  })
  const sources: Partial<Record<SiteSourceKind, FileSourceAdapter>> = {
    ftp: sourceAdapter('ftp'),
    sftp: sourceAdapter('sftp'),
  }
  const inspector = (engine: DatabaseEngine): DatabaseInspector => ({
    engine,
    accessKind: 'db',
    accessSchema: dbAccessSchema,
    defaultPort: engine === 'mysql' ? 3306 : 5432,
    endpoint: (input) => ({ host: input.host, port: input.port }),
    async check(input, context) {
      databaseChecks.push({ input, context })
      if (control.databaseResponder) return control.databaseResponder(input, context)
      return { ok: true, tables: 12 }
    },
    prepare: prepareDatabase,
    endpointOf: unused,
    matchesTarget: unused,
    scanValues: unused,
    readSchema: unused,
  })
  const databases = { mysql: inspector('mysql'), postgres: inspector('postgres') }

  const services: SiteConnectionServices = {
    appEnv,
    secrets,
    lookup,
    connectableStacks: ['wordpress'],
    rootMarkers: () => ['wp-content', 'wp-includes'],
    sources(kind) {
      const adapter = sources[kind]
      if (!adapter) throw new Error(`No adapter of kind ${kind}`)
      return adapter
    },
    databases: (engine) => databases[engine],
    sourceOptions: [
      { kind: 'sftp', defaultPort: 22 },
      { kind: 'ftp', defaultPort: 21 },
    ],
    databaseOptions: [
      { engine: 'mysql', defaultPort: 3306 },
      { engine: 'postgres', defaultPort: 5432 },
    ],
  }
  return {
    services,
    secrets,
    lookup,
    sourceChecks,
    databaseChecks,
    /** Every check of the files answers this from now on. */
    answerSource(responder: SourceResponder | SourceCheckOutcome) {
      control.sourceResponder = typeof responder === 'function' ? responder : () => responder
    },
    answerDatabase(responder: DatabaseResponder | DatabaseCheckOutcome) {
      control.databaseResponder = typeof responder === 'function' ? responder : () => responder
    },
    /** The key the fake sftp server presents. */
    presentHostKey(key: string) {
      control.presentedHostKey = key
    },
  }
}

/** The project of a `project.create` that created one; a test failure otherwise. */
export async function createdProject<T extends { outcome: string }>(
  creation: Promise<T>,
): Promise<Extract<T, { outcome: 'created' }> extends { project: infer P } ? P : never> {
  const outcome = await creation
  if (outcome.outcome !== 'created')
    throw new Error(`The project was not created: ${outcome.outcome}`)
  return (outcome as unknown as { project: never }).project
}

/**
 * What a worker of core does when the first import of a site succeeds, for tests that add more sites than
 * connectionsInProgressPerUser: nothing runs the imports here.
 */
export async function finishImports(db: PrismaClient, userId: string): Promise<void> {
  await db.siteProvisioningStage.updateMany({
    where: { status: { in: ['queued', 'running'] }, site: { workspace: { createdById: userId } } },
    data: { status: 'succeeded', step: null, finishedAt: new Date() },
  })
}

/**
 * Removes what `project.create` wrote besides the site and its workspace, for the cleanup of a test before
 * it deletes the sites: the references, the rows of the source and the database, the stages and the
 * initial version hold their site with Restrict keys; the outbox events and the audit entries are its own.
 */
export async function deleteSiteConnectionRows(
  db: PrismaClient,
  workspaceIds: string[],
): Promise<void> {
  const sites = await db.site.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  })
  const siteIds = sites.map(({ id }) => id)
  if (siteIds.length === 0) return
  const ofSites = { siteId: { in: siteIds } }
  await db.outboxEvent.deleteMany({
    where: { OR: siteIds.map((id) => ({ dedupeKey: { startsWith: `site-provisioning:${id}:` } })) },
  })
  await db.auditLog.deleteMany({ where: { targetType: 'site', targetId: { in: siteIds } } })
  await db.siteInitialVersion.deleteMany({ where: ofSites })
  await db.siteProvisioningStage.deleteMany({ where: ofSites })
  await db.siteCodeSource.deleteMany({ where: ofSites })
  await db.siteDatabase.deleteMany({ where: ofSites })
  await db.credentialRef.deleteMany({ where: ofSites })
}
