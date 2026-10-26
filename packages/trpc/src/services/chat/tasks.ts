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
  type SiteStatus,
} from '@repo/db'
import {
  assertTransition,
  conflict,
  isProduction,
  llmBackendIds,
  maxTaskAttempts,
  modelClassOfEffort,
  siteSetupState,
  taskHoldExpiry,
  terminalTaskStatuses,
  workspaceTransitKey,
  type FeedRequestPayload,
  type ReasoningEffort,
  type RetryRefusal,
  type TaskRequirements,
  type TaskStatus,
} from '@repo/domain'

import { failureLabel } from '../site-access.ts'
import { accessibleSite } from '../site-basics.ts'
import { lockLiveSite } from '../site-delete.ts'
import {
  browserAddressSecure,
  defaultRequirements,
  siteCapabilities,
  type SiteCapabilities,
} from '../site-capabilities.ts'
import { codeImportOnly } from '../site-setup.ts'
import { taskNotFound } from './access.ts'
import { bindMessageAttachments, requestAttachments } from './attachments.ts'
import { browserConfigured, type ChatContext } from './context.ts'
import { assertCommandAvailable, dialogFacts } from './dialog-facts.ts'
import { moveTo, underDialogLock, WRITE, writeRequest } from './dialog-lock.ts'
import {
  cancelPending,
  creditsAfterReturn,
  dialogRetry,
  lastQuestion,
  liveCandidate,
  openCeilingQuestion,
  openResult,
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
  taskNothingToResume,
  taskNothingToRetry,
  workspaceKeyUnavailable,
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
  /**
   * What the task works with (docs/plan/57-browser-tasks.md, Б2, Б3); absent — the repository
   * where the site has it ready, else the browser where that is (`defaultRequirements`).
   */
  requirements?: TaskRequirements
  /** Files of the first message, announced and stored (`attachment.start`), lowercase. */
  attachments?: readonly string[]
  /** How hard the model thinks (owner's request of 26.10.2026); absent — `high`, as before. */
  effort?: ReasoningEffort
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
 * Whether a site takes a task with these requirements (Б3, Б9), or the refusal: the repository and
 * the browser at once are not taken yet; a task in the browser needs a site that is not closed and
 * a browser of the platform; a task with the repository, a connected site — as it always did.
 */
function assertEnvironment(
  requirements: TaskRequirements,
  site: { status: SiteStatus },
  capabilities: SiteCapabilities,
): void {
  if (requirements.repository && requirements.browser)
    throw taskNotAccepted('environment_unsupported')
  if (requirements.repository) {
    if (site.status !== 'active') throw taskNotAccepted('site_not_active')
    return
  }
  if (capabilities.browser === 'closed') throw taskNotAccepted('site_not_active')
  if (capabilities.browser === 'insecure') throw taskNotAccepted('browser_insecure')
  if (capabilities.browser !== 'ready') throw taskNotAccepted('browser_unavailable')
}

/**
 * The Transit key of the workspace, made when it is missing (docs/plan/57-browser-tasks.md, Б32):
 * every turn of a task seals its snapshot with it, and a site added by «Добавить проект» has no
 * other step that makes it. A failure of Vault — or of its settings — refuses the task with
 * WORKSPACE_KEY_UNAVAILABLE; the log names the workspace and the class of the failure only.
 */
async function ensureWorkspaceKey(chat: ChatContext, workspaceId: string): Promise<void> {
  try {
    await chat.secrets().transitEnsureKey(workspaceTransitKey(workspaceId))
  } catch (error) {
    console.warn(`workspace_key_failed workspace=${workspaceId} ${failureLabel(error)}`)
    throw workspaceKeyUnavailable()
  }
}

/**
 * A new dialog (docs/plan/53-chat-preview-release.md, Р1, Р8; feed design, «Три писателя»):
 * one transaction writes the task (`queued`, class `standard`, billable), sets credits aside
 * for its first attempt (`placeCreditHold`), binds the files of the first message, writes the
 * client's words as `feed.request`, puts the pass into the outbox and opens the preview of the
 * dialog. A refused reserve or file rolls all of it back: there is no task without a reserve. A
 * repeat with the same id returns the task of the first delivery to its author; an id that is
 * someone else's answers NOT_FOUND.
 *
 * A task with the repository needs a connected site (`active`); a task in the browser (docs/plan/57,
 * Б9) a site that is not closed and the browser of the platform, and it gets no preview — it works
 * in the site itself (Б1). Outside production a dialog is taken only in a synthetic workspace
 * (rule 1; spec §20, decision 6 of 11.10.2026). The Transit key of the workspace is made before
 * the transaction, after the refusals that read the database only (Б32): a refused task asks
 * nothing of Vault, and a failure of Vault writes nothing — no task, no reserve.
 */
export async function createDialog(
  db: PrismaClient,
  chat: ChatContext,
  input: CreateDialogInput,
): Promise<CreatedDialog> {
  const { userId, siteId, now } = input
  const taskId = input.taskId.toLowerCase()
  const text = requestText(input.text)
  const attachments = input.attachments ?? []
  const payload = requestPayload({
    v: 1,
    kind: 'first',
    authorId: userId,
    requestId: taskId,
    text,
    ...requestAttachments(attachments),
  })

  const earlier = await sameDialog(db, { taskId, siteId, userId })
  if (earlier !== null) return earlier

  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      workspaceId: true,
      status: true,
      url: true,
      alias: true,
      workspace: { select: { dataClass: true } },
      provisioningStages: { ...codeImportOnly, select: { status: true } },
      gitRepositories: { select: { id: true }, take: 1 },
    },
  })
  if (site === null) throw taskNotFound()
  const capabilities = siteCapabilities({
    status: site.status,
    setup: siteSetupState(site.provisioningStages[0]),
    hasRepository: site.gitRepositories.length > 0,
    browserConfigured: browserConfigured({ chat }),
    secureAddress: browserAddressSecure(site.url, chat.appEnv),
  })
  const requirements = input.requirements ?? defaultRequirements(capabilities)
  assertEnvironment(requirements, site, capabilities)
  if (!isProduction(chat.appEnv) && site.workspace.dataClass !== 'synthetic')
    throw taskNotAccepted('not_synthetic')
  const preview = requirements.repository ? chat.preview : null
  const hasDatabase = preview !== null && (await siteHasDatabase(db, site.id))
  await ensureWorkspaceKey(chat, site.workspaceId)
  const modelClass = modelClassOfEffort(input.effort ?? 'high')

  return db.$transaction(async (tx) => {
    // A site being deleted waits here, and a deleted one is not found (`deleteSite`).
    await lockLiveSite(tx, site.id)
    // The pass would fail `unavailable` without a profile of the chosen class or its price:
    // refused before anything is written, as «Попробовать ещё» refuses it.
    if (!(await modelClassPriced(tx, { modelClass, backends: llmBackendIds, now })))
      throw taskNotAccepted('class_unavailable')
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
          modelClass,
          billable: true,
          title: dialogTitle(text),
          // «Чат» is a dialog without the files of the site, «Работа» one on their copy (owner's
          // request of 26.10.2026).
          mode: requirements.repository ? 'work' : 'chat',
          needsRepository: requirements.repository,
          needsBrowser: requirements.browser,
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
    await bindMessageAttachments(tx, {
      ids: attachments,
      taskId,
      userId,
      workspaceId: site.workspaceId,
      siteId: site.id,
    })
    const requestEventId = await insertFeedEvent(tx, {
      taskId,
      row: { type: 'feed.request', payload },
    })
    await enqueueAgentTurn(tx, { taskId, attempt: 1, requestEventId: String(requestEventId) })
    if (preview !== null) {
      await insertDialogPreview(tx, {
        siteId: site.id,
        taskId,
        siteAlias: site.alias,
        taskAlias: task.alias,
        hasDatabase,
        address: preview.address,
        ttlHours: preview.ttlHours,
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
  /** Files of the message (docs/plan/57, Б26), lowercase: bound to the task with the words. */
  attachments?: readonly string[]
  now: Date
}

/**
 * Words to a dialog that waits (Р6): the answer to the agent's question or to a result that
 * left the dialog open (`awaiting_user → queued`, `feed.request` `answer`; owner's decision of
 * 26.10.2026) or a new pass on top of the candidate (`awaiting_approval →
 * queued`, `revision`). The same attempt goes on under the same reserve, which is moved on; the
 * pass goes into the outbox with the row. A question of the platform about credits is answered
 * by «Продолжить» (`task.continue`), never by words. A repeat with the same `requestId` returns
 * the row of the first delivery. The files of the message are bound to the task with it — all of
 * them or the message is refused. Words to a task in the browser that asked the client to act
 * there answer it as well (docs/plan/57, Б16): the agent goes on.
 */
export async function postDialogMessage(
  db: PrismaClient,
  input: DialogMessageInput,
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  const text = requestText(input.text)
  const attachments = requestAttachments(input.attachments ?? [])
  // Checked before the transaction, so the words are refused in the client's terms.
  requestPayload({ v: 1, kind: 'first', authorId: userId, requestId, text, ...attachments })

  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }
    // «Остановить» of a task in the browser is final: core is closing it (Б24).
    if (task.requirements.browser && (await cancelPending(tx, task.id))) throw taskFinished()

    let payload: FeedRequestPayload
    if (task.status === 'awaiting_user') {
      const question = await lastQuestion(tx, task.id)
      if (question !== null && !question.answered && question.kind === 'ceiling')
        throw taskContinueRequired()
      // The words answer the open question, or the result that left the dialog open.
      const answers =
        question !== null && !question.answered ? question.id : await openResult(tx, task.id)
      if (answers === null)
        throw conflict('The dialog waits for an answer without an open question')
      payload = {
        v: 1,
        kind: 'answer',
        authorId: userId,
        requestId,
        text,
        ...attachments,
        answersEventId: String(answers),
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
        ...attachments,
        candidateRevision: candidate.revision,
      }
    } else {
      throw notWaiting(task.status)
    }

    await moveTo(tx, task, 'queued')
    await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
    await bindMessageAttachments(tx, {
      ids: attachments.attachments ?? [],
      taskId: task.id,
      userId,
      workspaceId: task.workspaceId,
      siteId: task.siteId,
    })
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
    // «Остановить» of a task in the browser is final: core is closing it (Б24).
    if (task.requirements.browser && (await cancelPending(tx, task.id))) throw taskFinished()

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

/**
 * «Продолжить работу агента» (docs/plan/57-browser-tasks.md, Б16): a task in the browser waits for
 * the client — the agent asked them to act there, or asked a question — and the client gives the
 * work back without words. The same attempt goes on under the same reserve, which is moved on, as
 * an answer would (Б25); the pass takes the browser back from the client when it starts. A
 * question of the platform about credits is answered by «Продолжить». A repeat with the same
 * `requestId` returns the row of the first delivery.
 */
export async function resumeDialog(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string; now: Date },
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }
    // «Остановить» of a task in the browser is final: core is closing it (Б24).
    if (task.requirements.browser && (await cancelPending(tx, task.id))) throw taskFinished()

    if (!task.requirements.browser) throw taskNothingToResume()
    if (task.status !== 'awaiting_user') {
      if (task.status === 'awaiting_approval') throw taskNothingToResume()
      throw notWaiting(task.status)
    }
    const question = await lastQuestion(tx, task.id)
    if (question === null || question.answered) throw taskNothingToResume()
    if (question.kind === 'ceiling') throw taskContinueRequired()

    await moveTo(tx, task, 'queued')
    await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'resume',
      authorId: userId,
      requestId,
    })
    await enqueueAgentTurn(tx, { taskId: task.id, attempt: task.attempt, requestEventId })
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
 * of 11.10.2026) —, and neither does the daily limit (the owner, 19.10.2026): the reserve is
 * placed as a retry (`retry: true`), whose tariff part only the free tariff credits bound, and
 * what it takes still counts on the day for the placements after it. It needs five credits that
 * can be spent, and unpaid work bounds it like a new task. A repeat with the same `requestId`
 * returns the row of the first delivery; a press on a failure that was answered meanwhile, or on
 * another one, is refused.
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
    // A retry by the verdict above, which the day does not bound: said here, never by the client.
    await placeCreditHold(tx, {
      workspaceId: task.workspaceId,
      taskId: task.id,
      attempt,
      now,
      expiresAt: taskHoldExpiry(now, 'waiting'),
      retry: true,
    })
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
 *
 * A task in the browser (docs/plan/57, Б24) is stopped by core in any status it has not ended
 * in: core reads on the site what the task saved there, writes `feed.cancelled` with it, gives
 * the reserve back and closes the browser — nothing on the site is deleted. Until it has, the
 * task takes no words, «Продолжить» or «Продолжить работу агента» (`cancelPending`): a row after
 * the press would hide it from core, and the agent would go on.
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

    if (task.requirements.browser || task.status === 'preparing' || task.status === 'running') {
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
