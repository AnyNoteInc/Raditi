import type { PrismaClient } from '@repo/db'
import { conflict } from '@repo/domain'

// The hold of one core on one preview (docs/plan/53-chat-preview-release.md, R5c): a build, a
// sync of the agent's tree, the browser of the agent. Like a stage of site provisioning it is a
// fencing token of the row (`lease_epoch`) and a heartbeat (`heartbeat_at`): another core takes a
// preview over only once the heartbeat is older than `stale`, and every write of the holder names
// its epoch, so a holder that lost the preview writes nothing. Times are the database's.

export const previewLeaseTimings = Object.freeze({
  /** How often a holder renews its heartbeat. */
  heartbeatMs: 15_000,
  /** A heartbeat this old is of a holder that died: the preview may be taken over. */
  staleSeconds: 90,
})

export interface PreviewFence {
  previewId: string
  epoch: number
}

type Db = Pick<PrismaClient, '$queryRaw'>

/**
 * Takes the preview when nobody holds it (or its holder died). null — another core holds it;
 * `enqueues` is the counter of requests the holder starts from.
 */
export async function claimPreview(
  db: Db,
  previewId: string,
): Promise<(PreviewFence & { enqueues: number }) | null> {
  const rows = await db.$queryRaw<Array<{ lease_epoch: number; enqueues: number }>>`
    UPDATE preview_environments
    SET lease_epoch = lease_epoch + 1, heartbeat_at = now(), updated_at = now()
    WHERE id = ${previewId}::uuid
      AND (heartbeat_at IS NULL
        OR heartbeat_at < now() - ${previewLeaseTimings.staleSeconds}::int * interval '1 second')
    RETURNING lease_epoch, enqueues`
  const row = rows[0]
  return row ? { previewId, epoch: row.lease_epoch, enqueues: row.enqueues } : null
}

/** false — the preview is no longer this holder's. */
export async function renewPreview(db: Db, fence: PreviewFence): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE preview_environments SET heartbeat_at = now()
    WHERE id = ${fence.previewId}::uuid AND lease_epoch = ${fence.epoch}
    RETURNING id`
  return rows.length === 1
}

/**
 * Lets the preview go, unless a request came while it was held: then the holder keeps it and
 * answers the new `enqueues` (returned). null — let go, or no longer this holder's.
 */
export async function releasePreview(
  db: Db,
  fence: PreviewFence,
  seen: number,
): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ enqueues: number; released: boolean }>>`
    UPDATE preview_environments
    SET heartbeat_at = CASE WHEN enqueues = ${seen} THEN NULL ELSE now() END
    WHERE id = ${fence.previewId}::uuid AND lease_epoch = ${fence.epoch}
    RETURNING enqueues, enqueues = ${seen} AS released`
  const row = rows[0]
  return row && !row.released ? row.enqueues : null
}

/**
 * A held preview: its fence, and a signal that aborts once the heartbeat finds the preview taken
 * over — whatever the holder still does then writes nothing to the row.
 */
export class PreviewHold {
  readonly #controller = new AbortController()
  readonly #timer: NodeJS.Timeout

  constructor(
    private readonly db: Db,
    readonly fence: PreviewFence,
    heartbeatMs: number = previewLeaseTimings.heartbeatMs,
  ) {
    this.#timer = setInterval(() => void this.#beat(), heartbeatMs)
    this.#timer.unref()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** Throws when the preview was taken over. */
  assert(): void {
    if (this.#controller.signal.aborted) throw conflict('The preview is held by another core now')
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  async #beat(): Promise<void> {
    try {
      if (!(await renewPreview(this.db, this.fence))) this.#lost()
    } catch {
      // A database hiccup: the next beat tries again, the row decides who holds it.
    }
  }

  #lost(): void {
    this.stop()
    this.#controller.abort(conflict('The preview is held by another core now'))
  }
}
