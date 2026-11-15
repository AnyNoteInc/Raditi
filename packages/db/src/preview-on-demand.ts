import { enqueuePreviewSync } from './chat-outbox.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

// A preview built when something needs it (docs/plan/82-scheduled-tasks.md, Зп18): the client
// opens it, or a content tool or the browser of the agent reaches into it. One writer of the
// demand for web (`/preview` and its frame) and for `mcp` (the agent's tools), so both mark the
// row the same way and the manager of previews in core reads the mark as the need.

/** A stopped preview is asked to be built again at most this often, however often it is needed. */
export const PREVIEW_DEMAND_SECONDS = 60

/**
 * Asks core to build a stopped preview of a dialog again (`preview.sync`), once while a demand is
 * fresh: the row is marked (`last_viewed_at` — it is wanted now, so its time to live counts from
 * here) and the job queued; a demand within `PREVIEW_DEMAND_SECONDS` of the mark finds it and
 * queues nothing, so a screen or a tool that asks again on «not ready» adds no jobs. Both times
 * are of the database's clock. Once core moves the row out of `expired`, nothing is asked. A
 * preview never built — of a chat a scheduled task started — waits for exactly this mark (or a
 * candidate) before core builds it. Returns whether a job was queued.
 */
export async function demandStoppedPreview(
  db: Pick<PrismaClient, '$transaction'>,
  previewId: string,
): Promise<boolean> {
  return db.$transaction(
    async (tx) => {
      const marked = await tx.$queryRaw<Array<{ enqueues: number; revision: number }>>`
        UPDATE preview_environments
        SET enqueues = enqueues + 1, last_viewed_at = now(), updated_at = now()
        WHERE id = ${previewId}::uuid AND status = 'expired'
          AND (last_viewed_at IS NULL
            OR last_viewed_at < now() - ${PREVIEW_DEMAND_SECONDS}::int * interval '1 second')
        RETURNING enqueues, revision`
      const row = marked[0]
      if (row === undefined) return false
      await enqueuePreviewSync(tx, { previewId, revision: row.revision, seq: row.enqueues })
      return true
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
