import { createHash, randomBytes } from 'node:crypto'

import {
  enqueuePreviewSync,
  insertFeedEvent,
  requestPreviewSync,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  badRequest,
  isPreviewPath,
  isPreviewServing,
  previewEnterUrl,
  previewHostname,
  previewOrigin,
  previewTimings,
  terminalTaskStatuses,
  type PreviewAddress,
  type TaskStatus,
} from '@repo/domain'

import { accessibleTask, lockTask, taskNotFound } from './access.ts'
import { assertCommandAvailable, dialogFacts } from './dialog-facts.ts'
import { requestOf } from './dialog-state.ts'
import { commandUnavailable, previewNotReady } from './refusals.ts'

type Tx = Prisma.TransactionClient

const HOUR_MS = 60 * 60 * 1000

/**
 * Whether a preview can have a copy of the site's database (Р4): the site has a connection to
 * its database from the wizard, or a saved access of the kind `db`.
 */
export async function siteHasDatabase(
  db: Pick<Tx, 'siteDatabase' | 'credentialRef'>,
  siteId: string,
): Promise<boolean> {
  const database = await db.siteDatabase.findUnique({
    where: { siteId },
    select: { siteId: true },
  })
  if (database !== null) return true
  const access = await db.credentialRef.findFirst({
    where: { siteId, kind: 'db' },
    select: { id: true },
  })
  return access !== null
}

export interface DialogPreviewInput {
  siteId: string
  taskId: string
  /** `sites.alias` and `tasks.alias`, as the database drew them. */
  siteAlias: string
  taskAlias: string
  hasDatabase: boolean
  address: PreviewAddress
  /** PREVIEW_TTL_HOURS: an unviewed preview stops after this long. */
  ttlHours: number
  now: Date
}

/**
 * The preview of a new dialog, in the transaction of `task.create` (Р2, Р4, Р17): `pending`
 * with a copy of the database, built by core on `preview.sync`; without an access to the
 * database `unavailable` with `no_database` — said plainly, never drawn, and nothing is built.
 * Returns its id.
 */
export async function insertDialogPreview(
  tx: Pick<Tx, 'previewEnvironment' | 'outboxEvent'>,
  input: DialogPreviewInput,
): Promise<string> {
  const { hasDatabase, now } = input
  const preview = await tx.previewEnvironment.create({
    data: {
      siteId: input.siteId,
      taskId: input.taskId,
      status: hasDatabase ? 'pending' : 'unavailable',
      dbMode: hasDatabase ? 'copy' : 'none',
      unavailableReason: hasDatabase ? null : 'no_database',
      hostname: previewHostname(
        { siteAlias: input.siteAlias, taskAlias: input.taskAlias },
        input.address.baseDomain,
      ),
      expiresAt: new Date(now.getTime() + input.ttlHours * HOUR_MS),
    },
    select: { id: true },
  })
  // The row was just written with `enqueues` 1: the first job carries that counter.
  if (hasDatabase) await enqueuePreviewSync(tx, { previewId: preview.id, revision: 0, seq: 1 })
  return preview.id
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface IssuedPreviewTicket {
  /** 32 random bytes in base64url: what the URL carries, never stored. */
  ticket: string
  expiresAt: Date
}

/**
 * A one-time way into a preview for a person (Р19): 32 random bytes in base64url, of which the
 * database keeps only the SHA-256; it lives 60 seconds and opens one session of the gateway.
 * The caller has checked that the user may open the preview and that it is served —
 * `openPreview` does both, and the route `/preview/open` of web goes through it.
 */
export async function issuePreviewTicket(
  db: Pick<Tx, 'previewTicket'>,
  input: { previewId: string; userId: string; now?: Date },
): Promise<IssuedPreviewTicket> {
  const now = input.now ?? new Date()
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + previewTimings.ticketSeconds * 1000)
  await db.previewTicket.create({
    data: {
      previewId: input.previewId,
      userId: input.userId,
      kind: 'user',
      tokenHash: sha256Hex(ticket),
      expiresAt,
    },
  })
  return { ticket, expiresAt }
}

export interface OpenPreviewInput {
  userId: string
  /** The dialog, or the exact host of its preview: what `/preview/open?host=…` is given. */
  target: { taskId: string } | { hostname: string }
  /** Where the viewer lands: a path of the preview with one leading `/`; `/` when absent. */
  to?: string
  now?: Date
}

const BUSY: readonly TaskStatus[] = ['preparing', 'running']

/** A stopped preview is asked to be built again at most this often, however often it is opened. */
export const REBUILD_REQUEST_SECONDS = 60

/**
 * Asks core to build a stopped preview again (`preview.sync`), once while a request is fresh: an
 * open marks the row (`last_viewed_at` — the viewer wants it now, so its time to live counts
 * from here) and queues the job; an open within `REBUILD_REQUEST_SECONDS` of the mark finds it
 * and queues nothing, so a screen that asks again on PREVIEW_NOT_READY adds no jobs. Both times
 * are of the database's clock. Once core moves the row out of `expired`, nothing is asked.
 */
async function rebuildStopped(
  db: PrismaClient,
  input: { previewId: string; revision: number },
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      const marked = await tx.$queryRaw<Array<{ enqueues: number }>>`
        UPDATE preview_environments
        SET enqueues = enqueues + 1, last_viewed_at = now(), updated_at = now()
        WHERE id = ${input.previewId}::uuid AND status = 'expired'
          AND (last_viewed_at IS NULL
            OR last_viewed_at < now() - ${REBUILD_REQUEST_SECONDS}::int * interval '1 second')
        RETURNING enqueues`
      const row = marked[0]
      if (row === undefined) return
      await enqueuePreviewSync(tx, {
        previewId: input.previewId,
        revision: input.revision,
        seq: row.enqueues,
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * The ticket URL of a dialog's preview for a member of its workspace (`preview.ticket`, and
 * `/preview/open` of web): what an iframe `src` and «Открыть в новой вкладке» open. The preview
 * must be served; a stopped one (`expired`) of a dialog that goes on is built again — the
 * answer then is PREVIEW_NOT_READY and the screen asks again. A preview of someone else or a
 * host that is not a preview answers NOT_FOUND, like a site.
 */
export async function openPreview(
  db: PrismaClient,
  address: PreviewAddress | null,
  input: OpenPreviewInput,
): Promise<{ url: string; expiresAt: Date }> {
  const to = input.to ?? '/'
  if (!isPreviewPath(to)) throw badRequest('Invalid preview path')
  const member = { workspace: { members: { some: { userId: input.userId } } } }
  const where: Prisma.PreviewEnvironmentWhereInput =
    'taskId' in input.target
      ? { taskId: input.target.taskId, task: member }
      : { hostname: input.target.hostname, task: member }
  const preview = await db.previewEnvironment.findFirst({
    where,
    select: {
      id: true,
      hostname: true,
      status: true,
      revision: true,
      task: { select: { id: true, workspaceId: true, siteId: true, status: true } },
    },
  })
  if (preview === null) throw taskNotFound()
  if (address === null) throw commandUnavailable('preview', 'preview_unavailable')
  const { task } = preview
  const facts = await dialogFacts(db, task, input.userId)
  assertCommandAvailable(facts.commands, 'preview')

  if (!isPreviewServing(preview.status)) {
    // Allowed and not served: a stopped preview, opened again. A dialog that has ended keeps
    // only a preview that still runs.
    if (preview.status !== 'expired' || terminalTaskStatuses.includes(task.status))
      throw commandUnavailable('preview', 'preview_unavailable')
    // During a pass the preview follows the pass; core brings it back after it.
    if (!BUSY.includes(task.status))
      await rebuildStopped(db, { previewId: preview.id, revision: preview.revision })
    throw previewNotReady()
  }

  const { ticket, expiresAt } = await issuePreviewTicket(db, {
    previewId: preview.id,
    userId: input.userId,
    now: input.now,
  })
  return { url: previewEnterUrl(previewOrigin(preview.hostname, address), ticket, to), expiresAt }
}

/**
 * `/reset` (Р22, Р34): the preview is built again to the candidate the dialog waits with, or to
 * its base — what the client changed in it is gone. `dirty` tells the manager of previews that
 * the preview may not show its revision any more, so the job rebuilds it; the enqueue counter
 * gives the job a key of its own. Refused while the agent works or a release is in work.
 * `requestId` — the press of the browser: the feed shows it, and a repeat writes nothing.
 */
export async function resetPreview(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId?: string | undefined; now?: Date },
): Promise<{ requestEventId: string | null; repeated: boolean }> {
  const visible = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (visible === null) throw taskNotFound()
  return db.$transaction(
    async (tx) => {
      const task = await lockTask(tx, input.taskId)
      if (task === null) throw taskNotFound()
      if (input.requestId !== undefined) {
        const repeated = await requestOf(tx, task.id, input.requestId)
        if (repeated !== null) return { requestEventId: String(repeated), repeated: true }
      }
      const facts = await dialogFacts(tx, task, input.userId)
      assertCommandAvailable(facts.commands, 'reset')
      await tx.previewEnvironment.update({ where: { taskId: task.id }, data: { dirty: true } })
      await requestPreviewSync(tx, { taskId: task.id, revision: facts.candidate?.revision ?? 0 })
      if (input.requestId === undefined) return { requestEventId: null, repeated: false }
      const id = await insertFeedEvent(tx, {
        taskId: task.id,
        row: {
          type: 'feed.request',
          payload: {
            v: 1,
            kind: 'command',
            command: 'reset',
            authorId: input.userId,
            requestId: input.requestId,
          },
        },
      })
      return { requestEventId: String(id), repeated: false }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
