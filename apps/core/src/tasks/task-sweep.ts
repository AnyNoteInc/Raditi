import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { chargeTask, expireTaskHolds } from '@repo/billing'
import {
  cancelWaitingTask,
  clearStaleUncheckedSections,
  closeStaleRepoProposals,
  dropAbandonedPages,
  insertFeedEvent,
  purgeExpiredPages,
  recordRunOutcome,
  stalePageReservations,
  stalePendingRuns,
  type PrismaClient,
  type waitingTaskStatuses,
} from '@repo/db'
import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnRetryJobId,
  feedEndedSiteOf,
  isDomainError,
  memoryPassEvidence,
  publicationLimits,
  scheduleLimits,
  type FeedCreditsState,
  type JobQueue,
  type MemoryPassEvidence,
  type ObjectStorage,
  type TurnCredentialSource,
  type TurnPlan,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

import { readBrowserTaskFacts } from '../browser/browser-facts.ts'
import type { BrowserSessions } from '../browser/browser-sessions.ts'
import { recoveredTextRefusal } from '../turns/text-refusal.ts'
import { readTurnResult } from '../turns/turn-result.ts'
import {
  replayedTurn,
  type JournaledEvidence,
  type TurnJournalRange,
} from '../turns/turn-journal.ts'
import { collectExpiredAttachments, expiredAttachmentsIn } from './attachment-collector.ts'
import type { LivePasses } from './live-passes.ts'
import type { PageMetrics } from '../pages/page-metrics.ts'
import type { MemoryChanges } from './memory-changes.ts'
import type { ProjectTrash } from '../projects/project-trash.ts'
import type { PageChanges } from './page-changes.ts'
import type { PagePublications } from './page-publications.ts'
import type { RepoChanges } from './repo-turns.ts'
import type { ScheduleChanges } from './schedule-changes.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import {
  CHARGE_LATER_EVENT,
  type PassEnding,
  type PassSettlement,
  type SettleAnswer,
} from './pass-settlement.ts'
import { savedPlanOf } from './turn-planner.ts'

export const TASK_SWEEP_INTERVAL_MS = 60_000
/** A pass claimed this long ago that opened no turn lost its handler (core died while planning). */
export const ORPHAN_PREPARING_MS = 5 * 60_000
/** A task back in the queue this long without a pass lost its retry job: it is put again. */
export const LOST_RETRY_MS = 15 * 60_000
/**
 * A task queued this long, for no reason to wait, lost its `turn.run` (a job that failed before
 * its claim, a core that died after BullMQ handed the job over, Redis): it is put again. A job
 * still in the queue meanwhile only finds the task taken (claimQueuedTask).
 */
export const LOST_TURN_JOB_MS = 5 * 60_000
/** A pass that could not be ended yet (`later`) is not looked at again before this. */
export const LATER_PAUSE_MS = 5 * 60_000
/** A publication of a turn that no end of turn settled is failed this long after it was made. */
export const PAGE_SWEEP_AFTER_MS = 24 * 60 * 60_000
const BATCH = 50

type Waiting = (typeof waitingTaskStatuses)[number]

/** The commit recovery published under the chat's ref for a turn, and the repository of its plan. */
interface RecoveredPublication {
  repository: NonNullable<TurnPlan['repository']>
  baseSha: string
  headSha: string
}

/** What the end of a completed turn the sweep reached needs of its changes, from its journal. */
interface SweptTurn {
  /** What the turn took in from outside, by the events its journal kept (ПР18). */
  evidence: MemoryPassEvidence
  /** The plan of the turn had a repository. */
  repository: boolean
}

export interface TaskSweepDependencies {
  db: PrismaClient
  settlement: PassSettlement
  live: LivePasses
  journal: { replay(range: TurnJournalRange): Promise<JournaledEvidence[]> }
  drivers: AgentDriverRegistry
  queue: JobQueue
  /**
   * The cloud browser of tasks (docs/plan/57-browser-tasks.md, Б18): what a task saved is read
   * on the site before its pass is ended, and the sessions are compared with the worker every
   * tick. null — no worker is configured.
   */
  browser?: Pick<BrowserSessions, 'verify' | 'sweep'> | null
  /**
   * The object storage of raditi-inbox: files nobody sent are collected there every tick
   * (docs/plan/57, Б26). Absent — they are not collected.
   */
  inbox?: Pick<ObjectStorage, 'delete'> | null
  /**
   * The pages of turns (docs/plan/69-pages.md, Ст6): a publication no end of turn settled is told
   * to have failed, a page that never got a version is removed. Absent — not swept.
   */
  pages?: Pick<PagePublications, 'left'> | null
  /** The metrics of the sites of pages, counted again after each sweep of them (73.12). */
  pageMetrics?: Pick<PageMetrics, 'refresh'> | null
  /**
   * The trash of projects (docs/plan/84-projects.md, ПР20): chats of projects in the trash are
   * stopped, projects past their day purged. Absent — not swept.
   */
  projects?: Pick<ProjectTrash, 'sweep'> | null
  /**
   * The memory of chats (docs/plan/84-projects.md, ПР18): a change no end of a turn applied is
   * closed failed a day on. Absent — not swept.
   */
  memory?: Pick<MemoryChanges, 'sweep' | 'apply'> | null
  /**
   * The changes of the scheduled tasks no end of a turn reached (docs/plan/82-scheduled-tasks.md,
   * Зп33): closed and told once the turn is over. Absent — not swept.
   */
  schedules?: Pick<ScheduleChanges, 'sweep' | 'apply'> | null
  /**
   * The changes of pages a completed turn reserved (docs/plan/73-pages-sites.md, Дер23), applied
   * when the sweep ends its pass. Absent — they are left for the sweep of pages.
   */
  pageChanges?: Pick<PageChanges, 'apply'> | null
  /**
   * The current values of the variables of a chat's workspace (БП4): what the changes of a turn
   * the sweep ends are refused for. Absent or unanswered — the memory of that turn is closed
   * failed, and its pages and scheduled tasks wait for their sweeps, as after a live end without
   * Vault.
   */
  values?: Pick<TurnCredentialSource, 'siteValues'> | null
  /**
   * The repository of a chat whose turn recovery published (docs/plan/84-projects.md, ПР12): the
   * card «Изменения в ветке» of the commit recovery put under the chat's ref, its diff read from
   * the mirror. Absent — no trusted git: such a turn is only answered.
   */
  repositories?: {
    changes: Pick<RepoChanges, 'apply'>
    workspace: Pick<GitWorkspaceService, 'buildSettingsChange'>
  } | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/**
 * The sweep of chats (feed-design.md «Сверка»): every minute it ends the passes whose turn
 * recovery closed or whose handler died, cancels the chats whose reserve ran out, puts again a
 * pass whose retry got lost, compares the browsers of tasks with the worker and removes the files
 * nobody sent. Every write is a conditional move in PostgreSQL, so a pass
 * is idempotent and may race the live handler.
 */
export class TaskSweep {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #warn: ThrottledLog
  readonly #now: () => Date
  /** Tasks whose pass answered `later`, until when they are left alone: others get their turn. */
  readonly #paused = new Map<string, number>()

  constructor(private readonly deps: TaskSweepDependencies) {
    this.#logger = deps.logger ?? new Logger('TaskSweep')
    this.#warn = throttledLogger((line) => this.#logger.warn(line))
    this.#now = deps.now ?? (() => new Date())
  }

  async tick(): Promise<void> {
    for (const [name, pass] of [
      ['orphans', () => this.settleOrphans()],
      ['charges', () => this.chargeLater()],
      ['expiry', () => this.expireHolds()],
      ['retries', () => this.requeueLost()],
      ['browsers', () => this.sweepBrowsers()],
      ['attachments', () => this.collectAttachments()],
      ['pages', () => this.sweepPages()],
      ['projects', () => this.deps.projects?.sweep()],
      ['memory', () => this.sweepMemory()],
      ['schedules', () => this.sweepSchedules()],
      ['manual runs', () => this.closeStaleManualRuns()],
    ] as const) {
      try {
        await pass()
      } catch (error) {
        this.#warn(`task sweep ${name}`, logged(error))
      }
    }
  }

  /**
   * Passes left in `preparing` or `running` with no turn assigned: ended from the journal of
   * their turn, or — a pass whose handler was lost before it opened a turn — put back in the
   * queue. Every row on its own: one that throws is logged and the batch goes on.
   */
  async settleOrphans(): Promise<number> {
    const { db } = this.deps
    const now = this.#now()
    for (const [taskId, until] of this.#paused)
      if (until <= now.getTime()) this.#paused.delete(taskId)
    const tasks = await db.$queryRaw<
      Array<{
        id: string
        attempt: number
        turn_no: number
        status: string
        updated_at: Date
        needs_browser: boolean
      }>
    >`
      SELECT t.id, t.attempt, t.turn_no, t.status::text AS status, t.updated_at, t.needs_browser
      FROM tasks t
      WHERE t.status IN ('preparing', 'running')
        AND NOT (t.id = ANY(${[...this.#paused.keys()]}::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM turn_assignments a WHERE a.task_id = t.id AND a.finished_at IS NULL)
      ORDER BY t.updated_at LIMIT ${BATCH}`
    let settled = 0
    for (const task of tasks) {
      if (this.deps.live.has(task.id)) continue
      try {
        const answer = await this.#settleOrphan(task, now)
        if (answer === 'moved') settled++
        if (answer === 'later') this.#paused.set(task.id, now.getTime() + LATER_PAUSE_MS)
      } catch (error) {
        this.#warn(`task sweep orphan task=${task.id}`, logged(error))
      }
    }
    if (settled > 0) this.#logger.log(`task_sweep_settled count=${settled}`)
    return settled
  }

  async #settleOrphan(
    task: {
      id: string
      attempt: number
      turn_no: number
      status: string
      updated_at: Date
      needs_browser: boolean
    },
    now: Date,
  ): Promise<SettleAnswer | null> {
    const { db } = this.deps
    const assignment =
      task.turn_no > 0
        ? await db.turnAssignment.findFirst({
            where: { taskId: task.id, turnNo: task.turn_no, finishedAt: { not: null } },
            orderBy: { createdAt: 'desc' },
          })
        : null
    const ref = { taskId: task.id, attempt: task.attempt, turnNo: task.turn_no }
    // A turn that closed before the pass claimed its task is an earlier pass's: the move that
    // ended that pass and the claim both stamp `updated_at` with the database's clock, as
    // `finished_at` is. A turn the pass opened itself closes after its open stamped the task;
    // only a clock of core far ahead of PostgreSQL reads it as none, and then the pass is merely
    // put back in the queue.
    if (
      task.status === 'preparing' &&
      (!assignment?.finishedAt || assignment.finishedAt.getTime() < task.updated_at.getTime())
    ) {
      if (now.getTime() - task.updated_at.getTime() < ORPHAN_PREPARING_MS) return null
      const answer = await this.deps.settlement.settle(ref, { kind: 'orphaned' })
      // Nothing was lost before the turn: a pass back in the queue is put again.
      const back = await db.task.findUnique({ where: { id: task.id }, select: { status: true } })
      if (answer === 'moved' && back?.status === 'queued')
        await this.#put(task.id, task.attempt, `orphan-${now.getTime()}`)
      return answer
    }
    if (!assignment?.finishedAt) return null
    // Lost by recovery before any runner claimed it — its core died between the reservation of a
    // slot and the prepare: nothing of the turn ran anywhere (spec §8, proof 1), so the pass goes
    // back to the queue as one lost before its turn, not to the client as a failure
    // (docs/plan/86-speedups.md).
    if (
      task.status === 'preparing' &&
      assignment.executor === 'runner' &&
      assignment.runnerId === null &&
      assignment.outcome === 'lost'
    ) {
      const answer = await this.deps.settlement.settle(ref, { kind: 'orphaned' })
      const back = await db.task.findUnique({ where: { id: task.id }, select: { status: true } })
      if (answer === 'moved' && back?.status === 'queued')
        await this.#put(task.id, task.attempt, `orphan-${now.getTime()}`)
      return answer
    }
    const { ending, published, swept } = await this.#endingOf(assignment)
    // As the live handler: what a task in the browser saved is read first (Б23).
    if (task.needs_browser) await this.deps.browser?.verify(task.id)
    const answer = await this.deps.settlement.settle(ref, ending)
    if (answer === 'moved' && ending.kind === 'completed' && swept)
      await this.#applyChanges(assignment, ending.turn, swept)
    if (answer === 'moved' && ending.kind === 'completed' && published)
      await this.#tellPublished(task.id, ending.turn, published)
    return answer
  }

  /**
   * What the live end of a completed pass applies after its answer, for a turn whose end only the
   * sweep reached — recovery finished it, or its handler died after the journal recorded it
   * (docs/plan/84-projects.md, §10): the changes of pages, of scheduled tasks and of the memory, in
   * the order of PassRunner and with its checks. The keys of the turn are gone with its attempt, so
   * any text in their form is refused; the values are read again. The client's words of the pass
   * are not read again either: every note of the agent is only «Предложено», which the client
   * saves himself. Never throws.
   */
  async #applyChanges(
    assignment: { taskId: string; sessionId: string; turnNo: number; firstEpoch: number },
    turn: number,
    swept: SweptTurn,
  ): Promise<void> {
    const { taskId } = assignment
    let refusesText: ReturnType<typeof recoveredTextRefusal> | null = null
    try {
      const values = this.deps.values?.siteValues
        ? await this.deps.values.siteValues({
            taskId,
            sessionId: assignment.sessionId,
            turn: assignment.turnNo,
            epoch: assignment.firstEpoch,
          })
        : null
      if (values) refusesText = recoveredTextRefusal(values)
    } catch (error) {
      this.#warn(`task sweep values task=${taskId}`, logged(error))
    }
    if (refusesText) {
      await this.deps.pageChanges?.apply(taskId, turn, refusesText)
      await this.deps.schedules?.apply(taskId, turn, refusesText)
    }
    await this.deps.memory?.apply(taskId, turn, refusesText, {
      // Not read again: a note of the turn is never active at once (passMayRemember).
      remember: false,
      evidence: swept.evidence,
      repository: swept.repository,
    })
  }

  /**
   * The card of the commit recovery published for a turn (`publication_recovered`): as the live
   * handler shows it, from the diff of the base and the commit in the mirror. Without it the next
   * turn would take the chat's ref back to the head the cards name and drop that commit.
   */
  async #tellPublished(taskId: string, turn: number, published: RecoveredPublication) {
    const repositories = this.deps.repositories
    if (!repositories) return
    const { repository, baseSha, headSha } = published
    try {
      const change = await repositories.workspace.buildSettingsChange({
        projectRepositoryId: repository.projectRepositoryId,
        from: baseSha,
        to: headSha,
        isBuildPath: () => true,
        maxBytes: publicationLimits.patchBytes,
      })
      await repositories.changes.apply(
        taskId,
        turn,
        { baseSha, headSha, patch: change.patch ?? new Uint8Array(), buildPaths: [] },
        {
          projectRepositoryId: repository.projectRepositoryId,
          branch: repository.branch,
          mode: repository.mode,
        },
      )
    } catch (error) {
      this.#warn(`task sweep recovered publication task=${taskId}`, logged(error))
    }
  }

  /** How a closed turn ended, from its journal; a journal that contradicts itself is technical. */
  async #endingOf(assignment: {
    taskId: string
    siteId: string
    sessionId: string
    turnNo: number
    firstEpoch: number
    leaseEpoch: number
    plan: unknown
  }): Promise<{ ending: PassEnding; published?: RecoveredPublication; swept?: SweptTurn }> {
    const turn = assignment.turnNo
    const technical = { ending: { kind: 'failed', turn } as PassEnding }
    let entries: JournaledEvidence[]
    try {
      entries = await this.deps.journal.replay({
        siteId: assignment.siteId,
        taskId: assignment.taskId,
        sessionId: assignment.sessionId,
        turn,
        fromEpoch: assignment.firstEpoch,
        toEpoch: assignment.leaseEpoch,
      })
    } catch (error) {
      if (isDomainError(error) && error.code === 'CONFLICT') return technical
      throw error
    }
    let replayed
    try {
      replayed = replayedTurn(entries)
    } catch {
      return technical
    }
    const plan = savedPlanOf(assignment.plan)
    // A plan with a repository is of a project, and projects are gone
    // (docs/plan/83-remove-projects.md): its schema refuses it, and such a turn ends as a
    // technical failure.
    const raw = assignment.plan
    if (plan === null && typeof raw === 'object' && raw !== null && 'workspace' in raw)
      return technical
    const swept: SweptTurn = {
      evidence: memoryPassEvidence(replayed.events),
      repository: Boolean(plan?.repository),
    }
    if (replayed.lastPhase === 'completed') {
      const result = entries.findLast((entry) => entry.phase === 'completed')?.result
      if (!result) return technical
      return { ending: { kind: 'completed', turn, result }, swept }
    }
    // Recovery finished the checkpoint of the turn (Б6), or the publication of its commit into the
    // mirror (ПР12), but does not keep its result: it is read from the output.
    if (
      replayed.lastPhase === 'checkpoint_recovered' ||
      replayed.lastPhase === 'publication_recovered'
    ) {
      if (!plan || !this.deps.drivers.has(plan.driverId)) return technical
      let result
      try {
        result = readTurnResult(
          this.deps.drivers.get(plan.driverId),
          replayed.events,
          plan.input.action,
        )
      } catch {
        return { ending: { kind: 'failed', turn, errorCode: 'TURN_OUTPUT_REJECTED' } }
      }
      const ending: PassEnding = { kind: 'completed', turn, result }
      const recovered = entries.findLast((entry) => entry.phase === 'publication_recovered')
      const headSha = recovered?.candidateHeadSha
      const baseSha = recovered?.baseSha
      if (
        replayed.lastPhase === 'publication_recovered' &&
        plan.repository &&
        headSha &&
        baseSha &&
        headSha !== baseSha
      )
        // The head stands from the settlement of this pass, as the live end writes it (ревью C1):
        // the next pass, which the drain may start before the card is written, reads it.
        return {
          ending: { ...ending, repoHead: { baseSha, headSha } },
          published: { repository: plan.repository, baseSha, headSha },
          swept,
        }
      return { ending, swept }
    }
    if (replayed.lastPhase === 'failed' && replayed.reason)
      return { ending: { kind: 'failed', turn, journalReason: replayed.reason } }
    return technical
  }

  /**
   * The charges a pass could not make when it ended (`CHARGE_LATER_EVENT`: the usage of a turn
   * key was still open): a task that waits or is done, whose chain of that attempt is still
   * active, is charged now (`chargeTask`). A refusal leaves it for the next tick; words of the
   * client that came first went on with the chain, and the end of their pass charged it.
   */
  async chargeLater(): Promise<number> {
    const { db } = this.deps
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT t.id FROM tasks t
      JOIN task_events e ON e.task_id = t.id AND e.type = ${CHARGE_LATER_EVENT}
      WHERE t.status IN ('awaiting_user', 'awaiting_approval', 'done') AND t.billable
        AND EXISTS (SELECT 1 FROM credit_holds h
          WHERE h.task_id = t.id AND h.status = 'active'
            AND h.attempt = (e.payload->>'attempt')::int)
      LIMIT ${BATCH}`
    let charged = 0
    for (const row of rows)
      try {
        const done = await db.$transaction(
          async (tx) => {
            // The task may have gone back to work since it was read: then its pass charges it.
            const waiting = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM tasks
              WHERE id = ${row.id}::uuid AND status IN ('awaiting_user', 'awaiting_approval', 'done')
              FOR SHARE`
            if (waiting.length === 0) return false
            return (await chargeTask(tx, { taskId: row.id, now: this.#now() })).applied
          },
          { isolationLevel: 'ReadCommitted', timeout: 30_000 },
        )
        if (done) charged++
      } catch (error) {
        this.#warn(`task sweep charge task=${row.id}`, logged(error))
      }
    if (charged > 0) this.#logger.log(`task_sweep_charged count=${charged}`)
    return charged
  }

  /**
   * A dialog whose every reserve row is past its expiry while it waits is cancelled and its
   * reserve given back (`expireTaskHolds`).
   */
  async expireHolds(): Promise<number> {
    const { db } = this.deps
    const rows = await db.$queryRaw<
      Array<{ id: string; status: Waiting; attempt: number; needs_browser: boolean }>
    >`
      SELECT t.id, t.status::text AS status, t.attempt, t.needs_browser FROM tasks t
      WHERE t.status IN ('queued', 'awaiting_user', 'awaiting_approval')
        AND EXISTS (SELECT 1 FROM credit_holds h WHERE h.task_id = t.id AND h.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM credit_holds h
          WHERE h.task_id = t.id AND h.status = 'active' AND h.expires_at > now())
      LIMIT ${BATCH}`
    let cancelled = 0
    for (const row of rows) {
      let moved = false
      try {
        moved = await this.#expire(row)
      } catch (error) {
        // A reserve extended meanwhile is no longer past its expiry: the move is rolled back.
        this.#warn(`task sweep expiry task=${row.id}`, logged(error))
      }
      if (moved) cancelled++
    }
    if (cancelled > 0) this.#logger.log(`task_sweep_expired count=${cancelled}`)
    return cancelled
  }

  #expire(row: {
    id: string
    status: Waiting
    attempt: number
    needs_browser: boolean
  }): Promise<boolean> {
    return this.deps.db.$transaction(
      async (tx) => {
        // The database's clock, as the selection above read it: never before it.
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        const now = clock!.now
        const settled = await cancelWaitingTask(tx, {
          taskId: row.id,
          from: row.status,
          attempt: row.attempt,
          feed: [],
        })
        if (!settled.moved) return false
        const returned = await expireTaskHolds(tx, { taskId: row.id, now })
        const credits: FeedCreditsState | null = returned.applied
          ? returned.expiries.length > 0
            ? 'expired'
            : 'returned'
          : null
        // Anyone acted in the task's browser (Б28): nothing gives that back.
        const writes =
          (await tx.browserSession.count({ where: { taskId: row.id, wroteAt: { not: null } } })) > 0
        const task = await tx.task.findUniqueOrThrow({
          where: { id: row.id },
          select: { turnNo: true },
        })
        // What a task in the browser had saved, as last read there (Б24); its session is
        // closed by the browser pass of this tick.
        const objects = row.needs_browser ? (await readBrowserTaskFacts(tx, row.id)).objects : []
        await insertFeedEvent(tx, {
          taskId: row.id,
          turnId: settled.turnId,
          row: {
            type: 'feed.cancelled',
            payload: {
              v: 1,
              turn: task.turnNo > 0 ? task.turnNo : null,
              by: row.status === 'queued' ? 'queue_timeout' : 'no_answer',
              site: feedEndedSiteOf(writes),
              credits,
              ...(objects.length ? { objects } : {}),
            },
          },
        })
        return true
      },
      { isolationLevel: 'ReadCommitted', timeout: 30_000 },
    )
  }

  /**
   * The browsers of tasks against the worker (Б18): those of ended tasks and past their deadline
   * are closed, those the worker lost are marked so, its orphans closed. A task whose pass is at
   * work in this process is never taken for lost.
   */
  async sweepBrowsers(): Promise<void> {
    await this.deps.browser?.sweep({ busy: (taskId) => this.deps.live.has(taskId) })
  }

  /**
   * Files nobody sent past their expiry leave raditi-inbox, then the database: a batch a tick,
   * a file that fails is tried again on the next one (Б26).
   */
  async collectAttachments(): Promise<number> {
    const { inbox } = this.deps
    if (!inbox) return 0
    const removed = await collectExpiredAttachments({
      files: expiredAttachmentsIn(this.deps.db),
      storage: inbox,
      limit: BATCH,
      // One line a minute for all of them: a storage that is down fails every file.
      onFailure: (_id, error) => this.#warn('task sweep attachments', logged(error)),
    })
    if (removed > 0) this.#logger.log(`task_sweep_attachments count=${removed}`)
    return removed
  }

  /**
   * Publications of turns that never ended, a day on (PAGE_SWEEP_AFTER_MS): settled as failed and
   * told; then pages that never got a version and wait for nothing are removed.
   */
  async sweepPages(): Promise<number> {
    const { pages, db } = this.deps
    if (!pages) return 0
    const before = new Date(this.#now().getTime() - PAGE_SWEEP_AFTER_MS)
    const stale = await stalePageReservations(db, before, BATCH)
    for (const reservation of stale)
      await pages.left(reservation, 'failed', { taskId: reservation.taskId, turnId: null })
    const dropped = await dropAbandonedPages(db, before)
    // Text of documents no end of a turn checked: it may hold a value of the client (Ст19).
    const cleared = await clearStaleUncheckedSections(db, before)
    // Pages whose 30 days in the trash are over (docs/plan/73-pages-sites.md, Дер2).
    const purged = await purgeExpiredPages(db, this.#now(), BATCH)
    if (stale.length > 0 || dropped > 0 || cleared > 0 || purged > 0)
      this.#logger.log(
        `task_sweep_pages failed=${stale.length} dropped=${dropped} sections_cleared=${cleared} purged=${purged}`,
      )
    // The numbers of the sites are a reading, never a reason to stop the sweep.
    await this.deps.pageMetrics?.refresh().catch(() => this.#logger.warn('page_metrics_failed'))
    return stale.length
  }

  /** Changes of memory of turns that never ended, a day on (PAGE_SWEEP_AFTER_MS). */
  async sweepMemory(): Promise<number> {
    const { memory } = this.deps
    const before = new Date(this.#now().getTime() - PAGE_SWEEP_AFTER_MS)
    // And the proposals of a merge request of such turns (ревью C11).
    const proposals = await closeStaleRepoProposals(this.deps.db, before)
    if (proposals > 0) this.#logger.log(`task_sweep_repo_proposals failed=${proposals}`)
    if (!memory) return 0
    const closed = await memory.sweep(before)
    if (closed > 0) this.#logger.log(`task_sweep_memory failed=${closed}`)
    return closed
  }

  /**
   * The changes of the scheduled tasks a turn reserved and no end of it applied (Зп33): a pass
   * still at work in this process keeps them for its own end.
   */
  async sweepSchedules(): Promise<number> {
    const { schedules, live } = this.deps
    if (!schedules) return 0
    return schedules.sweep((taskId) => live.has(taskId))
  }

  /**
   * Runs of «Запустить сейчас» a web left waiting — it stopped between writing the run and its
   * answer — close here, «Не запустилась: сбой платформы», without a notice (Зп24): a run that
   * waits holds its task up as «Выполняется», and every scheduled moment would be skipped beside
   * it. Here, not in the tick of the schedules: the button works through web alone, whether this
   * core runs the schedules or not. Returns how many.
   */
  async closeStaleManualRuns(): Promise<number> {
    const { db } = this.deps
    const now = this.#now()
    const olderThan = new Date(now.getTime() - scheduleLimits.manualPendingSweepMinutes * 60_000)
    let closed = 0
    for (const run of await stalePendingRuns(db, olderThan, BATCH, 'manual')) {
      try {
        const recorded = await recordRunOutcome(
          db,
          run.id,
          { status: 'refused', reason: 'platform' },
          now,
        )
        if (recorded.recorded) closed++
      } catch (error) {
        this.#warn(`task sweep manual run=${run.id}`, logged(error))
      }
    }
    if (closed > 0) this.#logger.log(`task_sweep_manual_runs count=${closed}`)
    return closed
  }

  /**
   * A queued pass whose job never came is put again: a delayed retry of a busy lease or pool
   * (LOST_RETRY_MS), or the `turn.run` of a task that waits for nothing (LOST_TURN_JOB_MS). The
   * job answers the request that queued the pass — the last words or «Продолжить», never a
   * command — and its id is the moment the task went back to the queue, so a stall is put once.
   */
  async requeueLost(): Promise<number> {
    const { db } = this.deps
    const rows = await db.$queryRaw<Array<{ id: string; attempt: number; updated_at: Date }>>`
      SELECT t.id, t.attempt, t.updated_at FROM tasks t
      WHERE t.status = 'queued' AND (
        (t.waiting IS NOT NULL
          AND t.updated_at < now() - make_interval(secs => ${LOST_RETRY_MS / 1000}))
        OR (t.waiting IS NULL
          AND t.updated_at < now() - make_interval(secs => ${LOST_TURN_JOB_MS / 1000})))
      ORDER BY t.updated_at LIMIT ${BATCH}`
    let put = 0
    for (const row of rows) {
      if (this.deps.live.has(row.id)) continue
      try {
        if (await this.#put(row.id, row.attempt, `sweep-${row.updated_at.getTime()}`)) put++
      } catch (error) {
        this.#warn(`task sweep requeue task=${row.id}`, logged(error))
      }
    }
    return put
  }

  /**
   * Puts the pass of the attempt again, answering its last request; false — it has none. A press
   * of a command moves nothing; `agent_command` — `/init` — is a pass, and it is put again.
   */
  async #put(taskId: string, attempt: number, tag: string): Promise<boolean> {
    const [request] = await this.deps.db.$queryRaw<Array<{ id: bigint | null }>>`
      SELECT max(id) AS id FROM task_events
      WHERE task_id = ${taskId}::uuid AND type = 'feed.request'
        AND payload->>'kind' IS DISTINCT FROM 'command'`
    if (!request?.id) return false
    const job = { taskId, attempt, requestEventId: request.id.toString() }
    await this.deps.queue.enqueue(AGENT_TURN_QUEUE, AGENT_TURN_JOB, job, {
      jobId: agentTurnRetryJobId(job, tag),
    })
    return true
  }
}

/** Only a code: messages of storage and database errors stay out of the log. */
const logged = (error: unknown) =>
  new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown')

/** The sweep runs only in running applications, one pass at a time (as CoreCredentialRuntime). */
export class TaskSweepRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #closing = false

  constructor(
    private readonly sweep: Pick<TaskSweep, 'tick'>,
    private readonly background: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || this.#timer || this.#closing) return
    this.#timer = setInterval(() => void this.tick(), TASK_SWEEP_INTERVAL_MS)
    this.#timer.unref()
    void this.tick()
  }

  tick(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = this.sweep.tick().finally(() => {
      if (this.#pending === pending) this.#pending = undefined
    })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
  }
}
