import {
  enqueueBrowserEnsure,
  openBrowserSession,
  openBrowserSessionOfTask,
  taskAttachment,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  browserEnsureWindow,
  browserSessionLimits,
  browserTaskError,
  isDomainError,
  terminalTaskStatuses,
  type BrowserSessionStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { McpTurnAccess } from '../access/mcp-access.ts'

/**
 * What the `web` tools of a browser task keep in PostgreSQL (docs/plan/57-browser-tasks.md,
 * Б18, Б20, Б26; docs/plan/61-chats-first.md, К11): the admission of each call — its turn is live
 * and the task's browser session is open, asked for here when it has none — and the files sent with
 * the task's messages. The browser itself is the worker's and core starts it: nothing here touches
 * it, and nothing here reads a secret.
 */

/** The live turn of a `web` call and the open browser session of its task, read for this call. */
export interface McpWebAdmission {
  assignmentId: string
  /** `browser_sessions`: where the worker runs the action, and whether it is up yet. */
  session: { id: string; status: BrowserSessionStatus }
  now: Date
  /** The first of the key's, the assignment's and the lease's deadlines. */
  deadlineAt: Date
}

/** The store of the `web` tools; `PostgresMcpWebStore` is the one implementation. */
export interface McpWebStore {
  /**
   * Refuses with `BROWSER_SESSION_UNAVAILABLE` when the turn is gone or the session cannot be, and
   * with `BROWSER_WORKSPACE_BUSY` when the workspace holds all the browsers it may.
   */
  admit(scope: McpTurnAccess): Promise<McpWebAdmission>
  /** The status of a session as the database holds it now; null — no such session. */
  sessionState(sessionId: string): Promise<BrowserSessionStatus | null>
  /** Whether every id is a file sent with a message of the task (`attachments.status = 'bound'`). */
  attachmentsOfTask(taskId: string, ids: readonly string[]): Promise<boolean>
}

const admissionRowSchema = z.object({
  assignmentId: z.uuid(),
  now: z.date(),
  deadlineAt: z.date(),
  /** Sessions of the task opened since its assignment began. */
  started: z.number().int().min(0),
})

const unavailable = () => browserTaskError('BROWSER_SESSION_UNAVAILABLE')

type Db = Pick<PrismaClient, '$transaction' | 'attachment' | 'browserSession'>

export class PostgresMcpWebStore implements McpWebStore {
  constructor(
    private readonly db: Db,
    /** BROWSER_SESSION_MAX_HOURS: the hard deadline of a session opened here. */
    private readonly options: { maxHours: number },
  ) {}

  /**
   * The admission of the agent (spec §8) once more, for this call: its key, its assignment and
   * the turn lease are live, the task needs a browser and its site takes it (`PostgresMcpAccess`:
   * none, active, or still being connected for a task without a repository). The task's open
   * browser session is of its own site, or of none; with no open session this call opens one and
   * asks core to start it, in this transaction (К11) — within what one assignment may start (К41).
   * A session still `starting` asks again once a window: its job may have been lost. What the page
   * shows is content of the task: its contact map is kept from now on (`content_accessed_at`).
   */
  async admit(scope: McpTurnAccess): Promise<McpWebAdmission> {
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT a.id AS "assignmentId", clock_timestamp() AS now,
          LEAST(k.expires_at, k.valid_until, a.deadline_at, l.expires_at) AS "deadlineAt",
          (SELECT count(*)::int FROM browser_sessions b
            WHERE b.task_id = t.id AND b.created_at >= a.created_at) AS started
        FROM llm_keys k JOIN tasks t ON t.id = k.task_id
        LEFT JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
        JOIN turn_assignments a ON a.task_id = t.id AND a.site_id = COALESCE(t.site_id, t.id)
          AND a.session_id = k.session_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
        JOIN site_leases l ON l.site_id = COALESCE(t.site_id, t.id) AND l.holder_task_id = t.id
          AND l.epoch = a.lease_epoch
        WHERE k.id = ${scope.keyId}::uuid AND t.id = ${scope.taskId}::uuid
          AND t.site_id IS NOT DISTINCT FROM ${scope.siteId}::uuid
          AND t.workspace_id = ${scope.workspaceId}::uuid
          AND a.session_id = ${scope.sessionId} AND a.turn_no = ${scope.turn}
          AND a.first_epoch = ${scope.firstEpoch} AND a.lease_epoch = ${scope.epoch}
          AND k.mcp_token_hash IS NOT NULL AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
          AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
          AND k.valid_until > clock_timestamp()
          AND a.deadline_at > clock_timestamp() AND a.finished_at IS NULL AND a.outcome IS NULL
          AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
          AND t.needs_browser
          AND (t.site_id IS NULL OR s.status = 'active' OR (t.needs_browser
            AND NOT t.needs_repository AND s.status = 'onboarding'))
          AND t.content_retired_at IS NULL
          AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])`
      if (rows.length !== 1) throw unavailable()
      const row = admissionRowSchema.safeParse(rows[0])
      if (!row.success) throw unavailable()
      const { started, ...admission } = row.data
      const session = await this.#sessionOf(tx, scope, started)
      if (session.status === 'starting')
        await enqueueBrowserEnsure(
          tx,
          { taskId: scope.taskId, sessionId: session.id },
          { window: browserEnsureWindow(admission.now) },
        )
      await tx.task.updateMany({
        where: { id: scope.taskId, contentAccessedAt: null },
        data: { contentAccessedAt: admission.now },
      })
      return { ...admission, session: { id: session.id, status: session.status } }
    })
  }

  async #sessionOf(tx: Prisma.TransactionClient, scope: McpTurnAccess, started: number) {
    const open = await openBrowserSessionOfTask(tx, scope.taskId)
    if (open && (open.siteId !== scope.siteId || open.workspaceId !== scope.workspaceId))
      throw unavailable()
    // One start and one replacement per assignment: a turn never runs up containers without end.
    if (!open && started >= browserSessionLimits.perAssignment) throw unavailable()
    return (
      open ??
      (await openBrowserSession(tx, { taskId: scope.taskId, maxHours: this.options.maxHours }))
    )
  }

  async sessionState(sessionId: string): Promise<BrowserSessionStatus | null> {
    try {
      const row = await this.db.browserSession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      })
      return row?.status ?? null
    } catch {
      throw unavailable()
    }
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
      if (isDomainError(error) && error.code === 'BROWSER_WORKSPACE_BUSY') throw error
      // A refusal to open a session, or an outage of the database: out of reach for this call.
      throw unavailable()
    }
  }
}
