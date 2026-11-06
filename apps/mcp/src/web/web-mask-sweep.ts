import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common'
import { Prisma, type PrismaClient } from '@repo/db'
import { leaseScopeOf, type SecretStore } from '@repo/domain'

import { contentExpiredSql } from '../privacy/content-expiry.ts'
import { contentMaskPath } from '../privacy/content-privacy.ts'

const SWEEP_EVERY_MS = 60 * 60_000
const PAGE = 100

/** SQL: a task with a browser whose contact map is past its window and nobody has removed yet. */
const dueSql = Prisma.sql`needs_browser AND web_masks_purged_at IS NULL
  AND content_masks_purged_at IS NULL AND ${contentExpiredSql('tasks')}`

/**
 * Removes the contact maps of finished tasks with a browser in the process that runs in production
 * (docs/plan/61-chats-first.md, К38): `web_*` writes what the pages show into
 * `kv/content-masks/<scope>/<taskId>`, and the sweep of ContentModule has no scheduler and no
 * production. A task still holding a live assignment or key is left for a later hour.
 *
 * `web_masks_purged_at` is its own column: `content_masks_purged_at` also closes the sweep of a
 * repository task's artifacts, which this one does not touch. It sets no `content_retired_at`
 * either: on a retired task the claim of that sweep skips what it checks before removing them.
 * What stops a new map after this one is the final status: admission refuses a task in one.
 *
 * Nothing here logs an id, a path or a contact: only counts and the name of an error.
 */
export class WebMaskSweep implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly #logger = new Logger('WebMaskSweep')
  #timer: ReturnType<typeof setInterval> | undefined
  #running: Promise<void> | undefined
  #stopped = false

  constructor(
    private readonly db: Pick<PrismaClient, '$transaction'>,
    private readonly secrets: Pick<SecretStore, 'kvDestroyAll'>,
    private readonly everyMs = SWEEP_EVERY_MS,
  ) {}

  onApplicationBootstrap(): void {
    this.#timer = setInterval(() => void this.#tick(), this.everyMs)
    this.#timer.unref()
  }

  /** Before the database closes: no timer fires again and the run going ends at its next task. */
  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.#timer)
    this.#stopped = true
    await this.#running
  }

  /** One run over every task due. A failed task is counted and tried again the next hour. */
  async sweep() {
    const counts = { visited: 0, purged: 0, failed: 0 }
    let after: string | null = null
    do {
      const page: Array<{ id: string }> = await this.#due(after)
      for (const { id } of page) {
        if (this.#stopped) return counts
        counts.visited++
        try {
          const task = await this.#claim(id)
          if (!task) continue
          // Removing it twice changes nothing, a lost acknowledgement is simply repeated.
          await this.secrets.kvDestroyAll(
            contentMaskPath({ siteId: leaseScopeOf(task), taskId: task.id }),
          )
          // Raw: Prisma's @updatedAt would lift a chat finished long ago to the top of its list.
          await this.db.$transaction(
            (tx) => tx.$executeRaw`
              UPDATE tasks SET web_masks_purged_at = clock_timestamp() WHERE id = ${id}::uuid`,
          )
          counts.purged++
        } catch {
          counts.failed++
        }
      }
      after = page.length === PAGE ? page.at(-1)!.id : null
    } while (after !== null)
    return counts
  }

  /** One run at a time: an hour that finds the last one going leaves it to finish. */
  #tick(): Promise<void> {
    this.#running ??= this.sweep()
      .then(({ purged, failed }) => {
        if (failed > 0) this.#logger.warn(`web_mask_sweep purged=${purged} failed=${failed}`)
        else if (purged > 0) this.#logger.log(`web_mask_sweep purged=${purged}`)
      })
      .catch((error: unknown) => {
        this.#logger.warn(
          `web_mask_sweep stopped: ${error instanceof Error ? error.name : 'unknown'}`,
        )
      })
      .finally(() => {
        this.#running = undefined
      })
    return this.#running
  }

  #due(after: string | null) {
    return this.db.$transaction(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM tasks WHERE ${dueSql}
          AND (${after}::uuid IS NULL OR id > ${after}::uuid)
        ORDER BY id LIMIT ${PAGE}`,
    )
  }

  /** The task, locked and read again; null when it has stopped being due or is still in use. */
  #claim(id: string) {
    return this.db.$transaction(async (tx) => {
      const [task] = await tx.$queryRaw<Array<{ id: string; siteId: string | null }>>`
        SELECT id, site_id AS "siteId" FROM tasks WHERE id = ${id}::uuid AND ${dueSql} FOR UPDATE`
      if (!task) return null
      if (await tx.turnAssignment.count({ where: { taskId: id, finishedAt: null } })) return null
      const keys = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM llm_keys WHERE task_id = ${id}::uuid
          AND revoke_requested_at IS NULL AND revoked_at IS NULL
          AND LEAST(expires_at, valid_until) > clock_timestamp() LIMIT 1`
      return keys.length > 0 ? null : task
    })
  }
}
