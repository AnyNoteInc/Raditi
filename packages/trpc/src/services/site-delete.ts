import type { Prisma, PrismaClient } from '@repo/db'
import {
  DomainError,
  siteAccessKinds,
  siteAccessPath,
  siteEnvVarPath,
  siteEnvVarTombstone,
  type SecretStore,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'

// «Удалить проект» (owner's decision of 25.10.2026): the site is hidden and its address freed,
// its history kept. The row stays — tasks, credit holds, the ledger, releases and the audit point
// at it — and is marked `deleted_at`; the cabinet no longer finds the site, and the unique address
// of a workspace holds among the sites that are not deleted, so it may be added again. The
// secrets of the site in Vault — its accesses and the values of its variables — are overwritten by
// a version without a value that is the only one the key keeps. The repository of the site in
// Gitea stays: web has no way to it.

/** What Vault is reached with: write by CAS and read the versions — never read a value back. */
export type SiteSecretEraser = Pick<SecretStore, 'kvWrite' | 'kvMetadata'>

/** Statuses after which a task does nothing more on its own (spec §7). */
const FINISHED_TASK_STATUSES = ['done', 'failed', 'rolled_back', 'cancelled'] as const

/** Statuses of a release that is over: installed, returned, failed (spec §10). */
const FINISHED_RELEASE_STATUSES = ['installed', 'rolled_back', 'failed'] as const

/** How long the transaction may hold the row: it erases the secrets under the lock. */
const DELETE_TIMEOUT_MS = 60_000

export const siteDeleteNotAllowed = () =>
  new DomainError('SITE_DELETE_NOT_ALLOWED', 'Only an owner or an admin deletes a site', 403)

export const siteDeleteNameMismatch = () =>
  new DomainError('SITE_DELETE_NAME_MISMATCH', 'The typed name is not the name of the site', 400)

/** Work is going on at the site, or its outcome is unknown: nothing is deleted. */
export const siteDeleteBusy = (reason: 'tasks' | 'release' | 'setup' | 'lease') =>
  new DomainError('SITE_DELETE_BUSY', 'The site has work in progress', 409, { reason })

export const siteDeleteUnavailable = () =>
  new DomainError('SITE_DELETE_UNAVAILABLE', 'The secrets of the site cannot be erased', 503)

export interface SiteDeleteInput {
  userId: string
  siteId: string
  /** The name of the site as the client typed it to confirm. */
  confirmName: string
  ip: string | null
  now: Date
}

/**
 * The paths of the secrets of a site, all under `kv/sites/<id>/`: every kind of access — a kind
 * that «Изменить доступ» replaced keeps its secret without a reference — whatever its reference
 * names, and every variable.
 */
async function secretPathsOf(
  db: Pick<Prisma.TransactionClient, 'credentialRef' | 'siteEnvVar'>,
  siteId: string,
): Promise<string[]> {
  const [refs, variables] = await Promise.all([
    db.credentialRef.findMany({ where: { siteId }, select: { vaultPath: true } }),
    db.siteEnvVar.findMany({ where: { siteId }, select: { name: true } }),
  ])
  const own = `kv/sites/${siteId}/`
  return [
    ...new Set([
      ...siteAccessKinds.map((kind) => siteAccessPath(siteId, kind)),
      ...refs.map((ref) => ref.vaultPath).filter((path) => path.startsWith(own)),
      ...variables.map((variable) => siteEnvVarPath(siteId, variable.name)),
    ]),
  ].sort()
}

/** Why the site may not be deleted now, read under the lock of its row; null — it may. */
async function busyReason(
  tx: Prisma.TransactionClient,
  siteId: string,
  now: Date,
): Promise<Parameters<typeof siteDeleteBusy>[0] | null> {
  const task = await tx.task.findFirst({
    where: { siteId, status: { notIn: [...FINISHED_TASK_STATUSES] } },
    select: { id: true },
  })
  if (task !== null) return 'tasks'
  const release = await tx.siteRelease.findFirst({
    where: { siteId, status: { notIn: [...FINISHED_RELEASE_STATUSES] } },
    select: { id: true },
  })
  if (release !== null) return 'release'
  // A site being set up — its first import queued, running or failed — is not deleted: «Повторить»
  // and «Изменить доступ» of a failed import write its accesses and queue it again (spec §12).
  const stage = await tx.siteProvisioningStage.findFirst({
    where: { siteId, status: { not: 'succeeded' } },
    select: { siteId: true },
  })
  if (stage !== null) return 'setup'
  const lease = await tx.siteLease.findUnique({
    where: { siteId },
    select: {
      operation: true,
      expiresAt: true,
      heldForOperator: true,
      inflightMcpCallId: true,
      inflightReleaseId: true,
    },
  })
  if (
    lease !== null &&
    (lease.heldForOperator ||
      lease.inflightMcpCallId !== null ||
      lease.inflightReleaseId !== null ||
      (lease.operation !== null && lease.expiresAt !== null && lease.expiresAt > now))
  )
    return 'lease'
  return null
}

/**
 * Overwrites a secret by a version without a value that the key alone keeps (`maxVersions: 1`
 * prunes the older ones); a key never written is left alone. Exported for a writer that finds
 * the site deleted after it wrote a value (`siteEnv.set`).
 */
export async function eraseSiteSecret(
  secrets: SiteSecretEraser,
  path: string,
  now: Date,
): Promise<void> {
  const metadata = await secrets.kvMetadata(path)
  if (metadata === null) return
  await secrets.kvWrite(path, siteEnvVarTombstone(now), {
    cas: metadata.currentVersion,
    maxVersions: 1,
  })
}

/**
 * Deletes a site of the user: only an owner or an admin of its workspace, with its name typed
 * again, and only while nothing goes on at it — no task that is not over, no release that is not
 * over, no first import that has not succeeded, no lease that is held. Under the lock of the row
 * (FOR UPDATE: a new dialog takes FOR KEY SHARE on it, so the two wait for each other and the
 * later one sees the earlier) the checks run again and the secrets are erased before the mark is
 * written: a refusal of Vault — or a crash — leaves the site as it was, and deleting it again
 * erases what is left.
 */
export async function deleteSite(
  db: PrismaClient,
  secrets: (() => SiteSecretEraser) | null,
  input: SiteDeleteInput,
): Promise<void> {
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: { id: true, name: true, workspaceId: true },
  })
  if (site === null) throw siteNotFound()
  if (!isManagerRole(await memberRole(db, site.workspaceId, input.userId)))
    throw siteDeleteNotAllowed()
  if (input.confirmName.trim() !== site.name.trim()) throw siteDeleteNameMismatch()
  const store = secrets?.() ?? null
  if (store === null) throw siteDeleteUnavailable()

  await db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM sites WHERE id = ${site.id}::uuid FOR UPDATE`
      if (rows[0] === undefined || rows[0].deleted_at !== null) throw siteNotFound()
      const busy = await busyReason(tx, site.id, input.now)
      if (busy !== null) throw siteDeleteBusy(busy)
      for (const path of await secretPathsOf(tx, site.id)) {
        try {
          await eraseSiteSecret(store, path, input.now)
        } catch {
          // The site id alone: the path names a kind or a variable, never a value.
          console.warn(`site_delete_secret_failed site=${site.id}`)
          throw siteDeleteUnavailable()
        }
      }
      await tx.site.update({ where: { id: site.id }, data: { deletedAt: input.now } })
      await tx.auditLog.create({
        data: {
          actorType: 'user',
          actorId: input.userId,
          workspaceId: site.workspaceId,
          action: 'site.delete',
          targetType: 'site',
          targetId: site.id,
          ip: input.ip,
        },
      })
    },
    { isolationLevel: 'ReadCommitted', timeout: DELETE_TIMEOUT_MS },
  )
}

/**
 * The lock a new dialog or an undo of a release takes on its site before it writes: FOR KEY
 * SHARE waits for a deletion in flight (FOR UPDATE), and a site deleted meanwhile is not found.
 */
export async function lockLiveSite(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  siteId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM sites WHERE id = ${siteId}::uuid FOR KEY SHARE`
  if (rows[0] === undefined || rows[0].deleted_at !== null) throw siteNotFound()
}
