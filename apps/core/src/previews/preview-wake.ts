import { enqueuePreviewSync, type PrismaClient } from '@repo/db'

/**
 * A pass of a dialog starts (owner's answer of 26.10.2026): its preview, stopped as unused for
 * PREVIEW_IDLE_MINUTES or at the end of its life, is asked to be built again at once — as an open
 * of it asks — so the agent's browser and content tools get it back during the turn rather than
 * at the next sweep. false — the dialog has no stopped preview (none, or one that serves).
 */
export async function wakeStoppedPreview(
  db: Pick<PrismaClient, '$transaction'>,
  taskId: string,
): Promise<boolean> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; enqueues: number; revision: number }>>`
        UPDATE preview_environments SET enqueues = enqueues + 1, updated_at = now()
        WHERE task_id = ${taskId}::uuid AND status = 'expired'
        RETURNING id, enqueues, revision`
      const row = rows[0]
      if (!row) return false
      await enqueuePreviewSync(tx, { previewId: row.id, revision: row.revision, seq: row.enqueues })
      return true
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
