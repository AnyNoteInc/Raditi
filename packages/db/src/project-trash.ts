import { randomUUID } from 'node:crypto'

import { terminalTaskStatuses } from '@repo/domain'

import { purgeProjectArtifacts } from './artifacts.ts'
import { insertFeedEvent } from './feed-events.ts'
import type { Prisma, PrismaClient, TaskStatus } from './generated/prisma/client.ts'
import { enqueueRepoGone, repoHookSelect } from './outbox.ts'
import { enqueueTurnCancel } from './task-commands-outbox.ts'
import { deleteProjectSchedules, lockProjectSchedules } from './scheduled-tasks.ts'
import { forgetTelegramChat } from './telegram-outbox.ts'

// The trash of projects (docs/plan/84-projects.md, ПР20; slice 84.5). «Удалить» stops what the
// chats of the project have at work, as «Удалить диалог» stops a chat: a `feed.request` of the
// command `cancel` by the author of the project and the job `turn.cancel`, which core carries out
// — the pass is stopped, or the chat that only waits in the queue is closed with its reserve given
// back. After `purge_after` the project leaves the database: its chats stay, deleted.

type Tx = Prisma.TransactionClient

/** A chat of a project the trash locked: not ended, not deleted. */
export interface ProjectChat {
  id: string
  status: TaskStatus
}

/**
 * The chats of the project that have not ended, locked in the order of their ids. The trash locks
 * them before the row of the project, as a pass locks its chat before it touches the project
 * (`touchProjectActivity`): the same order for both, so the two never wait for each other.
 */
export function lockProjectChats(tx: Tx, projectId: string): Promise<ProjectChat[]> {
  return tx.$queryRaw<ProjectChat[]>`
    SELECT id, status::text AS status FROM tasks
    WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
      AND status::text <> ALL(${[...terminalTaskStatuses]}::text[])
    ORDER BY id
    FOR UPDATE`
}

/**
 * Whether the newest request of the chat is already a press of `cancel`: core stops it, and a
 * second press would only be a second row in the feed.
 */
async function cancelPressedLast(tx: Tx, taskId: string): Promise<boolean> {
  const [newest] = await tx.$queryRaw<Array<{ kind: string | null; command: string | null }>>`
    SELECT payload->>'kind' AS kind, payload->>'command' AS command FROM task_events
    WHERE task_id = ${taskId}::uuid AND type = 'feed.request'
    ORDER BY id DESC LIMIT 1`
  return newest?.kind === 'command' && newest.command === 'cancel'
}

/**
 * Stops the locked chats whose status is one of `statuses` (`/cancel` of web's `stopDialog`, done
 * through core): the words that waited in their queue are dropped (docs/plan/75, ВВ5), the press is
 * written by `authorId` — the author of the project — and `turn.cancel` is put. A chat pressed
 * already is left alone. Returns the ids of the chats it pressed.
 */
export async function stopProjectChats(
  tx: Tx,
  input: { chats: readonly ProjectChat[]; statuses: readonly TaskStatus[]; authorId: string },
): Promise<string[]> {
  const pressed: string[] = []
  for (const chat of input.chats) {
    if (!input.statuses.includes(chat.status)) continue
    if (await cancelPressedLast(tx, chat.id)) continue
    await tx.taskQueuedMessage.deleteMany({ where: { taskId: chat.id } })
    const requestEventId = await insertFeedEvent(tx, {
      taskId: chat.id,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command: 'cancel',
          authorId: input.authorId,
          // The press is the platform's own: a repeat is known by the press found last, not by it.
          requestId: randomUUID(),
        },
      },
    })
    await enqueueTurnCancel(tx, { taskId: chat.id, requestEventId: String(requestEventId) })
    pressed.push(chat.id)
  }
  return pressed
}

/** Projects whose 30 days in the trash are over, the longest there first. */
export function projectsDueForPurge(
  db: Pick<PrismaClient, 'project'>,
  now: Date,
  limit: number,
): Promise<Array<{ id: string }>> {
  return db.project.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    orderBy: { purgeAfter: 'asc' },
    take: limit,
    select: { id: true },
  })
}

export type ProjectPurge =
  /** The project is gone, its chats deleted. */
  | { state: 'purged'; chats: number }
  /** Chats of it have not ended yet: each was pressed to stop, the next sweep purges. */
  | { state: 'stopping'; chats: number }
  /** Not in the trash past its day any more: «Вернуть» came first, or another core purged it. */
  | { state: 'kept' }

/**
 * Purges one project of the trash (ПР20): its chats become deleted (`deleted_at`, the topic in
 * Telegram deleted, as «Удалить диалог» does), and the row of the project is deleted — the chats
 * keep everything that points at them (billing, calls) with `project_id` NULL. A chat that has not
 * ended is stopped first (any status: a waiting chat is closed with its reserve given back), and
 * the project waits for the next sweep. Idempotent: a project restored or purged meanwhile is
 * `kept`.
 *
 * The files of the context go before (core's ProjectTrash drops their objects and rows: this
 * transaction cannot reach S3); a row left would go by cascade. Memory, git caches and the hook of
 * the project (ПР20) have no tables yet: they go here when their slices bring them (84.13, 84.16).
 */
export async function purgeProject(
  db: PrismaClient,
  input: { projectId: string; now: Date },
): Promise<ProjectPurge> {
  return db.$transaction(async (tx) => {
    const chats = await lockProjectChats(tx, input.projectId)
    // The tasks before the project, as «Удалить» takes them (ПР19).
    await lockProjectSchedules(tx, input.projectId)
    const [project] = await tx.$queryRaw<Array<{ id: string; created_by_id: string }>>`
      SELECT id, created_by_id FROM projects
      WHERE id = ${input.projectId}::uuid AND deleted_at IS NOT NULL
        AND purge_after <= ${input.now}
      FOR UPDATE`
    if (!project) return { state: 'kept' as const }
    if (chats.length > 0) {
      await stopProjectChats(tx, {
        chats,
        statuses: chats.map((chat) => chat.status),
        authorId: project.created_by_id,
      })
      return { state: 'stopping' as const, chats: chats.length }
    }
    const deleted = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE tasks SET deleted_at = ${input.now}
      WHERE project_id = ${project.id}::uuid AND deleted_at IS NULL
      RETURNING id`
    for (const chat of deleted) await forgetTelegramChat(tx, chat.id)
    // Its scheduled tasks go with it (ПР19), deleted; their runs stay without the project.
    await deleteProjectSchedules(tx, project.id, input.now)
    // Its repository goes by cascade; core removes its mirror and bundles from the volume after
    // this commits (`git.repo.forget`), or they would stay there and count against its quota.
    // A hook core made on it goes too (`git.hook.remove`, slice 84.26).
    const repos = await tx.projectRepository.findMany({
      where: { projectId: project.id },
      select: repoHookSelect,
    })
    for (const repo of repos) await enqueueRepoGone(tx, repo)
    // Its artifacts go for good (Ар42): `project_id` is ON DELETE SET NULL, they would stay
    // personal. A day already past — the collector deletes them with their files.
    await purgeProjectArtifacts(tx, { projectId: project.id, now: input.now })
    // `tasks.project_id` is ON DELETE SET NULL: every chat of the project, deleted before or now,
    // stays without it.
    await tx.$executeRaw`DELETE FROM projects WHERE id = ${project.id}::uuid`
    return { state: 'purged' as const, chats: deleted.length }
  })
}
