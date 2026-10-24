import { openBrowserSessionOfTask, taskAttachment, type Prisma, type PrismaClient } from '@repo/db'
import { browserTaskError, isDomainError, terminalTaskStatuses } from '@repo/domain'
import { z } from 'zod'

import type { McpAccess } from '../access/mcp-access.ts'

/**
 * What the `web` tools of a browser task read in PostgreSQL (docs/plan/57-browser-tasks.md,
 * Б18, Б20, Б26): the admission of each call — its turn is live and the task's browser session is
 * open — and the files sent with the task's messages. The browser itself is the worker's: nothing
 * here starts, controls or closes it, and nothing here reads a secret.
 */

/** The live turn of a `web` call and the open browser session of its task, read for this call. */
export interface McpWebAdmission {
  assignmentId: string
  /** `browser_sessions.id`: where the worker runs the action. */
  sessionId: string
  now: Date
  /** The first of the key's, the assignment's and the lease's deadlines. */
  deadlineAt: Date
}

/** The store of the `web` tools; `PostgresMcpWebStore` is the one implementation. */
export interface McpWebStore {
  /** Refuses with `BROWSER_SESSION_UNAVAILABLE` when the turn or the session is gone. */
  admit(scope: McpAccess): Promise<McpWebAdmission>
  /** Whether every id is a file sent with a message of the task (`attachments.status = 'bound'`). */
  attachmentsOfTask(taskId: string, ids: readonly string[]): Promise<boolean>
}

const admissionRowSchema = z.object({
  assignmentId: z.uuid(),
  now: z.date(),
  deadlineAt: z.date(),
})

const unavailable = () => browserTaskError('BROWSER_SESSION_UNAVAILABLE')

type Db = Pick<PrismaClient, '$transaction' | 'attachment'>

export class PostgresMcpWebStore implements McpWebStore {
  constructor(private readonly db: Db) {}

  /**
   * The admission of the agent (spec §8) once more, for this call: its key, its assignment and
   * the turn lease are live, the task needs a browser and its site takes it (`PostgresMcpAccess`:
   * active, or still being connected for a task without a repository), and the task has an open
   * browser session of its own site. What the page shows is content of the task: its contact map
   * is kept from now on (`content_accessed_at`).
   */
  async admit(scope: McpAccess): Promise<McpWebAdmission> {
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT a.id AS "assignmentId", clock_timestamp() AS now,
          LEAST(k.expires_at, k.valid_until, a.deadline_at, l.expires_at) AS "deadlineAt"
        FROM llm_keys k JOIN tasks t ON t.id = k.task_id
        JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
        JOIN turn_assignments a ON a.task_id = t.id AND a.site_id = s.id
          AND a.session_id = k.session_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
        JOIN site_leases l ON l.site_id = s.id AND l.holder_task_id = t.id AND l.epoch = a.lease_epoch
        WHERE k.id = ${scope.keyId}::uuid AND t.id = ${scope.taskId}::uuid
          AND s.id = ${scope.siteId}::uuid AND t.workspace_id = ${scope.workspaceId}::uuid
          AND a.session_id = ${scope.sessionId} AND a.turn_no = ${scope.turn}
          AND a.first_epoch = ${scope.firstEpoch} AND a.lease_epoch = ${scope.epoch}
          AND k.mcp_token_hash IS NOT NULL AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
          AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
          AND k.valid_until > clock_timestamp()
          AND a.deadline_at > clock_timestamp() AND a.finished_at IS NULL AND a.outcome IS NULL
          AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
          AND t.needs_browser
          AND (s.status = 'active' OR (t.needs_browser AND NOT t.needs_repository
            AND s.status = 'onboarding'))
          AND t.content_retired_at IS NULL
          AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])`
      if (rows.length !== 1) throw unavailable()
      const row = admissionRowSchema.safeParse(rows[0])
      if (!row.success) throw unavailable()
      // core opens it before the turn (Б18); one of another site or workspace is not this one's.
      const session = await openBrowserSessionOfTask(tx, scope.taskId)
      if (!session || session.siteId !== scope.siteId || session.workspaceId !== scope.workspaceId)
        throw unavailable()
      await tx.task.updateMany({
        where: { id: scope.taskId, contentAccessedAt: null },
        data: { contentAccessedAt: row.data.now },
      })
      return { ...row.data, sessionId: session.id }
    })
  }

  async attachmentsOfTask(taskId: string, ids: readonly string[]): Promise<boolean> {
    try {
      for (const id of ids) if (!(await taskAttachment(this.db, { id, taskId }))) return false
      return true
    } catch {
      throw unavailable()
    }
  }

  async #transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(work)
    } catch (error) {
      if (isDomainError(error)) throw error
      // An outage of the database leaves the browser out of reach for this call.
      throw unavailable()
    }
  }
}
