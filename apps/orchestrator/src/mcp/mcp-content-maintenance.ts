import type { Prisma, PrismaClient } from '@repo/db'
import { badRequest, type ObjectStorage, type SecretStore } from '@repo/domain'
import { z } from 'zod'

import { contentMaskPath } from './content-privacy.ts'
import { contentExpiredSql, contentSnapshotKey } from './content-snapshots.ts'
import {
  mcpHostScopeSchema,
  mcpSiteScopeSchema,
  type McpHostScope,
  type McpSiteScope,
} from './mcp-access.ts'
import {
  BROWSER_SCREENSHOT_EVENT,
  browserScreenshotKey,
  screenshotIdOf,
} from './mcp-browser-store.ts'
import { recoverContentWrite, type ContentGatewayResolver } from './mcp-content.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'

export const MCP_CONTENT_MAINTENANCE = Symbol('MCP_CONTENT_MAINTENANCE')
const pageSchema = z.strictObject({
  siteId: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(100),
})
type Page = { siteId?: string; after?: string; limit?: number }
const captured = {
  mcpCalls: { include: { assignment: true, turn: true } },
  task: { include: { site: true } },
} as const
const admitted = {
  assignment: true,
  turn: { include: { task: { include: { site: true } } } },
} as const
type CallOwner = Prisma.McpCallGetPayload<{ include: { assignment: true; turn: true } }>
type TaskSite = Prisma.TaskGetPayload<{ include: { site: true } }>

/** The owner the journal gave a call: an assignment and a key, or the holder of a site lease. */
function owned(call: CallOwner, snapshot: { taskId: string | null; siteId: string }): boolean {
  if (call.hostTaskId !== null)
    return call.assignment === null && call.credentialKeyId === null && call.hostOperation !== null
  return (
    call.assignment !== null &&
    call.credentialKeyId !== null &&
    call.assignment.taskId === snapshot.taskId &&
    call.assignment.siteId === snapshot.siteId &&
    call.assignment.turnNo === call.turn.turnNo
  )
}

/**
 * Trusted local host maintenance, never an MCP tool. Claims precede external deletion;
 * metadata and the journal stay durable. No S3, Vault or site I/O runs in a SQL transaction.
 * A failed/lost acknowledgement leaves a claim that another process can retry safely.
 *
 * It works under the host scope of the journal: a write is reconciled by the fence of the
 * lease it was admitted under, and a site is reached by the site alone. No turn key is
 * borrowed and no scope of an agent is made up from a journal row.
 */
export class McpContentMaintenance {
  constructor(
    private readonly db: Pick<PrismaClient, '$transaction'>,
    private readonly storage: Pick<ObjectStorage, 'delete'>,
    private readonly secrets: Pick<SecretStore, 'kvDestroyAll'>,
    private readonly resolve: ContentGatewayResolver,
  ) {}

  recoverCaptures(siteId: string): Promise<number> {
    return new PostgresMcpJournal(this.db).recoverCaptures(siteId)
  }

  /**
   * Reconciles admitted writes past their deadline, when a site can prove absence. Nothing is
   * dispatched again; a proof clears the writer marker, the operator hold stays for recovery.
   * Only writes to the site: they alone hold its barrier. A write of unknown outcome into a
   * preview is closed by the preview's reset (docs/plan/53-chat-preview-release.md, Р24).
   */
  async recoverWrites(input: Page = {}) {
    const page = this.#page(input)
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM mcp_calls c JOIN site_leases l ON l.inflight_mcp_call_id = c.id
      WHERE c.result IS NULL AND c.write_started_at IS NOT NULL
        AND c.write_deadline_at <= clock_timestamp()
        AND (${page.siteId ?? null}::uuid IS NULL OR l.site_id = ${page.siteId ?? null}::uuid)
        AND (${page.after ?? null}::uuid IS NULL OR c.id > ${page.after ?? null}::uuid)
      ORDER BY c.id LIMIT ${page.limit}`,
    )
    const counts = { completed: 0, notCommitted: 0, unknown: 0, failed: 0 }
    for (const row of rows) {
      try {
        const call = await this.db.$transaction((tx) =>
          tx.mcpCall.findUniqueOrThrow({ where: { id: row.id }, include: admitted }),
        )
        const outcome = await recoverContentWrite(
          new PostgresMcpJournal(this.db),
          this.resolve,
          this.#hostScope(call, call.turn.task),
          call.id,
        )
        counts[outcome === 'not_committed' ? 'notCommitted' : outcome]++
      } catch {
        // Never log credentials, raw CMS responses or content.
        counts.failed++
      }
    }
    return {
      visited: rows.length,
      ...counts,
      nextAfter: rows.length === page.limit ? rows.at(-1)!.id : null,
    }
  }

  /**
   * Writes into previews left open by an unknown outcome (Р24), once the database they wrote
   * into is gone: the preview was rebuilt under a later write epoch, or destroyed with its
   * dialog. Nothing is dispatched or reconciled — the reset that replaced that database waited
   * for their deadline — so they close as reset; a preview that keeps its epoch keeps them open.
   */
  async closePreviewWrites(input: Pick<Page, 'siteId' | 'limit'> = {}) {
    const page = this.#page(input)
    // Closed rows leave the condition: a full batch means the caller runs it again.
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
      WITH stale AS (
        SELECT c.id FROM mcp_calls c JOIN preview_environments p ON p.id = c.preview_id
        WHERE c.result IS NULL
          AND (c.write_started_at IS NULL OR c.write_deadline_at <= clock_timestamp())
          AND (p.write_epoch > c.preview_write_epoch OR p.status = 'destroyed')
          AND (${page.siteId ?? null}::uuid IS NULL OR p.site_id = ${page.siteId ?? null}::uuid)
        ORDER BY c.id LIMIT ${page.limit} FOR UPDATE OF c SKIP LOCKED)
      UPDATE mcp_calls c SET result = 'error',
        response = '{"code":"CONTENT_PREVIEW_RESET"}'::jsonb, finished_at = clock_timestamp()
      FROM stale WHERE c.id = stale.id
      RETURNING c.id`,
    )
    return { closed: rows.length, more: rows.length === page.limit }
  }

  async sweepSnapshots(input: Page = {}) {
    const page = this.#page(input)
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM snapshots s LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.expires_at <= clock_timestamp() AND ${contentExpiredSql('t')}
        AND (${page.siteId ?? null}::uuid IS NULL OR s.site_id = ${page.siteId ?? null}::uuid)
        AND (${page.after ?? null}::uuid IS NULL OR s.id > ${page.after ?? null}::uuid)
        AND (s.purged_at IS NULL OR EXISTS (
          SELECT 1 FROM mcp_calls c WHERE c.snapshot_id = s.id AND c.receipt_purged_at IS NULL))
      ORDER BY s.id LIMIT ${page.limit}`,
    )
    let purged = 0,
      receipts = 0,
      failed = 0
    for (const row of rows) {
      try {
        const snapshot = await this.#claimSnapshot(row.id)
        if (!snapshot) continue
        if (!snapshot.purgedAt) {
          await this.storage.delete('artifacts', snapshot.s3Key)
          await this.db.$transaction((tx) =>
            tx.snapshot.update({ where: { id: snapshot.id }, data: { purgedAt: new Date() } }),
          )
          purged++
        }
        for (const call of snapshot.mcpCalls) {
          if (call.receiptPurgedAt) continue
          // The receipt of a write into a preview lives in the preview's database, which goes
          // with the preview: only the site is asked to forget one.
          if (call.writeStartedAt && call.previewId === null) {
            const task = snapshot.task!
            await (
              await this.resolve(this.#site(task))
            ).forgetOperation({
              callId: call.id,
              siteId: task.siteId,
              epoch: call.leaseEpoch!,
              requestHash: call.requestHash!,
              objectRef: call.objectRef!,
              deadlineAt: call.writeDeadlineAt!.getTime(),
              // The claim admits a call only past its write deadline on the PostgreSQL clock.
              ttlMs: 0,
            })
          }
          await this.db.$transaction((tx) =>
            tx.mcpCall.update({ where: { id: call.id }, data: { receiptPurgedAt: new Date() } }),
          )
          receipts++
        }
      } catch {
        // Never log credentials, raw CMS responses, content or storage exceptions.
        failed++
      }
    }
    return {
      visited: rows.length,
      purged,
      receipts,
      failed,
      nextAfter: rows.length === page.limit ? rows.at(-1)!.id : null,
    }
  }

  /**
   * The content of a task with third parties' data, once its undo window is over: the pixels of
   * the agent's screenshots and the sealed values of its database plan in `raditi-artifacts`
   * (docs/plan/53-chat-preview-release.md, N22, Р22), then the contact map in Vault. A task
   * still holding its site — a turn, a release, a write — is left for a later sweep; a removal
   * that fails is repeated, deleting an object twice changes nothing.
   */
  async sweepMasks(input: Page = {}) {
    const page = this.#page(input)
    const rows = await this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tasks WHERE content_masks_purged_at IS NULL
        AND (${page.siteId ?? null}::uuid IS NULL OR site_id = ${page.siteId ?? null}::uuid)
        AND (${page.after ?? null}::uuid IS NULL OR id > ${page.after ?? null}::uuid)
        AND ${contentExpiredSql('tasks')}
        AND (content_retired_at IS NOT NULL OR content_accessed_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM task_turns tt
            JOIN mcp_calls c ON c.turn_id = tt.id WHERE tt.task_id = tasks.id))
      ORDER BY id LIMIT ${page.limit}`,
    )
    let purged = 0,
      failed = 0
    for (const row of rows) {
      try {
        const task = await this.#claimMasks(row.id)
        if (!task) continue
        for (const key of await this.#taskArtifacts(task.id))
          await this.storage.delete('artifacts', key)
        await this.secrets.kvDestroyAll(contentMaskPath({ siteId: task.siteId, taskId: task.id }))
        await this.db.$transaction(async (tx) => {
          // The description of a plan holds its values in clear (docs/plan/53, «Операции БД и
          // миграции»): it goes with them.
          await tx.$executeRaw`
            UPDATE task_candidates SET db_view = NULL, db_view_sha256 = NULL
            WHERE task_id = ${task.id}::uuid AND db_view IS NOT NULL`
          await tx.task.update({
            where: { id: task.id },
            data: { contentMasksPurgedAt: new Date() },
          })
        })
        purged++
      } catch {
        failed++
      }
    }
    return {
      visited: rows.length,
      purged,
      failed,
      nextAfter: rows.length === page.limit ? rows.at(-1)!.id : null,
    }
  }

  async #claimSnapshot(id: string) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.snapshot.findUniqueOrThrow({ where: { id } })
      const leases = await tx.$queryRaw<
        Array<{ held: boolean; writer: string | null; holder: string | null }>
      >`
        SELECT held_for_operator AS held, inflight_mcp_call_id AS writer, holder_task_id AS holder
        FROM site_leases WHERE site_id = ${initial.siteId}::uuid FOR UPDATE`
      // Snapshots outlive the task by the undo window, whatever their capture expiry.
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS now FROM snapshots s JOIN tasks t ON t.id = s.task_id
        WHERE s.id = ${id}::uuid AND s.expires_at <= clock_timestamp()
          AND ${contentExpiredSql('t')}
        FOR UPDATE OF s`
      if (clocks.length !== 1) return null
      const snapshot = await tx.snapshot.findUniqueOrThrow({ where: { id }, include: captured })
      // Only our bounded snapshots, of a call the journal admitted: the agent's, backed by its
      // assignment, or a restore of the host. Legacy/generic artifacts need an operator.
      if (
        !snapshot.task ||
        snapshot.task.siteId !== snapshot.siteId ||
        snapshot.s3Key !== contentSnapshotKey(snapshot) ||
        snapshot.mcpCalls.length === 0 ||
        snapshot.mcpCalls.some(
          (call) =>
            !owned(call, snapshot) ||
            !call.requestHash ||
            !call.leaseEpoch ||
            !call.objectRef ||
            call.objectRef !== snapshot.objectRef ||
            call.result === null ||
            call.turn.taskId !== snapshot.taskId ||
            (call.writeStartedAt &&
              (!call.writeDeadlineAt || call.writeDeadlineAt > clocks[0]!.now)),
        )
      )
        return null
      if (!snapshot.purgeRequestedAt) {
        if (
          leases.some((lease) => lease.held || lease.writer || lease.holder) ||
          (await tx.turnAssignment.count({
            where: { taskId: snapshot.taskId!, finishedAt: null },
          })) ||
          (await tx.mcpCall.count({
            where: { result: null, OR: [{ snapshotId: id }, { restoresSnapshotId: id }] },
          }))
        )
          return null
        await tx.snapshot.update({ where: { id }, data: { purgeRequestedAt: clocks[0]!.now } })
      }
      return snapshot
    })
  }

  /** The objects of the task's own prefix its events and its plan name. */
  async #taskArtifacts(taskId: string): Promise<string[]> {
    const { screenshots, operations } = await this.db.$transaction(async (tx) => ({
      screenshots: await tx.taskEvent.findMany({
        where: { taskId, type: BROWSER_SCREENSHOT_EVENT },
        select: { payload: true },
      }),
      operations: await tx.previewDbOperation.findMany({
        where: { taskId },
        select: { beforeObjectKey: true, afterObjectKey: true },
      }),
    }))
    const keys = [
      ...screenshots.flatMap((event) => {
        const id = screenshotIdOf(event.payload)
        return id ? [browserScreenshotKey(taskId, id)] : []
      }),
      ...operations.flatMap((operation) => [operation.beforeObjectKey, operation.afterObjectKey]),
    ]
    const prefix = `tasks/${taskId.toLowerCase()}/`
    return [...new Set(keys)].filter((key) => key.startsWith(prefix))
  }

  async #claimMasks(id: string) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.task.findUniqueOrThrow({ where: { id } })
      const leases = await tx.$queryRaw<
        Array<{ held: boolean; writer: string | null; holder: string | null }>
      >`
        SELECT held_for_operator AS held, inflight_mcp_call_id AS writer, holder_task_id AS holder
        FROM site_leases WHERE site_id = ${initial.siteId}::uuid FOR UPDATE`
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS now FROM tasks WHERE id = ${id}::uuid
          AND content_masks_purged_at IS NULL AND ${contentExpiredSql('tasks')} FOR UPDATE`
      if (clocks.length !== 1) return null
      const task = await tx.task.findUniqueOrThrow({ where: { id } })
      if (!task.contentRetiredAt) {
        if (
          leases.some((lease) => lease.held || lease.writer || lease.holder) ||
          (await tx.turnAssignment.count({ where: { taskId: id, finishedAt: null } })) ||
          // Site receipts hold no personal data: a site that never confirms their removal
          // must not keep third parties' contacts in Vault.
          (await tx.mcpCall.count({ where: { turn: { taskId: id }, result: null } })) ||
          (await tx.snapshot.count({ where: { taskId: id, purgedAt: null } })) ||
          // An undo of its release confirmed, its values not yet sealed for the deploy job
          // (docs/plan/53, «Отмена выпуска»): they are read from here until it is armed.
          (await tx.siteRelease.count({
            where: { taskId: id, kind: 'undo', status: { in: ['approved', 'publishing'] } },
          })) ||
          (
            await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT id FROM llm_keys WHERE task_id = ${id}::uuid
            AND revoke_requested_at IS NULL AND revoked_at IS NULL
            AND LEAST(expires_at, valid_until) > clock_timestamp() LIMIT 1`
          ).length
        )
          return null
        // Authentication/admission also check this barrier. A retired context cannot be resumed.
        await tx.task.update({ where: { id }, data: { contentRetiredAt: clocks[0]!.now } })
      }
      return task
    })
  }

  /** What it takes to reach the site of a task; nothing of a turn or a key. */
  #site(task: TaskSite): McpSiteScope {
    return mcpSiteScopeSchema.parse({
      workspaceId: task.workspaceId,
      siteId: task.siteId,
      stack: task.site.stack,
      url: task.site.url,
    })
  }

  /**
   * The host scope a write is reconciled under: the fence of the lease the journal recorded
   * with the call — the holder, its operation and the epoch. The journal then checks that the
   * site is still leased exactly so and that the call was written under that lease.
   */
  #hostScope(call: CallOwner, task: TaskSite): McpHostScope {
    return mcpHostScopeSchema.parse({
      ...this.#site(task),
      targetTaskId: task.id,
      fence: {
        siteId: task.siteId,
        taskId: call.hostTaskId ?? call.assignment?.taskId,
        operation: call.hostOperation ?? 'turn',
        epoch: call.leaseEpoch,
      },
    })
  }

  #page(input: Page) {
    const parsed = pageSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content maintenance page')
    return parsed.data
  }
}
