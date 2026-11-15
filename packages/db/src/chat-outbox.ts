import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  BROWSER_ENSURE_JOB,
  BROWSER_SESSION_QUEUE,
  agentTurnDedupeKey,
  agentTurnJobSchema,
  agentTurnRetryJobId,
  browserEnsureDedupeKey,
  browserEnsureJobSchema,
  type AgentTurnJob,
  type BrowserEnsureJob,
  tierQueuePriority,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'
import { workspaceUsageTerms } from './usage-windows.ts'

// The jobs of a chat (docs/plan/53-chat-preview-release.md, «Очереди и задания»). Each helper writes its outbox row in the caller's transaction, so a job
// exists exactly when the change it acts on was committed (spec §7). Payloads carry ids and
// counters only (CLAUDE.md, rule 2), and every key carries the step or counter of its row: a
// later event of the same row gets a new key instead of being dropped by `ON CONFLICT DO
// NOTHING`. Each helper returns false when a row with its key already exists.

/** Ids are written as PostgreSQL prints them, so one row is one key whatever case it came in. */
const lower = (id: string): string => id.toLowerCase()

/**
 * The place of a pass of the task in the queue: the tier of the live paid tariff of its
 * workspace (plan 71, §2.3) — a repeat after the pool waited comes back in the same order.
 */
export async function agentTurnPriority(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  taskId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ workspaceId: string }[]>`
    SELECT workspace_id AS "workspaceId" FROM tasks WHERE id = ${taskId}::uuid`
  const workspaceId = rows[0]?.workspaceId
  // The tier the limits of the workspace are read by, so a pass and its windows never disagree.
  const tier =
    workspaceId === undefined ? 'none' : (await workspaceUsageTerms(tx, workspaceId)).tier
  return tierQueuePriority[tier]
}

export async function enqueueAgentTurn(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, '$queryRaw'>,
  job: AgentTurnJob,
  options: { availableAt?: Date } = {},
): Promise<boolean> {
  const parsed = agentTurnJobSchema.parse(job)
  const payload: AgentTurnJob = {
    ...parsed,
    taskId: lower(parsed.taskId),
    priority: parsed.priority ?? (await agentTurnPriority(tx, parsed.taskId)),
  }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: AGENT_TURN_JOB,
    payload,
    dedupeKey: agentTurnDedupeKey(payload),
    availableAt: options.availableAt,
  })
}

/** The most waiting passes one wake puts back. */
const WAKE_BATCH = 50
const wakeTagSchema = z.string().regex(/^[a-z]+-[0-9a-f-]{1,80}$/)

/**
 * The passes that wait for the agents (`queued`, `waiting = agents`) go back on the queue now,
 * oldest first (docs/plan/70-turn-without-time-limit.md, ВР15): a pass ended and freed a place —
 * of its workspace (`workspaceId`), or of the platform. A pass of a workspace at its limit is
 * refused again at its claim, cheaply, and holds no place meanwhile. Each job answers the last
 * request that queued its pass — the words, «Продолжить» or a command the agent carries out, never
 * a press of a command — under the key of `tag`, so one end wakes a pass once. In the
 * caller's transaction; returns how many were put.
 */
export async function enqueueAgentWaitingPasses(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { workspaceId?: string; limit: number; tag: string },
): Promise<number> {
  const workspaceId = input.workspaceId === undefined ? null : z.uuid().parse(input.workspaceId)
  const limit = z.number().int().min(1).max(WAKE_BATCH).parse(input.limit)
  const tag = wakeTagSchema.parse(input.tag.toLowerCase())
  const rows = await tx.$queryRaw<
    Array<{ id: string; attempt: number; request_id: bigint | null }>
  >`
    SELECT t.id, t.attempt,
      (SELECT max(e.id) FROM task_events e
        WHERE e.task_id = t.id AND e.type = 'feed.request'
          AND e.payload->>'kind' IS DISTINCT FROM 'command') AS request_id
    FROM tasks t
    WHERE t.status = 'queued' AND t.waiting = 'agents'
      AND (${workspaceId}::uuid IS NULL OR t.workspace_id = ${workspaceId}::uuid)
    ORDER BY t.updated_at, t.id
    LIMIT ${limit}`
  let put = 0
  for (const row of rows) {
    if (row.request_id === null) continue
    const job = agentTurnJobSchema.parse({
      taskId: lower(row.id),
      attempt: row.attempt,
      requestEventId: row.request_id.toString(),
      // A woken pass keeps the place of its tier: BullMQ takes a job without a priority first.
      priority: await agentTurnPriority(tx, row.id),
    })
    if (
      await enqueueOutbox(tx, {
        topic: AGENT_TURN_QUEUE,
        type: AGENT_TURN_JOB,
        payload: job,
        dedupeKey: agentTurnRetryJobId(job, tag),
      })
    )
      put += 1
  }
  return put
}

/**
 * The start of a browser session (docs/plan/61-chats-first.md, К11). `window` is
 * `browserEnsureWindow` of the database's time: one job per session in each of them, so a session
 * that stays `starting` asks again and a call of the same window adds nothing.
 */
export async function enqueueBrowserEnsure(
  tx: OutboxWriter,
  job: BrowserEnsureJob,
  options: { window: number },
): Promise<boolean> {
  const parsed = browserEnsureJobSchema.parse(job)
  const payload: BrowserEnsureJob = {
    taskId: lower(parsed.taskId),
    sessionId: lower(parsed.sessionId),
  }
  return enqueueOutbox(tx, {
    topic: BROWSER_SESSION_QUEUE,
    type: BROWSER_ENSURE_JOB,
    payload,
    dedupeKey: browserEnsureDedupeKey(payload, options.window),
  })
}
