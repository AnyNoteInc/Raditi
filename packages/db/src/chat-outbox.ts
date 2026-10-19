import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnDedupeKey,
  agentTurnJobSchema,
  agentTurnRetryJobId,
  PREVIEW_BROWSER_JOB,
  PREVIEW_QUEUE,
  PREVIEW_SYNC_JOB,
  previewBrowserDedupeKey,
  previewBrowserJobSchema,
  previewSyncDedupeKey,
  previewSyncJobSchema,
  RELEASE_ADVANCE_JOB,
  RELEASE_QUEUE,
  releaseAdvanceDedupeKey,
  releaseAdvanceJobSchema,
  type AgentTurnJob,
  type PreviewBrowserJob,
  type PreviewSyncJob,
  type ReleaseAdvanceJob,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// The jobs of the chat → preview → /release path (docs/plan/53-chat-preview-release.md,
// «Очереди и задания»). Each helper writes its outbox row in the caller's transaction, so a job
// exists exactly when the change it acts on was committed (spec §7). Payloads carry ids and
// counters only (CLAUDE.md, rule 2), and every key carries the step or counter of its row: a
// later event of the same row gets a new key instead of being dropped by `ON CONFLICT DO
// NOTHING`. Each helper returns false when a row with its key already exists.

/** Ids are written as PostgreSQL prints them, so one row is one key whatever case it came in. */
const lower = (id: string): string => id.toLowerCase()

export async function enqueueAgentTurn(
  tx: OutboxWriter,
  job: AgentTurnJob,
  options: { availableAt?: Date } = {},
): Promise<boolean> {
  const parsed = agentTurnJobSchema.parse(job)
  const payload: AgentTurnJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: AGENT_TURN_JOB,
    payload,
    dedupeKey: agentTurnDedupeKey(payload),
    availableAt: options.availableAt,
  })
}

/** The most waiting passes of one site one wake puts back. */
const WAKE_BATCH = 50
const wakeTagSchema = z.string().regex(/^[a-z]+-[0-9a-f-]{1,80}$/)

/**
 * The passes of a site that wait for it (`queued`, `waiting = site`) go back on the queue now:
 * the holder of the site let it go — a turn of another dialog ended, a release ended (stand
 * R12). Without it a waiting pass looks again only at its own retry. Each job answers the last
 * request that queued its pass — the words or «Продолжить», never a command, as the sweep puts
 * it — under the key of `tag` (what let the site go), so one end wakes a pass once. In the
 * caller's transaction; returns how many were put.
 */
export async function enqueueSiteWaitingPasses(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { siteId: string; tag: string },
): Promise<number> {
  const siteId = z.uuid().parse(input.siteId)
  const tag = wakeTagSchema.parse(input.tag.toLowerCase())
  const rows = await tx.$queryRaw<
    Array<{ id: string; attempt: number; request_id: bigint | null }>
  >`
    SELECT t.id, t.attempt,
      (SELECT max(e.id) FROM task_events e
        WHERE e.task_id = t.id AND e.type = 'feed.request'
          AND e.payload->>'kind' IS DISTINCT FROM 'command') AS request_id
    FROM tasks t
    WHERE t.site_id = ${siteId}::uuid AND t.status = 'queued' AND t.waiting = 'site'
    ORDER BY t.updated_at, t.id
    LIMIT ${WAKE_BATCH}`
  let put = 0
  for (const row of rows) {
    if (row.request_id === null) continue
    const job = agentTurnJobSchema.parse({
      taskId: lower(row.id),
      attempt: row.attempt,
      requestEventId: row.request_id.toString(),
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

export async function enqueuePreviewSync(
  tx: OutboxWriter,
  job: PreviewSyncJob,
  options: { availableAt?: Date } = {},
): Promise<boolean> {
  const parsed = previewSyncJobSchema.parse(job)
  const payload: PreviewSyncJob = { ...parsed, previewId: lower(parsed.previewId) }
  return enqueueOutbox(tx, {
    topic: PREVIEW_QUEUE,
    type: PREVIEW_SYNC_JOB,
    payload,
    dedupeKey: previewSyncDedupeKey(payload),
    availableAt: options.availableAt,
  })
}

export async function enqueuePreviewBrowser(
  tx: OutboxWriter,
  job: PreviewBrowserJob,
): Promise<boolean> {
  const parsed = previewBrowserJobSchema.parse(job)
  const payload: PreviewBrowserJob = {
    previewId: lower(parsed.previewId),
    requestId: lower(parsed.requestId),
  }
  return enqueueOutbox(tx, {
    topic: PREVIEW_QUEUE,
    type: PREVIEW_BROWSER_JOB,
    payload,
    dedupeKey: previewBrowserDedupeKey(payload),
  })
}

export async function enqueueReleaseAdvance(
  tx: OutboxWriter,
  job: ReleaseAdvanceJob,
  options: { availableAt?: Date } = {},
): Promise<boolean> {
  const parsed = releaseAdvanceJobSchema.parse(job)
  const payload: ReleaseAdvanceJob = { ...parsed, releaseId: lower(parsed.releaseId) }
  return enqueueOutbox(tx, {
    topic: RELEASE_QUEUE,
    type: RELEASE_ADVANCE_JOB,
    payload,
    dedupeKey: releaseAdvanceDedupeKey(payload),
    availableAt: options.availableAt,
  })
}
