import {
  extendTaskHolds,
  modelClassPriced,
  placeCreditHold,
  releaseTask,
  taskChainAttempts,
} from '@repo/billing'
import {
  enqueueAgentTurn,
  enqueueTurnCancel,
  insertFeedEvent,
  taskHasProductionWrites,
  redoTurn,
  undoTurn,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  conflict,
  feedEndedSiteOf,
  llmBackendIds,
  maxTaskAttempts,
  modelClassOfEffort,
  taskHoldExpiry,
  terminalTaskStatuses,
  workspaceTransitKey,
  type FeedAgentCommandId,
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
  lastQuestion,
  openCeilingQuestion,
  openResult,
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
  workspaceKeyUnavailable,
} from './refusals.ts'
import { dialogTitle, requestPayload, requestText } from './request-text.ts'

type Tx = Prisma.TransactionClient

/** A chat has no site (docs/plan/83-remove-projects.md, БП1): its rows say so. */
const NO_SITE = { siteId: null }

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
  now: Date
}

export interface CreatedDialog {
  taskId: string
  /** The short name of the chat. */
  alias: string
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
 */
export async function createDialog(
  db: PrismaClient,
  chat: ChatContext,
  input: CreateDialogInput,
): Promise<CreatedDialog> {
  const { userId, now } = input
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
  if (!UUID_V7.safeParse(taskId).success) throw taskIdInvalid()

  const earlier = await sameDialog(db, { taskId, userId })
  if (earlier !== null) return earlier

  const { id: workspaceId } = await personalWorkspaceOf(db, { userId, appEnv: chat.appEnv })
  const browser = browserConfigured({ chat })
  await ensureWorkspaceKey(chat, workspaceId)
  const modelClass = modelClassOfEffort(input.effort ?? 'high')

  return db.$transaction(async (tx) => {
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
          workspaceId,
          createdById: userId,
          status: 'queued',
          modelClass,
          billable: true,
          title: dialogTitle(text),
          needsBrowser: browser,
        },
      ],
      skipDuplicates: true,
    })
    if (inserted.count === 0) {
      const raced = await sameDialog(tx, { taskId, userId })
      if (raced === null) throw taskNotFound()
      return raced
    }
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { alias: true } })

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
    const requestEventId = await insertFeedEvent(tx, {
      taskId,
      row: { type: 'feed.request', payload },
    })
    await enqueueAgentTurn(tx, { taskId, attempt: 1, requestEventId: String(requestEventId) })
    return { taskId, alias: task.alias, created: true }
  }, WRITE)
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
    select: { createdById: true, alias: true, deletedAt: true },
  })
  if (task === null) return null
  // A dialog deleted since is not found again by a late repeat of the request that made it.
  if (task.createdById !== ids.userId || task.deletedAt !== null) throw taskNotFound()
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
    const ceiling =
      task.status === 'awaiting_user' || task.status === 'awaiting_approval'
        ? await openCeilingQuestion(tx, task.id)
        : null
    if (ceiling !== null) {
      payload = {
        v: 1,
        kind: 'answer',
        authorId: userId,
        requestId,
        text,
        ...attachments,
        answersEventId: String(ceiling.id),
      }
    } else if (task.status === 'awaiting_user') {
      const question = await lastQuestion(tx, task.id)
      // The words answer the open question, or the ending that left the dialog open.
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
    } else {
      throw notWaiting(task.status)
    }

    const attempt =
      ceiling !== null
        ? await wordsAfterCeiling(tx, task, ceiling, now)
        : await nextPassAttempt(tx, task, 'message', now)
    await moveTo(tx, task, 'queued', attempt === task.attempt ? {} : { attempt })
    await bindMessageAttachments(tx, {
      ids: attachments.attachments ?? [],
      taskId: task.id,
      userId,
      workspaceId: task.workspaceId,
    })
    const requestEventId = await writeRequest(tx, task.id, payload)
    // A message to an archived chat brings it back to the list (docs/plan/75, ВВ21).
    await tx.$executeRaw`
      UPDATE tasks SET archived_at = NULL WHERE id = ${task.id}::uuid AND archived_at IS NOT NULL`
    await enqueueAgentTurn(tx, { taskId: task.id, attempt, requestEventId })
    return { requestEventId, repeated: false }
  })
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
    command: FeedAgentCommandId
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
          site: feedEndedSiteOf(NO_SITE, await taskHasProductionWrites(tx, task.id)),
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
 * (`taskHasProductionWrites`). The press is a `feed.request` of the command `cancel`, by which a repeat is recognised.
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
        site: feedEndedSiteOf(NO_SITE, await taskHasProductionWrites(tx, task.id)),
        credits: creditsAfterReturn(returned),
      },
    },
  })
  return { requestEventId, state: 'cancelled' }
}
