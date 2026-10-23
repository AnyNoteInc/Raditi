import {
  BROWSER_SCREENSHOT_EVENT,
  browserScreenshotEventSchema,
  enqueuePreviewBrowser,
  recordBrowserChecks,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  badRequest,
  browserScreenshotKey,
  DomainError,
  isDomainError,
  leaseLost,
  previewStatuses,
  terminalTaskStatuses,
  type PreviewStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { McpAccess } from '../access/mcp-access.ts'

/**
 * What the agent's browser tools keep in PostgreSQL (docs/plan/53-chat-preview-release.md, Р21,
 * Р22, Р23): the admission of a call — the live turn and its dialog's preview —, the requests
 * core answers (a sync of the working tree onto the preview, a browser for it), the dirty mark of
 * a preview and the outcome of the agent's checks. No network or browser work runs in a SQL
 * transaction; nothing here reads a secret.
 */

/** The live turn of a browser call and the preview of its dialog, read for this call. */
export interface McpBrowserAdmission {
  assignmentId: string
  /** `task_turns.id` of the running turn; null — its row is not written yet. */
  turnId: string | null
  turnNo: number
  now: Date
  /** The first of the key's, the assignment's and the lease's deadlines. */
  deadlineAt: Date
  preview: {
    id: string
    status: PreviewStatus
    hostname: string
    /** `db_mode = 'copy'`. */
    database: boolean
    revision: number
  }
}

/** A request core answers: done with `error_code` null, refused with one, or not yet. */
export interface McpBrowserRequestState {
  id: string
  done: boolean
  errorCode: string | null
}

export interface McpBrowserCheckSummary {
  total: number
  passed: number
  failed: number
}

/** The store of the browser tools; `PostgresMcpBrowserStore` is the one implementation. */
export interface McpBrowserStore {
  admit(scope: McpAccess): Promise<McpBrowserAdmission>
  requestSync(admission: McpBrowserAdmission): Promise<string>
  syncState(id: string): Promise<McpBrowserRequestState>
  /** The open browser request of the turn, or a new one with its job; `fresh` — always new. */
  requestBrowser(admission: McpBrowserAdmission, fresh: boolean): Promise<string>
  browserState(id: string): Promise<McpBrowserRequestState>
  markDirty(admission: McpBrowserAdmission, taskId: string): Promise<void>
  /** A run of the agent's checks on the tree the sync `syncRequestId` brought onto the preview. */
  recordChecks(
    admission: McpBrowserAdmission,
    taskId: string,
    summary: McpBrowserCheckSummary,
    syncRequestId: string,
  ): Promise<void>
  /**
   * A screenshot stored under `browserScreenshotKey(taskId, id)`, taken on the tree of the sync
   * `syncRequestId`: what the sweep removes and the candidate's check shows.
   */
  recordScreenshot(
    admission: McpBrowserAdmission,
    taskId: string,
    id: string,
    syncRequestId: string,
  ): Promise<void>
  /** Which of the assignments still hold their turn: the others' browsers are closed. */
  liveAssignments(ids: readonly string[]): Promise<Set<string>>
}

const admissionRowSchema = z.object({
  assignmentId: z.uuid(),
  turnId: z.uuid().nullable(),
  turnNo: z.number().int().positive(),
  now: z.date(),
  deadlineAt: z.date(),
  previewId: z.uuid(),
  status: z.enum(previewStatuses),
  hostname: z.string().min(1).max(253),
  dbMode: z.enum(['copy', 'none']),
  revision: z.number().int().min(0),
})

const unavailable = () =>
  new DomainError('MCP_JOURNAL_UNAVAILABLE', 'MCP journal is unavailable', 503)
const uuid = z.uuid()

/** Internal event of a task: a run of the agent's checks (`@repo/db`, carried on by R3). */
export { BROWSER_CHECKS_EVENT } from '@repo/db'
/** Internal event of a task: a screenshot of the agent's browser, by its id. */
export { BROWSER_SCREENSHOT_EVENT }
/** The S3 key of a screenshot: the task's own prefix of raditi-artifacts (spec §14, N22). */
export { browserScreenshotKey }

export class PostgresMcpBrowserStore implements McpBrowserStore {
  constructor(private readonly db: Pick<PrismaClient, '$transaction'>) {}

  /**
   * The admission of the agent (spec §8) once more, for this call: its key, its assignment and
   * the turn lease are live, and the dialog has the preview the token's scope named. A page of
   * the preview is content of the task: its contact map is kept from now on (`content_accessed_at`).
   */
  async admit(scope: McpAccess): Promise<McpBrowserAdmission> {
    if (!scope.preview) throw leaseLost('MCP browser scope has no preview')
    const preview = scope.preview
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT a.id AS "assignmentId", tt.id AS "turnId", a.turn_no AS "turnNo",
          clock_timestamp() AS now,
          LEAST(k.expires_at, k.valid_until, a.deadline_at, l.expires_at) AS "deadlineAt",
          p.id AS "previewId", p.status::text AS status, p.hostname, p.db_mode::text AS "dbMode",
          p.revision
        FROM llm_keys k JOIN tasks t ON t.id = k.task_id
        JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
        JOIN turn_assignments a ON a.task_id = t.id AND a.site_id = s.id
          AND a.session_id = k.session_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
        JOIN site_leases l ON l.site_id = s.id AND l.holder_task_id = t.id AND l.epoch = a.lease_epoch
        JOIN preview_environments p ON p.task_id = t.id AND p.site_id = s.id
        LEFT JOIN task_turns tt ON tt.task_id = t.id AND tt.turn_no = a.turn_no AND tt.status = 'running'
        WHERE k.id = ${scope.keyId}::uuid AND t.id = ${scope.taskId}::uuid
          AND s.id = ${scope.siteId}::uuid AND t.workspace_id = ${scope.workspaceId}::uuid
          AND a.session_id = ${scope.sessionId} AND a.turn_no = ${scope.turn}
          AND a.first_epoch = ${scope.firstEpoch} AND a.lease_epoch = ${scope.epoch}
          AND p.id = ${preview.id}::uuid
          AND k.mcp_token_hash IS NOT NULL AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
          AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
          AND k.valid_until > clock_timestamp()
          AND a.deadline_at > clock_timestamp() AND a.finished_at IS NULL AND a.outcome IS NULL
          AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
          AND s.status = 'active' AND t.content_retired_at IS NULL
          AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])`
      if (rows.length !== 1) throw leaseLost('MCP browser scope is no longer active')
      const row = admissionRowSchema.safeParse(rows[0])
      if (!row.success)
        throw new DomainError('MCP_ACCESS_SCOPE_INVALID', 'MCP admission row is invalid', 503)
      await tx.task.updateMany({
        where: { id: scope.taskId, contentAccessedAt: null },
        data: { contentAccessedAt: row.data.now },
      })
      const { previewId, status, hostname, dbMode, revision, ...turn } = row.data
      return {
        ...turn,
        preview: { id: previewId, status, hostname, database: dbMode === 'copy', revision },
      }
    })
  }

  /** Р23: core exports the working tree of the turn's sandbox onto the preview's files. */
  async requestSync(admission: McpBrowserAdmission): Promise<string> {
    return this.#transaction(async (tx) => {
      const row = await tx.previewSyncRequest.create({
        data: { previewId: admission.preview.id, assignmentId: admission.assignmentId },
        select: { id: true },
      })
      return row.id
    })
  }

  async syncState(id: string): Promise<McpBrowserRequestState> {
    if (!uuid.safeParse(id).success) throw badRequest('Invalid preview sync request')
    return this.#transaction(async (tx) => {
      const row = await tx.previewSyncRequest.findUnique({
        where: { id },
        select: { completedAt: true, errorCode: true },
      })
      if (!row) throw leaseLost('Preview sync request is gone')
      return { id, done: row.completedAt !== null, errorCode: row.errorCode }
    })
  }

  /**
   * Р21: core starts the preview's browser for the request (job `preview.browser` in the same
   * transaction) and answers it with a fresh service ticket in Vault before `ready_at`. A turn
   * keeps using its open request; a spent ticket or a stopped browser needs a new one.
   */
  async requestBrowser(admission: McpBrowserAdmission, fresh: boolean): Promise<string> {
    return this.#transaction(async (tx) => {
      if (!fresh) {
        const open = await tx.previewBrowserRequest.findFirst({
          where: {
            previewId: admission.preview.id,
            assignmentId: admission.assignmentId,
            stoppedAt: null,
            errorCode: null,
          },
          orderBy: { requestedAt: 'desc' },
          select: { id: true },
        })
        if (open) return open.id
      }
      const created = await tx.previewBrowserRequest.create({
        data: { previewId: admission.preview.id, assignmentId: admission.assignmentId },
        select: { id: true },
      })
      await enqueuePreviewBrowser(tx, { previewId: admission.preview.id, requestId: created.id })
      return created.id
    })
  }

  async browserState(id: string): Promise<McpBrowserRequestState> {
    if (!uuid.safeParse(id).success) throw badRequest('Invalid preview browser request')
    return this.#transaction(async (tx) => {
      const row = await tx.previewBrowserRequest.findUnique({
        where: { id },
        select: { readyAt: true, stoppedAt: true, errorCode: true },
      })
      if (!row) throw leaseLost('Preview browser request is gone')
      // A browser stopped before it was taken is a refusal of this request: ask again.
      const errorCode = row.errorCode ?? (row.stoppedAt ? 'stopped' : null)
      return { id, done: row.readyAt !== null || errorCode !== null, errorCode }
    })
  }

  /** Р22: an action that may write leaves the preview other than its revision until a reset. */
  async markDirty(admission: McpBrowserAdmission, taskId: string): Promise<void> {
    await this.#transaction(async (tx) => {
      await tx.previewEnvironment.updateMany({
        where: { id: admission.preview.id, taskId, dirty: false },
        data: { dirty: true },
      })
    })
  }

  /**
   * A run of the agent's checks (Р21, Р22): an internal event of the task with the counts, the
   * preview and the sync of the working tree the run looked at. During a turn the preview shows
   * that working state, never a revision: the pass that records the turn's candidate carries the
   * run into it (`carryBrowserChecks`, R3). Counts only: never a path, a selector or a text.
   */
  async recordChecks(
    admission: McpBrowserAdmission,
    taskId: string,
    summary: McpBrowserCheckSummary,
    syncRequestId: string,
  ): Promise<void> {
    await this.#transaction((tx) =>
      recordBrowserChecks(tx, {
        taskId,
        turnId: admission.turnId,
        run: {
          v: 1,
          turn: admission.turnNo,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          previewId: admission.preview.id,
          syncRequestId,
        },
      }),
    )
  }

  async recordScreenshot(
    admission: McpBrowserAdmission,
    taskId: string,
    id: string,
    syncRequestId: string,
  ) {
    // What it looked at, as a check run names it: the candidate of the turn takes it as the
    // artifact of its check `agent_browser` when it is the same look (carryBrowserChecks).
    const payload = browserScreenshotEventSchema.safeParse({
      v: 1,
      id,
      turn: admission.turnNo,
      previewId: admission.preview.id,
      syncRequestId,
    })
    if (!payload.success) throw badRequest('Invalid screenshot id')
    await this.#transaction(async (tx) => {
      await tx.taskEvent.create({
        data: {
          taskId,
          turnId: admission.turnId,
          type: BROWSER_SCREENSHOT_EVENT,
          payload: payload.data,
          clientVisible: false,
        },
      })
    })
  }

  /**
   * The turns whose context may stay open: the assignment, the lease of its turn and a key of
   * the turn that is neither revoked nor expired. A revoked key closes the context of its turn
   * at the next sweep, as the end of the turn does.
   */
  async liveAssignments(ids: readonly string[]): Promise<Set<string>> {
    const valid = ids.filter((id) => uuid.safeParse(id).success)
    if (valid.length === 0) return new Set()
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM turn_assignments a
        JOIN site_leases l ON l.site_id = a.site_id AND l.holder_task_id = a.task_id
          AND l.epoch = a.lease_epoch
        WHERE a.id = ANY(${valid}::uuid[]) AND a.finished_at IS NULL AND a.outcome IS NULL
          AND a.deadline_at > clock_timestamp()
          AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM llm_keys k
            WHERE k.task_id = a.task_id AND k.session_id = a.session_id
              AND k.turn_no = a.turn_no AND k.first_epoch = a.first_epoch
              AND k.mcp_token_hash IS NOT NULL
              AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
              AND k.expires_at > clock_timestamp() AND k.valid_until > clock_timestamp())`
      return new Set(rows.map((row) => row.id))
    })
  }

  async #transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(work)
    } catch (error) {
      if (isDomainError(error)) throw error
      throw unavailable()
    }
  }
}
