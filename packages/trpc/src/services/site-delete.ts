import { randomUUID } from 'node:crypto'

import { lockSiteSchedules, pauseSiteSchedules, type Prisma, type PrismaClient } from '@repo/db'
import {
  DomainError,
  siteAccessKinds,
  siteAccessPath,
  siteEnvVarPath,
  siteEnvVarTombstone,
  type SecretStore,
} from '@repo/domain'

import { isManagerRole, lockTask, memberRole, type LockedTask } from './chat/access.ts'
import { dialogCommands, dialogFacts } from './chat/dialog-facts.ts'
import { stopDialog } from './chat/tasks.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'

// «Удалить проект» (owner's decision of 25.10.2026): the site is hidden and its address freed,
// its history kept. The row stays — tasks, credit holds, the ledger, releases and the audit point
// at it — and is marked `deleted_at`; the cabinet no longer finds the site, and the unique address
// of a workspace holds among the sites that are not deleted, so it may be added again. The
// secrets of the site in Vault — its accesses and the values of its variables — are overwritten by
// a version without a value that is the only one the key keeps. The repository of the site in
// Gitea stays: web has no way to it. Its scheduled tasks stop (`project_gone`, docs/plan/82), and
// the chats of their runs that wait for the client are closed with it: a run that answered or asked
// leaves its chat waiting for good, and a project with a daily task would never be deleted.

/** What Vault is reached with: write by CAS and read the versions — never read a value back. */
export type SiteSecretEraser = Pick<SecretStore, 'kvWrite' | 'kvMetadata'>

/** Statuses after which a task does nothing more on its own (spec §7). */
const FINISHED_TASK_STATUSES = ['done', 'failed', 'rolled_back', 'cancelled'] as const

/** A chat that waits for its client: no pass is planned or runs (spec §7). */
const WAITING_TASK_STATUSES = ['awaiting_user', 'awaiting_approval'] as const

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

/**
 * The chats of runs of the site's scheduled tasks that wait for the client (docs/plan/82, Зп17,
 * Зп22), under their rows — taken before the site's, as a writer of a chat takes its chat and then
 * its site: they are closed with the deletion, never a reason to refuse it.
 */
async function lockWaitingRunChats(
  tx: Prisma.TransactionClient,
  siteId: string,
): Promise<LockedTask[]> {
  const chats = await tx.task.findMany({
    where: {
      siteId,
      deletedAt: null,
      status: { in: [...WAITING_TASK_STATUSES] },
      scheduledRun: { isNot: null },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  const locked: LockedTask[] = []
  for (const chat of chats) {
    const task = await lockTask(tx, chat.id)
    // A chat that went on meanwhile — its client wrote, or it ended — is counted as it is now.
    if (task !== null && (WAITING_TASK_STATUSES as readonly string[]).includes(task.status))
      locked.push(task)
  }
  return locked
}

/**
 * Why the site may not be deleted now, read under the lock of its row; null — it may. `closing` —
 * the waiting chats of runs the deletion closes (`lockWaitingRunChats`).
 */
async function busyReason(
  tx: Prisma.TransactionClient,
  siteId: string,
  now: Date,
  closing: readonly string[],
): Promise<Parameters<typeof siteDeleteBusy>[0] | null> {
  const task = await tx.task.findFirst({
    where: {
      siteId,
      status: { notIn: [...FINISHED_TASK_STATUSES] },
      ...(closing.length > 0 ? { id: { notIn: [...closing] } } : {}),
    },
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
 * A waiting chat of a run, closed with its project as «Удалить чат» closes one (`removeDialog`):
 * `/cancel` by the deleting owner or admin — its reserve given back, its preview sent to be
 * removed; a chat in the browser is stopped by core, which closes its browser.
 */
async function closeWaitingChat(
  tx: Prisma.TransactionClient,
  task: LockedTask,
  input: { userId: string; now: Date },
): Promise<void> {
  const facts = await dialogFacts(tx, task, input.userId, input.now)
  const cancel = dialogCommands(facts).find((command) => command.id === 'cancel')
  if (cancel?.refusal === 'release_in_progress') throw siteDeleteBusy('release')
  await stopDialog(tx, task, facts, {
    userId: input.userId,
    // The press is the server's own, made once: the deletion is not repeated after it commits.
    requestId: randomUUID(),
    now: input.now,
  })
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
 * again, and only while nothing goes on at it — no task that is not over (a chat of a run of its
 * scheduled tasks that waits for the client aside: it is closed as «Удалить чат» closes one), no
 * release that is not over, no first import that has not succeeded, no lease that is held. The
 * scheduled tasks of the site and the waiting chats of their runs are locked first, then the site's
 * row (FOR UPDATE: a new dialog takes FOR KEY SHARE on it, so the two wait for each other and the
 * later one sees the earlier) — the order of the tick and «Запустить сейчас», which take a task and
 * then the project its run refers to. Under these locks the checks run again, the waiting chats of
 * runs are closed, and the secrets are erased before the mark is written: a refusal of Vault — or
 * a crash — leaves the site as it was, and deleting it again erases what is left.
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
      // Tasks before their project (Зп22, Зп24): the tick never waits on the deletion in a circle.
      await lockSiteSchedules(tx, site.id)
      const closing = await lockWaitingRunChats(tx, site.id)
      const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM sites WHERE id = ${site.id}::uuid FOR UPDATE`
      if (rows[0] === undefined || rows[0].deleted_at !== null) throw siteNotFound()
      const busy = await busyReason(
        tx,
        site.id,
        input.now,
        closing.map((task) => task.id),
      )
      if (busy !== null) throw siteDeleteBusy(busy)
      // Closed before the secrets are erased: a refusal here leaves the site and Vault as they were.
      for (const task of closing) await closeWaitingChat(tx, task, input)
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
      // Its scheduled tasks stop with it, without a notice (docs/plan/82-scheduled-tasks.md,
      // Зп22): the window of the deletion named how many.
      await pauseSiteSchedules(tx, site.id)
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
