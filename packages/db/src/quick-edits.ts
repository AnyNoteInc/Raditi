import type { QuickEditReason, QuickEditState } from '@repo/domain/artifacts'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { blockCheckedText } from './pages.ts'

// Quick edits of artifact notes (docs/plan/98-quick-edits.md): the service task «Быстрые правки»
// of a person and the rows of their clicks. Each click is an attempt of that task; its writes
// carry the actor agent{task, attempt}, which is what «Отменить» undoes.

type Tx = Prisma.TransactionClient

export const QUICK_TASK_TITLE = 'Быстрые правки'

export interface QuickTaskAttempt {
  taskId: string
  attempt: number
  /** The first attempt of a new task: its reserve is a new chain, not the next of one. */
  created: boolean
}

/**
 * The person's quick task of the workspace, moved to `queued` for one more attempt; null when it
 * is busy with the previous edit. Created on the first click: the partial unique index makes two
 * first clicks at once find one task.
 */
export async function queueQuickAttempt(
  tx: Tx,
  input: { workspaceId: string; userId: string; taskId: string },
): Promise<QuickTaskAttempt | null> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO tasks (id, workspace_id, created_by_id, kind, status, model_class, billable,
                       title, title_source, updated_at)
    VALUES (${input.taskId}::uuid, ${input.workspaceId}::uuid, ${input.userId}::uuid, 'quick_edits',
            'queued', 'light', true, ${QUICK_TASK_TITLE}, 'client', now())
    ON CONFLICT (workspace_id, created_by_id) WHERE kind = 'quick_edits' AND deleted_at IS NULL
    DO NOTHING
    RETURNING id`
  if (inserted[0]) return { taskId: inserted[0].id, attempt: 1, created: true }
  const [task] = await tx.$queryRaw<{ id: string; status: string; attempt: number }[]>`
    SELECT id, status::text AS status, attempt FROM tasks
    WHERE workspace_id = ${input.workspaceId}::uuid AND created_by_id = ${input.userId}::uuid
      AND kind = 'quick_edits' AND deleted_at IS NULL
    FOR UPDATE`
  if (!task || task.status !== 'awaiting_user') return null
  const attempt = task.attempt + 1
  await tx.$executeRaw`
    UPDATE tasks SET status = 'queued', waiting = NULL, attempt = ${attempt}, updated_at = now()
    WHERE id = ${task.id}::uuid AND status = 'awaiting_user'`
  return { taskId: task.id, attempt, created: false }
}

export async function insertQuickEdit(
  tx: Tx,
  input: {
    id: string
    artifactId: string
    taskId: string
    attempt: number
    userId: string
    requestId: string
  },
): Promise<void> {
  await tx.artifactQuickEdit.create({ data: input })
}

export interface ClaimedQuickEdit {
  id: string
  artifactId: string
  taskId: string
  attempt: number
  userId: string
  requestId: string
  workspaceId: string
}

/**
 * The start of an edit: its row `queued → running`, its task `queued → preparing` with the turn of
 * this attempt. null — taken by another worker, or its task is no longer waiting for it.
 */
export async function claimQuickEdit(
  db: Pick<PrismaClient, '$transaction'>,
  quickEditId: string,
): Promise<ClaimedQuickEdit | null> {
  return db.$transaction(async (tx) => {
    const [edit] = await tx.$queryRaw<
      {
        id: string
        artifact_id: string
        task_id: string
        attempt: number
        user_id: string
        request_id: string
      }[]
    >`
      UPDATE artifact_quick_edits SET state = 'running', started_at = now()
      WHERE id = ${quickEditId}::uuid AND state = 'queued'
      RETURNING id, artifact_id, task_id, attempt, user_id, request_id`
    if (!edit) return null
    const [task] = await tx.$queryRaw<{ workspace_id: string }[]>`
      UPDATE tasks SET status = 'preparing', waiting = NULL, turn_no = ${edit.attempt},
        updated_at = now()
      WHERE id = ${edit.task_id}::uuid AND status = 'queued' AND attempt = ${edit.attempt}
        AND kind = 'quick_edits'
      RETURNING workspace_id`
    if (!task) {
      await finishQuickEditIn(tx, { id: edit.id, state: 'failed', reason: 'platform' })
      return null
    }
    return {
      id: edit.id,
      artifactId: edit.artifact_id,
      taskId: edit.task_id,
      attempt: edit.attempt,
      userId: edit.user_id,
      requestId: edit.request_id,
      workspaceId: task.workspace_id,
    }
  })
}

async function finishQuickEditIn(
  tx: Pick<Tx, '$executeRaw'>,
  input: { id: string; state: QuickEditState; reason?: QuickEditReason | null; calls?: number },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE artifact_quick_edits
    SET state = ${input.state}::"ArtifactQuickEditState", reason = ${input.reason ?? null},
        calls = GREATEST(calls, ${input.calls ?? 0}), finished_at = now()
    WHERE id = ${input.id}::uuid AND finished_at IS NULL`
}

/** The end of an edit, in the caller's transaction (with the settlement of its attempt). */
export const finishQuickEdit = finishQuickEditIn

export interface QuickEditBlock {
  key: string
  heading: string | null
  /** The checked Markdown of the block. */
  markdown: string
  rev: number
  /** Who holds the block now: `human` — a person other than the clicker; null — no one. */
  hold: 'human' | 'claim' | 'checking' | null
}

/**
 * The blocks of the notes of an edit, without the rest of the artifact. The clicker's own lease of
 * a block is let go first: they pressed «Исправить», so their typing there is over (БПр10).
 */
export async function quickEditBlocks(
  tx: Tx,
  input: { artifactId: string; userId: string; keys: readonly string[]; now: Date },
): Promise<QuickEditBlock[]> {
  await tx.$executeRaw`
    UPDATE chat_document_sections
    SET lease_holder = NULL, lease_user_id = NULL, lease_task_id = NULL, lease_turn = NULL,
        lease_token = NULL, lease_until = NULL, lease_intent = NULL
    WHERE document_id = ${input.artifactId}::uuid AND section_key = ANY(${[...input.keys]}::text[])
      AND lease_holder = 'human' AND lease_user_id = ${input.userId}::uuid`
  const blocks = await tx.artifactBlock.findMany({
    where: { documentId: input.artifactId, sectionKey: { in: [...input.keys] }, deletedRev: null },
  })
  const live = (until: Date | null) => until !== null && until.getTime() > input.now.getTime()
  return blocks.map((block) => ({
    key: block.sectionKey,
    heading: block.heading,
    markdown: blockCheckedText(block) ?? '',
    rev: block.rev,
    hold:
      block.pendingTaskId !== null
        ? 'checking'
        : block.leaseHolder === 'human' && live(block.leaseUntil)
          ? 'human'
          : block.leaseHolder === 'agent' && live(block.leaseUntil)
            ? 'claim'
            : null,
  }))
}

export interface QuickEditRow {
  id: string
  taskId: string
  attempt: number
  state: QuickEditState
  reason: string | null
  createdAt: Date
  finishedAt: Date | null
}

/** The person's own edits of an artifact lately: what the page shows of them. */
export async function quickEditsOfArtifact(
  db: Pick<PrismaClient, 'artifactQuickEdit'>,
  input: { artifactId: string; userId: string; since: Date },
): Promise<QuickEditRow[]> {
  return db.artifactQuickEdit.findMany({
    where: { artifactId: input.artifactId, userId: input.userId, createdAt: { gte: input.since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      taskId: true,
      attempt: true,
      state: true,
      reason: true,
      createdAt: true,
      finishedAt: true,
    },
  })
}

/** Edits left unfinished longer than `olderThanMs`: their core died or their job was lost. */
export async function staleQuickEdits(
  db: Pick<PrismaClient, '$queryRaw'>,
  olderThanMs: number,
): Promise<{ id: string; taskId: string; attempt: number; state: QuickEditState }[]> {
  return db.$queryRaw`
    SELECT id, task_id AS "taskId", attempt, state::text AS state FROM artifact_quick_edits
    WHERE finished_at IS NULL
      AND created_at < now() - make_interval(secs => ${olderThanMs / 1000})
    ORDER BY created_at LIMIT 100`
}
