import { randomUUID } from 'node:crypto'

import { chargeTask, placeCreditHold } from '@repo/billing'
import {
  artifactRole,
  enqueueOutbox,
  insertQuickEdit,
  queueQuickAttempt,
  quickEditsOfArtifact,
  snapshotArtifactComments,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import { DomainError, FEED_VERSION, isDomainError, taskHoldExpiry } from '@repo/domain'
import {
  artifactRoleAtLeast,
  QUICK_EDIT_JOB,
  quickEditLimits,
  type ArtifactCommentSnapshot,
} from '@repo/domain/artifacts'
import { z } from 'zod'

import { WRITE, writeRequest } from '../chat/dialog-lock.ts'

// «Исправить» on notes of a «Документ» (docs/plan/98-quick-edits.md, §4 step 2): in one
// transaction the reserve of one more attempt of the clicker's quick task, the request in its feed,
// the snapshot of the notes, the row of the edit and its job — the id only (rule 2).

/** The outbox topic core's queue of quick edits reads. */
export const QUICK_EDIT_QUEUE = 'artifact-edits'

export const quickEditInput = z.strictObject({
  artifactId: z.uuid(),
  threadIds: z
    .array(z.uuid())
    .min(1)
    .max(quickEditLimits.threads)
    .refine((ids) => new Set(ids).size === ids.length)
    .transform((ids) => ids.sort()),
  /** Invented by the browser: a repeated press finds the edit it made. */
  requestId: z.uuid(),
  /**
   * The clicker confirmed «Сделать, как просит <имя>?» for notes of other people: their words
   * become the clicker's request (БПр9, Ар53).
   */
  confirmOthers: z.boolean().default(false),
})

const quickEditError = (code: string, message: string, status = 409) =>
  new DomainError(code, message, status)

/** The quick task is busy with the previous edit of this person. */
export const quickEditBusy = () =>
  quickEditError('QUICK_EDIT_BUSY', 'The previous quick edit is not finished yet')
/** Notes of other people need the clicker's confirmation. */
export const quickEditNeedsConfirmation = () =>
  quickEditError('QUICK_EDIT_CONFIRM', 'Notes of other people need a confirmation')
/** What a quick edit does not take: another kind, another workspace, no right to edit. */
export const quickEditUnavailable = () =>
  quickEditError('QUICK_EDIT_UNAVAILABLE', 'A quick edit is not available here', 403)

const quoteOf = (note: ArtifactCommentSnapshot[number]): string => {
  const anchor = note.anchor as { kind?: string; quote?: string }
  return anchor.kind === 'quote' && typeof anchor.quote === 'string' ? anchor.quote : ''
}

/** What the feed of «Быстрые правки» shows of the request: the notes, shortly. */
function requestText(notes: ArtifactCommentSnapshot): string {
  const cut = (text: string, size: number) =>
    Array.from(text).length > size ? `${Array.from(text).slice(0, size).join('')}…` : text
  const lines = notes.map(
    (note) => `«${cut(note.body, 200)}» — к словам «${cut(quoteOf(note), 80)}»`,
  )
  return cut(`Исправить по заметке: ${lines.join('; ')}`, 1500)
}

/**
 * The charge of the previous attempt put off (`billing.charge_later`) is made before the next
 * reserve: a reserve after an uncharged chain is refused otherwise (rule 7). Still not chargeable
 * (its calls are not settled yet) — the client waits a moment.
 */
async function chargePutOff(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; now: Date },
): Promise<void> {
  const task = await tx.task.findFirst({
    where: {
      workspaceId: input.workspaceId,
      createdById: input.userId,
      kind: 'quick_edits',
      deletedAt: null,
      status: 'awaiting_user',
      creditHolds: { some: { status: 'active' } },
    },
    select: { id: true },
  })
  if (task === null) return
  try {
    await chargeTask(tx, { taskId: task.id, now: input.now })
  } catch (error) {
    if (isDomainError(error) && error.code === 'CONFLICT') throw quickEditBusy()
    throw error
  }
}

export async function requestQuickEdit(
  db: PrismaClient,
  userId: string,
  raw: z.input<typeof quickEditInput>,
  now: Date,
): Promise<{ quickEditId: string }> {
  const input = quickEditInput.parse(raw)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quick-edit:${userId}:${input.requestId}`}, 0))`
    const repeated = await tx.artifactQuickEdit.findUnique({
      where: { userId_requestId: { userId, requestId: input.requestId } },
      select: { id: true, artifactId: true },
    })
    if (repeated) {
      if (repeated.artifactId !== input.artifactId) throw quickEditUnavailable()
      return { quickEditId: repeated.id }
    }
    const role = await artifactRole(tx, { artifactId: input.artifactId, userId })
    if (role === null || !artifactRoleAtLeast(role, 'edit')) throw quickEditUnavailable()
    const artifact = await tx.artifact.findUniqueOrThrow({
      where: { id: input.artifactId },
      select: { kind: true, workspaceId: true },
    })
    if (artifact.kind !== 'document') throw quickEditUnavailable()
    // Stage 1: the quick task lives in the artifact's workspace, so its credits pay (plan 98, §6).
    const member = await tx.member.findFirst({
      where: { workspaceId: artifact.workspaceId, userId },
      select: { userId: true },
    })
    if (member === null) throw quickEditUnavailable()
    const notes = await snapshotArtifactComments(tx, {
      artifactId: input.artifactId,
      userId,
      workspaceId: artifact.workspaceId,
      threadIds: input.threadIds,
    })
    if (notes.some((note) => quoteOf(note) === '')) throw quickEditUnavailable()
    if (!input.confirmOthers && notes.some((note) => note.by === 'other'))
      throw quickEditNeedsConfirmation()
    await chargePutOff(tx, { workspaceId: artifact.workspaceId, userId, now })
    const queued = await queueQuickAttempt(tx, { workspaceId: artifact.workspaceId, userId })
    if (queued === null) throw quickEditBusy()
    const { taskId, attempt } = queued
    await placeCreditHold(tx, {
      workspaceId: artifact.workspaceId,
      taskId,
      attempt,
      now,
      expiresAt: taskHoldExpiry(now, 'waiting'),
      // The first attempt opens the chain; every next one follows a charged attempt (БПр13).
      ...(queued.created ? {} : { follows: 'message' as const }),
    })
    const requestEventId = await writeRequest(tx, taskId, {
      v: FEED_VERSION,
      authorId: userId,
      requestId: input.requestId,
      kind: 'quick_edit',
      text: requestText(notes),
    })
    const key = { userId, requestId: input.requestId }
    await tx.artifactCommentDispatchKey.create({ data: key })
    await tx.artifactCommentDispatch.create({
      data: {
        ...key,
        artifactId: input.artifactId,
        requestEventId: BigInt(requestEventId),
        sha256: '0'.repeat(64),
        notes,
      },
    })
    const quickEditId = randomUUID()
    await insertQuickEdit(tx, {
      id: quickEditId,
      artifactId: input.artifactId,
      taskId,
      attempt,
      userId,
      requestId: input.requestId,
    })
    await enqueueOutbox(tx, {
      topic: QUICK_EDIT_QUEUE,
      type: QUICK_EDIT_JOB,
      payload: { quickEditId },
      dedupeKey: `${QUICK_EDIT_JOB}:${quickEditId}`,
    })
    return { quickEditId }
  }, WRITE)
}

/** The clicker's own edits of an artifact in the last 15 minutes: what its page shows. */
export async function quickEditsOf(
  db: PrismaClient,
  userId: string,
  artifactId: string,
  now: Date,
) {
  const role = await artifactRole(db, { artifactId, userId })
  if (role === null) return []
  const rows = await quickEditsOfArtifact(db, {
    artifactId,
    userId,
    since: new Date(now.getTime() - 15 * 60_000),
  })
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }))
}
