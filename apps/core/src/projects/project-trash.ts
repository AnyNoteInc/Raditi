import { Logger } from '@nestjs/common'
import {
  lockProjectChats,
  projectBusyStatuses,
  projectsDueForPurge,
  purgeProject,
  stopProjectChats,
  type PrismaClient,
} from '@repo/db'

/** How often the projects whose 30 days in the trash are over are purged (docs/plan/84, §4.3). */
export const PROJECT_PURGE_EVERY_MS = 60 * 60_000
const BATCH = 20

export interface ProjectTrashDependencies {
  db: PrismaClient
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

export interface ProjectTrashSweep {
  /** Chats of projects in the trash pressed to stop on this sweep. */
  stopped: number
  /** Projects purged; null — not their hour. */
  purged: number | null
}

/**
 * The trash of projects in core (docs/plan/84-projects.md, ПР20; slice 84.5), a pass of the sweep
 * of chats (TaskSweep, every minute):
 * - a chat of a project in the trash whose pass is queued or runs is stopped — the second line
 *   after «Удалить», which presses them in its own transaction (`trashProject`): a chat queued
 *   there by a race with it is stopped here;
 * - once an hour the projects past `purge_after` are purged (`purgeProject`): only their chats
 *   stay, deleted. A project with a chat that has not ended presses it and waits for the next hour.
 *
 * The pause of the scheduled tasks of a project in the trash (ПР19, `project_gone`) comes with
 * the scheduled tasks (Э5): its place is `stopChats`. Every write is conditional under the lock of
 * its rows, so two cores sweep side by side.
 */
export class ProjectTrash {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date
  #purgedAt: number | null = null

  constructor(private readonly deps: ProjectTrashDependencies) {
    this.#logger = deps.logger ?? new Logger('ProjectTrash')
    this.#now = deps.now ?? (() => new Date())
  }

  async sweep(): Promise<ProjectTrashSweep> {
    const stopped = await this.stopChats()
    const now = this.#now().getTime()
    const due = this.#purgedAt === null || now - this.#purgedAt >= PROJECT_PURGE_EVERY_MS
    const purge = due ? await this.purge() : null
    // A chat still stopping, or more projects than a batch: the next minute goes on.
    if (purge && !purge.more) this.#purgedAt = now
    const purged = purge?.purged ?? null
    if (stopped > 0 || (purged ?? 0) > 0)
      this.#logger.log(`project_trash stopped=${stopped} purged=${purged ?? 0}`)
    return { stopped, purged }
  }

  /** The chats of projects in the trash whose pass is queued or runs, pressed to stop. */
  async stopChats(): Promise<number> {
    const { db } = this.deps
    const projects = await db.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT p.id FROM projects p
      JOIN tasks t ON t.project_id = p.id
      WHERE p.deleted_at IS NOT NULL AND t.deleted_at IS NULL
        AND t.status::text = ANY(${[...projectBusyStatuses]}::text[])
      LIMIT ${BATCH}`
    let stopped = 0
    for (const { id } of projects) {
      stopped += await db.$transaction(async (tx) => {
        const chats = await lockProjectChats(tx, id)
        const [project] = await tx.$queryRaw<Array<{ created_by_id: string }>>`
          SELECT created_by_id FROM projects
          WHERE id = ${id}::uuid AND deleted_at IS NOT NULL
          FOR SHARE`
        // «Вернуть» came first: its chats go on.
        if (!project) return 0
        const pressed = await stopProjectChats(tx, {
          chats,
          statuses: projectBusyStatuses,
          authorId: project.created_by_id,
        })
        return pressed.length
      })
    }
    return stopped
  }

  /**
   * Projects past their day in the trash, purged a batch at a time. `more` — a project waits for its
   * chats to stop, or the batch was full: the sweep comes back on the next minute, not the next hour.
   */
  async purge(): Promise<{ purged: number; more: boolean }> {
    const { db } = this.deps
    const now = this.#now()
    const due = await projectsDueForPurge(db, now, BATCH)
    let purged = 0
    let waiting = 0
    for (const { id } of due) {
      const result = await purgeProject(db, { projectId: id, now })
      if (result.state === 'purged') purged++
      else if (result.state === 'stopping') waiting++
    }
    if (waiting > 0) this.#logger.log(`project_purge_waits projects=${waiting}`)
    return { purged, more: waiting > 0 || due.length === BATCH }
  }
}
