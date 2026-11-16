import type { MemberRole, Prisma } from '@repo/db'
import { DomainError, type TaskRequirements, type TaskStatus } from '@repo/domain'

/**
 * A chat the user may open: a task of a workspace they are a member of, not deleted itself
 * («Удалить диалог») and not of a project in the trash, where its chats go with it
 * (docs/plan/84-projects.md, ПР20). A task of someone else and a task that does not exist answer
 * the same NOT_FOUND.
 */
export const accessibleTask = (userId: string, id: string) =>
  ({
    id,
    deletedAt: null,
    workspace: { members: { some: { userId } } },
    OR: [{ projectId: null }, { project: { deletedAt: null } }],
  }) satisfies Prisma.TaskWhereInput

export const taskNotFound = () =>
  new DomainError('NOT_FOUND', 'No such chat among the chats of the user', 404)

/** Who may change the variables of a workspace (docs/plan/83-remove-projects.md, БП4). */
export const isManagerRole = (role: MemberRole | null): boolean =>
  role === 'owner' || role === 'admin'

/** The role of the user in a workspace; null — not a member. */
export async function memberRole(
  db: Pick<Prisma.TransactionClient, 'member'>,
  workspaceId: string,
  userId: string,
): Promise<MemberRole | null> {
  const member = await db.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  })
  return member?.role ?? null
}

/** The row of a dialog a procedure acts on, read under its lock. */
export interface LockedTask {
  id: string
  workspaceId: string
  status: TaskStatus
  attempt: number
  turnNo: number
  /** What the task works with (docs/plan/57, Б2): fixed when it was created. */
  requirements: TaskRequirements
}

/**
 * Locks the row of a dialog for the rest of the caller's transaction: the procedures that move
 * a dialog or answer a request by its id run one at a time per dialog, so a repeated request
 * finds the row its first delivery wrote. Nothing else of the web locks a task; core locks a
 * lease before a task (task-turn-assignments.ts), and the billing writers that follow lock no
 * task. null — no such task, or one deleted («Удалить диалог»; re-read after the wait for the lock,
 * so a dialog deleted meanwhile is not acted on).
 */
export async function lockTask(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  taskId: string,
): Promise<LockedTask | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string
      workspace_id: string
      status: TaskStatus
      attempt: number
      turn_no: number
      needs_browser: boolean
    }>
  >`
    SELECT id, workspace_id, status::text AS status, attempt, turn_no,
           needs_browser
    FROM tasks WHERE id = ${taskId}::uuid AND deleted_at IS NULL FOR UPDATE`
  const row = rows[0]
  if (row === undefined) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    attempt: row.attempt,
    turnNo: row.turn_no,
    requirements: { repository: false, browser: row.needs_browser },
  }
}
