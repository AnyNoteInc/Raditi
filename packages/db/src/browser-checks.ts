import { badRequest, browserScreenshotKey } from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

// The agent's checks in the browser of its preview (docs/plan/53-chat-preview-release.md, Р21,
// Р22). A run of `browser_run_checks` is an internal event of the task, bound to the sync of the
// working tree it ran on (`preview_sync_requests`): during a turn the preview shows the turn's
// working state, never a revision, so the run cannot name a candidate yet. The pass that records
// the turn's candidate carries the run into it (`carryBrowserChecks`, R3).

type Tx = Prisma.TransactionClient

/** The internal event of a run; never shown to the client (`client_visible = false`). */
export const BROWSER_CHECKS_EVENT = 'browser.checks'

const id = z.uuid()
const turnNo = z.number().int().min(1).max(999_999)
const count = z.number().int().min(0).max(100)

/** Counts and ids only: never a path, a selector or a text of a page. */
export const browserChecksEventSchema = z
  .strictObject({
    v: z.literal(1),
    turn: turnNo,
    total: count.min(1),
    passed: count,
    failed: count,
    /** The preview the run looked at, and the sync that brought the working tree onto it. */
    previewId: id,
    syncRequestId: id,
  })
  .refine((run) => run.passed + run.failed === run.total)
export type BrowserChecksRun = z.infer<typeof browserChecksEventSchema>

/** The internal event of a screenshot of the agent's browser (N22); never shown as a row. */
export const BROWSER_SCREENSHOT_EVENT = 'browser.screenshot'

/**
 * The screenshot `id` (`browserScreenshotKey`) and what it looked at: the turn, the preview and
 * the sync that brought the working tree onto it. Rows of the first version name the id alone.
 */
export const browserScreenshotEventSchema = z.strictObject({
  v: z.literal(1),
  id,
  turn: turnNo.optional(),
  previewId: id.optional(),
  syncRequestId: id.optional(),
})

/** Writes a run in the caller's transaction (the mcp role). */
export async function recordBrowserChecks(
  tx: Pick<Tx, 'taskEvent'>,
  input: { taskId: string; turnId: string | null; run: BrowserChecksRun },
): Promise<void> {
  const parsed = z
    .strictObject({ taskId: id, turnId: id.nullable(), run: browserChecksEventSchema })
    .safeParse(input)
  if (!parsed.success) throw badRequest('Invalid browser check run')
  const { taskId, turnId, run } = parsed.data
  await tx.taskEvent.create({
    data: { taskId, turnId, type: BROWSER_CHECKS_EVENT, payload: run, clientVisible: false },
  })
}

const carrySchema = z.strictObject({ taskId: id, candidateId: id, turnNo })

/**
 * Carries the last check run of turn `turnNo` into `candidateId` — the candidate the pass of that
 * turn records, or the standing one the turn left unchanged — as a `candidate_checks` row of kind
 * `agent_browser` at the candidate's revision. Only when what the run looked at is what the
 * candidate holds, as far as the platform sees: no later sync of the preview brought other files
 * (a later one with the same `files_digest` is a later look at the same tree), and no content
 * write into the preview began after the run. A file the agent changed after its last browser
 * action is seen by no sync: the run is the agent's look at its working state, and the
 * revision itself is checked by `preview_smoke`. Once per candidate and turn; call it in the
 * transaction that records the candidate. true — a row was written.
 */
export async function carryBrowserChecks(
  tx: Pick<Tx, '$queryRaw' | 'candidateCheck'>,
  input: { taskId: string; candidateId: string; turnNo: number },
): Promise<boolean> {
  const parsed = carrySchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid browser checks carry')
  const { taskId, candidateId } = parsed.data
  const turn = String(parsed.data.turnNo)
  const rows = await tx.$queryRaw<Array<{ payload: unknown; createdAt: Date; revision: number }>>`
    SELECT e.payload, e.created_at AS "createdAt", c.revision
    FROM task_events e
    JOIN task_candidates c ON c.id = ${candidateId}::uuid AND c.task_id = e.task_id
    WHERE e.task_id = ${taskId}::uuid AND e.type = ${BROWSER_CHECKS_EVENT}
      AND NOT e.client_visible AND e.payload->>'turn' = ${turn}
    ORDER BY e.id DESC LIMIT 1`
  const row = rows[0]
  const run = browserChecksEventSchema.safeParse(row?.payload)
  if (!row || !run.success) return false
  const { previewId, syncRequestId } = run.data
  const current = await tx.$queryRaw<Array<{ current: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM preview_sync_requests s
      JOIN preview_environments p ON p.id = s.preview_id AND p.task_id = ${taskId}::uuid
      WHERE s.id = ${syncRequestId}::uuid AND s.preview_id = ${previewId}::uuid
        AND s.completed_at IS NOT NULL AND s.error_code IS NULL AND s.files_digest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM preview_sync_requests later
          WHERE later.preview_id = s.preview_id AND later.id <> s.id
            AND later.requested_at >= s.requested_at
            AND (later.completed_at IS NULL OR later.error_code IS NOT NULL
              OR later.files_digest IS DISTINCT FROM s.files_digest))
        AND NOT EXISTS (
          SELECT 1 FROM mcp_calls w
          WHERE w.preview_id = s.preview_id AND w.write_started_at >= ${row.createdAt})
        AND NOT EXISTS (
          SELECT 1 FROM candidate_checks k
          WHERE k.candidate_id = ${candidateId}::uuid AND k.kind = 'agent_browser'
            AND k.summary->>'turn' = ${turn})
    ) AS current`
  if (current[0]?.current !== true) return false
  const { total, passed, failed } = run.data
  await tx.candidateCheck.create({
    data: {
      candidateId,
      revision: row.revision,
      kind: 'agent_browser',
      status: failed === 0 ? 'passed' : 'failed',
      summary: { v: 1, turn: run.data.turn, total, passed, failed },
      artifactKey: await sameLookScreenshot(tx, { taskId, turn, previewId, syncRequestId }),
      finishedAt: row.createdAt,
    },
  })
  return true
}

/**
 * The key of the last screenshot of the turn that shows what the run looked at (Р22: artifacts
 * of a revision with its check), or null: taken on a sync of the same tree as the run's, no
 * earlier than the run's sync was asked for, and no content write into the preview began after
 * it — the run's own conditions keep everything later from changing the look.
 */
async function sameLookScreenshot(
  tx: Pick<Tx, '$queryRaw'>,
  input: { taskId: string; turn: string; previewId: string; syncRequestId: string },
): Promise<string | null> {
  const { taskId, turn, previewId, syncRequestId } = input
  const rows = await tx.$queryRaw<Array<{ payload: unknown }>>`
    SELECT e.payload FROM task_events e
    JOIN preview_sync_requests run ON run.id = ${syncRequestId}::uuid
    WHERE e.task_id = ${taskId}::uuid AND e.type = ${BROWSER_SCREENSHOT_EVENT}
      AND NOT e.client_visible AND e.payload->>'turn' = ${turn}
      AND e.payload->>'previewId' = ${previewId}
      AND e.created_at >= run.requested_at
      AND EXISTS (
        SELECT 1 FROM preview_sync_requests shot
        WHERE shot.id::text = e.payload->>'syncRequestId' AND shot.preview_id = run.preview_id
          AND shot.completed_at IS NOT NULL AND shot.error_code IS NULL
          AND shot.files_digest = run.files_digest)
      AND NOT EXISTS (
        SELECT 1 FROM mcp_calls w
        WHERE w.preview_id = run.preview_id AND w.write_started_at >= e.created_at)
    ORDER BY e.id DESC LIMIT 1`
  const shot = browserScreenshotEventSchema.safeParse(rows[0]?.payload)
  return shot.success ? browserScreenshotKey(taskId, shot.data.id) : null
}
