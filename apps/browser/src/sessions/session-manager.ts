import {
  browserEnsureResponseSchema,
  browserSessionTimings,
  browserTaskError,
  conflict,
  isBrowserSessionLive,
  notFound,
  OPEN_WEB_OBJECTS,
  OPEN_WEB_POLICY,
  type BrowserActionRequest,
  type BrowserCloseReason,
  type BrowserEnsureRequest,
  type BrowserListResponse,
  type BrowserSessionState,
  type BrowserSessionStatus,
  type BrowserToolResult,
  type BrowserVerifyResponse,
  withTimeout,
} from '@repo/domain'

import type { BrowserWorkerMetrics } from '../metrics/worker-metrics.ts'
import {
  WorkerSession,
  type SessionContext,
  type SessionSettings,
  type SessionSpec,
} from './worker-session.ts'

export interface SessionManagerSettings extends SessionSettings {
  idleMinutes: number
  /** How long the sweep waits for the row of an idle session before it closes it anyway. */
  activityReadMs: number
  maxHours: number
  maxSessions: number
  /** BROWSER_PLATFORM_HOSTS: names of the platform no page of any session reaches (К37). */
  platformHosts: readonly string[]
  /** PAGES_BASE_DOMAIN: the agent's published pages open in every session (Ст26). */
  pageDomain: string | null
}

/** Defaults of the timings a session needs besides the configuration. */
export const sessionTimingDefaults = Object.freeze({
  agentActionTimeoutMs: browserSessionTimings.agentActionTimeoutMs,
  // Within the 45 s the mcp client gives an action, so the agent hears the worker's own code.
  actionBudgetMs: 40_000,
  queueWaitMs: 20_000,
  // Within the 40 s the client gives a check.
  verifyBudgetMs: 35_000,
  touchEveryMs: 60_000,
  // Well within the sweep (15 s): a row read that hangs never holds the closing of the others.
  activityReadMs: 5_000,
})

export interface SessionManagerDeps extends Omit<
  SessionContext,
  'settings' | 'metrics' | 'runtime'
> {
  /** null — the images are not configured (outside production): every session is unavailable. */
  runtime: SessionContext['runtime'] | null
  settings: SessionManagerSettings
  metrics: BrowserWorkerMetrics
}

const HOUR_MS = 3_600_000
/**
 * How long before its deadline a session looks whether its turn moved its row on (plan 70, ВР20):
 * enough sweeps for a lease to be written before the watchdog's deadline.
 */
const EXTEND_AHEAD_MS = 10 * 60_000

/** `ensure` as this worker reads it: a saved sign-in the caller may still send is never taken. */
type EnsuredSession = Omit<BrowserEnsureRequest, 'signIn'>

/** Where a session's browser may go and what it knows about its pages. */
type SessionPlace = Pick<
  SessionSpec,
  'openWeb' | 'adapter' | 'policy' | 'allowedHosts' | 'startUrl'
>

/**
 * The browser of a chat (docs/plan/61-chats-first.md, К12; docs/plan/83-remove-projects.md, БП9):
 * an empty page, no host of its own, no sign-in, no policy and no object — every public https site
 * opens.
 */
const OPEN_WEB: SessionPlace = Object.freeze({
  openWeb: true,
  adapter: OPEN_WEB_OBJECTS,
  policy: OPEN_WEB_POLICY,
  allowedHosts: [],
  startUrl: null,
})

/**
 * The sessions of this worker (docs/plan/57-browser-tasks.md, §3.5, Б18): the ones core starts on
 * the agent's first `web_*` call (docs/plan/61-chats-first.md, К11), gives back with the next turn
 * and closes with the task, idle ones closed after `idleMinutes`, every one at its
 * hard deadline. In memory only: a worker that restarts holds none, and the sessions it held
 * are lost (core's collector marks them; an `ensure` of one says so at once).
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps
  readonly #context: SessionContext | null
  readonly #sessions = new Map<string, WorkerSession>()
  readonly #starting = new Map<string, Promise<WorkerSession>>()
  #stopping = false

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps
    const runtime = deps.runtime
    this.#context = runtime && {
      runtime,
      browsers: deps.browsers,
      store: deps.store,
      files: deps.files,
      screenshots: deps.screenshots,
      metrics: deps.metrics,
      settings: deps.settings,
      now: deps.now,
      warn: deps.warn,
    }
  }

  /** Whether sessions can be started here at all (the runtime is configured). */
  get configured(): boolean {
    return this.#context !== null
  }

  get size(): number {
    return this.#sessions.size
  }

  get viewers(): number {
    let count = 0
    for (const session of this.#sessions.values()) count += session.viewerCount
    return count
  }

  /** A live session this worker holds, for the stream; null — none. */
  session(sessionId: string): WorkerSession | null {
    const session = this.#sessions.get(sessionId.toLowerCase())
    return session?.live ? session : null
  }

  /** `POST /v1/sessions/ensure`. */
  async ensure(input: BrowserEnsureRequest): Promise<BrowserSessionState> {
    // Ids as PostgreSQL spells them: the session of another spelling is the same session.
    const { signIn: _signIn, ...rest } = input
    const request: EnsuredSession = {
      ...rest,
      sessionId: input.sessionId.toLowerCase(),
      taskId: input.taskId.toLowerCase(),
      siteId: input.siteId?.toLowerCase() ?? null,
    }
    const session = await this.#held(request)
    if (!session.live) {
      // Ending here (idle, expired, crashed): its row is closed only once the containers are
      // gone. Answered after that, the next `web_*` call opens a new session (К11).
      await session.ending?.catch(() => undefined)
      throw conflict('The browser session is closed')
    }
    // A pass of the task is about to use it: an idle sweep reading its row meanwhile keeps it.
    session.noteActivity(this.#deps.now())
    if (request.takeControl) session.agentTakesControl()
    return browserEnsureResponseSchema.parse(session.state())
  }

  async #held(request: EnsuredSession): Promise<WorkerSession> {
    const id = request.sessionId
    const known = this.#sessions.get(id) ?? (await this.#starting.get(id))
    if (known) {
      if (known.taskId !== request.taskId || known.siteId !== request.siteId)
        throw conflict('The browser session belongs to another task')
      return known
    }
    const starting = this.#create(request)
    this.#starting.set(id, starting)
    try {
      return await starting
    } finally {
      this.#starting.delete(id)
    }
  }

  async #create(request: EnsuredSession): Promise<WorkerSession> {
    const context = this.#context
    const { store, settings, now } = this.#deps
    if (this.#stopping || context === null) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    // A session that starts is in both maps until its start is over.
    if (new Set([...this.#sessions.keys(), ...this.#starting.keys()]).size >= settings.maxSessions)
      throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    const row = await store.session(request.sessionId)
    if (!row || row.taskId !== request.taskId || row.siteId !== request.siteId)
      throw notFound('Browser session not found')
    // A session of a site is no longer served: there are no projects (plan 83, БП1).
    if (row.siteId !== null || row.taskSiteId !== null)
      throw conflict('The browser session is not of a chat')
    if (!isBrowserSessionLive(row.status)) throw conflict('The browser session is closed')
    if (row.readyAt !== null) {
      // Another worker process started it and is gone with its sign-in (Б18).
      await store.close({
        sessionId: row.id,
        status: 'lost',
        reason: 'crashed',
        errorCode: 'WORKER_RESTARTED',
      })
      await context.runtime.stop(row.id).catch(() => undefined)
      throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    }
    // One live session per task: one the database has replaced is not this worker's either.
    for (const other of this.#sessions.values())
      if (other.taskId === request.taskId) await other.close('orphaned')

    const deadline = Math.min(row.expiresAt.getTime(), now() + settings.maxHours * HOUR_MS)
    if (deadline <= now()) throw conflict('The browser session has expired')
    const session = new WorkerSession(
      {
        ...OPEN_WEB,
        id: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        platformHosts: settings.platformHosts,
        pageDomain: settings.pageDomain,
        deadline,
        checkpoints: await store.checkpoints(row.taskId),
      },
      context,
      (ended) => {
        if (this.#sessions.get(ended.id) === ended) this.#sessions.delete(ended.id)
      },
    )
    this.#sessions.set(session.id, session)
    await session.start()
    return session
  }

  /** `POST /v1/sessions/:id/close`; a session this worker does not hold is closed in the database. */
  async close(
    sessionId: string,
    reason: BrowserCloseReason,
  ): Promise<{ sessionId: string; status: BrowserSessionStatus }> {
    const held =
      this.#sessions.get(sessionId) ?? (await this.#starting.get(sessionId)?.catch(() => null))
    if (held) return { sessionId, status: await held.close(reason) }
    const { store } = this.#deps
    const row = await store.session(sessionId)
    if (!row) throw notFound('Browser session not found')
    let status = row.status
    if (isBrowserSessionLive(status)) {
      const closed = await store.close({
        sessionId,
        status: reason === 'crashed' || reason === 'shutdown' ? 'lost' : 'closed',
        reason,
      })
      status = closed?.status ?? status
    }
    // What a worker before this one left behind; the watchdog would reap it at the deadline.
    await this.#context?.runtime.stop(sessionId).catch(() => undefined)
    return { sessionId, status }
  }

  /** `POST /v1/sessions/:id/verify`. */
  async verify(sessionId: string): Promise<BrowserVerifyResponse> {
    const session = this.session(sessionId)
    if (!session) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    return { checkpoints: await session.verify() }
  }

  /** `POST /v1/sessions/:id/actions`: the session must be the task's. */
  async act(sessionId: string, request: BrowserActionRequest): Promise<BrowserToolResult> {
    const session = this.session(sessionId.toLowerCase())
    if (!session || session.taskId !== request.taskId.toLowerCase()) {
      this.#deps.metrics.action(request.action.tool, 'BROWSER_SESSION_UNAVAILABLE')
      throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    }
    return session.act(request.action)
  }

  /** `GET /v1/sessions`. */
  list(): BrowserListResponse {
    return {
      sessions: [...this.#sessions.values()]
        .filter((session) => session.live)
        .map((session) => ({
          sessionId: session.id,
          taskId: session.taskId,
          status: session.status,
        })),
    }
  }

  /**
   * Every `sweepMs`: a session past its deadline is closed `expired`, one nobody acted in or
   * watched for `idleMinutes` — `idle` (`#closeIfIdle`), one whose browser is gone — lost.
   */
  async sweep(): Promise<void> {
    const { now, settings } = this.#deps
    const idleMs = settings.idleMinutes * 60_000
    const ends: Promise<unknown>[] = []
    for (const session of [...this.#sessions.values()]) {
      if (!session.live) continue
      session.keepAliveWhileWatched()
      if (now() >= session.deadline - EXTEND_AHEAD_MS) ends.push(this.#extendOrExpire(session))
      else if (!session.connected()) ends.push(session.close('crashed'))
      else if (session.status === 'ready' && now() - session.lastActivity >= idleMs)
        ends.push(this.#closeIfIdle(session, idleMs))
    }
    await Promise.allSettled(ends)
  }

  /**
   * A session idle here may still be looked at: the chat of its task counts as watching its browser
   * (owner's answer of 30.10.2026, docs/plan/59, И18), and the cabinet records the client looking at
   * the dialog in the session's row. Closed `idle` only when the row says nobody looked either, and
   * nothing was done here while it was read. A read that fails or hangs past `activityReadMs` counts
   * for nothing: the session closes as it did before, and the sweep is never held by it.
   */
  async #closeIfIdle(session: WorkerSession, idleMs: number): Promise<unknown> {
    const { now, store, warn, settings } = this.#deps
    try {
      const row = await withTimeout(
        store.session(session.id),
        settings.activityReadMs,
        'the activity of a browser session was not read in time',
      )
      // A look recorded on a row that still holds a browser; a closed one says nothing.
      if (row !== null && isBrowserSessionLive(row.status))
        session.noteActivity(row.lastActivityAt.getTime())
    } catch (error) {
      warn('browser_activity_not_read', error)
    }
    if (session.status !== 'ready' || now() - session.lastActivity < idleMs) return
    return session.close('idle')
  }

  /**
   * A session near its deadline lives on while its turn does: core moves the row's `expires_at`
   * with every renewal of the turn (plan 70, ВР20). At most `maxHours` from now at a time; past
   * the deadline without a later row, or when the extension fails then, it is closed `expired`.
   */
  async #extendOrExpire(session: WorkerSession): Promise<unknown> {
    const { now, store, warn, settings } = this.#deps
    try {
      const row = await withTimeout(
        store.session(session.id),
        settings.activityReadMs,
        'the deadline of a browser session was not read in time',
      )
      if (row !== null && isBrowserSessionLive(row.status)) {
        const until = Math.min(row.expiresAt.getTime(), now() + settings.maxHours * HOUR_MS)
        if (until > session.deadline) await session.extend(until)
      }
    } catch (error) {
      warn('browser_deadline_not_extended', error)
    }
    if (now() >= session.deadline) return session.close('expired')
  }

  /** At start: no session survives a restart, so what an earlier process left goes. */
  async removeLeftovers(): Promise<void> {
    const runtime = this.#context?.runtime
    if (!runtime) return
    try {
      for (const sessionId of await runtime.list())
        if (!this.#sessions.has(sessionId)) await runtime.stop(sessionId)
    } catch (error) {
      this.#deps.warn('browser_leftovers_not_removed', error)
    }
  }

  /** The worker stops: every session ends, and with it the sign-in in it (Б18, Б19). */
  async shutdown(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled([...this.#starting.values()])
    await Promise.allSettled(
      [...this.#sessions.values()].map((session) => session.close('shutdown')),
    )
  }
}
