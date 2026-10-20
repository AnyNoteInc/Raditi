import { Logger } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { claimQueuedTask, enqueueSiteWaitingPasses, type PrismaClient } from '@repo/db'
import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnRetryJobId,
  CANDIDATE_REBASE_JOB,
  candidateRebaseDedupeKey,
  isDomainError,
  readFeedRow,
  turnEvidenceSchema,
  type AgentTurnCancelJob,
  type AgentTurnJob,
  type JobQueue,
  type LlmBackend,
  type PreviewAddress,
  type SandboxRuntime,
  type SiteAdapter,
  type SiteLeaseStore,
  type SiteStack,
} from '@repo/domain'

import type { TurnSupervisor } from '../turns/turn-supervisor.ts'
import type { CandidateGit } from './candidate-git.ts'
import type { LivePasses } from './live-passes.ts'
import { readPassFacts } from './pass-facts.ts'
import type { PassEnding, PassRef, PassSettlement } from './pass-settlement.ts'
import { causeOf, failureFactsOf, feedFailureOf } from './turn-outcome.ts'
import { planTurn, type PassPlan } from './turn-planner.ts'

/** How often a running pass looks for the client's «Отменить» in the feed. */
export const CANCEL_POLL_MS = 5_000

/**
 * Back to the queue: the retry of a busy site or pool waits at least this much and at most that.
 * A pass that waits for its site is woken when the holder lets it go (a turn of another dialog
 * ended, a release ended — `enqueueSiteWaitingPasses`); `site` is the latest it looks again
 * without a wake: a holder that died, a wake lost on the way.
 */
const RETRY_DELAY_MS = Object.freeze({
  min: 10_000,
  site: 2 * 60_000,
  /** A branch an `/update` is still moving, a pool that names no time: nothing wakes the pass. */
  update: 30_000,
  max: 10 * 60_000,
})

const clamp = (value: number) =>
  Math.min(RETRY_DELAY_MS.max, Math.max(RETRY_DELAY_MS.min, Math.round(value)))

export interface PassRunnerDependencies {
  db: PrismaClient
  /** null while git is not configured: no turn can run (spec §20 «Транспорт git»). */
  supervisor: TurnSupervisor | null
  git: CandidateGit | null
  drivers: AgentDriverRegistry
  backends: readonly LlmBackend[]
  adapter: (stack: SiteStack) => SiteAdapter
  leases: Pick<SiteLeaseStore, 'inspect'>
  /** The runtime of turn sandboxes (SANDBOX_RUNTIME). */
  runtime: SandboxRuntime
  previews: PreviewAddress | null
  settlement: PassSettlement
  live: LivePasses
  queue: JobQueue
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
  cancelPollMs?: number
}

/** A retry of the pass a busy site or pool sent back, and when. */
interface Retry {
  delayMs: number
}

/**
 * One pass of the agent from the `agent-turns` queue (roadmap N11/N12; docs/plan/53-chat-
 * preview-release.md, R3): take the task, check its reserve, plan the turn, run it under the
 * supervisor and end it with PassSettlement. A pass whose turn is still assigned when `run`
 * throws is left alone: recovery may finish it, and the sweep ends it from the journal (spec
 * §7, «назначение хода закрыто»). Logs carry ids only.
 */
export class PassRunner {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: PassRunnerDependencies) {
    this.#logger = deps.logger ?? new Logger('PassRunner')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: AgentTurnJob): Promise<void> {
    const claimed = await claimQueuedTask(this.deps.db, {
      taskId: job.taskId,
      attempt: job.attempt,
    })
    if (!claimed) {
      this.#logger.log(`pass_skipped task=${job.taskId} attempt=${job.attempt}`)
      return
    }
    const controller = this.deps.live.enter(job.taskId)
    const ref: PassRef = { taskId: job.taskId, attempt: job.attempt, turnNo: claimed.turnNo }
    // A live pass keeps its task out of `queued`, so the claim above cannot succeed beside one;
    // should it ever, that pass ends the task, never a second one.
    if (!controller) return
    try {
      await this.#pass(job, ref, claimed.billable, controller)
    } finally {
      this.deps.live.leave(job.taskId, controller)
    }
  }

  /**
   * «Отменить» while a pass is preparing or running: the live pass is stopped and ends
   * `cancelled` itself (its settlement reads the press again under the lock of the task). A pass
   * this process does not run — its core died before the turn was assigned — is ended here; one
   * whose turn recovery holds is ended by the sweep. A dialog whose pass ended otherwise before
   * the press reached it waits now, and is closed as web closes a waiting dialog.
   */
  async cancel(job: AgentTurnCancelJob): Promise<void> {
    if (this.deps.live.abort(job.taskId)) return
    const task = await this.deps.db.task.findUnique({
      where: { id: job.taskId },
      select: { status: true, attempt: true, turnNo: true },
    })
    if (!task) return
    const answer =
      task.status === 'preparing' || task.status === 'running'
        ? await this.deps.settlement.settle(
            { taskId: job.taskId, attempt: task.attempt, turnNo: task.turnNo },
            { kind: 'cancelled', turn: task.status === 'running' ? task.turnNo : null },
          )
        : await this.deps.settlement.cancelWaiting(job.taskId)
    this.#logger.log(`pass_cancel task=${job.taskId} answer=${answer}`)
  }

  async #pass(
    job: AgentTurnJob,
    ref: PassRef,
    billable: boolean,
    controller: AbortController,
  ): Promise<void> {
    const { settlement } = this.deps
    // Spec §20 «Задачи до биллинга»: a task that should hold a reserve and holds none is never
    // run, in any environment — the second check after the one of the procedure that queued it.
    if (billable && !(await this.#holdsReserve(job))) {
      this.#logger.warn(`pass_without_reserve task=${job.taskId} attempt=${job.attempt}`)
      await settlement.settle(ref, { kind: 'refused', code: 'unavailable' })
      return
    }
    const supervisor = this.deps.supervisor
    const git = this.deps.git
    if (!supervisor || !git) {
      await settlement.settle(ref, { kind: 'refused', code: 'unavailable' })
      return
    }

    let plan: PassPlan
    try {
      plan = await this.#plan(job, ref, git)
    } catch (error) {
      const code = feedFailureOf({ ...failureFactsOf(error), policyFlagged: false })
      this.#logger.warn(`pass_unplanned task=${job.taskId} code=${code} cause=${causeOf(error)}`)
      await settlement.settle(ref, { kind: 'refused', code })
      return
    }
    if (plan.kind === 'refused') {
      await settlement.settle(ref, { kind: 'refused', code: plan.code })
      return
    }
    if (plan.kind === 'ceiling') {
      await settlement.settle(ref, { kind: 'ceiling', question: plan.question })
      return
    }
    if (plan.kind === 'branch_moved') {
      await this.#branchMoved(job, ref, plan.update)
      return
    }
    if (await this.#cancelRequested(job)) controller.abort()
    if (controller.signal.aborted) {
      await settlement.settle(ref, { kind: 'cancelled', turn: null })
      return
    }

    const watch = this.#watchCancel(job, controller)
    let ending: PassEnding | null
    let retry: Retry | null = null
    let cause: string | null = null
    try {
      const completed = await supervisor.run(plan.request, plan.policy, controller.signal)
      ending = {
        kind: 'completed',
        turn: plan.turn,
        result: completed.result,
        headSha: completed.manifest.git.headSha,
      }
    } catch (error) {
      cause = causeOf(error)
      const outcome = await this.#endingOf(error, ref, plan.turn, controller.signal)
      ending = outcome?.ending ?? null
      retry = outcome?.retry ?? null
    } finally {
      clearInterval(watch)
    }
    if (!ending) {
      this.#logger.warn(
        `pass_left_to_recovery task=${job.taskId} turn=${plan.turn} cause=${cause ?? 'unknown'}`,
      )
      return
    }
    const turnNo = await this.#turnNo(job.taskId)
    if (turnNo === null) return
    const answer = await settlement.settle({ ...ref, turnNo }, ending)
    this.#logger.log(
      `pass_settled task=${job.taskId} ending=${ending.kind} answer=${answer}${cause ? ` cause=${cause}` : ''}`,
    )
    if (ending.kind === 'busy') {
      if (answer === 'moved' && retry) await this.#requeue(job, retry)
    } else await this.#wakeSite(job, turnNo)
  }

  /**
   * The turn let the site go: the passes of other dialogs that waited for it go now, not at their
   * retry (stand R12). A wake that is not written leaves them their retry.
   */
  async #wakeSite(job: AgentTurnJob, turnNo: number): Promise<void> {
    try {
      const task = await this.deps.db.task.findUnique({
        where: { id: job.taskId },
        select: { siteId: true },
      })
      if (!task) return
      await enqueueSiteWaitingPasses(this.deps.db, {
        siteId: task.siteId,
        tag: `turn-${job.taskId}-${turnNo}`,
      })
    } catch {
      this.#logger.warn(`pass_wake_failed task=${job.taskId}`)
    }
  }

  async #plan(job: AgentTurnJob, ref: PassRef, git: CandidateGit): Promise<PassPlan> {
    const facts = await readPassFacts(
      {
        db: this.deps.db,
        adapter: this.deps.adapter,
        backends: this.deps.backends,
        previews: this.deps.previews,
      },
      {
        taskId: job.taskId,
        attempt: job.attempt,
        turnNo: ref.turnNo,
        requestEventId: job.requestEventId,
        now: this.#now(),
      },
    )
    if (!facts) return { kind: 'refused', code: 'technical' }
    const [driver] = this.deps.drivers.list()
    if (!driver) return { kind: 'refused', code: 'unavailable' }
    const repo = facts.repo
    return planTurn(facts, {
      driver,
      backends: this.deps.backends,
      runtime: this.deps.runtime,
      mainHead: () =>
        repo ? git.readBranchHead({ repo, branch: repo.defaultBranch }) : Promise.resolve(null),
      branchHead: () =>
        repo ? git.readBranchHead({ repo, branch: `agent/${job.taskId}` }) : Promise.resolve(null),
    })
  }

  /**
   * The task branch is not where the platform last left it. While an `/update` of the dialog
   * may still be moving it, the pass waits in the queue and that update is put again — it
   * finishes from the branch as it stands (CandidateRebase); otherwise nothing can publish, and
   * the pass fails before a turn spends money.
   */
  async #branchMoved(job: AgentTurnJob, ref: PassRef, update: string | null): Promise<void> {
    this.#logger.warn(`pass_branch_moved task=${job.taskId} update=${update ?? 'none'}`)
    if (update === null) {
      await this.deps.settlement.settle(ref, { kind: 'refused', code: 'technical' })
      return
    }
    const answer = await this.deps.settlement.settle(ref, { kind: 'busy', waiting: 'site' })
    if (answer !== 'moved') return
    const rebase = { taskId: job.taskId, requestEventId: update }
    await this.deps.queue
      .enqueue(AGENT_TURN_QUEUE, CANDIDATE_REBASE_JOB, rebase, {
        jobId: `${candidateRebaseDedupeKey(rebase)}:repair:${this.#now().getTime()}`,
      })
      .catch(() => this.#logger.warn(`pass_update_requeue_failed task=${job.taskId}`))
    await this.#requeue(job, { delayMs: RETRY_DELAY_MS.update })
  }

  /**
   * What a pass whose `run` threw ends in, or null while a turn of the task is still assigned:
   * then recovery owns it, and the sweep ends it.
   */
  async #endingOf(
    error: unknown,
    ref: PassRef,
    plannedTurn: number,
    signal: AbortSignal,
  ): Promise<{ ending: PassEnding; retry?: Retry } | null> {
    const { db } = this.deps
    const open = await db.turnAssignment.count({ where: { taskId: ref.taskId, finishedAt: null } })
    if (open > 0) return null
    const turnNo = await this.#turnNo(ref.taskId)
    // The turn was opened only when the task's number moved: an earlier failure has no turn.
    const turn = turnNo !== null && turnNo >= plannedTurn ? plannedTurn : null
    if (isDomainError(error)) {
      if (error.code === 'SITE_BUSY')
        return { ending: { kind: 'busy', waiting: 'site' }, retry: await this.#siteRetry(ref) }
      if (error.code === 'SUBSCRIPTION_BUSY' || error.code === 'SUBSCRIPTION_WAIT')
        return {
          ending: { kind: 'busy', waiting: 'agents' },
          retry: this.#poolRetry(error.details),
        }
    }
    if (signal.aborted) return { ending: { kind: 'cancelled', turn } }
    return {
      ending: {
        kind: 'failed',
        turn,
        ...failureFactsOf(error),
        ...(turn !== null ? await this.#journalReason(ref.taskId, turn) : {}),
      },
    }
  }

  /** The reason of the turn's last `failed` journal entry, when it has one. */
  async #journalReason(
    taskId: string,
    turn: number,
  ): Promise<Pick<Extract<PassEnding, { kind: 'failed' }>, 'journalReason'>> {
    const rows = await this.deps.db.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM task_events
      WHERE task_id = ${taskId}::uuid AND type = 'turn.lifecycle'
        AND payload->>'phase' = 'failed' AND payload->>'turn' = ${String(turn)}
      ORDER BY id DESC LIMIT 1`
    const entry = turnEvidenceSchema.safeParse(rows[0]?.payload)
    return entry.success && entry.data.reason ? { journalReason: entry.data.reason } : {}
  }

  async #turnNo(taskId: string): Promise<number | null> {
    const task = await this.deps.db.task.findUnique({
      where: { id: taskId },
      select: { turnNo: true },
    })
    return task?.turnNo ?? null
  }

  async #holdsReserve(job: AgentTurnJob): Promise<boolean> {
    const holds = await this.deps.db.creditHold.count({
      where: { taskId: job.taskId, attempt: job.attempt, status: 'active' },
    })
    return holds > 0
  }

  /** A `cancel` command written after the request of this pass. */
  async #cancelRequested(job: AgentTurnJob): Promise<boolean> {
    const rows = await this.deps.db.taskEvent.findMany({
      where: { taskId: job.taskId, type: 'feed.request', id: { gt: BigInt(job.requestEventId) } },
      select: { payload: true },
    })
    return rows.some((row) => {
      const event = readFeedRow('feed.request', row.payload)
      return event.type === 'feed.request' && event.kind === 'command' && event.command === 'cancel'
    })
  }

  /** Polls the feed for «Отменить» while the turn runs: a cancel job may wait in the queue. */
  #watchCancel(job: AgentTurnJob, controller: AbortController): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (controller.signal.aborted) return
      this.#cancelRequested(job)
        .then((requested) => {
          if (requested) controller.abort()
        })
        .catch(() => this.#logger.warn(`pass_cancel_poll_failed task=${job.taskId}`))
    }, this.deps.cancelPollMs ?? CANCEL_POLL_MS)
    timer.unref()
    return timer
  }

  /**
   * The site is busy: the pass looks again when its lease expires, and no later than in
   * `RETRY_DELAY_MS.site`. A lease ends mostly much sooner — a turn that finished early, a
   * deploy that kept its lease for half an hour and ended in a minute —, and then its holder
   * wakes the pass (`enqueueSiteWaitingPasses`); this retry is for a wake that never came.
   * Every retry moves the task `queued → preparing → queued`, so it is not more frequent.
   */
  async #siteRetry(ref: PassRef): Promise<Retry> {
    const task = await this.deps.db.task.findUnique({
      where: { id: ref.taskId },
      select: { siteId: true },
    })
    const lease = task ? await this.deps.leases.inspect(task.siteId).catch(() => null) : null
    if (!lease?.expiresAt) return { delayMs: RETRY_DELAY_MS.site }
    const left = lease.expiresAt.getTime() - lease.serverNow.getTime()
    // A release barrier outlives its lease (an attempt whose run still goes, a release held for
    // the operator): the end of the lease says nothing, and the release wakes the pass itself.
    if (lease.inflightReleaseId || left <= 0) return { delayMs: RETRY_DELAY_MS.site }
    return { delayMs: Math.min(RETRY_DELAY_MS.site, clamp(left)) }
  }

  /** The pool names when it may have an account again. */
  #poolRetry(details: unknown): Retry {
    const retryAt = (details as { retryAt?: unknown } | undefined)?.retryAt
    const at = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN
    return {
      delayMs: Number.isFinite(at) ? clamp(at - this.#now().getTime()) : RETRY_DELAY_MS.update,
    }
  }

  /**
   * The pass goes back to the queue with a delay. No database row changes here, so no outbox:
   * the job is put directly, under an id of its own (agentTurnRetryJobId). A lost retry is put
   * again by the sweep, which finds the task waiting too long.
   */
  async #requeue(job: AgentTurnJob, retry: Retry): Promise<void> {
    await this.deps.queue
      .enqueue(AGENT_TURN_QUEUE, AGENT_TURN_JOB, job, {
        jobId: agentTurnRetryJobId(job, String(this.#now().getTime())),
        delayMs: retry.delayMs,
      })
      .catch(() => this.#logger.warn(`pass_requeue_failed task=${job.taskId}`))
  }
}
