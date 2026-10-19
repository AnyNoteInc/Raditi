import { chargeTask, extendTaskHolds, releaseTask, type ReturnedTaskHolds } from '@repo/billing'
import {
  enqueueSiteWaitingPasses,
  freeReleaseLease,
  holdReleaseForOperator,
  insertFeedEvent,
  installRelease,
  requestPreviewSync,
  undoReturnsTo,
  type Prisma,
} from '@repo/db'
import {
  assertTransition,
  isDomainError,
  releaseStepDetailSchema,
  releaseTaskEffects,
  releaseTaskEffectsOf,
  taskHoldExpiry,
  undoPlanItemSchema,
  undoRecordCounts,
  taskStatusDuringRelease,
  terminalTaskStatuses,
  type FeedCreditsState,
  type ReleaseOutcome,
  type ReleaseStatus,
  type TaskStatus,
} from '@repo/domain'

import { z } from 'zod'

import { feedReasonOf, feedUndoReasonOf, isUndo, type ReleaseRow } from './release-row.ts'

// What the end of a release does to its dialog, its site and its credits (docs/plan/53-chat-
// preview-release.md, Р6, Р8, Р26, Р27, Р31; `releaseTaskEffects`). Each function is one part
// of one transaction of the caller; the barrier and the lease of the release go in the same
// transaction as the dialog's move, so a release is ended for its site exactly once.

type Tx = Prisma.TransactionClient

/** Rolls the transaction back: the release is ended again by a later run. */
export class EndLater extends Error {
  constructor(readonly reason: string) {
    super(`The end of the release waits: ${reason}`)
  }
}

const deploymentStatusOf = {
  installed: 'succeeded',
  rolled_back: 'rolled_back',
  failed: 'failed',
  refused: 'cancelled',
  unknown: 'unknown',
} as const satisfies Record<ReleaseOutcome, string>

const creditsOf = (returned: ReturnedTaskHolds): FeedCreditsState | null =>
  returned.applied ? (returned.expiries.length > 0 ? 'expired' : 'returned') : null

/**
 * Moves the dialog by the steps of an outcome, each one conditional UPDATE: a dialog already
 * past a step skips it. Returns the status it ended in, or null when it stood elsewhere.
 */
export async function moveTask(
  tx: Pick<Tx, '$queryRaw'>,
  taskId: string,
  steps: readonly { from: readonly TaskStatus[]; to: TaskStatus }[],
): Promise<TaskStatus | null> {
  let moved: TaskStatus | null = null
  for (const step of steps) {
    for (const from of step.from) assertTransition(from, step.to)
    const terminal = terminalTaskStatuses.includes(step.to)
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE tasks SET status = ${step.to}::"TaskStatus", waiting = NULL, updated_at = now(),
        finished_at = CASE WHEN ${terminal} THEN now() ELSE finished_at END
      WHERE id = ${taskId}::uuid AND status::text = ANY(${[...step.from]}::text[])
      RETURNING id`
    if (rows.length === 1) moved = step.to
  }
  return moved
}

/**
 * The dialog follows its release while it goes on (`taskStatusDuringRelease`): the check of the
 * site moves it `deploying → verifying`. An end moves it by its outcome (`releaseTaskEffects`).
 */
export async function moveTaskDuringRelease(
  tx: Pick<Tx, '$queryRaw'>,
  taskId: string,
  status: ReleaseStatus,
): Promise<void> {
  if (taskStatusDuringRelease(status) === 'verifying')
    await moveTask(tx, taskId, [{ from: ['deploying'], to: 'verifying' }])
}

/**
 * What the rollback of a release left on the site, as its job reported it (docs/plan/53,
 * «Операции БД и миграции»): new records someone changed since, new tables; none — undefined.
 */
async function keptOf(
  tx: Tx,
  releaseId: string,
): Promise<{ records: number; tables: number } | undefined> {
  const step = await tx.releaseStep.findFirst({
    where: { releaseId, step: 'rollback', state: 'succeeded' },
    orderBy: { id: 'desc' },
    select: { detail: true },
  })
  const detail = releaseStepDetailSchema.safeParse(step?.detail)
  if (!detail.success) return undefined
  const kept = { records: detail.data.keptRecords ?? 0, tables: detail.data.keptTables ?? 0 }
  return kept.records + kept.tables > 0 ? kept : undefined
}

async function feed(
  tx: Tx,
  row: ReleaseRow,
  outcome: ReleaseOutcome,
  credits: FeedCreditsState | null,
): Promise<void> {
  if (isUndo(row)) {
    const items = z.array(undoPlanItemSchema).safeParse(row.undoPlan.items)
    await insertFeedEvent(tx, {
      taskId: row.taskId,
      row: {
        type: 'feed.undo',
        payload: {
          v: 1,
          stage: outcome,
          undoId: row.id,
          releaseId: row.undoesReleaseId,
          undoneVersion: row.undoes.version,
          version: row.version,
          returnsTo: await undoReturnsTo(tx, {
            siteId: row.siteId,
            installedBeforeSha: row.undoes.installedBeforeSha,
          }),
          reason: feedUndoReasonOf(outcome, row.errorCode),
          records: undoRecordCounts(items.success ? items.data : []),
        },
      },
    })
    return
  }
  const kept = outcome === 'rolled_back' ? await keptOf(tx, row.id) : undefined
  await insertFeedEvent(tx, {
    taskId: row.taskId,
    row: {
      type: 'feed.release',
      payload: {
        v: 1,
        releaseId: row.id,
        version: row.version,
        outcome,
        reason: feedReasonOf(outcome, row.errorCode),
        credits,
        ...(kept ? { kept } : {}),
      },
    },
  })
}

async function closeDeployment(
  tx: Tx,
  row: ReleaseRow,
  outcome: ReleaseOutcome,
  now: Date,
): Promise<void> {
  if (row.deploymentId === null) return
  await tx.deployment.updateMany({
    where: { id: row.deploymentId },
    data: { status: deploymentStatusOf[outcome], finishedAt: now },
  })
}

/**
 * An end without `installed` (`failed`, `rolled_back`, `refused`): the barrier and the lease of
 * `epoch` go, and the turns of other dialogs that waited for the site are put back on the queue;
 * the dialog moves by its table — back to its candidate after `failed` and `refused`, with its
 * reserve kept and extended; `rolled_back` ends it and gives the reserve back —, the outcome
 * goes into the feed. EndLater when this run does not own the release.
 */
export async function endWithoutInstall(
  tx: Tx,
  input: {
    row: ReleaseRow
    outcome: 'failed' | 'rolled_back' | 'refused'
    epoch: number | null
    now: Date
  },
): Promise<void> {
  const { row, outcome, epoch, now } = input
  if (epoch !== null) {
    if (!(await freeReleaseLease(tx, { releaseId: row.id, epoch }))) throw new EndLater('lease')
    // The site is free: the turns of other dialogs that waited for it go now (stand R12).
    await enqueueSiteWaitingPasses(tx, { siteId: row.siteId, tag: `release-${row.id}` })
  }
  const effect = releaseTaskEffectsOf(row.kind, outcome)
  const moved = await moveTask(tx, row.taskId, effect.steps)
  let credits: FeedCreditsState | null = null
  if (effect.credits === 'release') {
    credits = creditsOf(await releaseTask(tx, { taskId: row.taskId, now }))
    // The dialog is closed: the manager of previews takes its preview down (R3, R5c).
    await requestPreviewSync(tx, { taskId: row.taskId, revision: 0 })
  } else if (effect.credits === 'keep' && moved !== null)
    await extendTaskHolds(tx, { taskId: row.taskId, expiresAt: taskHoldExpiry(now, 'waiting') })
  await closeDeployment(tx, row, outcome, now)
  await feed(tx, row, outcome, credits)
}

/**
 * `unknown` (Р31): the barrier and the lease stay with the release, marked held for the
 * operator, and the dialog waits where it is. The feed learns it once — with the call that
 * marked the lease. false — it was marked before.
 */
export async function holdForOperator(tx: Tx, row: ReleaseRow, now: Date): Promise<boolean> {
  if (!(await holdReleaseForOperator(tx, { releaseId: row.id }))) return false
  await closeDeployment(tx, row, 'unknown', now)
  await feed(tx, row, 'unknown', null)
  return true
}

/**
 * The first transaction of `installed` (Р26): the site records its installed version, the
 * candidate is released, the other dialogs' candidates of the site go stale, the barrier and
 * the lease go, the turns of other dialogs that waited for the site are put back on the queue,
 * and the feed says so. EndLater when this run does not own the release.
 */
export async function endInstalled(
  tx: Tx,
  input: { row: ReleaseRow; epoch: number; now: Date },
): Promise<void> {
  const { row, epoch, now } = input
  await installRelease(tx, { releaseId: row.id })
  if (!(await freeReleaseLease(tx, { releaseId: row.id, epoch }))) throw new EndLater('lease')
  await enqueueSiteWaitingPasses(tx, { siteId: row.siteId, tag: `release-${row.id}` })
  await closeDeployment(tx, row, 'installed', now)
  await feed(tx, row, 'installed', null)
}

/**
 * The second transaction of `installed`: the dialog moves `deploying → verifying → done` and
 * is charged by its usage (rule 7) in the same transaction. Open usage of a turn key (or, until
 * `giveUp`, any refusal of the charge) rolls it back with EndLater: the site is free already,
 * only the dialog waits. Returns whether the dialog is `done` now.
 */
export async function closeInstalledDialog(
  tx: Tx,
  input: { row: ReleaseRow; now: Date; giveUp: boolean; onRefusal?: (reason: string) => void },
): Promise<boolean> {
  const { row, now } = input
  const moved = await moveTask(tx, row.taskId, releaseTaskEffects.installed.steps)
  if (moved !== 'done') return false
  try {
    await chargeTask(tx, { taskId: row.taskId, now })
  } catch (error) {
    const refusal = chargeRefusal(error)
    if (refusal === null) throw error
    if (refusal === 'usage_open' || !input.giveUp) throw new EndLater(`charge ${refusal}`)
    input.onRefusal?.(refusal)
  }
  await requestPreviewSync(tx, { taskId: row.taskId, revision: 0 })
  return true
}

function chargeRefusal(error: unknown): string | null {
  if (!isDomainError(error) || error.code !== 'CONFLICT') return null
  const charge = (error.details as { charge?: unknown } | undefined)?.charge
  return typeof charge === 'string' ? charge : null
}
