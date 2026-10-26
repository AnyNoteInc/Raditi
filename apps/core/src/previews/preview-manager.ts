import { Logger } from '@nestjs/common'
import { enqueuePreviewSync, markStaleCandidates } from '@repo/db'
import {
  isDomainError,
  terminalTaskStatuses,
  type TurnCredentialSource,
  type TurnExecutor,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import {
  buildPreview,
  destroyPreview,
  expirePreview,
  failBuild,
  previewSiteFacts,
  PreviewLater,
  PreviewUnavailable,
  type BuiltPreview,
  type PreviewBuildDeps,
} from './preview-builder.ts'
import {
  idleBrowsers,
  previewBrowserErrorCode,
  PreviewBrowserRefused,
  startPreviewBrowser,
  stopPreviewBrowser,
} from './preview-browser.ts'
import { runCandidateChecks } from './preview-checks.ts'
import {
  loadPreviewFacts,
  previewAction,
  previewLastUseSql,
  type PreviewFacts,
} from './preview-facts.ts'
import { claimPreview, PreviewHold, previewLeaseTimings, releasePreview } from './preview-lease.ts'
import {
  previewSyncErrorCode,
  PreviewSyncRefused,
  syncWorkingTree,
  type PreviewSyncGit,
} from './preview-sync.ts'

// The manager of previews in the core role (docs/plan/53-chat-preview-release.md, R5c): every
// job of the `previews` queue, every request row of the mcp role (which has no Redis) and the
// sweep come here. One core works on one preview at a time — the hold of its row (preview-
// lease.ts); a job for a preview another core holds is not lost: the holder sees the counter of
// requests move and goes on. Logs carry ids and codes only.

export interface PreviewManagerDeps extends PreviewBuildDeps {
  git: PreviewSyncGit | null
  executor: Pick<TurnExecutor, 'exportWorkingTree'>
  credentials: Pick<TurnCredentialSource, 'recover'>
}

export const previewManagerTimings = Object.freeze({
  /** A sync request waits this long for the preview another work holds; then `busy`. */
  syncWaitMs: 30_000,
  /** A browser request waits this long, a first build included; then `busy`. */
  browserWaitMs: 5 * 60_000,
  /** A preview the site's lease keeps from a new seed is asked again after this. */
  laterMs: 30_000,
  /** The sweep leaves a row alone this long after its last change: a job may be on its way. */
  settleSeconds: 60,
  /** A view of a stopped preview this recent still wants it built. */
  viewedSeconds: 10 * 60,
  /**
   * Builds the sweep starts at once, each beside the sweep: a build takes minutes, and the sweep
   * stops idle browsers and moves times to live meanwhile. More due previews wait for its next
   * pass.
   */
  sweepBuilds: 2,
})

const SWEEP_BATCH = 50
/** A temporary database of a dump younger than this is left to the build that made it. */
const STAGING_GRACE_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Work =
  | { kind: 'refresh'; requested: boolean; lost?: boolean }
  | { kind: 'sync'; requestId: string; assignmentId: string | null }
  | { kind: 'browser'; requestId: string; assignmentId: string | null }
  | { kind: 'stopBrowser' }

/** The row moved under the holder (previewLeaseLost): nothing more is written. */
const isLeaseLost = (error: unknown) =>
  isDomainError(error) &&
  error.code === 'PREVIEW_BUILD_FAILED' &&
  (error.details as { code?: unknown } | undefined)?.code === 'lease_lost'

/** Only a code: messages of storage, database and Docker errors stay out of the log. */
const logged = (error: unknown) =>
  new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown')

export class PreviewManager {
  readonly #logger = new Logger(PreviewManager.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  /** Previews this process works on now: a second job for one of them waits for the next tick. */
  readonly #working = new Set<string>()
  /** Refreshes the sweep started and does not wait for. */
  readonly #detached = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: PreviewManagerDeps,
    private readonly options: { heartbeatMs?: number } = {},
  ) {}

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /**
   * A job of `preview.sync`, or the sweep: brings the preview to what it should be now. false —
   * another work holds it (this process or another core) and will see the request.
   */
  refresh(previewId: string, options: { requested: boolean; lost?: boolean }): Promise<boolean> {
    return this.#run(previewId, { kind: 'refresh', ...options })
  }

  /** A pending row of `preview_sync_requests`; false — not served yet, ask again later. */
  async serveSync(requestId: string): Promise<boolean> {
    const row = await this.deps.db.previewSyncRequest.findUnique({
      where: { id: requestId },
      select: { previewId: true, assignmentId: true, completedAt: true, requestedAt: true },
    })
    if (!row || row.completedAt) return true
    const served = await this.#run(row.previewId, {
      kind: 'sync',
      requestId,
      assignmentId: row.assignmentId,
    })
    if (!served && this.#waited(row.requestedAt, previewManagerTimings.syncWaitMs))
      await this.#refuseSync(requestId, 'busy')
    return served
  }

  /** A pending row of `preview_browser_requests`; false — not served yet, ask again later. */
  async serveBrowser(requestId: string): Promise<boolean> {
    const row = await this.deps.db.previewBrowserRequest.findUnique({
      where: { id: requestId },
      select: {
        previewId: true,
        assignmentId: true,
        readyAt: true,
        stoppedAt: true,
        errorCode: true,
        requestedAt: true,
      },
    })
    if (!row || row.readyAt || row.stoppedAt || row.errorCode) return true
    const served = await this.#run(row.previewId, {
      kind: 'browser',
      requestId,
      assignmentId: row.assignmentId,
    })
    if (!served && this.#waited(row.requestedAt, previewManagerTimings.browserWaitMs))
      await this.#refuseBrowser(requestId, 'busy')
    return served
  }

  #waited(since: Date, ms: number): boolean {
    return this.#now().getTime() - since.getTime() > ms
  }

  /** Request rows of the mcp role still to answer, the oldest first. */
  async pendingRequests(limit: number): Promise<{
    sync: Array<{ id: string; previewId: string }>
    browser: Array<{ id: string; previewId: string }>
  }> {
    const [sync, browser] = await Promise.all([
      this.deps.db.previewSyncRequest.findMany({
        where: { completedAt: null },
        orderBy: { requestedAt: 'asc' },
        take: limit,
        select: { id: true, previewId: true },
      }),
      this.deps.db.previewBrowserRequest.findMany({
        where: { readyAt: null, stoppedAt: null, errorCode: null },
        orderBy: { requestedAt: 'asc' },
        take: limit,
        select: { id: true, previewId: true },
      }),
    ])
    return { sync, browser }
  }

  /** The preview is worked on by this process now. */
  isWorking(previewId: string): boolean {
    return this.#working.has(previewId)
  }

  /** Resolves once every refresh the sweep started has ended (a stop of core, tests). */
  async idle(): Promise<void> {
    while (this.#detached.size) await Promise.allSettled([...this.#detached.values()])
  }

  /**
   * A refresh of the sweep beside it, a few at once (`sweepBuilds`): a preview due now and not
   * started waits for the next pass. Its failures are logged by the refresh itself.
   */
  #detach(previewId: string, options: { requested: boolean; lost?: boolean }): void {
    if (this.#detached.has(previewId) || this.#working.has(previewId)) return
    if (this.#detached.size >= previewManagerTimings.sweepBuilds) return
    const work = this.refresh(previewId, options)
      .then(() => undefined)
      .catch((error: unknown) => this.#warn(`preview ${previewId} sweep`, logged(error)))
      .finally(() => this.#detached.delete(previewId))
    this.#detached.set(previewId, work)
  }

  async #run(previewId: string, first: Work): Promise<boolean> {
    if (this.#working.has(previewId)) return false
    this.#working.add(previewId)
    try {
      const claim = await claimPreview(this.deps.db, previewId)
      if (!claim) return false
      const hold = new PreviewHold(
        this.deps.db,
        claim,
        this.options.heartbeatMs ?? previewLeaseTimings.heartbeatMs,
      )
      let later = false
      try {
        let work: Work = first
        let seen = claim.enqueues
        for (;;) {
          const facts = await loadPreviewFacts(this.deps.db, previewId)
          if (!facts) break
          try {
            await this.#do(hold, facts, work)
          } catch (error) {
            if (error instanceof PreviewLater) later = true
            else if (hold.signal.aborted) return true
            else this.#warn(`preview ${previewId} ${work.kind}`, logged(error))
          }
          // Requests that came while it was held are this holder's to answer.
          const next = await releasePreview(this.deps.db, hold.fence, seen)
          if (next === null) break
          seen = next
          work = { kind: 'refresh', requested: true }
        }
      } finally {
        hold.stop()
      }
      if (later) await this.#askLater(previewId)
      return true
    } finally {
      this.#working.delete(previewId)
    }
  }

  async #do(hold: PreviewHold, facts: PreviewFacts, work: Work): Promise<void> {
    switch (work.kind) {
      case 'refresh':
        return this.#refresh(hold, facts, work)
      case 'sync':
        return this.#sync(hold, facts, work)
      case 'browser':
        return this.#browser(hold, facts, work)
      case 'stopBrowser':
        return stopPreviewBrowser(this.deps, hold, facts.preview.id)
    }
  }

  async #refresh(
    hold: PreviewHold,
    facts: PreviewFacts,
    work: { requested: boolean; lost?: boolean },
  ): Promise<void> {
    const action = previewAction(facts, {
      requested: work.requested,
      now: this.#now(),
      idleMs: this.deps.config.idleMinutes * 60_000,
      ...(work.lost ? { lost: true } : {}),
    })
    if (action === 'destroy') return destroyPreview(this.deps, hold, facts)
    if (action === 'expire') return expirePreview(this.deps, hold, facts)
    if (action !== 'build') return
    let built: BuiltPreview
    try {
      built = await buildPreview(this.deps, hold, facts)
    } catch (error) {
      if (error instanceof PreviewLater || hold.signal.aborted || isLeaseLost(error)) throw error
      if (!(error instanceof PreviewUnavailable))
        this.#warn(`preview ${facts.preview.id} build`, logged(error))
      await failBuild(this.deps.db, hold, error)
      return
    }
    const { candidate } = facts
    if (candidate && this.deps.runtime)
      await runCandidateChecks({ db: this.deps.db, runtime: this.deps.runtime }, hold, {
        taskId: facts.preview.taskId,
        candidate,
        recipe: built.recipe,
        target: { upstream: built.upstream, hostname: facts.preview.hostname },
      })
  }

  async #sync(
    hold: PreviewHold,
    facts: PreviewFacts,
    work: { requestId: string; assignmentId: string | null },
  ): Promise<void> {
    try {
      await syncWorkingTree(this.deps, hold, facts, {
        requestId: work.requestId,
        assignmentId: work.assignmentId,
        recipe: this.#recipeOf(facts),
      })
    } catch (error) {
      if (hold.signal.aborted) throw error
      if (!(error instanceof PreviewSyncRefused))
        this.#warn(`preview ${facts.preview.id} sync`, logged(error))
      await this.#refuseSync(work.requestId, previewSyncErrorCode(error))
    }
  }

  async #browser(
    hold: PreviewHold,
    facts: PreviewFacts,
    work: { requestId: string; assignmentId: string | null },
  ): Promise<void> {
    try {
      await startPreviewBrowser(this.deps, hold, facts, {
        id: work.requestId,
        assignmentId: work.assignmentId,
      })
    } catch (error) {
      if (hold.signal.aborted) throw error
      if (!(error instanceof PreviewBrowserRefused))
        this.#warn(`preview ${facts.preview.id} browser`, logged(error))
      await this.#refuseBrowser(work.requestId, previewBrowserErrorCode(error))
    }
  }

  /** The recipe of a built preview, from the settings its seed was copied with. */
  #recipeOf(facts: PreviewFacts) {
    if (!facts.preview.record.database) return null
    try {
      return this.deps
        .adapters(facts.site.stack)
        .previewRecipe(
          previewSiteFacts(
            facts.site,
            facts.preview.record.database,
            facts.preview.record.runtimeMatch?.production,
          ),
        )
    } catch {
      return null
    }
  }

  async #refuseSync(requestId: string, code: string): Promise<void> {
    await this.deps.db.previewSyncRequest.updateMany({
      where: { id: requestId, completedAt: null },
      data: { completedAt: new Date(), errorCode: code },
    })
  }

  async #refuseBrowser(requestId: string, code: string): Promise<void> {
    await this.deps.db.previewBrowserRequest.updateMany({
      where: { id: requestId, readyAt: null, stoppedAt: null, errorCode: null },
      data: { errorCode: code },
    })
  }

  /** The preview is asked again once the site's lease may have let go (a release in work). */
  async #askLater(previewId: string): Promise<void> {
    const availableAt = new Date(this.#now().getTime() + previewManagerTimings.laterMs)
    await this.deps.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ enqueues: number; revision: number }>>`
          UPDATE preview_environments SET enqueues = enqueues + 1, updated_at = now()
          WHERE id = ${previewId}::uuid AND status <> 'destroyed'
          RETURNING enqueues, revision`
        const row = rows[0]
        if (row)
          await enqueuePreviewSync(
            tx,
            { previewId, revision: row.revision, seq: row.enqueues },
            { availableAt },
          )
      },
      { isolationLevel: 'ReadCommitted' },
    )
  }

  /**
   * One pass of the sweep: what jobs may have lost — builds of a core that died, previews of
   * closed dialogs, previews whose time is up or whose containers are gone, previews not showing
   * their candidate — and the time to live of the previews of waiting dialogs, idle browsers,
   * stale candidates and the leftovers of the runtime.
   */
  async sweep(): Promise<void> {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['lost', () => this.#reconcileLost()],
      ['ttl', () => this.#extendLives()],
      ['due', () => this.#refreshDue()],
      ['idle', () => this.#stopIdleBrowsers()],
      ['stale', () => markStaleCandidates(this.deps.db)],
      ['leftovers', () => this.#removeLeftovers()],
      ['staging', () => this.#removeStaging()],
    ]
    for (const [name, step] of steps)
      try {
        await step()
      } catch (error) {
        this.#warn(`preview sweep ${name}`, logged(error))
      }
  }

  /** Served previews whose containers a restart of the daemon took: rebuilt (R5a). */
  async #reconcileLost(): Promise<void> {
    const runtime = this.deps.runtime
    if (!runtime) return
    const rows = await this.deps.db.previewEnvironment.findMany({
      where: {
        status: 'ready',
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: this.#stale() } }],
      },
      select: { id: true, upstreamHost: true, upstreamPort: true },
      take: SWEEP_BATCH,
    })
    for (const row of rows) {
      if (this.#detached.size >= previewManagerTimings.sweepBuilds) break
      if (this.#working.has(row.id)) continue
      const state = await runtime.inspect(row.id).catch(() => undefined)
      if (state === undefined) continue
      const same =
        state?.running === true &&
        state.upstream?.port === row.upstreamPort &&
        state.upstream.host === row.upstreamHost
      if (!same) this.#detach(row.id, { requested: true, lost: true })
    }
  }

  #stale(): Date {
    return new Date(this.#now().getTime() - previewLeaseTimings.staleSeconds * 1000)
  }

  /**
   * The time to live of a preview follows its dialog (Р8, R5a): the reserve of the dialog, moved
   * on while it waits, and the last view (a ticket) plus PREVIEW_TTL_HOURS. The containers'
   * deadline moves with it. The life is not the time its containers run: a served preview no one
   * used for PREVIEW_IDLE_MINUTES stops within it (`previewIdle`, #refreshDue) — the reserve keeps
   * its copy and the dialog, never its containers running.
   */
  async #extendLives(): Promise<void> {
    const rows = await this.deps.db.$queryRaw<Array<{ id: string; status: string; horizon: Date }>>`
      SELECT id, status, horizon FROM (
        SELECT p.id, p.status::text AS status, p.expires_at, GREATEST(
          (SELECT max(h.expires_at) FROM credit_holds h
            WHERE h.task_id = p.task_id AND h.status = 'active'),
          (SELECT max(k.created_at) FROM preview_tickets k WHERE k.preview_id = p.id)
            + make_interval(hours => ${this.deps.config.ttlHours})
        ) AS horizon
        FROM preview_environments p JOIN tasks t ON t.id = p.task_id
        WHERE p.status IN ('pending', 'building', 'ready', 'failed', 'unavailable')
          AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])
          AND p.expires_at > now()
      ) d
      WHERE horizon > expires_at + interval '1 minute'
      LIMIT ${SWEEP_BATCH}`
    for (const row of rows) {
      await this.deps.db.$executeRaw`
        UPDATE preview_environments SET expires_at = GREATEST(expires_at, ${row.horizon})
        WHERE id = ${row.id}::uuid`
      if (this.deps.runtime && row.status !== 'pending' && row.status !== 'unavailable')
        await this.deps.runtime.extend(row.id, row.horizon.getTime()).catch(() => {
          // Nothing of it runs here (a build that never started its containers): nothing to move.
        })
    }
  }

  /**
   * Previews that need their holder now and have none — among them a served one no one used for
   * PREVIEW_IDLE_MINUTES while its dialog waits (stopped), and a stopped one whose dialog has a
   * pass queued or running (built again: the agent's browser and content tools need it).
   */
  async #refreshDue(): Promise<void> {
    const settle = previewManagerTimings.settleSeconds
    const viewed = previewManagerTimings.viewedSeconds
    const idle = this.deps.config.idleMinutes
    const rows = await this.deps.db.$queryRaw<Array<{ id: string; requested: boolean }>>`
      SELECT p.id,
        (p.status = 'expired' OR (p.status = 'ready' AND (p.dirty OR c.id IS DISTINCT FROM p.candidate_id
          OR COALESCE(c.revision, 0) <> p.revision))) AS requested
      FROM preview_environments p
      JOIN tasks t ON t.id = p.task_id
      LEFT JOIN LATERAL (SELECT id, revision FROM task_candidates
        WHERE task_id = p.task_id AND status IN ('current', 'stale')
        ORDER BY revision DESC LIMIT 1) c ON true
      WHERE p.status <> 'destroyed'
        AND (p.heartbeat_at IS NULL
          OR p.heartbeat_at < now() - make_interval(secs => ${previewLeaseTimings.staleSeconds}))
        AND p.updated_at < now() - make_interval(secs => ${settle})
        AND (
          t.status = ANY(${[...terminalTaskStatuses]}::"TaskStatus"[])
          OR p.status IN ('pending', 'building')
          OR (p.expires_at <= now() AND p.status IN ('ready', 'failed', 'unavailable')
            AND t.status NOT IN ('preparing', 'running'))
          OR (p.status = 'expired' AND p.last_viewed_at > now() - make_interval(secs => ${viewed}))
          OR (p.status = 'expired' AND t.status IN ('queued', 'preparing', 'running'))
          OR (p.status = 'ready' AND t.status NOT IN ('preparing', 'running') AND (p.dirty
            OR c.id IS DISTINCT FROM p.candidate_id OR COALESCE(c.revision, 0) <> p.revision))
          OR (p.status = 'ready' AND t.status NOT IN ('queued', 'preparing', 'running')
            AND ${previewLastUseSql} <= now() - make_interval(mins => ${idle}))
        )
      ORDER BY p.updated_at LIMIT ${SWEEP_BATCH}`
    for (const row of rows) this.#detach(row.id, { requested: row.requested })
  }

  async #stopIdleBrowsers(): Promise<void> {
    for (const id of await idleBrowsers(this.deps.db, SWEEP_BATCH))
      await this.#run(id, { kind: 'stopBrowser' })
  }

  /**
   * What the runtime still holds of previews this database destroyed (a removal that failed
   * half-way). A preview this database does not know is left to the watchdog of the host and
   * its deadline label (R5a): another platform may share the daemon (a stand, another tree).
   */
  async #removeLeftovers(): Promise<void> {
    const runtime = this.deps.runtime
    if (!runtime) return
    const ids = (await runtime.list()).filter((id) => UUID.test(id))
    if (!ids.length) return
    const destroyed = await this.deps.db.previewEnvironment.findMany({
      where: { id: { in: ids }, status: 'destroyed' },
      select: { id: true },
    })
    for (const { id } of destroyed)
      if (!this.#working.has(id))
        await runtime.destroy(id).catch((error: unknown) => {
          this.#warn(`preview leftovers ${id}`, logged(error))
        })
  }

  /**
   * Temporary databases of dumps (named by their preview) that no build holds: a build removes
   * its own, these outlived a core that stopped in the middle of one.
   */
  async #removeStaging(): Promise<void> {
    const staging = this.deps.staging
    if (!staging) return
    // A load of a moment ago may not have marked its preview `building` yet anywhere it is read.
    const before = this.#now().getTime() - STAGING_GRACE_MS
    const ids = (await staging.list())
      .filter((row) => UUID.test(row.stagingId) && row.createdAt < before)
      .map((row) => row.stagingId)
    if (!ids.length) return
    // A build of another core holds its own: a preview in `building` keeps its staging.
    const building = await this.deps.db.previewEnvironment.findMany({
      where: { id: { in: ids }, status: 'building' },
      select: { id: true },
    })
    const held = new Set(building.map((row) => row.id))
    for (const id of ids)
      if (!this.#working.has(id) && !held.has(id))
        await staging.remove(id).catch((error: unknown) => {
          this.#warn(`preview staging ${id}`, logged(error))
        })
  }
}
