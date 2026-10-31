import { setTimeout as pause } from 'node:timers/promises'

import { Logger } from '@nestjs/common'
import type { BrowserWorkerClient } from '@repo/browser-link'
import {
  clearBrowserHelp,
  closeBrowserSession,
  listOpenBrowserSessions,
  markBrowserSessionReady,
  openBrowserSessionOfTask,
  type PrismaClient,
} from '@repo/db'
import {
  browserTaskError,
  isBrowserSessionLive,
  isDomainError,
  type BrowserCloseReason,
  type BrowserEnsureJob,
  type BrowserSignIn,
  type TaskStatus,
} from '@repo/domain'

// The cloud browser of a task as core drives it (docs/plan/57-browser-tasks.md, Б10, Б18;
// docs/plan/61-chats-first.md, К11): it starts a session the agent asked for, gives a live one back
// to the agent when a turn starts, asks the worker to check what the task saved on the site, closes
// the session with the task and compares the database with the worker. The worker owns Chromium
// and records what happens in a session; core owns when a session lives. Logs carry ids and codes
// only: never an address, a token or anything the worker answered.

/** A session younger than this may still be starting on the worker: the collector leaves it. */
export const BROWSER_ENSURE_GRACE_MS = 5 * 60_000

export interface BrowserSessionsDependencies {
  db: PrismaClient
  client: BrowserWorkerClient
  /** The site's saved sign-in (`readSiteSignIn`, Б36); none — the client signs in by hand. */
  signIn?: (siteId: string) => Promise<BrowserSignIn | null>
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
 * a blip —: about 45 s in all, well inside the 5 minutes the collector gives a starting session.
 */
export const ENSURE_RETRY_PAUSES_MS = [2_000, 8_000, 35_000] as const

/** `browser_sessions.error_code` of a session core could not start. */
export const BROWSER_START_FAILED = 'BROWSER_START_FAILED'

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
   * The start of a session the first `web_*` call of a turn asked for (docs/plan/61-chats-first.md,
   * К11, job `browser.ensure`). A row already `ready`, closed or of another task is left alone: a
   * job that comes late never touches a browser at work. The worker is asked without taking
   * control and nothing here clears a request for help: a client in the middle of signing in stays
   * there. A worker that did not answer while the row is still `starting` (it restarts, a blip) is
   * asked again after a pause, up to three times; a row that became `ready` meanwhile lost only its
   * answer, and stays. A failure closes a row still `starting` as `failed`, and the call that waits
   * for it tells the agent. The site's saved sign-in goes with the request (Б36); one that cannot be
   * read is left out — the client signs in by hand. `signal` is the shutdown of core: the row stays,
   * and the next `web_*` call puts the job again. Never throws: the row says the end.
   */
  async start(job: BrowserEnsureJob, signal: AbortSignal): Promise<void> {
    const { db, client } = this.deps
    const { sessionId, taskId } = job
    try {
      const session = await db.browserSession.findUnique({
        where: { id: sessionId },
        select: { taskId: true, status: true },
      })
      if (session?.taskId !== taskId || session.status !== 'starting') return
      const siteId = await this.#siteOf(taskId)
      const signIn = await this.#signIn(siteId)
      for (let retries = 0; ;) {
        try {
          const state = await client.ensure(
            {
              sessionId,
              taskId,
              siteId,
              takeControl: false,
              ...(signIn ? { signIn } : {}),
            },
            { signal },
          )
          if (!isBrowserSessionLive(state.status))
            throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
          if (state.status === 'ready') await markBrowserSessionReady(db, { sessionId })
          return
        } catch (error) {
          if (signal.aborted) throw error
          const open = await openBrowserSessionOfTask(db, taskId)
          // The row closed meanwhile (the worker said so, the task ended), or the worker's answer
          // was lost and it started the browser all the same: nothing left to start.
          if (open?.id !== sessionId || open.status !== 'starting') return
          const wait = unanswered(error) ? ENSURE_RETRY_PAUSES_MS[retries++] : undefined
          if (wait === undefined) throw error
          this.#logger.warn(`browser_ensure_retried task=${taskId} cause=${codeOf(error)}`)
          await pause(wait, undefined, { signal })
        }
      }
    } catch (error) {
      if (signal.aborted) return
      this.#logger.warn(`browser_ensure_failed task=${taskId} cause=${codeOf(error)}`)
      await closeBrowserSession(db, {
        sessionId,
        status: 'failed',
        reason: 'crashed',
        errorCode: BROWSER_START_FAILED,
        onlyStarting: true,
      }).catch(() => this.#logger.warn(`browser_ensure_not_closed task=${taskId}`))
    }
  }

  /**
   * A turn starts (Б16): the live session of the task, if it has one, comes back to the agent, and
   * the request for help the agent made is answered by this pass. The only call that takes control,
   * and it opens nothing: a turn that needs no browser starts none. The site's saved sign-in goes
   * with it (Б36). A failure is logged and the turn goes on: a `web_*` call meets the same state and
   * says what it means.
   */
  async reclaim(taskId: string, signal: AbortSignal): Promise<void> {
    const { db, client } = this.deps
    try {
      const session = await openBrowserSessionOfTask(db, taskId)
      if (!session) return
      const siteId = await this.#siteOf(taskId)
      const signIn = await this.#signIn(siteId)
      const state = await client.ensure(
        {
          sessionId: session.id,
          taskId,
          siteId,
          takeControl: true,
          ...(signIn ? { signIn } : {}),
        },
        { signal },
      )
      if (!isBrowserSessionLive(state.status)) return
      if (state.status === 'ready') await markBrowserSessionReady(db, { sessionId: session.id })
      await clearBrowserHelp(db, { sessionId: session.id })
    } catch (error) {
      if (!signal.aborted)
        this.#logger.warn(`browser_reclaim_failed task=${taskId} cause=${codeOf(error)}`)
    }
  }

  /**
   * The site of the task, null in a chat without one: the worker reads its address itself, by this
   * id, and checks it against the session's row.
   */
  async #siteOf(taskId: string): Promise<string | null> {
    const task = await this.deps.db.task.findUnique({
      where: { id: taskId },
      select: { siteId: true },
    })
    if (!task) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    return task.siteId
  }

  /**
   * The saved sign-in, or none when it is not set or cannot be read now: never thrown. A chat
   * without a site has none (rule 2).
   */
  async #signIn(siteId: string | null): Promise<BrowserSignIn | null> {
    if (siteId === null) return null
    try {
      return (await this.deps.signIn?.(siteId)) ?? null
    } catch (error) {
      this.#logger.warn(`browser_sign_in_unread site=${siteId} cause=${codeOf(error)}`)
      return null
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
