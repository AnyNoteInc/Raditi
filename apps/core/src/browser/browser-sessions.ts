import { setTimeout as pause } from 'node:timers/promises'

import { Logger } from '@nestjs/common'
import type { BrowserWorkerClient } from '@repo/browser-link'
import {
  clearBrowserHelp,
  closeBrowserSession,
  listOpenBrowserSessions,
  markBrowserSessionReady,
  openBrowserSession,
  openBrowserSessionOfTask,
  type PrismaClient,
} from '@repo/db'
import {
  browserTaskError,
  isBrowserSessionLive,
  isDomainError,
  type BrowserCloseReason,
  type BrowserSessionState,
  type TaskStatus,
} from '@repo/domain'

// The cloud browser of a task as core drives it (docs/plan/57-browser-tasks.md, Б10, Б18): it
// opens the session before a pass, asks the worker to check what the task saved on the site, closes
// the session with the task and compares the database with the worker. The worker owns Chromium
// and records what happens in a session; core owns when a session lives. Logs carry ids and codes
// only: never an address, a token or anything the worker answered.

/** A session younger than this may still be starting on the worker: the collector leaves it. */
export const BROWSER_ENSURE_GRACE_MS = 5 * 60_000

export interface BrowserSessionsDependencies {
  db: PrismaClient
  client: BrowserWorkerClient
  /** BROWSER_SESSION_MAX_HOURS: the hard deadline of a session core opens; the db default without. */
  maxHours?: number
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** What one pass of the collector did. */
export interface BrowserSweep {
  /** Sessions of ended tasks and past their deadline, closed. */
  closed: number
  /** Sessions the database holds open and the worker no longer has. */
  lost: number
  /** Sessions the worker holds that the database does not keep open. */
  orphaned: number
}

/** The close reason of a session whose task ended; null — the task goes on. */
export function closeReasonOfTask(status: TaskStatus | undefined): BrowserCloseReason | null {
  switch (status) {
    case undefined:
      return 'orphaned'
    case 'done':
      return 'task_done'
    case 'failed':
    case 'rolled_back':
      return 'task_failed'
    case 'cancelled':
      return 'task_cancelled'
    default:
      return null
  }
}

/** Only a code: messages of the worker client and the database stay out of the log. */
const codeOf = (error: unknown): string =>
  isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown'

/**
 * Pauses before asking a worker that did not answer for the same session again — it restarts,
 * a blip —: about 45 s in all, well inside the pass's own limits (ORPHAN_PREPARING_MS).
 */
export const ENSURE_RETRY_PAUSES_MS = [2_000, 8_000, 35_000] as const

/**
 * No answer, or a 5xx of a worker that stops or is full: the same session may be asked for again,
 * `ensure` is idempotent by its id. A timeout (a cold start may take its whole limit) and a 4xx
 * refusal are answers of their own.
 */
const unanswered = (error: unknown): boolean => {
  if (!isDomainError(error)) return false
  const details = error.details as { failure?: string; status?: number } | undefined
  return (
    details?.failure === 'unreachable' ||
    details?.failure === 'status' ||
    (details?.failure === 'refused' && (details.status ?? 0) >= 500)
  )
}

export class BrowserSessions {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: BrowserSessionsDependencies) {
    this.#logger = deps.logger ?? new Logger('BrowserSessions')
    this.#now = deps.now ?? (() => new Date())
  }

  /**
   * The live session of the task before its pass (Б16, Б18): opened in the database when it has
   * none, then started or found on the worker, which takes control back for the agent. A request
   * for help the agent made is answered by this pass and is cleared. Any failure is
   * BROWSER_SESSION_UNAVAILABLE — the pass is refused `unavailable` —, except the caller's own
   * cancellation, which rejects with its reason. A session a worker lost (it restarted: the worker
   * closes the row `lost` and refuses) is replaced by a new one once — the client signs in again
   * there, the task goes on (Б18). A worker that did not answer while the row is still open (it
   * restarts, a blip) is asked again for the same session after a pause, up to three times.
   */
  async ensure(taskId: string, signal: AbortSignal): Promise<void> {
    const { db, client, maxHours } = this.deps
    try {
      // The worker reads the site's address and stack itself; its notes reach the agent in the
      // prompt of the turn (turn-planner), never through the worker.
      const task = await db.task.findUnique({ where: { id: taskId }, select: { siteId: true } })
      if (!task) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
      let retries = 0
      let replaced = false
      for (;;) {
        const session = await openBrowserSession(db, {
          taskId,
          ...(maxHours === undefined ? {} : { maxHours }),
        })
        let state: BrowserSessionState
        try {
          state = await client.ensure(
            {
              sessionId: session.id,
              taskId,
              siteId: task.siteId,
              takeControl: true,
            },
            { signal },
          )
        } catch (error) {
          if (signal.aborted) throw error
          const open = await openBrowserSessionOfTask(db, taskId)
          if (open?.id === session.id) {
            // The worker did not answer for a session it may still start: the same one, again.
            const wait = unanswered(error) ? ENSURE_RETRY_PAUSES_MS[retries++] : undefined
            if (wait === undefined) throw error
            this.#logger.warn(`browser_ensure_retried task=${taskId} cause=${codeOf(error)}`)
            await pause(wait, undefined, { signal }).catch(() => {
              throw signal.reason
            })
            continue
          }
          if (replaced) throw error
          replaced = true
          this.#logger.warn(`browser_ensure_replaced task=${taskId} cause=${codeOf(error)}`)
          continue
        }
        if (!isBrowserSessionLive(state.status))
          throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
        if (state.status === 'ready') await markBrowserSessionReady(db, { sessionId: session.id })
        await clearBrowserHelp(db, { sessionId: session.id })
        return
      }
    } catch (error) {
      if (signal.aborted) throw error
      this.#logger.warn(`browser_ensure_failed task=${taskId} cause=${codeOf(error)}`)
      throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    }
  }

  /**
   * Asks the worker to read every checkpoint of the task again on the site (Б22–Б24); it records
   * what it found. Best effort: false — no live session, or the worker did not answer, and the
   * last recorded state stands.
   */
  async verify(taskId: string): Promise<boolean> {
    try {
      const session = await openBrowserSessionOfTask(this.deps.db, taskId)
      if (!session) return false
      await this.deps.client.verify(session.id)
      return true
    } catch (error) {
      this.#logger.warn(`browser_verify_failed task=${taskId} cause=${codeOf(error)}`)
      return false
    }
  }

  /**
   * The task ended (Б18): its live session is closed in the database, then on the worker —
   * containers and files go. Best effort, never throws: the collector closes what is left.
   */
  async close(taskId: string, reason: BrowserCloseReason): Promise<void> {
    try {
      const session = await openBrowserSessionOfTask(this.deps.db, taskId)
      if (session) await this.#close(session.id, reason)
    } catch (error) {
      this.#logger.warn(`browser_close_failed task=${taskId} cause=${codeOf(error)}`)
    }
  }

  /**
   * The collector (Б18): sessions of ended tasks and past their deadline are closed — the worker
   * also expires its own —, those the worker no longer has are `lost`, those it holds and the
   * database does not keep open are closed on it. The worker's list is read before the
   * database's, so a session opened meanwhile is never taken for an orphan; one younger than
   * BROWSER_ENSURE_GRACE_MS, or of a task `busy` reports (its pass is at work in this process),
   * is never taken for lost.
   */
  async sweep(options: { busy?: (taskId: string) => boolean } = {}): Promise<BrowserSweep> {
    const { db, client } = this.deps
    const busy = options.busy ?? (() => false)
    const counts: BrowserSweep = { closed: 0, lost: 0, orphaned: 0 }
    let held: Set<string> | null = null
    let workerLive: string[] = []
    try {
      const listed = await client.list()
      workerLive = listed.sessions
        .filter((session) => isBrowserSessionLive(session.status))
        .map((session) => session.sessionId)
      held = new Set(workerLive)
    } catch (error) {
      // Without the worker's list nothing is taken for lost or orphaned in this pass.
      this.#logger.warn(`browser_sweep_list_failed cause=${codeOf(error)}`)
    }
    const open = await listOpenBrowserSessions(db)
    const tasks = open.length
      ? await db.task.findMany({
          where: { id: { in: [...new Set(open.map((session) => session.taskId))] } },
          select: { id: true, status: true },
        })
      : []
    const statusOf = new Map(tasks.map((task) => [task.id, task.status]))
    const now = this.#now().getTime()
    for (const session of open) {
      try {
        const ended = closeReasonOfTask(statusOf.get(session.taskId))
        if (ended || session.expiresAt.getTime() <= now) {
          await this.#close(session.id, ended ?? 'expired')
          counts.closed++
        } else if (
          held &&
          !held.has(session.id) &&
          !busy(session.taskId) &&
          now - session.createdAt.getTime() >= BROWSER_ENSURE_GRACE_MS
        ) {
          // The worker lost it (a restart, a crash): the client signs in again in a new one.
          await closeBrowserSession(db, {
            sessionId: session.id,
            status: 'lost',
            reason: 'crashed',
          })
          counts.lost++
        }
      } catch (error) {
        this.#logger.warn(
          `browser_sweep_session_failed task=${session.taskId} cause=${codeOf(error)}`,
        )
      }
    }
    const kept = new Set(open.map((session) => session.id))
    for (const sessionId of workerLive) {
      if (kept.has(sessionId)) continue
      try {
        await client.close(sessionId, { reason: 'orphaned' })
        counts.orphaned++
      } catch (error) {
        this.#logger.warn(`browser_sweep_orphan_failed cause=${codeOf(error)}`)
      }
    }
    if (counts.closed + counts.lost + counts.orphaned > 0)
      this.#logger.log(
        `browser_sweep closed=${counts.closed} lost=${counts.lost} orphaned=${counts.orphaned}`,
      )
    return counts
  }

  /** The database first — admission ends at once —, then the worker, whose failure is logged. */
  async #close(sessionId: string, reason: BrowserCloseReason): Promise<void> {
    await closeBrowserSession(this.deps.db, { sessionId, status: 'closed', reason })
    await this.deps.client.close(sessionId, { reason }).catch((error: unknown) => {
      this.#logger.warn(`browser_close_worker_failed session=${sessionId} cause=${codeOf(error)}`)
    })
  }
}
