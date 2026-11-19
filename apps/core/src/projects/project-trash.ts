import { Logger } from '@nestjs/common'
import {
  deleteExpiredProjectFile,
  deleteProjectFileRow,
  listExpiredProjectFiles,
  lockProjectChats,
  pauseSchedulesOfGoneProject,
  projectBusyStatuses,
  projectFileKeys,
  projectsDueForPurge,
  projectsWithRunningSchedules,
  purgeProject,
  stopProjectChats,
  type PrismaClient,
} from '@repo/db'
import type { ObjectStorage } from '@repo/domain'

const BATCH = 20
const FILE_BATCH = 100

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

export interface ProjectTrashDependencies {
  db: PrismaClient
  /**
   * raditi-inbox, where the files of the context lie (docs/plan/84-projects.md, ПР8): files no
   * project took are collected, and the files of a purged project go before it. Absent — neither:
   * a project with files then waits.
   */
  storage?: Pick<ObjectStorage, 'delete'> | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

export interface ProjectTrashSweep {
  /** Chats of projects in the trash pressed to stop on this sweep. */
  stopped: number
  /** Projects purged. */
  purged: number
  /** Files no project took, collected after their day (ПР8). */
  collected: number
  /** Scheduled tasks of projects in «Архив» or the trash stopped on this sweep (ПР19). */
  paused: number
}

/**
 * The trash of projects in core (docs/plan/84-projects.md, ПР20; slice 84.5), a pass of the sweep
 * of chats (TaskSweep, every minute):
 * - a chat of a project in the trash whose pass is queued or runs is stopped — the second line
 *   after «Удалить», which presses them in its own transaction (`trashProject`): a chat queued
 *   there by a race with it is stopped here;
 * - the projects past `purge_after` are purged (`purgeProject`): only their chats stay, deleted. A
 *   project with a chat that has not ended presses it and waits for the next sweep. Every sweep
 *   looks — one query on `projects_purge_idx` — so a project the client deleted for good from the
 *   trash («Удалить навсегда», ПР38) goes within a minute, not within the hour.
 *
 * - files of the context no project took within their day are collected, and the files of a
 *   project being purged go before it: their objects in raditi-inbox, then their rows (ПР8).
 *
 * - the scheduled tasks of a project in «Архив» or in the trash that still run are stopped
 *   (`project_gone`, ПР19) — the second line after «В архив» and «Удалить», which stop them in
 *   their own transaction.
 *
 * Every write is conditional under the lock of its rows, so two cores sweep side by side.
 */
export class ProjectTrash {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ProjectTrashDependencies) {
    this.#logger = deps.logger ?? new Logger('ProjectTrash')
    this.#now = deps.now ?? (() => new Date())
  }

  async sweep(): Promise<ProjectTrashSweep> {
    const stopped = await this.stopChats()
    const paused = await this.pauseSchedules()
    const collected = await this.collectFiles()
    // A chat still stopping, or more projects than a batch: the next sweep, a minute on, goes on.
    const purged = await this.purge()
    if (stopped > 0 || purged > 0 || collected > 0 || paused > 0)
      this.#logger.log(
        `project_trash stopped=${stopped} purged=${purged} files_collected=${collected} schedules_paused=${paused}`,
      )
    return { stopped, purged, collected, paused }
  }

  /** The scheduled tasks of projects put away that still run, stopped a project at a time (ПР19). */
  async pauseSchedules(): Promise<number> {
    const { db } = this.deps
    let paused = 0
    for (const id of await projectsWithRunningSchedules(db, BATCH))
      paused += await pauseSchedulesOfGoneProject(db, id)
    return paused
  }

  /**
   * Files of the context no project took within their day (ПР8), a batch at a time: the object
   * first, then the row. A delete that fails leaves the row for the next sweep; S3 deletes a missing
   * key without an error, so a repeat after a stop between the two only removes the row.
   */
  async collectFiles(): Promise<number> {
    const { db, storage } = this.deps
    if (!storage) return 0
    let removed = 0
    for (const file of await listExpiredProjectFiles(db, { limit: FILE_BATCH })) {
      try {
        await storage.delete('inbox', file.key)
        if (await deleteExpiredProjectFile(db, { id: file.id })) removed++
      } catch (error) {
        this.#logger.warn(`project_file_collect_failed ${errorName(error)}`)
      }
    }
    return removed
  }

  /**
   * The objects of the files of a project past its day, then their rows: purgeProject() would drop
   * the rows by cascade and leave the objects. false — a file is left (no storage, or a delete
   * failed): the project waits. Its day is over, so «Вернуть» can no longer bring the files back.
   */
  async #dropFiles(projectId: string): Promise<boolean> {
    const { db, storage } = this.deps
    for (;;) {
      const files = await projectFileKeys(db, { projectId, limit: FILE_BATCH })
      if (files.length === 0) return true
      if (!storage) return false
      for (const file of files) {
        try {
          await storage.delete('inbox', file.key)
          await deleteProjectFileRow(db, { id: file.id })
        } catch (error) {
          this.#logger.warn(`project_file_purge_failed ${errorName(error)}`)
          return false
        }
      }
    }
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
   * Projects past their day in the trash, purged a batch at a time; how many went. A project that
   * waits for its chats to stop or for its files, and those past a full batch, are left for the
   * next sweep.
   */
  async purge(): Promise<number> {
    const { db } = this.deps
    const now = this.#now()
    const due = await projectsDueForPurge(db, now, BATCH)
    let purged = 0
    let waiting = 0
    for (const { id } of due) {
      if (!(await this.#dropFiles(id))) {
        waiting++
        continue
      }
      const result = await purgeProject(db, { projectId: id, now })
      if (result.state === 'purged') purged++
      else if (result.state === 'stopping') waiting++
    }
    if (waiting > 0) this.#logger.log(`project_purge_waits projects=${waiting}`)
    return purged
  }
}
