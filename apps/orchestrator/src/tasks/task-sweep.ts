import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { expireTaskHolds, extendTaskHolds } from '@repo/billing'
import {
  cancelWaitingTask,
  insertFeedEvent,
  requestPreviewSync,
  taskHasProductionWrites,
  type PrismaClient,
  type waitingTaskStatuses,
} from '@repo/db'
import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnRetryJobId,
  isDomainError,
  type FeedCreditsState,
  type JobQueue,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

import { readTurnResult } from '../turns/turn-result.ts'
import {
  replayedTurn,
  type JournaledEvidence,
  type TurnJournalRange,
} from '../turns/turn-journal.ts'
import type { LivePasses } from './live-passes.ts'
import type { PassEnding, PassSettlement, SettleAnswer } from './pass-settlement.ts'
import { savedPlanOf } from './turn-planner.ts'

export const TASK_SWEEP_INTERVAL_MS = 60_000
/** A pass claimed this long ago that opened no turn lost its handler (core died while planning). */
export const ORPHAN_PREPARING_MS = 5 * 60_000
/** After this a pass that cannot be ended — git, open usage — is ended anyway. */
export const SETTLE_GIVE_UP_MS = 2 * 60 * 60_000
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
const BATCH = 50

type Waiting = (typeof waitingTaskStatuses)[number]

export interface TaskSweepDependencies {
  db: PrismaClient
  settlement: PassSettlement
  live: LivePasses
  journal: { replay(range: TurnJournalRange): Promise<JournaledEvidence[]> }
  drivers: AgentDriverRegistry
  queue: JobQueue
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/**
 * The sweep of dialogs (docs/plan/53-chat-preview-release.md, R3, Р8; feed-design.md
 * «Сверка»): every minute it ends the passes whose turn recovery closed or whose handler died,
 * keeps the reserves of dialogs that wait with a candidate while their preview lives, cancels
 * those whose reserve ran out — never one with a release in work — and puts again a pass whose
 * retry got lost. Every write is a conditional move in PostgreSQL, so a pass is idempotent and
 * may race the live handler.
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
      ['holds', () => this.extendHolds()],
      ['expiry', () => this.expireHolds()],
      ['retries', () => this.requeueLost()],
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
      Array<{ id: string; attempt: number; turn_no: number; status: string; updated_at: Date }>
    >`
      SELECT t.id, t.attempt, t.turn_no, t.status::text AS status, t.updated_at FROM tasks t
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
    task: { id: string; attempt: number; turn_no: number; status: string; updated_at: Date },
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
    const ending = await this.#endingOf(assignment)
    const giveUp = now.getTime() - assignment.finishedAt.getTime() >= SETTLE_GIVE_UP_MS
    return this.deps.settlement.settle(ref, ending, { giveUp })
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
  }): Promise<PassEnding> {
    const turn = assignment.turnNo
    const technical: PassEnding = { kind: 'failed', turn }
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
    const head = await this.deps.db.taskTurn.findUnique({
      where: { taskId_turnNo: { taskId: assignment.taskId, turnNo: turn } },
      select: { headSha: true },
    })
    const headSha = head?.headSha ?? replayed.candidateHeadSha
    if (replayed.lastPhase === 'completed') {
      const result = entries.findLast((entry) => entry.phase === 'completed')?.result
      if (!result || !headSha) return technical
      return { kind: 'completed', turn, result, headSha }
    }
    if (replayed.lastPhase === 'publication_recovered') {
      // Recovery published the turn but does not keep its result: it is read from the output.
      const plan = savedPlanOf(assignment.plan)
      if (!plan || !headSha || !this.deps.drivers.has(plan.driverId)) return technical
      try {
        const result = readTurnResult(this.deps.drivers.get(plan.driverId), replayed.events)
        return { kind: 'completed', turn, result, headSha }
      } catch {
        return { kind: 'failed', turn, errorCode: 'TURN_OUTPUT_REJECTED' }
      }
    }
    if (replayed.lastPhase === 'failed' && replayed.reason)
      return { kind: 'failed', turn, journalReason: replayed.reason }
    return technical
  }

  /**
   * A dialog that waits with a candidate keeps its reserve while its preview lives (Р8): the
   * reserve rows are moved to the preview's expiry.
   */
  async extendHolds(): Promise<number> {
    const { db } = this.deps
    const rows = await db.$queryRaw<Array<{ id: string; expires_at: Date }>>`
      SELECT t.id, p.expires_at FROM tasks t
      JOIN preview_environments p ON p.task_id = t.id
      WHERE t.status IN ('awaiting_user', 'awaiting_approval') AND t.billable
        AND p.status NOT IN ('expired', 'destroyed') AND p.expires_at > now()
        AND EXISTS (SELECT 1 FROM task_candidates c
          WHERE c.task_id = t.id AND c.status IN ('current', 'stale'))
        AND EXISTS (SELECT 1 FROM credit_holds h
          WHERE h.task_id = t.id AND h.status = 'active' AND h.expires_at < p.expires_at)
      LIMIT ${BATCH}`
    let extended = 0
    for (const row of rows)
      try {
        const moved = await db.$transaction(
          async (tx) => {
            // The dialog may have left its wait since it was read — words, «Продолжить»,
            // «Попробовать ещё» placed a new reserve with an expiry of its own: the row is held
            // as it waits, before the accounts (the order every writer takes), or left alone.
            const waiting = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM tasks
              WHERE id = ${row.id}::uuid AND status IN ('awaiting_user', 'awaiting_approval')
              FOR SHARE`
            if (waiting.length === 0) return false
            await extendTaskHolds(tx, { taskId: row.id, expiresAt: row.expires_at })
            return true
          },
          { isolationLevel: 'ReadCommitted' },
        )
        if (moved) extended++
      } catch (error) {
        this.#warn(`task sweep hold task=${row.id}`, logged(error))
      }
    return extended
  }

  /**
   * A dialog whose every reserve row is past its expiry while it waits is cancelled and its
   * reserve given back (`expireTaskHolds`). A dialog with a release that has not ended is never
   * touched: deploying and verifying are not waiting statuses, and the move checks the release.
   */
  async expireHolds(): Promise<number> {
    const { db } = this.deps
    const rows = await db.$queryRaw<Array<{ id: string; status: Waiting; attempt: number }>>`
      SELECT t.id, t.status::text AS status, t.attempt FROM tasks t
      WHERE t.status IN ('queued', 'awaiting_user', 'awaiting_approval')
        AND EXISTS (SELECT 1 FROM credit_holds h WHERE h.task_id = t.id AND h.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM credit_holds h
          WHERE h.task_id = t.id AND h.status = 'active' AND h.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM site_releases r
          WHERE r.task_id = t.id AND r.status NOT IN ('installed', 'rolled_back', 'failed'))
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

  #expire(row: { id: string; status: Waiting; attempt: number }): Promise<boolean> {
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
        const writes = await taskHasProductionWrites(tx, row.id)
        const task = await tx.task.findUniqueOrThrow({
          where: { id: row.id },
          select: { turnNo: true },
        })
        await insertFeedEvent(tx, {
          taskId: row.id,
          turnId: settled.turnId,
          row: {
            type: 'feed.cancelled',
            payload: {
              v: 1,
              turn: task.turnNo > 0 ? task.turnNo : null,
              by: row.status === 'queued' ? 'queue_timeout' : 'no_answer',
              site: writes ? 'check' : 'unchanged',
              credits,
            },
          },
        })
        // The dialog is closed: its preview is brought down by its manager.
        await requestPreviewSync(tx, { taskId: row.id, revision: 0 })
        return true
      },
      { isolationLevel: 'ReadCommitted', timeout: 30_000 },
    )
  }

  /**
   * A queued pass whose job never came is put again: a delayed retry of a busy site or pool
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

  /** Puts the pass of the attempt again, answering its last request; false — it has none. */
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
