import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  feedLimits,
  hasVisibleText,
  llmBackendIds,
  looksLikeSecret,
  modelClassOfEffort,
  terminalReleaseStatuses,
  terminalTaskStatuses,
  type ReasoningEffort,
} from '@repo/domain'
import { modelClassPriced } from '@repo/billing'

import { accessibleTask, lockTask, taskNotFound } from './access.ts'
import { dialogCommands, dialogFacts } from './dialog-facts.ts'
import { WRITE } from './dialog-lock.ts'
import {
  releaseInProgress,
  taskBusy,
  taskFinished,
  taskNotAccepted,
  taskTextEmpty,
  taskTextHasSecret,
  taskTextTooLong,
} from './refusals.ts'
import { stopDialog } from './tasks.ts'

// What the client does to a dialog as a whole (owner's request of 26.10.2026): renames it,
// deletes it, changes how hard the model thinks. None of it is a row of the feed, and none of it
// moves the dialog in the list: the writes are SQL, which leaves `updated_at` (set by Prisma
// alone) as the dialog's own work left it.

/** A release goes on in these: the dialog is not given another class then. */
const RELEASING = ['deploying', 'verifying'] as const
/**
 * The dialog waits for the client: no pass is planned or runs, so the next one reads the new class.
 * While a pass is queued or runs, core has planned its turn with the class it read and checks the
 * key it issues against the class of the task (turn-credentials.ts): a change then would fail it.
 */
const WAITING = ['awaiting_user', 'awaiting_approval'] as const

/**
 * The new name of a dialog: one line, spaces collapsed, at most the length of `tasks.title`;
 * refused in the client's words like the words of a message — empty, too long, a password.
 */
export function dialogName(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  if (!hasVisibleText(line)) throw taskTextEmpty()
  if (line.length > feedLimits.title) throw taskTextTooLong()
  if (looksLikeSecret(line)) throw taskTextHasSecret()
  return line
}

/** «Переименовать»: the title the list and the head show. A repeat writes the same title. */
export async function renameDialog(
  db: PrismaClient,
  input: { userId: string; taskId: string; title: string },
): Promise<{ title: string }> {
  const title = dialogName(input.title)
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (task === null) throw taskNotFound()
  await db.$executeRaw`
    UPDATE tasks SET title = ${title}
    WHERE id = ${task.id}::uuid AND deleted_at IS NULL`
  return { title }
}

/**
 * «Размышление» of a dialog that waits for the client: its class from the agent's next turn on.
 * The credits already set aside stay as they are, and so does the step of the attempt they were set
 * aside for — the step of the next turns is the new class's (`attemptCreditBudget`), the next
 * reserve («Продолжить», a new attempt) too. Refused while the agent works (TASK_BUSY: core has
 * planned its turn with the class it read), while a release goes on, in a dialog that has ended,
 * and when no priced model of the class is enabled — the next pass would fail `unavailable` (as
 * `task.create` refuses it).
 */
export async function setDialogEffort(
  db: PrismaClient,
  input: { userId: string; taskId: string; effort: ReasoningEffort; now: Date },
): Promise<{ effort: ReasoningEffort }> {
  const modelClass = modelClassOfEffort(input.effort)
  const visible = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (visible === null) throw taskNotFound()
  return db.$transaction(async (tx) => {
    const task = await lockTask(tx, visible.id)
    if (task === null) throw taskNotFound()
    if (terminalTaskStatuses.includes(task.status)) throw taskFinished()
    if ((RELEASING as readonly string[]).includes(task.status)) throw releaseInProgress()
    if (!(WAITING as readonly string[]).includes(task.status)) throw taskBusy()
    if (!(await modelClassPriced(tx, { modelClass, backends: llmBackendIds, now: input.now })))
      throw taskNotAccepted('class_unavailable')
    await tx.$executeRaw`
      UPDATE tasks SET model_class = ${modelClass}::"ModelClass"
      WHERE id = ${task.id}::uuid`
    return { effort: input.effort }
  }, WRITE)
}

/**
 * «Удалить диалог»: the dialog leaves the cabinet. One that has not ended is cancelled first, as
 * `/cancel` does it — the reserve is given back and the preview removed at once when it waits,
 * core stops it when it works — so nothing of it keeps running or holding credits. Refused while
 * a release of it — or «Отменить выпуск», which runs in a dialog that has ended — is not finished,
 * an outcome the operator still settles included: its feed is where the client reads it. The row
 * stays with all that points at it (billing, releases, calls); what was released stays on the site.
 * A repeat after a lost answer — or a second delete at the same time — finds it deleted and answers
 * the same.
 */
export async function removeDialog(
  db: PrismaClient,
  input: { userId: string; taskId: string; now: Date },
): Promise<{ removed: true }> {
  // Deleted or not: a repeat must find it.
  const task = await db.task.findFirst({
    where: {
      id: input.taskId,
      site: { deletedAt: null },
      workspace: { members: { some: { userId: input.userId } } },
    },
    select: { id: true, deletedAt: true },
  })
  if (task === null) throw taskNotFound()
  if (task.deletedAt !== null) return { removed: true }
  return db.$transaction(async (tx) => {
    // `lockTask` finds no row deleted meanwhile: a delete at the same time came first.
    const locked = await lockTask(tx, task.id)
    if (locked === null) return { removed: true as const }
    const releasing = await tx.siteRelease.count({
      where: { taskId: locked.id, status: { notIn: [...terminalReleaseStatuses] } },
    })
    if (releasing > 0) throw releaseInProgress()
    if (!terminalTaskStatuses.includes(locked.status)) {
      const facts = await dialogFacts(tx, locked, input.userId)
      const cancel = dialogCommands(facts).find((command) => command.id === 'cancel')
      if (cancel?.refusal === 'release_in_progress') throw releaseInProgress()
      await stopDialog(tx, locked, facts, {
        userId: input.userId,
        // The press is the server's own: a repeat is known by the mark below, not by this id.
        requestId: randomUUID(),
        now: input.now,
      })
    }
    await tx.$executeRaw`
      UPDATE tasks SET deleted_at = ${input.now}
      WHERE id = ${locked.id}::uuid AND deleted_at IS NULL`
    return { removed: true as const }
  }, WRITE)
}
