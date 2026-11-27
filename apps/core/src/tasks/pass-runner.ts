import { Logger } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { claimQueuedPass, enqueueAgentWaitingPasses, type PrismaClient } from '@repo/db'
import {
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnRetryJobId,
  isDomainError,
  poolWaitIsLimitsOut,
  readFeedRow,
  turnEvidenceSchema,
  type AgentTurnCancelJob,
  type AgentTurnJob,
  type JobQueue,
  type LlmBackend,
  type MemoryPassEvidence,
  type SandboxRuntime,
  type SiteLeaseStore,
} from '@repo/domain'

import type { BrowserSessions } from '../browser/browser-sessions.ts'
import type { PoolProbeClient } from '../llm/pool-probe-client.ts'
import type { CompletedTurn, TurnSupervisor } from '../turns/turn-supervisor.ts'
import type { ArtifactOutbox } from '../artifacts/artifact-outbox.ts'
import type { ChatFiles } from './chat-files.ts'
import type { ArtifactChecks } from '../artifacts/artifact-checks.ts'
import type { MemoryChanges } from './memory-changes.ts'
import type { PageChanges } from './page-changes.ts'
import type { RepoChanges, RepoTurnPreparer } from './repo-turns.ts'
import type { ScheduleChanges } from './schedule-changes.ts'
import type { LivePasses } from './live-passes.ts'
import { readPassFacts } from './pass-facts.ts'
import type { TurnCapacity } from './turn-capacity.ts'
import type { PassEnding, PassRef, PassSettlement, SettleAnswer } from './pass-settlement.ts'
import { causeOf, failureFactsOf, feedFailureOf } from './turn-outcome.ts'
import { planTurn, type PassPlan } from './turn-planner.ts'

/** How often a running pass looks for the client's «Отменить» in the feed. */
export const CANCEL_POLL_MS = 5_000
/** How often a running turn checks the sections of documents it wrote (docs/plan/74, Д2). */
export const LIVE_DOC_CHECK_MS = 1_500
/** How long a live check trusts the values of the variables it read from Vault. */
export const LIVE_DOC_VALUES_MS = 15_000

/**
 * Back to the queue: the retry of a busy lease or pool waits at least this much and at most that.
 * `site` is the latest a pass whose lease is held looks again: a holder that died.
 */
const RETRY_DELAY_MS = Object.freeze({
  min: 10_000,
  site: 2 * 60_000,
  /** A pool that names no time, or a full workspace: nothing else wakes the pass. */
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
   * The cloud browser of tasks that need one (docs/plan/57, Б18); null while no worker is
   * configured: the planner refuses such a task `unavailable`.
   */
  browser?: Pick<BrowserSessions, 'reclaim' | 'verify'> | null
  drivers: AgentDriverRegistry
  backends: readonly LlmBackend[]
  /** The probe of the pool before a pass leaves a plan the forecast alone closed (`poolHasRoom`). */
  poolProbe?: PoolProbeClient
  leases: Pick<SiteLeaseStore, 'inspect'>
  /** The runtime of turn sandboxes (SANDBOX_RUNTIME). */
  runtime: SandboxRuntime
  settlement: PassSettlement
  live: LivePasses
  queue: JobQueue
  logger?: { log(message: string): void; warn(message: string): void }
  /**
   * Brings the files the agent made for the client into the chat after a completed pass
   * (docs/plan/66-chat-visuals.md, В8); absent — they stay with the turn's container.
   */
  chatFiles?: Pick<ChatFiles, 'deliver' | 'failPages'>
  /** The files and imports of the outbox the artifacts reserved (docs/plan/88-artifacts.md, §7.5). */
  artifactOutbox?: Pick<ArtifactOutbox, 'take'>
  /**
   * The agent's writes in artifacts (docs/plan/88-artifacts.md, Ар16, Ар19): checked while the
   * turn runs and at its end; a turn that failed or was cancelled checks what it can and drops the
   * rest. Absent — they wait for the sweep, which drops them.
   */
  artifacts?: Pick<ArtifactChecks, 'checkLive' | 'settle' | 'fail'> &
    Partial<Pick<ArtifactChecks, 'tell'>>
  /** What the turn asked of the pages besides versions (docs/plan/73-pages-sites.md, Дер23). */
  pageChanges?: Pick<PageChanges, 'apply'>
  /** What the turn asked of the memory of its chat (docs/plan/84-projects.md, ПР18). */
  memoryChanges?: Pick<MemoryChanges, 'apply' | 'fail'>
  /**
   * The repository of the chat's project, prepared before the turn (docs/plan/84-projects.md,
   * §4.3, step 3); absent — the chat goes without it.
   */
  repositories?: Pick<RepoTurnPreparer, 'prepare'>
  /** What a turn with a repository left, told in the chat (§4.3, step 8). */
  repoChanges?: Pick<RepoChanges, 'apply' | 'fail'>
  /**
   * What the turn asked of the scheduled tasks of its author (docs/plan/82-scheduled-tasks.md,
   * Зп33): applied after a completed turn, refused at once after one that failed or was cancelled.
   */
  scheduleChanges?: Pick<ScheduleChanges, 'apply' | 'failTurn'>
  /** WORKSPACE_TURN_LIMIT (plan 70, ВР13); DEFAULT_WORKSPACE_TURN_LIMIT when absent. */
  workspaceTurnLimit?: number
  /** The places for turns of the platform (plan 70, ВР17); absent — no bound but the pool's. */
  capacity?: Pick<TurnCapacity, 'tryAcquire'>
  now?: () => Date
  cancelPollMs?: number
  /** LIVE_DOC_CHECK_MS when absent (docs/plan/74, Д2). */
  liveDocCheckMs?: number
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
 * One pass of the agent from the `agent-turns` queue (roadmap N11/N12): take the task, check its reserve, plan the turn, run it under the
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
      requestEventId: job.requestEventId,
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
    const ref: PassRef = {
      taskId: job.taskId,
      attempt: job.attempt,
      turnNo: claimed.turnNo,
      requestEventId: job.requestEventId,
    }
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
      // Only a pass that ended frees a place for good. One the pool or the site sent back held
      // its place for a moment and waits again — after the pool, among those it would wake:
      // waking them ran it again at once, a new turn every second (the chat of 13.11.2026). Its
      // retry is its only one; a pass refused while it held the place keeps its own retry too.
      if (ended === 'ended') await this.#wakeAgents(job, ref.turnNo)
    }
  }

  /**
   * The sections of documents and the writes in artifacts the turn makes, checked while it runs
   * (docs/plan/74, Д2; docs/plan/88-artifacts.md, Ар19): every `LIVE_DOC_CHECK_MS` once the turn
   * holds its keys and values, one check at a time; what passed is shown at once. The end of the
   * turn checks what is left, as before; `refuses()` gives it to a turn that did not complete.
   */
  #liveDocs(taskId: string, turn: number) {
    type Refuses = (text: string) => 'turn_key' | 'client_value' | null
    const checks = [this.deps.artifacts?.checkLive.bind(this.deps.artifacts)].filter(
      (each) => each !== undefined,
    )
    let timer: ReturnType<typeof setInterval> | null = null
    let running: Promise<void> | null = null
    let stopped = false
    let refusal: (() => Promise<Refuses>) | null = null
    // The values the client may change while the turn runs are read again every so often; a
    // Vault that does not answer skips the tick — the end of the turn checks what is left.
    let held: { refuses: Refuses; at: number } | null = null
    const fresh = async (): Promise<Refuses> => {
      if (held && Date.now() - held.at < LIVE_DOC_VALUES_MS) return held.refuses
      const refuses = await refusal!()
      held = { refuses, at: Date.now() }
      return refuses
    }
    const tick = () => {
      if (running || stopped || checks.length === 0 || !refusal) return
      running = fresh()
        .then(async (refuses) => {
          if (stopped) return
          await Promise.all(checks.map((check) => check(taskId, turn, refuses)))
        })
        .catch(() => undefined)
        .finally(() => {
          running = null
        })
    }
    return {
      arm: (armed: () => Promise<Refuses>) => {
        if (stopped || timer) return
        refusal = armed
        if (checks.length === 0) return
        timer = setInterval(tick, this.deps.liveDocCheckMs ?? LIVE_DOC_CHECK_MS)
        timer.unref?.()
      },
      stop: async () => {
        stopped = true
        if (timer) clearInterval(timer)
        await running
      },
      /** The turn's own check, if it got that far and Vault answers; null — nothing to check with. */
      refuses: async (): Promise<Refuses | null> =>
        refusal ? await fresh().catch(() => null) : null,
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
      await settlement.settle(ref, plan)
      return 'ended'
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
    const live = this.#liveDocs(job.taskId, plan.turn)
    let ending: PassEnding | null
    let retry: Retry | null = null
    let cause: string | null = null
    let outbox: Uint8Array | undefined
    let refusesText: ((text: string) => 'turn_key' | 'client_value' | null) | null = null
    let evidence: MemoryPassEvidence | undefined
    let repository: CompletedTurn['repository']
    try {
      const completed = await supervisor.run(plan.request, plan.policy, controller.signal, {
        onArmed: live.arm,
      })
      outbox = completed.outbox
      refusesText = completed.refusesText
      evidence = completed.evidence
      repository = completed.repository
      const repoHead =
        repository && !repository.refusal && repository.headSha && plan.request.repository
          ? { baseSha: repository.baseSha, headSha: repository.headSha }
          : null
      ending = {
        kind: 'completed',
        turn: plan.turn,
        result: completed.result,
        ...(repoHead ? { repoHead } : {}),
      }
    } catch (error) {
      cause = causeOf(error)
      const outcome = await this.#endingOf(error, ref, plan.turn, controller.signal)
      ending = outcome?.ending ?? null
      retry = outcome?.retry ?? null
    } finally {
      clearInterval(watch)
      await live.stop()
    }
    if (!ending) {
      this.#logger.warn(
        `pass_left_to_recovery task=${job.taskId} turn=${plan.turn} cause=${cause ?? 'unknown'}`,
      )
      return 'ended'
    }
    const turnNo = await this.#turnNo(job.taskId)
    if (turnNo === null) return 'ended'
    // What the turn put from its outbox into artifacts (docs/plan/88-artifacts.md, §7.5): its
    // imports are writes of the agent the check below reads; a turn that did not complete only
    // closes them. The names they took are no files of the chat.
    const takenByArtifacts =
      (await this.deps.artifactOutbox?.take({
        taskId: job.taskId,
        turn: 'turn' in ending && ending.turn !== null ? ending.turn : plan.turn,
        outbox: ending.kind === 'completed' ? (outbox ?? null) : null,
      })) ?? new Set<string>()
    // The sections of documents the chat wrote are checked with what only the turn knew (Ст19),
    // before the answer reaches the client: a document the answer speaks of shows what passed.
    if (ending.kind === 'completed' && refusesText) {
      await this.deps.artifacts?.settle(job.taskId, ending.turn, refusesText)
    }
    // A turn that did not complete — or completed without the values to check with — checks its
    // writes in artifacts with what it held, if it got so far, and drops the rest; its claims end
    // (Ар16): nothing waits for the collector, nothing holds a block.
    if (ending.kind !== 'completed' || !refusesText)
      await this.deps.artifacts?.fail(
        job.taskId,
        'turn' in ending ? ending.turn : null,
        await live.refuses(),
      )
    const answer = await this.#settle({ ...ref, turnNo }, ending, browser)
    this.#logger.log(
      `pass_settled task=${job.taskId} ending=${ending.kind} answer=${answer}${cause ? ` cause=${cause}` : ''}`,
    )
    // The pages a failed or cancelled turn named are told at once (docs/plan/69-pages.md, Ст6).
    if (
      (ending.kind === 'failed' || ending.kind === 'cancelled') &&
      answer === 'moved' &&
      ending.turn !== null
    ) {
      // Each of these never throws and touches only its own rows: they close side by side.
      await Promise.all([
        this.deps.chatFiles?.failPages(job.taskId, ending.turn),
        // What it asked of the memory is never applied (§4.3, step 9), nor its proposal of a
        // merge request shown.
        this.deps.memoryChanges?.fail(job.taskId, ending.turn),
        this.deps.repoChanges?.fail(job.taskId, ending.turn),
        // And the changes of the scheduled tasks it reserved (Зп33): «ответ агента оборвался».
        this.deps.scheduleChanges?.failTurn(job.taskId, ending.turn),
      ])
    }
    // The artifacts the turn made or changed stand below its answer (Ар46).
    if (ending.kind === 'completed' && answer === 'moved')
      await this.deps.artifacts?.tell?.(job.taskId, ending.turn)
    // After the answer of the turn, so that its files stand below it in the chat. A turn without
    // files still settles the pages it named (docs/plan/69-pages.md, Ст6).
    if (ending.kind === 'completed' && answer === 'moved')
      await this.deps.chatFiles?.deliver({
        taskId: job.taskId,
        turn: ending.turn,
        outbox: outbox ?? null,
        taken: takenByArtifacts,
      })
    // Then the changes the turn asked of its pages, after their versions: a page renamed or moved
    // in the turn keeps the version the turn gave it (Дер23).
    if (ending.kind === 'completed' && answer === 'moved' && refusesText) {
      await this.deps.pageChanges?.apply(job.taskId, ending.turn, refusesText)
      // The scheduled tasks the turn set up or changed, checked with what only the turn knew (Зп33).
      await this.deps.scheduleChanges?.apply(job.taskId, ending.turn, refusesText)
    }
    // Last, the notes of memory (docs/plan/84-projects.md, §4.3, step 8): «Запомнено» stands after
    // the answer. Without the values of the client they are closed failed, never applied unchecked.
    if (ending.kind === 'completed' && answer === 'moved')
      await this.deps.memoryChanges?.apply(job.taskId, ending.turn, refusesText, {
        remember: plan.remember,
        unattended: plan.unattended,
        ...(evidence ? { evidence } : {}),
        repository: plan.requirements.repository,
      })
    // Then the changes of the repository (§4.3, step 8): the card «Изменения в ветке», or why
    // they were not kept. The commit itself was published by the turn (ПР12).
    if (ending.kind === 'completed' && answer === 'moved' && repository && plan.request.repository)
      await this.deps.repoChanges?.apply(job.taskId, ending.turn, repository, {
        projectRepositoryId: plan.request.repository.projectRepositoryId,
        branch: plan.request.repository.branch,
        mode: plan.request.repository.mode,
      })
    if (ending.kind === 'busy') {
      // Another end of the task came first (a cancel, which wakes nobody): this one ended it.
      if (answer !== 'moved') return 'ended'
      if (retry) await this.#requeue(job, retry)
      return 'sent_back'
    }
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

  async #plan(job: AgentTurnJob, ref: PassRef): Promise<PassPlan> {
    const facts = await readPassFacts(
      {
        db: this.deps.db,
        backends: this.deps.backends,
        ...(this.deps.poolProbe ? { poolProbe: this.deps.poolProbe } : {}),
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
    // The repository of the chat's project: fetched, its base chosen and its bundle built before
    // the plan (ПР12). A failure throws: the pass does not start, its reserve goes back.
    const repository =
      facts.repositoryRow && this.deps.repositories
        ? await this.deps.repositories.prepare(job.taskId, facts.repositoryRow)
        : null
    return planTurn(
      { ...facts, repository },
      {
        driver,
        backends: this.deps.backends,
        runtime: this.deps.runtime,
        browser: Boolean(this.deps.browser),
      },
    )
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
   * The lease of the chat is held (a turn of it a died core left, docs/plan/83-remove-projects.md,
   * БП6): the pass looks again when that lease expires, and no later than in `RETRY_DELAY_MS.site`.
   */
  async #siteRetry(ref: PassRef): Promise<Retry> {
    const lease = await this.deps.leases.inspect(ref.taskId).catch(() => null)
    if (!lease?.expiresAt) return { delayMs: RETRY_DELAY_MS.site }
    const left = lease.expiresAt.getTime() - lease.serverNow.getTime()
    if (left <= 0) return { delayMs: RETRY_DELAY_MS.site }
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
