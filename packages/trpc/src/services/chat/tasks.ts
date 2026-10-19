import {
  extendTaskHolds,
  modelClassPriced,
  placeCreditHold,
  releaseTask,
  taskChainAttempts,
} from '@repo/billing'
import {
  enqueueAgentTurn,
  enqueueCandidateRebase,
  enqueueTurnCancel,
  insertFeedEvent,
  requestPreviewSync,
  taskHasProductionWrites,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  assertTransition,
  conflict,
  isDomainError,
  isProduction,
  llmBackendIds,
  maxTaskAttempts,
  taskHoldExpiry,
  terminalTaskStatuses,
  type FeedRequestPayload,
  type RetryRefusal,
  type TaskStatus,
} from '@repo/domain'

import { accessibleSite } from '../site-basics.ts'
import { taskNotFound } from './access.ts'
import type { ChatContext } from './context.ts'
import { assertCommandAvailable, dialogFacts } from './dialog-facts.ts'
import { moveTo, underDialogLock, WRITE, writeRequest } from './dialog-lock.ts'
import {
  creditsAfterReturn,
  dialogRetry,
  lastQuestion,
  liveCandidate,
  openCeilingQuestion,
  requestOf,
} from './dialog-state.ts'
import { insertDialogPreview, siteHasDatabase } from './previews.ts'
import {
  releaseInProgress,
  taskAttemptsExhausted,
  taskBusy,
  taskContinueRequired,
  taskFinished,
  taskNotAccepted,
  taskNothingToContinue,
  taskNothingToRetry,
  taskRetryDailyLimit,
} from './refusals.ts'
import { dialogTitle, requestPayload, requestText } from './request-text.ts'

type Tx = Prisma.TransactionClient

/** What a press or words of the client came to. */
export interface PostedRequest {
  /** `task_events.id` of the `feed.request`, the cursor of the feed. */
  requestEventId: string
  /** The same press was delivered before: nothing was written now. */
  repeated: boolean
}

/** Why a dialog is not where words or a press could move it. */
function notWaiting(status: TaskStatus): Error {
  switch (status) {
    case 'queued':
    case 'preparing':
    case 'running':
      return taskBusy()
    case 'deploying':
    case 'verifying':
      return releaseInProgress()
    default:
      return taskFinished()
  }
}

// ---------------------------------------------------------------------------------------------
// task.create
// ---------------------------------------------------------------------------------------------

export interface CreateDialogInput {
  userId: string
  siteId: string
  /** Invented by the browser (UUID v7): a repeated request is recognised by it. */
  taskId: string
  text: string
  now: Date
}

export interface CreatedDialog {
  taskId: string
  /** The second label of the preview address. */
  alias: string
  /** false — the same request was delivered before, nothing was written now. */
  created: boolean
}

/**
 * A new dialog (docs/plan/53-chat-preview-release.md, Р1, Р8; feed design, «Три писателя»):
 * one transaction writes the task (`queued`, class `standard`, billable), sets credits aside
 * for its first attempt (`placeCreditHold`), writes the client's words as `feed.request`, puts
 * the pass into the outbox and opens the preview of the dialog. A refused reserve rolls all of
 * it back: there is no task without a reserve. A repeat with the same id returns the task of the
 * first delivery to its author; an id that is someone else's answers NOT_FOUND.
 *
 * The site must be connected (`active`); outside production a dialog is taken only in a
 * synthetic workspace (rule 1; spec §20, decision 6 of 11.10.2026).
 */
export async function createDialog(
  db: PrismaClient,
  chat: ChatContext,
  input: CreateDialogInput,
): Promise<CreatedDialog> {
  const { userId, siteId, now } = input
  const taskId = input.taskId.toLowerCase()
  const text = requestText(input.text)
  const payload = requestPayload({
    v: 1,
    kind: 'first',
    authorId: userId,
    requestId: taskId,
    text,
  })

  const earlier = await sameDialog(db, { taskId, siteId, userId })
  if (earlier !== null) return earlier

  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      workspaceId: true,
      status: true,
      alias: true,
      workspace: { select: { dataClass: true } },
    },
  })
  if (site === null) throw taskNotFound()
  if (site.status !== 'active') throw taskNotAccepted('site_not_active')
  if (!isProduction(chat.appEnv) && site.workspace.dataClass !== 'synthetic')
    throw taskNotAccepted('not_synthetic')
  const hasDatabase = chat.preview !== null && (await siteHasDatabase(db, site.id))

  return db.$transaction(async (tx) => {
    // ON CONFLICT DO NOTHING: a repeat that raced the first delivery waits for it here and
    // writes nothing; an error would abort the transaction instead.
    const inserted = await tx.task.createMany({
      data: [
        {
          id: taskId,
          workspaceId: site.workspaceId,
          siteId: site.id,
          createdById: userId,
          status: 'queued',
          modelClass: 'standard',
          billable: true,
          title: dialogTitle(text),
          mode: 'work',
        },
      ],
      skipDuplicates: true,
    })
    if (inserted.count === 0) {
      const raced = await sameDialog(tx, { taskId, siteId, userId })
      if (raced === null) throw taskNotFound()
      return raced
    }
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { alias: true } })

    await placeCreditHold(tx, {
      workspaceId: site.workspaceId,
      taskId,
      attempt: 1,
      now,
      expiresAt: taskHoldExpiry(now, 'waiting'),
    })
    const requestEventId = await insertFeedEvent(tx, {
      taskId,
      row: { type: 'feed.request', payload },
    })
    await enqueueAgentTurn(tx, { taskId, attempt: 1, requestEventId: String(requestEventId) })
    if (chat.preview !== null) {
      await insertDialogPreview(tx, {
        siteId: site.id,
        taskId,
        siteAlias: site.alias,
        taskAlias: task.alias,
        hasDatabase,
        address: chat.preview.address,
        ttlHours: chat.preview.ttlHours,
        now,
      })
    }
    return { taskId, alias: task.alias, created: true }
  }, WRITE)
}

/**
 * The task of an earlier delivery of the same `task.create`: the same id, site and author. An
 * id taken by anything else is NOT_FOUND — the caller learns nothing of it.
 */
async function sameDialog(
  db: Pick<Tx, 'task'>,
  ids: { taskId: string; siteId: string; userId: string },
): Promise<CreatedDialog | null> {
  const task = await db.task.findUnique({
    where: { id: ids.taskId },
    select: { siteId: true, createdById: true, alias: true },
  })
  if (task === null) return null
  if (task.siteId !== ids.siteId || task.createdById !== ids.userId) throw taskNotFound()
  return { taskId: ids.taskId, alias: task.alias, created: false }
}

// ---------------------------------------------------------------------------------------------
// task.message, task.continue, task.cancel
// ---------------------------------------------------------------------------------------------

export interface DialogMessageInput {
  userId: string
  taskId: string
  /** Invented by the browser for this message: a repeat is recognised by it. */
  requestId: string
  text: string
  now: Date
}

/**
 * Words to a dialog that waits (Р6): the answer to the agent's question (`awaiting_user →
 * queued`, `feed.request` `answer`) or a new pass on top of the candidate (`awaiting_approval →
 * queued`, `revision`). The same attempt goes on under the same reserve, which is moved on; the
 * pass goes into the outbox with the row. A question of the platform about credits is answered
 * by «Продолжить» (`task.continue`), never by words. A repeat with the same `requestId` returns
 * the row of the first delivery.
 */
export async function postDialogMessage(
  db: PrismaClient,
  input: DialogMessageInput,
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  const text = requestText(input.text)
  // Checked before the transaction, so the words are refused in the client's terms.
  requestPayload({ v: 1, kind: 'first', authorId: userId, requestId, text })

  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }

    let payload: FeedRequestPayload
    if (task.status === 'awaiting_user') {
      const question = await lastQuestion(tx, task.id)
      if (question === null || question.answered)
        throw conflict('The dialog waits for an answer without an open question')
      if (question.kind === 'ceiling') throw taskContinueRequired()
      payload = {
        v: 1,
        kind: 'answer',
        authorId: userId,
        requestId,
        text,
        answersEventId: String(question.id),
      }
    } else if (task.status === 'awaiting_approval') {
      if ((await openCeilingQuestion(tx, task.id)) !== null) throw taskContinueRequired()
      const candidate = await liveCandidate(tx, task.id)
      if (candidate === null) throw conflict('The dialog waits for approval without a candidate')
      payload = {
        v: 1,
        kind: 'revision',
        authorId: userId,
        requestId,
        text,
        candidateRevision: candidate.revision,
      }
    } else {
      throw notWaiting(task.status)
    }

    await moveTo(tx, task, 'queued')
    await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
    const requestEventId = await writeRequest(tx, task.id, payload)
    await enqueueAgentTurn(tx, { taskId: task.id, attempt: task.attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
}

/**
 * «Продолжить» after a question of the platform about credits (Р8; spec §17, «Потолок
 * достигнут»): the next attempt of the same dialog with a reserve of its own — a continuation,
 * which keeps the reserve of the attempt before. The dialog waits in `awaiting_user`, or in
 * `awaiting_approval` when it has a candidate (so `/release` stays open meanwhile). A dialog
 * that used its three attempts is not continued.
 */
export async function continueDialog(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string; now: Date },
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }

    if (task.status !== 'awaiting_user' && task.status !== 'awaiting_approval') {
      if (terminalTaskStatuses.includes(task.status)) throw taskFinished()
      throw taskNothingToContinue()
    }
    const question = await openCeilingQuestion(tx, task.id)
    if (question === null) throw taskNothingToContinue()
    // The attempts of the chain: one a failure gave back is not counted (`maxTaskAttempts`).
    const chain = await taskChainAttempts(tx, task.id)
    if (question.reason === 'attempts' || chain.length >= maxTaskAttempts)
      throw taskAttemptsExhausted()

    const attempt = task.attempt + 1
    await moveTo(tx, task, 'queued', { attempt })
    await placeCreditHold(tx, {
      workspaceId: task.workspaceId,
      taskId: task.id,
      attempt,
      now,
      expiresAt: taskHoldExpiry(now, 'waiting'),
    })
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'continue',
      authorId: userId,
      requestId,
      questionEventId: String(question.id),
    })
    await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
}

/** The refusal of a press of «Попробовать ещё» by why it is not offered. */
const retryRefused: Readonly<Record<RetryRefusal, () => Error>> = {
  nothing: taskNothingToRetry,
  busy: taskBusy,
  releasing: releaseInProgress,
  finished: taskFinished,
}

/**
 * «Попробовать ещё» (the owner's answer 1 of 18.10.2026; docs/plan/53, «Попробовать ещё
 * (18.10)»): a pass of a dialog that already had a candidate failed, and the dialog waits with
 * the candidate and the failure row. The press repeats the pass as the next attempt with a
 * reserve of its own, in the class `heavy` (spec §9): the reserve of the failed attempt — the
 * whole chain — is given back, a new one is placed, the press is written as `feed.request` of
 * the kind `retry` naming the failure it answers, the preview is woken and the pass goes into the
 * outbox, in one transaction: a refused reserve rolls all of it back, and the dialog keeps
 * waiting with its candidate and its reserve. The work that built the candidate is not given
 * back with the reserve: it is charged with the dialog, from the new reserve, and bounds the keys
 * of the retry (`chargeTask`, `attemptCreditBudget`); only the pass that failed stays free (its
 * turn is rejected). Who may open the dialog may press it, as
 * «Продолжить». The three attempts do not stop it — it starts a new chain (spec §20, decision 4
 * of 11.10.2026) —; the daily limit does, like a new task (D7 of 17.10.2026: five credits that can
 * be spent now), after the chain it gives back has returned what it took of the day. A repeat
 * with the same `requestId` returns the row of the first delivery; a press on a failure that was
 * answered meanwhile, or on another one, is refused.
 */
export async function retryDialog(
  db: PrismaClient,
  chat: ChatContext,
  input: { userId: string; taskId: string; requestId: string; failureEventId: string; now: Date },
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }

    const verdict = await dialogRetry(tx, task)
    if (!verdict.allowed) throw retryRefused[verdict.refusal]()
    // The screen showed another failure: this one is the client's to see first.
    if (verdict.failureId !== input.failureEventId) throw taskNothingToRetry()
    const candidate = await liveCandidate(tx, task.id)
    if (candidate === null) throw conflict('The dialog waits for approval without a candidate')
    const site = await tx.site.findUniqueOrThrow({
      where: { id: task.siteId },
      select: { status: true, workspace: { select: { dataClass: true } } },
    })
    if (site.status !== 'active') throw taskNotAccepted('site_not_active')
    if (!isProduction(chat.appEnv) && site.workspace.dataClass !== 'synthetic')
      throw taskNotAccepted('not_synthetic')
    // The pass would fail `unavailable` — no profile of the class the planner would take, or
    // no price of it: refused before anything moves.
    if (!(await modelClassPriced(tx, { modelClass: 'heavy', backends: llmBackendIds, now })))
      throw taskNotAccepted('class_unavailable')

    assertTransition(task.status, 'queued')
    const attempt = task.attempt + 1
    await moveTo(tx, task, 'queued', { attempt, modelClass: 'heavy' })
    await releaseTask(tx, { taskId: task.id, now })
    try {
      await placeCreditHold(tx, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        attempt,
        now,
        expiresAt: taskHoldExpiry(now, 'waiting'),
      })
    } catch (error) {
      // The words of a retry, not of a new task; the transaction rolls back all the same.
      if (isDomainError(error) && error.code === 'BILLING_DAILY_LIMIT_REACHED')
        throw taskRetryDailyLimit(error.details)
      throw error
    }
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'retry',
      authorId: userId,
      requestId,
      failureEventId: verdict.failureId,
    })
    // A preview that fell asleep meanwhile is built again for the pass.
    await requestPreviewSync(tx, { taskId: task.id, revision: candidate.revision })
    await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
}

export interface CancelledDialog extends PostedRequest {
  /**
   * `cancelled` — the dialog is closed and its reserve given back; `stopping` — the agent was
   * at work, and core stops the pass and closes the dialog itself (`turn.cancel`).
   */
  state: 'cancelled' | 'stopping'
}

/**
 * `/cancel` (Р34; spec §7): a dialog that waits — queued, with a question or with a candidate —
 * is closed at once: `cancelled`, the reserve given back (`releaseTask`), `feed.cancelled` by
 * the client, and the manager of previews is woken to take its preview down. A pass that is
 * preparing or running is stopped by core: `turn.cancel` on `agent-turns`. A release in work is
 * not cancelled. Content of a dialog lives in its preview (Р3), so the site is `unchanged` —
 * unless the dialog had no preview and its agent wrote to the production site: then the client
 * is asked to check it, as the sweep says of the same dialog (`taskHasProductionWrites`). The
 * press is a `feed.request` of the command `cancel`, by which a repeat is recognised.
 */
export async function cancelDialog(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string; now: Date },
): Promise<CancelledDialog> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    const state = task.status === 'cancelled' ? 'cancelled' : 'stopping'
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true, state }

    const facts = await dialogFacts(tx, task, userId)
    assertCommandAvailable(facts.commands, 'cancel')
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'command',
      command: 'cancel',
      authorId: userId,
      requestId,
    })

    if (task.status === 'preparing' || task.status === 'running') {
      await enqueueTurnCancel(tx, { taskId: task.id, requestEventId })
      return { requestEventId, repeated: false, state: 'stopping' }
    }

    await moveTo(tx, task, 'cancelled', { finishedAt: now })
    const returned = await releaseTask(tx, { taskId: task.id, now })
    await insertFeedEvent(tx, {
      taskId: task.id,
      row: {
        type: 'feed.cancelled',
        payload: {
          v: 1,
          turn: task.turnNo >= 1 ? task.turnNo : null,
          by: 'customer',
          authorId: userId,
          site: (await taskHasProductionWrites(tx, task.id)) ? 'check' : 'unchanged',
          credits: creditsAfterReturn(returned),
        },
      },
    })
    if (facts.preview !== null)
      await requestPreviewSync(tx, { taskId: task.id, revision: facts.preview.revision })
    return { requestEventId, repeated: false, state: 'cancelled' }
  })
}

/**
 * «Обновить» (`/update`, Р27): core carries the candidate of the dialog onto the current
 * `main` without the model, rebuilds the preview and runs the checks again
 * (`candidate.rebase` on `agent-turns`). Offered when the candidate stands on an old version of
 * the site; the press is a `feed.request` of the command `update`, by which a repeat is known.
 */
export async function updateDialogCandidate(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string },
): Promise<PostedRequest> {
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }
    const facts = await dialogFacts(tx, task, input.userId)
    assertCommandAvailable(facts.commands, 'update')
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'command',
      command: 'update',
      authorId: input.userId,
      requestId,
    })
    await enqueueCandidateRebase(tx, { taskId: task.id, requestEventId })
    return { requestEventId, repeated: false }
  })
}
