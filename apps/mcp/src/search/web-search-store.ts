import type { Prisma, PrismaClient } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'
import { z } from 'zod'

import { leaseIdOf, type McpTurnAccess } from '../access/mcp-access.ts'
import type { McpWebSearchConfig } from '../config/config.ts'
import type { WebSearchStatus } from './parallel-search.ts'

/**
 * Why a call is refused before it leaves: the limit it would pass, no reserve of credits under the
 * task (spec §20: a workspace is bounded by its credits alone), or no live turn.
 */
export type WebSearchRefusal = 'turn_limit' | 'service_limit' | 'no_credits' | 'unavailable'

/**
 * What the calls before this one used, as the reservation counted them (this one not included).
 * The workspace's month is counted, not limited: its average tells the price of a search later.
 */
export interface WebSearchUsage {
  turn: number
  workspaceMonth: number
  serviceMonth: number
}

export type WebSearchReservation =
  | { reserved: true; id: string; usage: WebSearchUsage }
  | { reserved: false; refusal: WebSearchRefusal; usage?: WebSearchUsage }

export interface WebSearchStore {
  /** Counts the call before it leaves, or refuses it; never throws. */
  reserve(scope: McpTurnAccess, limits: McpWebSearchConfig['limits']): Promise<WebSearchReservation>
  /** How the reserved call ended; a failure to write it is the caller's to log, not the agent's. */
  finish(id: string, status: WebSearchStatus, latencyMs: number): Promise<void>
}

/**
 * One key for every reservation: calls are counted one at a time, so parallel calls of a turn, of
 * a workspace and of the service never pass a limit together. A search is a few a minute at most.
 */
const RESERVATION_LOCK = 'mcp:web-search'

const usageRowSchema = z.object({
  turn: z.number().int().min(0),
  workspaceMonth: z.number().int().min(0),
  serviceMonth: z.number().int().min(0),
})

type Db = Pick<PrismaClient, '$transaction' | 'webSearchCall'>

/**
 * The counts of `raditi_search_web` in PostgreSQL (`web_search_calls`): the turn is admitted once
 * more for the call and its task must hold an active reserve of credits — no credits, no searches;
 * the month is the calendar month in Moscow, and a reserved call counts whatever becomes of it —
 * the service may bill a request that timed out here.
 */
export class PostgresWebSearchStore implements WebSearchStore {
  constructor(private readonly db: Db) {}

  async reserve(
    scope: McpTurnAccess,
    limits: McpWebSearchConfig['limits'],
  ): Promise<WebSearchReservation> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${RESERVATION_LOCK}, 0))::text`
        if (!(await turnIsLive(tx, scope))) return { reserved: false, refusal: 'unavailable' }
        if (!(await holdsCredits(tx, scope))) return { reserved: false, refusal: 'no_credits' }
        const [row] = await tx.$queryRaw<unknown[]>`
          WITH month AS (
            SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'Europe/Moscow')
              AT TIME ZONE 'Europe/Moscow' AS start)
          SELECT
            (SELECT count(*)::int FROM web_search_calls
              WHERE task_id = ${scope.taskId}::uuid AND session_id = ${scope.sessionId}
                AND turn_no = ${scope.turn} AND first_epoch = ${scope.firstEpoch}) AS turn,
            (SELECT count(*)::int FROM web_search_calls, month
              WHERE workspace_id = ${scope.workspaceId}::uuid
                AND created_at >= month.start) AS "workspaceMonth",
            (SELECT count(*)::int FROM web_search_calls, month
              WHERE created_at >= month.start) AS "serviceMonth"`
        const usage = usageRowSchema.parse(row)
        const refusal: WebSearchRefusal | null =
          usage.turn >= limits.turn
            ? 'turn_limit'
            : usage.serviceMonth >= limits.serviceMonth
              ? 'service_limit'
              : null
        if (refusal) return { reserved: false, refusal, usage }
        const call = await tx.webSearchCall.create({
          data: {
            workspaceId: scope.workspaceId,
            taskId: scope.taskId,
            sessionId: scope.sessionId,
            turnNo: scope.turn,
            firstEpoch: scope.firstEpoch,
          },
          select: { id: true },
        })
        return { reserved: true, id: call.id, usage }
      })
    } catch {
      // An outage of the database: the call does not leave uncounted.
      return { reserved: false, refusal: 'unavailable' }
    }
  }

  async finish(id: string, status: WebSearchStatus, latencyMs: number): Promise<void> {
    await this.db.webSearchCall.updateMany({
      where: { id, status: null },
      data: { status, latencyMs: Math.max(0, Math.round(latencyMs)), finishedAt: new Date() },
    })
  }
}

/**
 * The admission of the guard (`PostgresMcpAccess`) once more, inside the reservation: the key, its
 * assignment and the turn lease are live now, not only when the request came in.
 */
async function turnIsLive(tx: Prisma.TransactionClient, scope: McpTurnAccess): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM llm_keys k JOIN tasks t ON t.id = k.task_id
    JOIN turn_assignments a ON a.task_id = t.id AND a.site_id = ${leaseIdOf(scope)}::uuid
      AND a.site_id IN (t.id, t.site_id)
      AND a.session_id = k.session_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
    JOIN site_leases l ON l.site_id = a.site_id AND l.holder_task_id = t.id
      AND l.epoch = a.lease_epoch
    WHERE k.id = ${scope.keyId}::uuid AND t.id = ${scope.taskId}::uuid
      AND t.workspace_id = ${scope.workspaceId}::uuid
      AND a.session_id = ${scope.sessionId} AND a.turn_no = ${scope.turn}
      AND a.first_epoch = ${scope.firstEpoch} AND a.lease_epoch = ${scope.epoch}
      AND k.mcp_token_hash IS NOT NULL AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
      AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
      AND k.valid_until > clock_timestamp()
      AND a.deadline_at > clock_timestamp() AND a.finished_at IS NULL AND a.outcome IS NULL
      AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
      AND t.content_retired_at IS NULL
      AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])`
  return rows.length === 1
}

/**
 * Whether the task of the call holds an active reserve of credits (`credit_holds`) for its current
 * attempt — the one its turn key is for: every pass of a chat runs on one, and a workspace whose
 * credits are spent starts none.
 */
async function holdsCredits(tx: Prisma.TransactionClient, scope: McpTurnAccess): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM credit_holds h JOIN tasks t ON t.id = h.task_id AND h.attempt = t.attempt
    WHERE h.task_id = ${scope.taskId}::uuid AND h.status = 'active'
      AND h.expires_at > clock_timestamp()
    LIMIT 1`
  return rows.length === 1
}
