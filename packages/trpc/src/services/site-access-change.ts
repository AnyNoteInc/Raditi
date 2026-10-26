import { clientIp } from '@repo/auth'
import type { Prisma, PrismaClient } from '@repo/db'
import {
  DomainError,
  siteConnectionLimits,
  terminalReleaseStatuses,
  type CodeSourceInput,
  type CodeSourceTarget,
  type ConnectionCheckReason,
  type ConnectionTls,
  type DatabaseCheckOutcome,
  type DatabaseEngine,
  type DatabaseInput,
  type DatabaseTarget,
  type PreparedAccess,
  type SiteConnectionServices,
  type SiteSourceKind,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import {
  checkSiteDatabase,
  codeSourceColumns,
  databaseColumns,
  deadline,
  gatedChecks,
  logOrphanedSecrets,
  offersSource,
  sourceRefusal,
  storeSiteAccess,
  type StoredAccess,
} from './site-access.ts'
import { replaceAccessVariables } from './site-access-variables.ts'
import { accessibleSite, assertStackConnectable, siteNotFound } from './site-basics.ts'
import { eraseSiteSecret } from './site-delete.ts'
import { noteRefusedLogin, passSiteConnectionGate } from './site-connection-gate.ts'

// «Переменные → Доступы» (owner's request of 26.10.2026): an owner or an admin changes an access
// of a working site — to its files or to its database. As «Изменить доступ» of a failed import,
// the new access is saved only once a connection with it succeeded: it is checked as at creation,
// its secret goes to Vault as the next version before the transaction, and the reference names
// that version only in the transaction. Unlike it nothing is queued: the site goes on with the new
// access. Not while a release goes on — its job takes the access of the hosting at the start of
// each attempt, and a return would reach another server or folder — and not before the first
// import succeeded: that access is changed on the setup screen.

export const SITE_ACCESS_CHANGE_ACTION = 'site.access.change'

/**
 * Why an access is not changed now: a release goes on, the outcome of one is unknown and waits for
 * the operator, or the first import of the site has not succeeded.
 */
export type AccessChangeBusy = 'release' | 'unresolved' | 'setup'

export const siteAccessChangeNotAllowed = () =>
  new DomainError(
    'SITE_ACCESS_CHANGE_NOT_ALLOWED',
    'Only an owner or an admin changes the accesses of a site',
    403,
  )

export const siteAccessChangeBusy = (reason: AccessChangeBusy) =>
  new DomainError('SITE_ACCESS_CHANGE_BUSY', 'A release or the first import is not over', 409, {
    reason,
  })

/** The site has no access of this kind: there is nothing to change, adding one is not offered. */
export const siteAccessMissing = () =>
  new DomainError('SITE_ACCESS_MISSING', 'The site has no access of this kind', 409)

/** Another change of the same access saved a newer version first. */
export const siteAccessChanged = () =>
  new DomainError('SITE_ACCESS_CHANGED', 'The access was changed meanwhile', 409)

/** The kind of access a source of the site is stored as, by its adapter; null — none or unknown. */
export function accessKindOf(services: SiteConnectionServices, kind: string | null): string | null {
  if (kind === null) return null
  try {
    return services.sources(kind as SiteSourceKind).accessKind
  } catch {
    return null
  }
}

/** The source a site is connected with, as far as a new access to its files is compared with it. */
export interface PinnedSource {
  kind: string
  host: string
  port: number
  hostKey: string | null
}

/** A check of the files that refused, as the procedures answer it. */
export interface SourceRefused {
  outcome: 'source_refused'
  reason: ConnectionCheckReason
  suggestedRoot?: string
  hostKey?: string
}

/**
 * An sftp access to the server the site is pinned to — the same host and port — with a key other than the
 * pinned one, which the user did not accept explicitly («Принять новый ключ»): refused as `host_key_changed`
 * with the key the client sent, before any connection or write. null when nothing stands against the input:
 * an accepted key, another server, an ftp access, or a source with no key pinned.
 */
export function unacceptedHostKey(
  services: SiteConnectionServices,
  pinned: PinnedSource | null | undefined,
  source: CodeSourceInput,
  accepted: boolean,
): SourceRefused | null {
  // Only a kind that pins a key has one in its row (site_code_sources_host_key_check); another kind
  // of access to the same server is a new access, not a changed key.
  if (accepted || !pinned || pinned.hostKey === null || pinned.kind !== source.kind) return null
  const endpoint = services.sources(source.kind).endpoint(source)
  if (pinned.host !== endpoint.host || pinned.port !== endpoint.port) return null
  const presented = 'hostKey' in source ? source.hostKey : undefined
  if (presented === pinned.hostKey) return null
  return {
    outcome: 'source_refused',
    reason: 'host_key_changed',
    ...(presented === undefined ? {} : { hostKey: presented }),
  }
}

/** Why the accesses of the site are not changed now; null — they may be. */
async function busyReason(
  db: Pick<Prisma.TransactionClient, 'siteProvisioningStage' | 'siteRelease' | 'siteLease'>,
  siteId: string,
  now: Date,
): Promise<AccessChangeBusy | null> {
  const stage = await db.siteProvisioningStage.findFirst({
    where: { siteId, stage: 'code_import', status: { not: 'succeeded' } },
    select: { siteId: true },
  })
  if (stage !== null) return 'setup'
  // An approved release waits for the lease and then takes the access: it counts as one going on.
  const releases = await db.siteRelease.findMany({
    where: { siteId, status: { notIn: [...terminalReleaseStatuses] } },
    select: { status: true },
    take: 4,
  })
  const lease = await db.siteLease.findUnique({
    where: { siteId },
    select: { operation: true, expiresAt: true, heldForOperator: true, inflightReleaseId: true },
  })
  // An unknown outcome ends only by the operator (`releases:resolve`), not by waiting.
  if (lease?.heldForOperator || releases.some((release) => release.status === 'unknown'))
    return 'unresolved'
  if (
    releases.length > 0 ||
    (lease !== null &&
      (lease.inflightReleaseId !== null ||
        (lease.operation === 'deploy' && lease.expiresAt !== null && lease.expiresAt > now)))
  )
    return 'release'
  return null
}

/**
 * The row of the site under FOR UPDATE, then whether the change may still be made: a release is
 * created by an insert whose foreign key takes FOR KEY SHARE on this row, so it waits for this
 * transaction — and one inserted before is seen here; the role of the user is read again. A site
 * deleted while the access was checked had its secrets erased before the version just written:
 * that version is erased here (rule 2), then the site is not found.
 */
async function lockIdleSite(
  tx: Prisma.TransactionClient,
  request: AccessChangeRequest,
  site: { id: string; workspaceId: string },
  stored: StoredAccess<unknown>,
) {
  const now = new Date()
  const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM sites WHERE id = ${site.id}::uuid FOR UPDATE`
  if (rows[0] === undefined) throw siteNotFound()
  if (rows[0].deleted_at !== null) {
    await eraseSiteSecret(request.services.secrets, stored.vaultPath, now)
    throw siteNotFound()
  }
  if (!isManagerRole(await memberRole(tx, site.workspaceId, request.userId)))
    throw siteAccessChangeNotAllowed()
  const busy = await busyReason(tx, site.id, now)
  if (busy !== null) throw siteAccessChangeBusy(busy)
}

const changeSelect = {
  id: true,
  stack: true,
  url: true,
  workspaceId: true,
  codeSource: {
    select: { kind: true, host: true, port: true, rootPath: true, tls: true, hostKey: true },
  },
  database: {
    select: { engine: true, host: true, port: true, databaseName: true, tls: true },
  },
} as const

/** A site of the user they may change the accesses of: found, theirs to manage, and not busy. */
async function changeableSite(db: PrismaClient, userId: string, siteId: string, now: Date) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: changeSelect,
  })
  if (!site) throw siteNotFound()
  if (!isManagerRole(await memberRole(db, site.workspaceId, userId)))
    throw siteAccessChangeNotAllowed()
  // Fail fast, before any connection to a server: the transaction asks again under the lock.
  const busy = await busyReason(db, site.id, now)
  if (busy !== null) throw siteAccessChangeBusy(busy)
  return site
}

/** The audit entry of a change: the kind and the version only, never a host, a folder or a name. */
const auditEntry = (
  site: { id: string; workspaceId: string },
  request: { userId: string; headers: Headers },
  meta: { kind: string; version: number },
): Prisma.AuditLogCreateArgs['data'] => ({
  actorType: 'user',
  actorId: request.userId,
  workspaceId: site.workspaceId,
  action: SITE_ACCESS_CHANGE_ACTION,
  targetType: 'site',
  targetId: site.id,
  meta,
  ip: clientIp(request.headers),
})

/**
 * The reference of an access at its path names the version just written. Of two changes of the
 * same access the later write is the newer version: when it committed first, this one refuses
 * rather than name an older secret.
 */
async function referVersion(
  tx: Prisma.TransactionClient,
  site: { id: string; workspaceId: string },
  stored: StoredAccess<unknown>,
): Promise<{ id: string }> {
  const existing = await tx.credentialRef.findUnique({
    where: { vaultPath: stored.vaultPath },
    select: { id: true, keyVersion: true },
  })
  if (existing && existing.keyVersion >= stored.version) throw siteAccessChanged()
  return tx.credentialRef.upsert({
    where: { vaultPath: stored.vaultPath },
    create: {
      kind: stored.accessKind,
      workspaceId: site.workspaceId,
      siteId: site.id,
      vaultPath: stored.vaultPath,
      keyVersion: stored.version,
    },
    update: { keyVersion: stored.version },
    select: { id: true },
  })
}

/** The reference of another kind goes once nothing refers to it; its secret stays behind. */
async function dropUnreferenced(
  tx: Prisma.TransactionClient,
  siteId: string,
  previous: string | undefined,
  current: string,
): Promise<boolean> {
  if (previous === undefined || previous === current) return false
  const { count } = await tx.credentialRef.deleteMany({
    where: {
      id: previous,
      siteId,
      codeSources: { none: {} },
      databases: { none: {} },
      gitRepositories: { none: {} },
      llmProviders: { none: {} },
      subscriptionAccount: { is: null },
    },
  })
  return count === 1
}

export interface AccessChangeRequest {
  db: PrismaClient
  services: SiteConnectionServices
  userId: string
  headers: Headers
  siteId: string
}

export type SourceChangeOutcome = { outcome: 'replaced' } | SourceRefused

/**
 * «Изменить» of the access to the files: checked like at creation — the address pinned, the login, the
 * folder and the markers of the platform, an sftp key required and compared with the pinned one — then
 * written, and the site goes on with it. Another kind (FTP instead of SFTP) is a new reference, and the
 * variables of the old kind go. A refused check writes nothing.
 */
export async function changeSiteSource(
  request: AccessChangeRequest & { source: CodeSourceInput; acceptNewHostKey: boolean },
): Promise<SourceChangeOutcome> {
  const { db, services, userId, source } = request
  const site = await changeableSite(db, userId, request.siteId, new Date())
  if (!site.codeSource) throw siteAccessMissing()
  assertStackConnectable(services, site.stack)
  if (!offersSource(services, source.kind))
    return { outcome: 'source_refused', reason: 'unsupported' }
  const accepted = request.acceptNewHostKey
  const changed = unacceptedHostKey(services, site.codeSource, source, accepted)
  if (changed) return changed

  const budget = deadline(siteConnectionLimits.createBudgetMs)
  let prepared: PreparedAccess<CodeSourceTarget>
  let stored: StoredAccess<CodeSourceTarget>
  try {
    const checked = await gatedChecks(services, {
      userId,
      units: 2,
      stack: site.stack,
      source,
      database: null,
      pinRequired: true,
      ms: siteConnectionLimits.checkMs,
      parent: budget.signal,
    })
    if (!checked.source.ok) return { outcome: 'source_refused', ...sourceRefusal(checked.source) }
    const { ok: _ok, ...passed } = checked.source
    prepared = services.sources(source.kind).prepare(source, passed)
    stored = await storeSiteAccess(services.secrets, {
      siteId: site.id,
      prepared,
      signal: budget.signal,
    })
  } finally {
    budget.end()
  }

  let replacedKind = false
  let previousKind: string | null = null
  let outcome: SourceChangeOutcome
  try {
    outcome = await db.$transaction(
      async (tx): Promise<SourceChangeOutcome> => {
        await lockIdleSite(tx, request, site, stored)
        // The row of the source as it is now: a change that committed since the read above decides
        // which key is pinned and which reference this one replaces.
        const [current] = await tx.$queryRaw<(PinnedSource & { credentialRefId: string })[]>`
          SELECT kind::text AS kind, host, port, host_key AS "hostKey",
                 credential_ref_id::text AS "credentialRefId"
          FROM site_code_sources
          WHERE site_id = ${site.id}::uuid
          FOR UPDATE
        `
        if (current === undefined) throw siteAccessMissing()
        const refused = unacceptedHostKey(services, current, source, accepted)
        if (refused) return refused
        previousKind = current.kind
        const ref = await referVersion(tx, site, stored)
        const columns = { ...codeSourceColumns(stored.target), credentialRefId: ref.id }
        await tx.siteCodeSource.update({ where: { siteId: site.id }, data: columns })
        replacedKind = await dropUnreferenced(tx, site.id, current.credentialRefId, ref.id)
        await tx.auditLog.create({
          data: auditEntry(site, request, { kind: stored.accessKind, version: stored.version }),
        })
        return { outcome: 'replaced' }
      },
      { isolationLevel: 'ReadCommitted' },
    )
  } catch (error) {
    // The new version is in Vault and the reference still names the old one.
    logOrphanedSecrets(site.id)
    throw error
  }
  // A key refused under the lock leaves the version just written without a reference too.
  if (outcome.outcome !== 'replaced' || replacedKind) logOrphanedSecrets(site.id)
  if (outcome.outcome === 'replaced')
    await replaceAccessVariables(db, services.secrets, {
      siteId: site.id,
      userId,
      siteUrl: site.url,
      prepared,
      previousAccessKind: accessKindOf(services, previousKind),
      reference: { vaultPath: stored.vaultPath, version: stored.version },
      now: new Date(),
    })
  return outcome
}

export type DatabaseChangeOutcome =
  { outcome: 'replaced' } | { outcome: 'database_refused'; reason: ConnectionCheckReason }

/**
 * One check of a database inside the limits of the wizard (site-connection-gate.ts), as `gatedChecks`
 * makes it beside the files: under one deadline, a refused login counted against its endpoint.
 */
async function gatedDatabaseCheck(
  services: SiteConnectionServices,
  request: { userId: string; database: DatabaseInput; parent: AbortSignal },
): Promise<DatabaseCheckOutcome> {
  const endpoint = services.databases(request.database.engine).endpoint(request.database)
  const outcome = await passSiteConnectionGate(
    { userId: request.userId, units: 2, endpoints: [endpoint] },
    async () => {
      const checks = deadline(siteConnectionLimits.checkMs, request.parent)
      try {
        return await checkSiteDatabase(services, {
          database: request.database,
          signal: checks.signal,
        })
      } finally {
        checks.end()
      }
    },
  )
  if (!outcome.ok && outcome.reason === 'auth_failed') noteRefusedLogin(request.userId, endpoint)
  return outcome
}

/**
 * «Изменить» of the access to the database: `SELECT 1` and its tables at the pinned address with the new
 * login, then the next version of `kv/sites/<id>/db` and the row of the database. A site without a database
 * gets none here: the SQL dump of «База и бэкап» is its way.
 */
export async function changeSiteDatabase(
  request: AccessChangeRequest & { database: DatabaseInput },
): Promise<DatabaseChangeOutcome> {
  const { db, services, userId, database } = request
  const site = await changeableSite(db, userId, request.siteId, new Date())
  if (!site.database) throw siteAccessMissing()
  assertStackConnectable(services, site.stack)
  if (!services.databaseOptions.some((option) => option.engine === database.engine))
    return { outcome: 'database_refused', reason: 'unsupported' }

  const budget = deadline(siteConnectionLimits.createBudgetMs)
  let prepared: PreparedAccess<DatabaseTarget>
  let stored: StoredAccess<DatabaseTarget>
  try {
    const checked = await gatedDatabaseCheck(services, {
      userId,
      database,
      parent: budget.signal,
    })
    if (!checked.ok) return { outcome: 'database_refused', reason: checked.reason }
    prepared = services.databases(database.engine).prepare(database)
    stored = await storeSiteAccess(services.secrets, {
      siteId: site.id,
      prepared,
      signal: budget.signal,
    })
  } finally {
    budget.end()
  }

  let replacedKind = false
  try {
    await db.$transaction(
      async (tx) => {
        await lockIdleSite(tx, request, site, stored)
        const [current] = await tx.$queryRaw<{ credentialRefId: string }[]>`
          SELECT credential_ref_id::text AS "credentialRefId"
          FROM site_databases
          WHERE site_id = ${site.id}::uuid
          FOR UPDATE
        `
        if (current === undefined) throw siteAccessMissing()
        const ref = await referVersion(tx, site, stored)
        await tx.siteDatabase.update({
          where: { siteId: site.id },
          data: { ...databaseColumns(stored.target), credentialRefId: ref.id },
        })
        replacedKind = await dropUnreferenced(tx, site.id, current.credentialRefId, ref.id)
        await tx.auditLog.create({
          data: auditEntry(site, request, { kind: stored.accessKind, version: stored.version }),
        })
      },
      { isolationLevel: 'ReadCommitted' },
    )
  } catch (error) {
    logOrphanedSecrets(site.id)
    throw error
  }
  if (replacedKind) logOrphanedSecrets(site.id)
  await replaceAccessVariables(db, services.secrets, {
    siteId: site.id,
    userId,
    siteUrl: site.url,
    prepared,
    previousAccessKind: prepared.accessKind,
    reference: { vaultPath: stored.vaultPath, version: stored.version },
    now: new Date(),
  })
  return { outcome: 'replaced' }
}

/** What the form of a change starts from: the public columns, never a login or a secret. */
export interface EditableAccess {
  /** An owner or an admin: the only ones who change an access. */
  canChange: boolean
  /** Why «Изменить» is refused now; null — it is not. */
  busy: AccessChangeBusy | null
  source: {
    kind: SiteSourceKind
    host: string
    port: number
    rootPath: string | null
    tls: ConnectionTls | null
    hostKey: string | null
  } | null
  database: {
    engine: DatabaseEngine
    host: string
    port: number
    databaseName: string
    tls: ConnectionTls
  } | null
}

/**
 * The accesses of a site as far as «Изменить» needs them. A member who is not an owner or an admin learns
 * only that: the public columns are of no use to them.
 */
export async function readEditableAccess(
  db: PrismaClient,
  userId: string,
  siteId: string,
): Promise<EditableAccess> {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: changeSelect,
  })
  if (!site) throw siteNotFound()
  if (!isManagerRole(await memberRole(db, site.workspaceId, userId)))
    return { canChange: false, busy: null, source: null, database: null }
  return {
    canChange: true,
    busy: await busyReason(db, site.id, new Date()),
    source: site.codeSource,
    database: site.database,
  }
}
