import { enqueueTurnCancel, type Prisma, type PrismaClient } from '@repo/db'
import { DomainError } from '@repo/domain'

import { bindMessageAttachments, requestAttachments } from './attachments.ts'
import { underDialogLock, writeRequest } from './dialog-lock.ts'
import { cancelPending, requestOf, turnRewinding } from './dialog-state.ts'
import { requestPayload, requestText } from './request-text.ts'
import { releaseInProgress, taskFinished, taskRedoing, taskRewinding } from './refusals.ts'

// The queue of a chat (docs/plan/75-chat-input-output.md, ВВ1–ВВ5): while the agent works the
// client writes on. The words wait in `task_queued_messages`, where the client may change or
// remove them; core takes them into the feed when the pass ends (`queue.drain`), and «Отправить
// сейчас» stops the pass for them (ВВ4). A dialog that waits takes words by `task.message`: the
// queue refuses them with TASK_NOT_BUSY, and the cabinet sends them so.

type Tx = Prisma.TransactionClient

/** The statuses a pass is planned or runs in: the words wait for it (ВВ1). */
const WORKING = ['queued', 'preparing', 'running'] as const
/** A pass that runs: «Отправить сейчас» has something to stop. */
const RUNNING = ['preparing', 'running'] as const

/** The most words a chat keeps queued. */
export const QUEUE_LIMIT = 10

export const taskNotBusy = () =>
  new DomainError('TASK_NOT_BUSY', 'The agent waits: the words go as a message', 409)
export const taskQueueFull = () =>
  new DomainError('TASK_QUEUE_FULL', 'The queue of the chat is full', 409)
export const taskQueueGone = () =>
  new DomainError('TASK_QUEUE_GONE', 'The queued words were already sent', 409)

export interface QueuedWords {
  id: string
  requestId: string
  text: string
  attachments: string[]
  createdAt: Date
}

const working = (status: string) => (WORKING as readonly string[]).includes(status)

/** What a dialog of the queue refuses besides its status: what `task.message` refuses. */
async function assertQueueOpen(
  tx: Tx,
  task: { id: string; status: string; requirements: { repository: boolean; browser: boolean } },
) {
  if (task.status === 'deploying' || task.status === 'verifying') throw releaseInProgress()
  if (!working(task.status)) throw taskNotBusy()
  // «Остановить» is on its way: the chat ends, nothing waits for it.
  if (await cancelPending(tx, task.id)) throw taskFinished()
  if (task.requirements.repository) {
    const pending = await turnRewinding(tx, task.id)
    if (pending !== null) throw pending.redo ? taskRedoing() : taskRewinding()
  }
}

/**
 * Words written while the agent works (ВВ1). A repeat with the same `requestId` finds the same
 * row — or, when core took the words already, nothing new is written. The files go with the words
 * and are bound to the task now, as `task.message` binds them.
 */
export async function queueDialogWords(
  db: PrismaClient,
  input: {
    userId: string
    taskId: string
    requestId: string
    text: string
    attachments?: readonly string[]
    /** «Сначала план» (ВВ12): the pass of these words only plans. */
    plan?: boolean
  },
): Promise<{ id: string | null; repeated: boolean }> {
  const requestId = input.requestId.toLowerCase()
  const text = requestText(input.text)
  const attachments = requestAttachments(input.attachments ?? [])
  // The words are checked as the row core will write of them.
  requestPayload({ v: 1, kind: 'queued', authorId: input.userId, requestId, text, ...attachments })
  return underDialogLock(db, input, async (tx, task) => {
    const kept = await tx.taskQueuedMessage.findUnique({
      where: { taskId_requestId: { taskId: task.id, requestId } },
      select: { id: true },
    })
    if (kept) return { id: kept.id, repeated: true }
    if ((await requestOf(tx, task.id, requestId)) !== null) return { id: null, repeated: true }
    await assertQueueOpen(tx, task)
    if ((await tx.taskQueuedMessage.count({ where: { taskId: task.id } })) >= QUEUE_LIMIT)
      throw taskQueueFull()
    await bindMessageAttachments(tx, {
      ids: attachments.attachments ?? [],
      taskId: task.id,
      userId: input.userId,
      workspaceId: task.workspaceId,
      siteId: task.siteId,
    })
    const row = await tx.taskQueuedMessage.create({
      data: {
        taskId: task.id,
        authorId: input.userId,
        requestId,
        text,
        attachments: attachments.attachments ?? [],
        plan: input.plan === true,
      },
      select: { id: true },
    })
    return { id: row.id, repeated: false }
  })
}

/** The words of the queue, oldest first. A chat that ended has none to show. */
export async function listQueuedWords(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<QueuedWords[]> {
  return underDialogLock(db, input, async (tx, task) => {
    if (
      !working(task.status) &&
      task.status !== 'awaiting_user' &&
      task.status !== 'awaiting_approval'
    )
      return []
    return tx.taskQueuedMessage.findMany({
      where: { taskId: task.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, requestId: true, text: true, attachments: true, createdAt: true },
    })
  })
}

/** «Изменить» of queued words (ВВ1): until core took them. */
export async function editQueuedWords(
  db: PrismaClient,
  input: { userId: string; taskId: string; id: string; text: string },
): Promise<{ text: string }> {
  const text = requestText(input.text)
  return underDialogLock(db, input, async (tx, task) => {
    const changed = await tx.taskQueuedMessage.updateMany({
      where: { id: input.id, taskId: task.id },
      data: { text },
    })
    if (changed.count !== 1) throw taskQueueGone()
    return { text }
  })
}

/** «Убрать» of queued words: until core took them; a repeat finds nothing and is not refused. */
export async function removeQueuedWords(
  db: PrismaClient,
  input: { userId: string; taskId: string; id: string },
): Promise<{ removed: true }> {
  return underDialogLock(db, input, async (tx, task) => {
    await tx.taskQueuedMessage.deleteMany({ where: { id: input.id, taskId: task.id } })
    return { removed: true as const }
  })
}

/**
 * «Отправить сейчас» (ВВ4): the pass that runs stops, the dialog stays open, and the queue goes
 * next. The press is a `feed.request` of the kind `interrupt`, the stop the job `turn.cancel` it
 * names — core tells it from «Остановить» by the kind. A pass that is only planned has nothing to
 * stop: the words follow it. A repeat finds the press written.
 */
export async function sendQueuedNow(
  db: PrismaClient,
  input: { userId: string; taskId: string; requestId: string },
): Promise<{ requestEventId: string | null }> {
  const requestId = input.requestId.toLowerCase()
  return underDialogLock(db, input, async (tx, task) => {
    const repeated = await requestOf(tx, task.id, requestId)
    if (repeated !== null) return { requestEventId: String(repeated) }
    await assertQueueOpen(tx, task)
    if ((await tx.taskQueuedMessage.count({ where: { taskId: task.id } })) === 0)
      throw taskQueueGone()
    if (!(RUNNING as readonly string[]).includes(task.status)) return { requestEventId: null }
    const requestEventId = await writeRequest(tx, task.id, {
      v: 1,
      kind: 'interrupt',
      authorId: input.userId,
      requestId,
    })
    await enqueueTurnCancel(tx, { taskId: task.id, requestEventId })
    return { requestEventId }
  })
}
