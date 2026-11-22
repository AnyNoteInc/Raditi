import {
  extendTaskHolds,
  modelClassPriced,
  placeCreditHold,
  releaseTask,
  taskChainAttempts,
} from '@repo/billing'
import {
  attachScheduledTaskArtifacts,
  enqueueAgentTurn,
  enqueueTurnCancel,
  insertFeedEvent,
  projectForChat,
  lockWaitingRun,
  recordRunOutcomeInTx,
  scheduledRunClosed,
  redoTurn,
  touchProjectActivity,
  undoTurn,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  conflict,
  feedEndedSiteOf,
  feedLimits,
  hasVisibleText,
  llmBackendIds,
  looksLikeSecret,
  maxTaskAttempts,
  modelClassOfEffort,
  taskHoldExpiry,
  terminalTaskStatuses,
  workspaceTransitKey,
  type FeedRequestPayload,
  type ReasoningEffort,
  type TaskStatus,
} from '@repo/domain'
import { z } from 'zod'

import { failureLabel } from '../failure-label.ts'
import { taskNotFound, type LockedTask } from './access.ts'
import { bindMessageAttachments, requestAttachments } from './attachments.ts'
import { browserConfigured, type ChatContext } from './context.ts'
import { assertCommandAvailable, dialogFacts, type DialogFacts } from './dialog-facts.ts'
import { moveTo, personalWorkspaceOf, underDialogLock, WRITE, writeRequest } from './dialog-lock.ts'
import {
  cancelPending,
  creditsAfterReturn,
  dialogMessageTarget,
  lastQuestion,
  openCeilingQuestion,
  requestOf,
  wordsOfTurn,
  wordsOfUndonePress,
  type DialogQuestion,
} from './dialog-state.ts'
import {
  taskAttemptsExhausted,
  taskBusy,
  taskContinueRequired,
  taskFinished,
  taskIdInvalid,
  taskNotAccepted,
  taskNothingToContinue,
  taskNothingToResume,
  taskTextEmpty,
  taskTextHasSecret,
  taskTextTooLong,
  workspaceKeyUnavailable,
} from './refusals.ts'
import { dialogTitle, requestPayload, requestText } from './request-text.ts'

type Tx = Prisma.TransactionClient

/** An explicit attachment to a single request, committed with its reserve and outbox row. */
export interface DialogRequestBinding {
  lock(tx: Tx): Promise<void>
  authorize(tx: Tx, taskId: string): Promise<void>
  /**
   * The earlier receipt under this key, its access checked again. The caller of `createDialog`
   * calls it first; both writers call it again under `lock`.
   */
  replay(db: Tx): Promise<{ taskId: string; requestEventId: string } | null>
  bind(tx: Tx, ids: { taskId: string; workspaceId: string; requestEventId: string }): Promise<void>
  collision(): Error
}

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
    default:
      return taskFinished()
  }
}

// ---------------------------------------------------------------------------------------------
// task.create
// ---------------------------------------------------------------------------------------------

export interface CreateDialogInput {
  userId: string
  /** Invented by the browser (UUID v7): a repeated request is recognised by it. */
  taskId: string
  text: string
  /** Files of the first message, announced and stored (`attachment.start`), lowercase. */
  attachments?: readonly string[]
  /** How hard the model thinks (owner's request of 26.10.2026); absent — `high`, as before. */
  effort?: ReasoningEffort
  /**
   * The project the chat starts in (docs/plan/84-projects.md, ПР2, ПР30), lowercase; null or
   * absent — a chat without a project.
   */
  projectId?: string | null
  /**
   * The name of the chat, set by the client (`title_source = 'client'`): the agent never renames
   * it. Absent — the first line of the words, which the agent may rename on its first pass. A run
   * of a scheduled task names its chat by the task (docs/plan/82-scheduled-tasks.md, Зп17).
   */
  title?: string
  /**
   * The run of a scheduled task this chat is of (docs/plan/82-scheduled-tasks.md, Зп20, Зп27):
   * the transaction that makes the chat takes the run's task first and writes the run `started`
   * with it, so a chat of a run is never seen without its run — every guard of a pass without its
   * client finds it — nor made after the run was closed (`SCHEDULE_RUN_CLOSED`, nothing written).
   */
  scheduledRunId?: string
  now: Date
}

export interface CreatedDialog {
  taskId: string
  requestEventId?: string
  /** false — the same request was delivered before, nothing was written now. */
  created: boolean
}

/** A chat takes only these ids (К14, `tasks_chat_id_check`): its id is its lease. */
const UUID_V7 = z.uuid({ version: 'v7' })

/**
 * The Transit key of the workspace, made when it is missing (docs/plan/57-browser-tasks.md, Б32):
 * every turn of a task seals its snapshot with it. A failure of Vault — or of its settings — refuses the task with
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
 * A new chat (docs/plan/53-chat-preview-release.md, Р1, Р8; feed design, «Три писателя»): one
 * transaction writes the task (`queued`, billable), sets credits aside for its first attempt
 * (`placeCreditHold`), binds the files of the first message, writes the client's words as
 * `feed.request` and puts the pass into the outbox. A refused reserve or file rolls all of it back:
 * there is no task without a reserve. A repeat with the same id returns the task of the first
 * delivery to its author; an id that is someone else's answers NOT_FOUND.
 *
 * A chat has no project (docs/plan/83-remove-projects.md, БП1): it goes to the user's personal
 * workspace, made here for a new user with the gift of the registration (К15), without the
 * repository and with the browser where the platform has one. Its id is of version 7: it is its
 * lease (К14). Rule 1 stands: the personal workspace has the data class of this environment, so
 * outside production it is synthetic (`findPersonalWorkspace`). The Transit key of the workspace
 * is made before the transaction (Б32): a failure of Vault writes nothing — no task, no reserve.
 *
 * A chat in a project (docs/plan/84-projects.md, ПР2, ПР30) goes to the workspace of the project —
 * a live one of the user, out of «Архив» (PROJECT_NOT_FOUND, PROJECT_ARCHIVED, checked again under
 * the transaction) — and the project rises in «Недавние».
 */
export async function createDialog(
  db: PrismaClient,
  chat: ChatContext,
  input: CreateDialogInput,
  binding?: DialogRequestBinding,
): Promise<CreatedDialog> {
  const { userId, now } = input
  const taskId = input.taskId.toLowerCase()
  const text = requestText(input.text)
  const title = input.title === undefined ? null : clientTitle(input.title)
  const attachments = input.attachments ?? []
  const payload = requestPayload({
    v: 1,
    kind: 'first',
    authorId: userId,
    requestId: taskId,
    text,
    ...requestAttachments(attachments),
  })
  if (!UUID_V7.safeParse(taskId).success) throw taskIdInvalid()

  // The caller of a bound request has replayed it already; it replays again under its lock below.
  if (!binding) {
    const earlier = await sameDialog(db, { taskId, userId })
    if (earlier !== null) return earlier
  }

  const projectId = input.projectId?.toLowerCase() ?? null
  const workspaceId =
    projectId === null
      ? (await personalWorkspaceOf(db, { userId, appEnv: chat.appEnv })).id
      : (await projectForChat(db, projectId, userId)).workspaceId
  const browser = browserConfigured({ chat })
  await ensureWorkspaceKey(chat, workspaceId)
  const modelClass = modelClassOfEffort(input.effort ?? 'high')

  return db.$transaction(async (tx) => {
    if (binding) {
      await binding.lock(tx)
      const earlier = await binding.replay(tx)
      if (earlier !== null) return { ...earlier, created: false }
    }
    // The task of the run first, as the tick takes it; a run closed meanwhile gets no chat.
    if (input.scheduledRunId !== undefined && !(await lockWaitingRun(tx, input.scheduledRunId)))
      throw scheduledRunClosed()
    // The pass would fail `unavailable` without a profile of the chosen class or its price:
    // refused before anything is written, as «Попробовать ещё» refuses it.
    if (!(await modelClassPriced(tx, { modelClass, backends: llmBackendIds, now })))
      throw taskNotAccepted('class_unavailable')
    // Archived or put into the trash meanwhile: refused in the client's words, not by the trigger.
    if (projectId !== null) await projectForChat(tx, projectId, userId)
    // ON CONFLICT DO NOTHING: a repeat that raced the first delivery waits for it here and
    // writes nothing; an error would abort the transaction instead.
    const inserted = await tx.task.createMany({
      data: [
        {
          id: taskId,
          workspaceId,
          createdById: userId,
          status: 'queued',
          modelClass,
          billable: true,
          ...(title === null
            ? { title: dialogTitle(text) }
            : { title, titleSource: 'client' as const }),
          needsBrowser: browser,
          projectId,
        },
      ],
      skipDuplicates: true,
    })
    if (inserted.count === 0) {
      const raced = await sameDialog(tx, { taskId, userId })
      if (raced === null) throw taskNotFound()
      if (binding) throw binding.collision()
      return raced
    }
    if (input.scheduledRunId !== undefined) {
      const bound = await recordRunOutcomeInTx(
        tx,
        input.scheduledRunId,
        { status: 'started', taskId },
        now,
      )
      if (!bound.recorded) throw scheduledRunClosed()
      // The artifacts its task names are given to the chat (docs/plan/88-artifacts.md, Ар24).
      await attachScheduledTaskArtifacts(tx, {
        taskId,
        scheduledRunId: input.scheduledRunId,
        now,
      })
    }
    await placeCreditHold(tx, {
      workspaceId,
      taskId,
      attempt: 1,
      now,
      expiresAt: taskHoldExpiry(now, 'waiting'),
    })
    await bindMessageAttachments(tx, {
      ids: attachments,
      taskId,
      userId,
      workspaceId,
    })
    const requestEventId = await writeRequest(tx, taskId, payload)
    await binding?.bind(tx, { taskId, workspaceId, requestEventId })
    await enqueueAgentTurn(tx, { taskId, attempt: 1, requestEventId })
    if (projectId !== null) await touchProjectActivity(tx, projectId, now)
    return { taskId, created: true, ...(binding ? { requestEventId } : {}) }
  }, WRITE)
}

/**
 * The name a caller gives a new chat, by the rules of a rename (`dialogName` of `task.rename`): one
 * line, spaces collapsed, at most the length of a title, refused in the client's words.
 */
function clientTitle(name: string): string {
  const line = name.replace(/\s+/gu, ' ').trim()
  if (!hasVisibleText(line)) throw taskTextEmpty()
  if (line.length > feedLimits.title) throw taskTextTooLong()
  if (looksLikeSecret(line)) throw taskTextHasSecret()
  return line
}

/**
 * The task of an earlier delivery of the same `task.create`: the same id and author. An id taken
 * by anything else is NOT_FOUND — the caller learns nothing of it.
 */
async function sameDialog(
  db: Pick<Tx, 'task'>,
  ids: { taskId: string; userId: string },
): Promise<CreatedDialog | null> {
  const task = await db.task.findUnique({
    where: { id: ids.taskId },
    select: { createdById: true, deletedAt: true },
  })
  if (task === null) return null
  // A dialog deleted since is not found again by a late repeat of the request that made it.
  if (task.createdById !== ids.userId || task.deletedAt !== null) throw taskNotFound()
  return { taskId: ids.taskId, created: false }
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
 * The attempt the next pass of an open dialog runs in, and its reserve (owner's answer of
 * 26.10.2026: every completed pass is charged when it ends). A chain that is still active — a
 * charge of the last pass waits for its usage — goes on, and its reserve is moved on. A chain that was charged, or given back after a
 * failure that left the dialog open (28.10.2026), is followed by a new one: the next attempt,
 * its reserve placed now (`follows` — the client's words or «Продолжить»), refused as a new task
 * would be. A task that is not billable goes on in its attempt.
 */
async function nextPassAttempt(
  tx: Tx,
  task: LockedTask,
  follows: 'message' | 'continue',
  now: Date,
): Promise<number> {
  const active = await tx.creditHold.count({ where: { taskId: task.id, status: 'active' } })
  if (active > 0) {
    await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
    return task.attempt
  }
  const row = await tx.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { billable: true },
  })
  if (!row.billable) return task.attempt
  const attempt = task.attempt + 1
  await placeCreditHold(tx, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    attempt,
    now,
    expiresAt: taskHoldExpiry(now, 'waiting'),
    follows,
  })
  return attempt
}

/**
 * Words to a dialog that waits (Р6): the answer to the agent's question or to a result that
 * left the dialog open (`awaiting_user → queued`, `feed.request` `answer`; owner's decision of
 * 26.10.2026). The pass that ended was charged, so the words open the next attempt with
 * a reserve of its own (`nextPassAttempt`; refused for credits as a new task is); a chain still
 * active goes on under its reserve. The pass goes into the outbox with the row. A question of the platform about credits is answered
 * by «Продолжить» (`task.continue`), never by words. A repeat with the same `requestId` returns
 * the row of the first delivery. The files of the message are bound to the task with it — all of
 * them or the message is refused. Words to a task in the browser that asked the client to act
 * there answer it as well (docs/plan/57, Б16): the agent goes on. Words to a question of the
 * platform about credits go on as «Продолжить» does, with the client's words for the agent
 * (owner's decision of 28.10.2026: «пользователь всегда должен иметь возможность ввести промпт»).
 */
export async function postDialogMessage(
  db: PrismaClient,
  input: DialogMessageInput,
  binding?: DialogRequestBinding,
): Promise<PostedRequest> {
  const { userId, now } = input
  const requestId = input.requestId.toLowerCase()
  const text = requestText(input.text)
  const attachments = requestAttachments(input.attachments ?? [])
  // Checked before the transaction, so the words are refused in the client's terms.
  requestPayload({ v: 1, kind: 'first', authorId: userId, requestId, text, ...attachments })

  return underDialogLock(
    db,
    input,
    async (tx, task) => {
      if (binding) {
        await binding.authorize(tx, task.id)
        const earlier = await binding.replay(tx)
        if (earlier !== null) return { requestEventId: earlier.requestEventId, repeated: true }
      }
      const repeated = await requestOf(tx, task.id, requestId)
      if (repeated !== null) {
        if (binding) throw binding.collision()
        return { requestEventId: String(repeated), repeated: true }
      }
      const target = await dialogMessageTarget(tx, {
        ...task,
        needsBrowser: task.requirements.browser,
      })
      if (target.kind === 'cancel_pending') throw taskFinished()
      if (target.kind === 'not_waiting') throw notWaiting(task.status)
      if (target.kind === 'no_open_event')
        throw conflict('The dialog waits for an answer without an open question')
      const payload: FeedRequestPayload = {
        v: 1,
        kind: 'answer',
        authorId: userId,
        requestId,
        text,
        ...attachments,
        answersEventId: String(target.kind === 'ceiling' ? target.question.id : target.id),
      }
      const attempt =
        target.kind === 'ceiling'
          ? await wordsAfterCeiling(tx, task, target.question, now)
          : await nextPassAttempt(tx, task, 'message', now)
      await moveTo(tx, task, 'queued', attempt === task.attempt ? {} : { attempt })
      await bindMessageAttachments(tx, {
        ids: attachments.attachments ?? [],
        taskId: task.id,
        userId,
        workspaceId: task.workspaceId,
      })
      const requestEventId = await writeRequest(tx, task.id, payload)
      await binding?.bind(tx, { taskId: task.id, workspaceId: task.workspaceId, requestEventId })
      // A message to an archived chat brings it back to the list (docs/plan/75, ВВ21).
      await tx.$executeRaw`
      UPDATE tasks SET archived_at = NULL WHERE id = ${task.id}::uuid AND archived_at IS NOT NULL`
      await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
      return { requestEventId, repeated: false }
    },
    binding?.lock,
  )
}

/**
 * The attempt that goes on after a question of the platform about credits, its reserve placed
 * (Р8): a continuation keeps the reserve of the attempt before; after a pass that ran out and
 * was charged (26.10.2026) it opens a new chain (`follows: 'continue'`). A dialog that used its
 * three attempts is not continued.
 */
async function continuationAttempt(
  tx: Tx,
  task: LockedTask,
  question: DialogQuestion,
  now: Date,
): Promise<number> {
  // The attempts of the chain: one a failure gave back is not counted (`maxTaskAttempts`).
  const chain = await taskChainAttempts(tx, task.id)
  if (question.reason === 'attempts' || chain.length >= maxTaskAttempts)
    throw taskAttemptsExhausted()
  const attempt = task.attempt + 1
  await placeCreditHold(tx, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    attempt,
    now,
    expiresAt: taskHoldExpiry(now, 'waiting'),
    // The pass that ran out was charged: the work goes on in a new chain.
    ...(chain.length === 0 ? { follows: 'continue' as const } : {}),
  })
  return attempt
}

/**
 * The attempt the client's words to a question about credits go on in (28.10.2026: «пользователь
 * всегда должен иметь возможность ввести промпт»): a continuation, as «Продолжить» places it, or —
 * once the chain has used its attempts, when «Продолжить» has nothing to offer — the next words
 * of an open dialog, a new chain as after an answer.
 */
async function wordsAfterCeiling(
  tx: Tx,
  task: LockedTask,
  question: DialogQuestion,
  now: Date,
): Promise<number> {
  const chain = await taskChainAttempts(tx, task.id)
  if (question.reason === 'attempts' || chain.length >= maxTaskAttempts)
    return nextPassAttempt(tx, task, 'message', now)
  return continuationAttempt(tx, task, question, now)
}

/**
 * «Продолжить» after a question of the platform about credits (Р8; spec §17, «Потолок
 * достигнут»): the next attempt of the same dialog with a reserve of its own — a continuation,
 * which keeps the reserve of the attempt before, or, when the pass that ran out was charged
 * (26.10.2026), a new chain (`follows: 'continue'`). The dialog waits in `awaiting_user`. A dialog
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
    const attempt = await continuationAttempt(tx, task, question, now)
    await moveTo(tx, task, 'queued', { attempt })
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
 * work back without words. The pass that asked was charged (26.10.2026): the work goes on in the
 * next attempt with a reserve of its own (`nextPassAttempt`, as «Продолжить»), or under the chain
 * that is still active; the pass takes the browser back from the client when it starts. A
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

    const attempt = await nextPassAttempt(tx, task, 'continue', now)
    await moveTo(tx, task, 'queued', attempt === task.attempt ? {} : { attempt })
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'resume',
      authorId: userId,
      requestId,
    })
    await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
}

/**
 * A command the agent carries out (docs/plan/61-chats-first.md, К30, §5.14): `/compact` — a pass
 * that shortens the session. It goes as the next words of the client would — paid, its reserve placed as theirs
 * (`follows`), refused for credits as they are — and, as they do, moves the chat on past a
 * question; it writes no words, only the command. A repeat with the same `requestId` returns the
 * row of the first delivery.
 */
export async function agentCommandDialog(
  db: PrismaClient,
  input: {
    userId: string
    taskId: string
    requestId: string
    /** The one command of the agent a chat has since `/init` went (plan 83). */
    command: 'compact'
    now: Date
  },
): Promise<PostedRequest> {
  const { userId, command, now } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated), repeated: true }
    const facts = await dialogFacts(tx, task, userId)
    assertCommandAvailable(facts.commands, command)

    const ceiling = await openCeilingQuestion(tx, task.id)
    const attempt =
      ceiling !== null
        ? await wordsAfterCeiling(tx, task, ceiling, now)
        : await nextPassAttempt(tx, task, 'message', now)
    await moveTo(tx, task, 'queued', attempt === task.attempt ? {} : { attempt })
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'agent_command',
      command,
      authorId: userId,
      requestId,
    })
    await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
}

/**
 * `/undo` (docs/plan/61-chats-first.md, К29, §5.14): the last turn is taken back, so the next pass
 * starts where it started and its words go to the agent no more; they come back to the field
 * instead. No model: its browser and its sign-in stay, and no money moves — the pass was charged
 * when it ended, and `undone_at` is no `rejected_at`. It is done here: the chat keeps waiting as it
 * did, and the row says what stays on the sites — the browser belongs to the whole task, not to
 * the turn. A repeat with the same
 * `requestId` returns the row of the first delivery and the words too: it comes when the page
 * never got the first answer, and the page puts them only into an empty field.
 */
export async function undoDialogTurn(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string },
): Promise<UndoneTurn> {
  const { userId } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null)
      return {
        requestEventId: String(repeated),
        repeated: true,
        words: await wordsOfUndonePress(tx, task, repeated),
      }
    const facts = await dialogFacts(tx, task, userId)
    assertCommandAvailable(facts.commands, 'turn_undo')
    const words = await wordsOfTurn(tx, task.id, task.turnNo)
    const turnId = await undoTurn(tx, { taskId: task.id, turnNo: task.turnNo })
    if (turnId === null) throw conflict('The last turn of the chat is no longer there to undo')
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'command',
      command: 'turn_undo',
      authorId: userId,
      requestId,
    })
    await insertFeedEvent(tx, {
      taskId: task.id,
      turnId,
      row: {
        type: 'feed.rewind',
        payload: {
          v: 1,
          turn: task.turnNo,
          files: false,
          site: feedEndedSiteOf(await browserWrote(tx, task.id)),
        },
      },
    })
    return { requestEventId, repeated: false, words }
  })
}

/**
 * `/redo` (docs/plan/61-chats-first.md, §5.14): the turn `/undo` took comes back, while nothing
 * moved the chat since. The next pass goes on from it, its words stand as read, and the page takes
 * them out of the field, or they would be sent a second time: they are given back as `/undo` gives
 * them. No model and no money. It is done here, and the chat, which `/undo` did not move either,
 * waits as it did. A repeat with the same
 * `requestId` returns the row of the first delivery.
 */
export async function redoDialogTurn(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string },
): Promise<UndoneTurn> {
  const { userId } = input
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null)
      return {
        requestEventId: String(repeated),
        repeated: true,
        words: await wordsOfTurn(tx, task.id, task.turnNo),
      }
    const facts = await dialogFacts(tx, task, userId)
    assertCommandAvailable(facts.commands, 'turn_redo')
    const words = await wordsOfTurn(tx, task.id, task.turnNo)
    const press = {
      v: 1,
      kind: 'command',
      command: 'turn_redo',
      authorId: userId,
      requestId,
    } as const
    const turnId = await redoTurn(tx, { taskId: task.id, turnNo: task.turnNo })
    if (turnId === null) throw conflict('The undone turn of the chat is no longer there to redo')
    const requestEventId = await writeRequest(tx, task.id, press)
    await insertFeedEvent(tx, {
      taskId: task.id,
      turnId,
      row: { type: 'feed.redo', payload: { v: 1, turn: task.turnNo, files: false, open: false } },
    })
    return { requestEventId, repeated: false, words }
  })
}

export interface UndoneTurn extends PostedRequest {
  /** What the client wrote for the undone turn, for the field; null — nothing. */
  words: string | null
}

export interface CancelledDialog extends PostedRequest {
  /**
   * `cancelled` — the dialog is closed and its reserve given back; `stopping` — the agent was
   * at work, and core stops the pass and closes the dialog itself (`turn.cancel`).
   */
  state: 'cancelled' | 'stopping'
}

/**
 * `/cancel` (Р34; spec §7): a chat that waits — queued or with a question — is closed at once:
 * `cancelled`, the reserve given back (`releaseTask`), `feed.cancelled` by the client. A pass that
 * is preparing or running is stopped by core: `turn.cancel` on `agent-turns`. When the agent wrote
 * on a site in the browser the client is asked to check it, as the sweep says of the same chat
 * (`browserWrote`). The press is a `feed.request` of the command `cancel`, by which a repeat is recognised.
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
    return { ...(await stopDialog(tx, task, facts, { userId, requestId, now })), repeated: false }
  })
}

/**
 * `/cancel` of a locked dialog the verdicts allow it for: the command is written as the client's
 * request, then the dialog that waits is closed at once — its reserve given back — while one that works, or a task in the browser, is stopped by core. Also
 * the first step of «Удалить диалог» (`removeDialog`).
 */
export async function stopDialog(
  tx: Tx,
  task: LockedTask,
  facts: DialogFacts,
  input: { userId: string; requestId: string; now: Date },
): Promise<{ requestEventId: string; state: 'cancelled' | 'stopping' }> {
  const { userId, requestId, now } = input
  // A chat that stops keeps no words for a next pass (docs/plan/75, ВВ5).
  await tx.taskQueuedMessage.deleteMany({ where: { taskId: task.id } })
  const requestEventId = await writeRequest(tx, task.id, {
    v: 1,
    kind: 'command',
    command: 'cancel',
    authorId: userId,
    requestId,
  })

  if (task.requirements.browser || task.status === 'preparing' || task.status === 'running') {
    await enqueueTurnCancel(tx, { taskId: task.id, requestEventId })
    return { requestEventId, state: 'stopping' }
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
        site: feedEndedSiteOf(await browserWrote(tx, task.id)),
        credits: creditsAfterReturn(returned),
      },
    },
  })
  return { requestEventId, state: 'cancelled' }
}

/**
 * Whether anyone acted in the browser of the chat (`browser_sessions.wrote_at`): what was done
 * there stays on the site it was done on, and the feed says to check it.
 */
async function browserWrote(db: Pick<Tx, 'browserSession'>, taskId: string): Promise<boolean> {
  return (await db.browserSession.count({ where: { taskId, wroteAt: { not: null } } })) > 0
}
