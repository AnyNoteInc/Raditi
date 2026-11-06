import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { insertFeedEvent, type Prisma, type PrismaClient } from '@repo/db'
import { conflict, type AppEnv, type FeedRequestPayload, type TaskStatus } from '@repo/domain'

import { accessibleTask, lockTask, taskNotFound, type LockedTask } from './access.ts'

type Tx = Prisma.TransactionClient

/**
 * The transactions of a dialog: READ COMMITTED, as every writer of @repo/billing requires, with
 * room for the locks of a reserve.
 */
export const WRITE: {
  isolationLevel: Prisma.TransactionIsolationLevel
  maxWait: number
  timeout: number
} = { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 20_000 }

/**
 * The personal workspace of a chat without a project (docs/plan/61-chats-first.md, К15), with the gift of the
 * registration, in a short transaction of its own: a new user has none until this first chat or
 * its first file. The gift stays even if the chat is refused later: it is the user's, once.
 */
export const personalWorkspaceOf = (
  db: PrismaClient,
  owner: { userId: string; appEnv: AppEnv },
): Promise<{ id: string }> =>
  db.$transaction((tx) => ensurePersonalWorkspaceWithGift(tx, owner), WRITE)

/**
 * Runs `act` under the lock of a dialog the user may open, in one transaction; NOT_FOUND for
 * any other dialog.
 */
export async function underDialogLock<T>(
  db: PrismaClient,
  ids: { userId: string; taskId: string },
  act: (tx: Tx, task: LockedTask) => Promise<T>,
): Promise<T> {
  const visible = await db.task.findFirst({
    where: accessibleTask(ids.userId, ids.taskId),
    select: { id: true },
  })
  if (visible === null) throw taskNotFound()
  return db.$transaction(async (tx) => {
    const task = await lockTask(tx, visible.id)
    if (task === null) throw taskNotFound()
    return act(tx, task)
  }, WRITE)
}

/** Writes a `feed.request` and returns its id, the cursor of the feed. */
export async function writeRequest(
  tx: Tx,
  taskId: string,
  payload: FeedRequestPayload,
): Promise<string> {
  const id = await insertFeedEvent(tx, { taskId, row: { type: 'feed.request', payload } })
  return String(id)
}

/** The conditional move of a locked dialog; the lock makes it certain, the WHERE keeps it honest. */
export async function moveTo(
  tx: Tx,
  task: LockedTask,
  to: TaskStatus,
  data: Prisma.TaskUpdateManyMutationInput = {},
): Promise<void> {
  const moved = await tx.task.updateMany({
    where: { id: task.id, status: task.status, attempt: task.attempt },
    data: { ...data, status: to, waiting: null },
  })
  if (moved.count !== 1) throw conflict(`The dialog left ${task.status} meanwhile`)
}
