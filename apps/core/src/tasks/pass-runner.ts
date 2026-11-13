import { Logger } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import {
  claimQueuedPass,
  enqueueAgentWaitingPasses,
  enqueueSiteWaitingPasses,
  type PrismaClient,
} from '@repo/db'
import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnRetryJobId,
  CANDIDATE_REBASE_JOB,
  candidateRebaseDedupeKey,
  isDomainError,
  poolWaitIsLimitsOut,
  turnLeaseOf,
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

import type { BrowserSessions } from '../browser/browser-sessions.ts'
import { wakeStoppedPreview } from '../previews/preview-wake.ts'
import type { TurnSupervisor } from '../turns/turn-supervisor.ts'
import type { CandidateGit } from './candidate-git.ts'
import type { ChatFiles } from './chat-files.ts'
import type { DocSections } from './doc-sections.ts'
import type { LivePasses } from './live-passes.ts'
import { readPassFacts } from './pass-facts.ts'
import type { TurnCapacity } from './turn-capacity.ts'
import type { PassEnding, PassRef, PassSettlement, SettleAnswer } from './pass-settlement.ts'
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

/**
 * Passes of one workspace that run at a time by default (owner's requests of 06.11.2026: «расширь
 * количество параллельных агентов на одного пользователя до 8», and of 12.11.2026: «на одного
 * клиента запускать до 8 сендбоксов»; WORKSPACE_TURN_LIMIT): the next one waits for the agents.
 * The places of the platform (TurnCapacity) and the pool bound all the workspaces together.
 */
export const DEFAULT_WORKSPACE_TURN_LIMIT = 8

/** How many waiting passes the end of a pass wakes: of its workspace, and of the platform. */
const WAKE_WORKSPACE = 8
const WAKE_PLATFORM = 2

const clamp = (value: number) =>
  Math.min(RETRY_DELAY_MS.max, Math.max(RETRY_DELAY_MS.min, Math.round(value)))

export interface PassRunnerDependencies {
  db: PrismaClient
  /** null while no agent driver is enabled: no turn can run. */
  supervisor: TurnSupervisor | null
  /**
   * null while git is not configured: a task with a repository is refused `unavailable` (spec §20
   * «Транспорт git»), one without runs all the same (docs/plan/57-browser-tasks.md, Б7).
   */
  git: CandidateGit | null
  /**
   * The cloud browser of tasks that need one (docs/plan/57, Б18); null while no worker is
   * configured: the planner refuses such a task `unavailable`.
   */
  browser?: Pick<BrowserSessions, 'reclaim' | 'verify'> | null
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
  /**
   * Brings the files the agent made for the client into the chat after a completed pass
   * (docs/plan/66-chat-visuals.md, В8); absent — they stay with the turn's container.
   */
  chatFiles?: Pick<ChatFiles, 'deliver' | 'failPages'>
  /** The documents of the chat (docs/plan/69-pages.md, Ст19); absent — not settled here. */
  docs?: Pick<DocSections, 'settle'>
  /** WORKSPACE_TURN_LIMIT (plan 70, ВР13); DEFAULT_WORKSPACE_TURN_LIMIT when absent. */
  workspaceTurnLimit?: number
  /** The places for turns of the platform (plan 70, ВР17); absent — no bound but the pool's. */
  capacity?: Pick<TurnCapacity, 'tryAcquire'>
  now?: () => Date
  cancelPollMs?: number
  /** Counts what the pool told a pass (plan 71, §4.4): metrics without ids. */
  pool?: { limitsOut(): void }
}

/**
 * How a pass that held a place left it: `ended` — its turn ran, or it was refused, cancelled or
 * left to recovery; `sent_back` — the pool or the site sent it back to the queue before its turn.
 */
type PassEnd = 'ended' | 'sent_back'

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
    // Of nine passes of one workspace that claim at once, exactly its limit go (plan 70, ВР13).
    const claimed = await claimQueuedPass(this.deps.db, {
      taskId: job.taskId,
      attempt: job.attempt,
      workspaceLimit: this.deps.workspaceTurnLimit ?? DEFAULT_WORKSPACE_TURN_LIMIT,
    })
    if (claimed === 'full') {
      // It waits for the agents, holding no worker: the end of a pass of its workspace wakes it.
      const answer = await this.deps.settlement.waitForAgents(job)
      this.#logger.log(
        `pass_settled task=${job.taskId} ending=busy answer=${answer} cause=WORKSPACE_FULL`,
      )
      if (answer === 'moved') await this.#requeue(job, { delayMs: RETRY_DELAY_MS.update })
      return
    }
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
      await this.#wakePreview(job.taskId)
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
      select: { status: true, attempt: true, turnNo: true, needsBrowser: true },
    })
    if (!task) return
    // «Остановить» of a task in the browser: what it saved is read on the site first, and the
    // feed tells the client what stays there — nothing on the site is deleted (Б24).
    if (task.needsBrowser) await this.deps.browser?.verify(job.taskId)
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
    // A place for the turn on the platform (plan 70, ВР17): without one the pass waits for the
    // agents and gives its worker up; the end of any pass wakes it.
    const release = this.deps.capacity ? this.deps.capacity.tryAcquire() : () => {}
    if (!release) {
      const answer = await settlement.settle(ref, { kind: 'busy', waiting: 'agents' })
      this.#logger.log(
        `pass_settled task=${job.taskId} ending=busy answer=${answer} cause=CAPACITY_FULL`,
      )
      if (answer === 'moved') await this.#requeue(job, { delayMs: RETRY_DELAY_MS.update })
      return
    }
    let ended: PassEnd = 'ended'
    try {
      ended = await this.#turnOf(job, ref, billable, controller)
    } finally {
      release()
      // Only a pass that ended its turn freed a place for the others. One the pool or the site
      // sent back took none of theirs and is itself among those waiting: waking them ran it again
      // at once, a new turn every second (the chat of 13.11.2026). Its retry is its only one.
      if (ended === 'ended') await this.#wakeAgents(job, ref.turnNo)
    }
  }

  async #turnOf(
    job: AgentTurnJob,
    ref: PassRef,
    billable: boolean,
    controller: AbortController,
  ): Promise<PassEnd> {
    const { settlement } = this.deps
    const supervisor = this.deps.supervisor
    if (!supervisor) {
      await settlement.settle(ref, { kind: 'refused', code: 'unavailable' })
      return 'ended'
    }

    let plan: PassPlan
    try {
      plan = await this.#plan(job, ref)
    } catch (error) {
      const code = feedFailureOf({ ...failureFactsOf(error), policyFlagged: false })
      this.#logger.warn(`pass_unplanned task=${job.taskId} code=${code} cause=${causeOf(error)}`)
      await settlement.settle(ref, { kind: 'refused', code })
      return 'ended'
    }
    if (plan.kind === 'refused') {
      await settlement.settle(ref, { kind: 'refused', code: plan.code })
      return 'ended'
    }
    if (plan.kind === 'ceiling') {
      await settlement.settle(ref, { kind: 'ceiling', question: plan.question })
      return 'ended'
    }
    if (plan.kind === 'branch_moved') {
      await this.#branchMoved(job, ref, plan.update)
      return 'sent_back'
    }
    const browser = plan.requirements.browser
    if (await this.#cancelRequested(job)) controller.abort()
    if (controller.signal.aborted) {
      await this.#settle(ref, { kind: 'cancelled', turn: null }, browser)
      return 'ended'
    }
    // The browser lives with the task, not with the turn (Б18), and starts with the agent's first
    // `web_*` call (docs/plan/61, К11): a live one only comes back to the agent here.
    if (browser) {
      await this.deps.browser?.reclaim(job.taskId, controller.signal)
      if (controller.signal.aborted) {
        await this.#settle(ref, { kind: 'cancelled', turn: null }, true)
        return 'ended'
      }
    }

    const watch = this.#watchCancel(job, controller)
    let ending: PassEnding | null
    let retry: Retry | null = null
    let cause: string | null = null
    let outbox: Uint8Array | undefined
    let refusesText: ((text: string) => 'turn_key' | 'client_value' | null) | null = null
    try {
      const completed = await supervisor.run(plan.request, plan.policy, controller.signal)
      outbox = completed.outbox
      refusesText = completed.refusesText
      const git = completed.manifest.git
      ending = {
        kind: 'completed',
        turn: plan.turn,
        result: completed.result,
        // A turn without a repository published nothing (plan 57, Б4).
        ...(git ? { headSha: git.headSha } : {}),
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
      return 'ended'
    }
    const turnNo = await this.#turnNo(job.taskId)
    if (turnNo === null) return 'ended'
    // The sections of documents the chat wrote are checked with what only the turn knew (Ст19),
    // before the answer reaches the client: a document the answer speaks of shows what passed.
    if (ending.kind === 'completed' && refusesText)
      await this.deps.docs?.settle(job.taskId, ending.turn, refusesText)
    const answer = await this.#settle({ ...ref, turnNo }, ending, browser)
    this.#logger.log(
      `pass_settled task=${job.taskId} ending=${ending.kind} answer=${answer}${cause ? ` cause=${cause}` : ''}`,
    )
    // The pages a failed or cancelled turn named are told at once (docs/plan/69-pages.md, Ст6).
    if (
      (ending.kind === 'failed' || ending.kind === 'cancelled') &&
      answer === 'moved' &&
      ending.turn !== null
    )
      await this.deps.chatFiles?.failPages(job.taskId, ending.turn)
    // After the answer of the turn, so that its files stand below it in the chat. A turn without
    // files still settles the pages it named (docs/plan/69-pages.md, Ст6).
    if (ending.kind === 'completed' && answer === 'moved')
      await this.deps.chatFiles?.deliver({
        taskId: job.taskId,
        turn: ending.turn,
        outbox: outbox ?? null,
      })
    if (ending.kind === 'busy') {
      if (answer === 'moved' && retry) await this.#requeue(job, retry)
      return 'sent_back'
    }
    await this.#wakeSite(job, turnNo)
    return 'ended'
  }

  /**
   * Ends the pass. A task in the browser has what it saved on the site read again first (Б23,
   * Б24): the ending reads the checkpoints as the worker recorded them — best effort, the last
   * recorded state stands when the worker does not answer.
   */
  async #settle(ref: PassRef, ending: PassEnding, browser: boolean): Promise<SettleAnswer> {
    if (browser && ['completed', 'failed', 'cancelled'].includes(ending.kind))
      await this.deps.browser?.verify(ref.taskId)
    return this.deps.settlement.settle(ref, ending)
  }

  /**
   * The dialog's preview, stopped while no one used it (owner's answer of 26.10.2026), is built
   * again for this pass: asked here, before the turn is planned, so the build runs beside the
   * preparation of the sandbox. A wake that is not written leaves it to the sweep of previews.
   */
  async #wakePreview(taskId: string): Promise<void> {
    try {
      if (await wakeStoppedPreview(this.deps.db, taskId))
        this.#logger.log(`pass_preview_woken task=${taskId}`)
    } catch {
      this.#logger.warn(`pass_preview_wake_failed task=${taskId}`)
    }
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
      // Nobody waits for a task without a site: its lease is its own.
      if (!task?.siteId) return
      await enqueueSiteWaitingPasses(this.deps.db, {
        siteId: task.siteId,
        tag: `turn-${job.taskId}-${turnNo}`,
      })
    } catch {
      this.#logger.warn(`pass_wake_failed task=${job.taskId}`)
    }
  }

  async #plan(job: AgentTurnJob, ref: PassRef): Promise<PassPlan> {
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
    // Only a task with a repository needs git (plan 57, Б7).
    const git = this.deps.git
    if (facts.requirements.repository && !git) return { kind: 'refused', code: 'unavailable' }
    const repo = facts.repo
    return planTurn(facts, {
      driver,
      backends: this.deps.backends,
      runtime: this.deps.runtime,
      browser: Boolean(this.deps.browser),
      mainHead: () =>
        repo && git
          ? git.readBranchHead({ repo, branch: repo.defaultBranch })
          : Promise.resolve(null),
      branchHead: () =>
        repo && git
          ? git.readBranchHead({ repo, branch: `agent/${job.taskId}` })
          : Promise.resolve(null),
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
    let facts = failureFactsOf(error)
    if (isDomainError(error)) {
      if (error.code === 'SITE_BUSY')
        return { ending: { kind: 'busy', waiting: 'site' }, retry: await this.#siteRetry(ref) }
      if (error.code === 'SUBSCRIPTION_BUSY' || error.code === 'SUBSCRIPTION_WAIT') {
        // A pool that names a time further away than a pass waits for has its limits out (a
        // window of the plan, an empty balance — owner's decision of 10.11.2026): the client is
        // told so and the dialog stays open, instead of a queue that looks short and lasts hours.
        // A busy pool names a minute, and a cooldown or a probe stays under the limit: they wait.
        const retryAt = this.#poolRetryAt(error.details)
        if (
          error.code === 'SUBSCRIPTION_WAIT' &&
          retryAt !== null &&
          poolWaitIsLimitsOut(retryAt, this.#now())
        ) {
          this.#logger.warn(
            `pass_limits_out task=${ref.taskId} turn=${turn ?? 'none'} retry_at=${retryAt.toISOString()}`,
          )
          this.deps.pool?.limitsOut()
          facts = { ...facts, detailReason: 'agent_limits' }
        } else
          return {
            ending: { kind: 'busy', waiting: 'agents' },
            retry: this.#poolRetry(error.details),
          }
      }
    }
    if (signal.aborted) return { ending: { kind: 'cancelled', turn } }
    return {
      ending: {
        kind: 'failed',
        turn,
        ...facts,
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

  /**
   * The pass gave its place back: the passes that waited for the agents go now, not at their
   * retry (plan 70, ВР15) — those of its workspace, whose limit it freed, then the oldest of the
   * platform. A wake that is not written leaves them their retry.
   */
  async #wakeAgents(job: AgentTurnJob, turnNo: number): Promise<void> {
    try {
      const task = await this.deps.db.task.findUnique({
        where: { id: job.taskId },
        select: { workspaceId: true },
      })
      const tag = `pass-${job.taskId}-${job.attempt}-${turnNo}`
      if (task)
        await enqueueAgentWaitingPasses(this.deps.db, {
          workspaceId: task.workspaceId,
          limit: WAKE_WORKSPACE,
          tag,
        })
      await enqueueAgentWaitingPasses(this.deps.db, { limit: WAKE_PLATFORM, tag })
    } catch {
      this.#logger.warn(`pass_wake_failed task=${job.taskId}`)
    }
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
      select: { siteId: true, needsRepository: true },
    })
    // The turn's own row: a chat with the code that waited for a release of its site finds it
    // free, and the release wakes the pass when it ends.
    const lease = task
      ? await this.deps.leases.inspect(turnLeaseOf({ id: ref.taskId, ...task })).catch(() => null)
      : null
    if (!lease?.expiresAt) return { delayMs: RETRY_DELAY_MS.site }
    const left = lease.expiresAt.getTime() - lease.serverNow.getTime()
    // A release barrier outlives its lease (an attempt whose run still goes, a release held for
    // the operator): the end of the lease says nothing, and the release wakes the pass itself.
    if (lease.inflightReleaseId || left <= 0) return { delayMs: RETRY_DELAY_MS.site }
    return { delayMs: Math.min(RETRY_DELAY_MS.site, clamp(left)) }
  }

  /** The time the pool names for when it may have an account again, or null when it names none. */
  #poolRetryAt(details: unknown): Date | null {
    const retryAt = (details as { retryAt?: unknown } | undefined)?.retryAt
    const at = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN
    return Number.isFinite(at) ? new Date(at) : null
  }

  /** The pool names when it may have an account again. */
  #poolRetry(details: unknown): Retry {
    const at = this.#poolRetryAt(details)
    return {
      delayMs: at ? clamp(at.getTime() - this.#now().getTime()) : RETRY_DELAY_MS.update,
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
        // After a wait of the pool the passes come back in the order of their tiers (plan 71).
        ...(job.priority === undefined ? {} : { priority: job.priority }),
      })
      .catch(() => this.#logger.warn(`pass_requeue_failed task=${job.taskId}`))
  }
}
