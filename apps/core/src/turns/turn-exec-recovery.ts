import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'
import {
  conflict,
  execLost,
  isDomainError,
  runEnvValues,
  TURN_PUBLICATION_GRACE_MS,
  withTimeout,
  withTurnCredentials,
  type AgentDriver,
  type AgentDriverId,
  type PreparedRun,
  type SandboxInfo,
  type SandboxLabels,
  type SiteLeaseGrant,
  type SiteLeaseStore,
  type SnapshotReference,
  type TurnAssignment,
  type TurnAssignmentOutcome,
  type TurnAssignmentStore,
  type TurnCredentialRef,
  type TurnCredentialSource,
  type TurnCredentialValues,
  type TurnEvidence,
  type TurnExecutor,
  type TurnJournal,
  type TurnPhase,
  type TurnPlan,
  type TurnTakeover,
  type TurnWorkspace,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

import { holdForRecovery, LeaseGuard } from './lease-guard.ts'
import type { LiveTurns } from './live-turns.ts'
import { TurnAttempt } from './turn-attempt.ts'
import {
  replayedTurn,
  type JournaledEvidence,
  type ReplayedTurn,
  type TurnJournalRange,
} from './turn-journal.ts'
import {
  isAmbiguousContainer,
  isBrokenCheckpoint,
  isMissingCheckpoint,
  TurnPublicationRecovery,
  type PublicationRemoval,
} from './turn-recovery.ts'
import { checkPreparedRun, type TurnSnapshotStore } from './turn-supervisor.ts'

/** Recovery passes over the unfinished assignments at start and this often. */
export const TURN_RECOVERY_INTERVAL_MS = 30_000
/** A turn recovery took over this many times without ending it waits for an operator. */
export const MAX_TURN_RECOVERY_ATTEMPTS = 2
/** How long one container of a given-up turn may take to be removed. */
const REMOVAL_MS = 2 * 60_000

const agentSteps: readonly TurnPhase[] = ['running', 'output', 'resumed']
const publicationSteps: readonly TurnPhase[] = [
  'checkpointing',
  'checkpointed',
  'destroyed',
  'publishing',
]
const doneSteps: readonly TurnPhase[] = ['completed', 'publication_recovered']

/** Only a code: messages of storage and database errors stay out of the log. */
const logged = (error: unknown) =>
  new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown')

export interface TurnExecRecoveryDependencies {
  leases: SiteLeaseStore
  /**
   * `abandon` is also told why recovery gives up a turn no runner took: the product store
   * closes the TaskTurn in the same transaction, before the `failed` entry that names it is
   * journaled (as RunnerHubDependencies). A store that keeps no TaskTurn ignores it.
   */
  assignments: TurnAssignmentStore & {
    abandon(
      id: string,
      outcome?: TurnAssignmentOutcome,
      reason?: NonNullable<TurnEvidence['reason']>,
    ): Promise<boolean>
  }
  executor: TurnExecutor
  journal: TurnJournal & { replay(range: TurnJournalRange): Promise<JournaledEvidence[]> }
  /** The driver a turn's plan names. */
  driver(id: AgentDriverId): AgentDriver
  workspace: TurnWorkspace
  snapshots: TurnSnapshotStore
  /** The subscription gateway key and MCP token of a turn whose executor lost them (P3, P6). */
  credentials: TurnCredentialSource
  /** Shared with the supervisor: a turn this process drives is never taken over. */
  live: LiveTurns
  logger?: { warn(message: string): void; error(message: string): void }
}

/** A parked turn whose journal ended and which only its site keeps open (#end). */
interface Unfreed {
  /** The epoch it ended at: moved to another one, it is recovered from its journal again. */
  epoch: number
  outcome: TurnAssignmentOutcome
}

/** A turn taken over under a newer epoch of its lease. */
interface Owner {
  grant: SiteLeaseGrant
  guard: LeaseGuard
  attempt: TurnAttempt
  /** What was left of the turn when it was taken over; 0 or less once its deadline passed. */
  remainingMs: number
}

/**
 * Takes over the turns a core left unfinished — spec §8 «Восстановление незавершённого хода».
 * At start and every 30 seconds it reads the unfinished assignments this process does not
 * drive, replays each one's journal over its epochs and acts on the step it reached: a turn
 * whose agent may have started is removed, a running one resumed, a quiesced one captured
 * again, a checkpointed one published. The site is held and reclaimed under a newer epoch for
 * what is left of the turn: its deadline is never extended. Zombie owners are fenced by that
 * epoch, zombie runners by their session. The site is freed early only with proof that the
 * turn's container is gone; otherwise it waits for the turn's deadline plus the grace, by which
 * the VM's watchdog removed the container.
 */
export class TurnExecRecovery {
  readonly #running = new Map<string, Promise<void>>()
  /** Kept while the assignment is unfinished; a revoke that failed is forgotten after its pass. */
  readonly #revocations = new Map<string, { settled: Promise<void>; failed: boolean }>()
  /** Left to an operator: this process does not try them again. */
  readonly #parked = new Set<string>()
  /** The parked turns a pass still asks the lease store about, and nothing else (#end). */
  readonly #unfreed = new Map<string, Unfreed>()
  readonly #publication: TurnPublicationRecovery
  readonly #logger: { warn(message: string): void; error(message: string): void }
  readonly #warn: ThrottledLog
  #timer: NodeJS.Timeout | undefined
  #pass: Promise<void> | undefined

  constructor(private readonly deps: TurnExecRecoveryDependencies) {
    this.#publication = new TurnPublicationRecovery(deps)
    this.#logger = deps.logger ?? new Logger('TurnRecovery')
    this.#warn = throttledLogger((line) => this.#logger.warn(line))
  }

  /** A pass now and then every `intervalMs`. */
  start(intervalMs = TURN_RECOVERY_INTERVAL_MS): void {
    if (this.#timer) return
    const pass = () => {
      this.#pass ??= this.tick()
        .catch((error: unknown) => this.#warn('turn recovery pass', logged(error)))
        .finally(() => {
          this.#pass = undefined
        })
    }
    this.#timer = setInterval(pass, intervalMs)
    this.#timer.unref()
    pass()
  }

  /** Stops the passes. Recoveries under way go on: a restarted core recovers them again. */
  async stop(): Promise<void> {
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pass
  }

  /**
   * One pass: a recovery for every unfinished assignment nobody drives. It does not wait for
   * them — a resumed agent may run for the rest of its turn.
   */
  async tick(): Promise<void> {
    await this.#sweep()
    const unfinished = await this.deps.assignments.unfinished()
    this.#forgetClosed(unfinished)
    for (const assignment of unfinished) {
      if (this.#running.has(assignment.id)) continue
      let unfreed = this.#unfreed.get(assignment.id)
      // Moved to another epoch meanwhile: what was remembered of the turn no longer holds.
      if (unfreed && unfreed.epoch !== assignment.fence.epoch) {
        this.#unpark(assignment.id)
        unfreed = undefined
      }
      if (!unfreed && this.#parked.has(assignment.id)) continue
      if (!this.deps.live.enter(assignment.fence)) continue
      const recovery = (
        unfreed ? this.#endUnfreed(assignment, unfreed.outcome) : this.#recover(assignment.id)
      )
        .catch((error: unknown) => this.#warn('turn recovery', logged(error)))
        .finally(() => {
          this.deps.live.leave(assignment.fence)
          this.#running.delete(assignment.id)
          // Only a revoke that went through is remembered: the next pass sends a failed one again.
          if (this.#revocations.get(assignment.id)?.failed) this.#revocations.delete(assignment.id)
        })
      this.#running.set(assignment.id, recovery)
    }
  }

  /** What this process remembered of assignments that are closed now. */
  #forgetClosed(unfinished: readonly TurnAssignment[]): void {
    const open = new Set(unfinished.map((assignment) => assignment.id))
    for (const id of this.#revocations.keys())
      if (!open.has(id) && !this.#running.has(id)) this.#revocations.delete(id)
    for (const id of this.#unfreed.keys()) if (!open.has(id)) this.#unpark(id)
  }

  /**
   * Holds left on finished turns — a recovery stopped between closing a turn and freeing its site,
   * or lost the race with an owner that finished it — are taken off first: no pass returns to them.
   */
  async #sweep(): Promise<void> {
    const freed = await this.deps.assignments.freeOrphanedHolds().catch((error: unknown) => {
      this.#warn('turn recovery sweep', logged(error))
      return 0
    })
    if (freed > 0) this.#logger.warn(`Turn recovery freed ${freed} site(s) held for finished turns`)
  }

  /** Settles once every recovery started so far has. */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values())
  }

  async #recover(id: string): Promise<void> {
    // Read again: the pass's row may be stale, and this statement's clock times the deadline.
    const assignment = await this.deps.assignments.get(id)
    if (!assignment || assignment.outcome !== null) return
    const readAt = performance.now()
    const remainingMs = () =>
      Math.floor(
        assignment.deadlineAt.getTime() -
          assignment.serverNow.getTime() -
          (performance.now() - readAt),
      )
    let turn: ReplayedTurn
    try {
      turn = replayedTurn(
        await this.deps.journal.replay({
          siteId: assignment.fence.siteId,
          taskId: assignment.fence.taskId,
          sessionId: assignment.sessionId,
          turn: assignment.turn,
          fromEpoch: assignment.firstEpoch,
          toEpoch: assignment.fence.epoch,
        }),
      )
    } catch (error) {
      if (isDomainError(error) && error.code === 'CONFLICT')
        return this.#park(assignment, undefined, 'journal mismatch')
      throw error
    }
    const step = turn.step
    if (!step || !consistent(assignment, turn))
      return this.#park(assignment, step, 'journal mismatch')
    // Published and journaled: only the release of the site or the assignment update was lost,
    // or the release failed and its owner held the site.
    if (doneSteps.includes(step)) return this.#end(assignment, 'completed', step)
    // Written only with proof that the container is gone or after the deadline and its grace:
    // only the release of the site or the assignment update was lost. The entry names the
    // outcome, so a turn recovery gave up stays `lost`.
    if (turn.lastPhase === 'failed')
      return this.#end(assignment, turn.outcome ?? 'failed', 'failed')
    // No container reported yet: nothing to resume, only to remove, and no attempt to count.
    if (step === 'leased') return this.#vacate(assignment, turn, remainingMs())
    if (assignment.recoveryAttempts >= MAX_TURN_RECOVERY_ATTEMPTS)
      return this.#park(assignment, step, 'too many recovery attempts')
    let driver: AgentDriver
    try {
      driver = this.deps.driver(assignment.plan.driverId)
    } catch {
      return this.#park(assignment, step, 'driver unavailable')
    }
    const takeover = this.deps.executor.takeover(assignment)
    if (publicationSteps.includes(step))
      return this.#publish(assignment, turn, driver, takeover, remainingMs())
    if (!takeover) return this.#expireAfterGrace(assignment, turn, remainingMs())
    const owner = await this.#takeOver(assignment, turn, driver, takeover, remainingMs())
    if (!owner) return
    if (owner.remainingMs <= 0) return this.#giveUp(assignment, turn, owner, 'timeout')
    // Held by its owner before any checkpoint: it already gave the agent up.
    const resumable =
      turn.lastPhase !== 'recovery' && (agentSteps.includes(step) || step === 'quiesced')
    if (resumable) return this.#continue(assignment, turn, driver, takeover, owner)
    // Created or restored: the agent may have started. Nothing of it is saved.
    return this.#giveUp(assignment, turn, owner, 'run_failed')
  }

  /**
   * Holds the site at the assignment's epoch, then reclaims it under the next one for what is left
   * of the turn and moves the assignment there in the same statement. null when another owner has
   * the turn now or the takeover did not go through.
   */
  async #takeOver(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    driver: AgentDriver | undefined,
    takeover: TurnTakeover,
    remainingMs: number,
    {
      countAttempt = true,
      outcome = 'lost',
    }: {
      countAttempt?: boolean
      outcome?: TurnAssignmentOutcome
    } = {},
  ): Promise<Owner | null> {
    const phase = turn.step!
    if (!(await this.deps.leases.holdForRecovery(assignment.fence))) {
      // Released by its owner, or taken by another task after it expired: the container went
      // with the turn's deadline, and nothing can be written for the turn any more.
      this.#logger.warn(
        `Turn recovery found the site lease moved on (epoch ${assignment.fence.epoch}, phase ${phase})`,
      )
      await this.#close(assignment, outcome)
      return null
    }
    const started = performance.now()
    const taken = await this.deps.assignments
      .takeOver({
        id: assignment.id,
        fence: assignment.fence,
        ttlMs: Math.max(0, remainingMs) + TURN_PUBLICATION_GRACE_MS,
        ...(takeover.runnerSession ? { runnerSession: takeover.runnerSession } : {}),
        countAttempt,
      })
      .catch(() => null)
    if (!taken) {
      await this.#afterTakeOver(assignment, phase)
      return null
    }
    const { assignment: advanced, grant } = taken
    const guard = new LeaseGuard(
      grant,
      this.deps.leases,
      Math.max(0, remainingMs),
      undefined,
      performance.now() - started,
    )
    const attempt = new TurnAttempt(
      {
        ...this.deps,
        credentials: {
          issue: (reference, grant) => this.deps.credentials.issue(reference, grant),
          recover: (reference) => this.deps.credentials.recover(reference),
          revoke: () => this.#revoke(assignment),
        },
      },
      {
        lease: grant,
        guard,
        plan: assignment.plan,
        ...(driver ? { driver } : {}),
        sequence: turn.sequence,
        recoveredFromEpoch: assignment.fence.epoch,
        phase,
      },
    )
    attempt.assignment = advanced
    attempt.credentialRef = credentialRef(assignment)
    return { grant, guard, attempt, remainingMs }
  }

  /**
   * A takeover that was refused or did not answer: the site and the assignment moved together or
   * not at all. Finished meanwhile by its owner, which had proof — the epoch this pass held is
   * freed. Moved on because the takeover committed and only its answer was lost — that epoch is
   * held for the next pass. Otherwise the site stays held at the assignment's epoch, or another
   * recovery has it. Returns the assignment as read now.
   */
  async #afterTakeOver(
    assignment: TurnAssignment,
    phase: TurnPhase,
  ): Promise<TurnAssignment | null> {
    const now = await this.deps.assignments.get(assignment.id).catch((error: unknown) => {
      // A hold this pass left on a turn its owner finished is freed by the next pass's sweep.
      this.#warn('turn recovery read after a takeover', logged(error))
      return null
    })
    if (now && now.outcome !== null) {
      await this.#revoke(now)
      await this.#free(now).catch(() =>
        this.#logger.error(
          `Turn recovery could not free the site of a finished turn (epoch ${now.fence.epoch}, phase ${phase})`,
        ),
      )
    } else if (now && now.fence.epoch > assignment.fence.epoch)
      await holdForRecovery(this.deps.leases, now.fence, phase)
    return now
  }

  /**
   * Resumes a running agent from the journal's cursor, or captures a quiesced turn again, and
   * finishes the turn like the supervisor. A lost exec, container or credentials give the turn
   * up; any other failure before the agent is back leaves the site held for another attempt.
   */
  async #continue(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    driver: AgentDriver,
    takeover: TurnTakeover,
    { grant, guard, attempt }: Owner,
  ): Promise<void> {
    const reference = credentialRef(assignment)
    let resumed = false
    let deferred = false
    try {
      // Core checks the output and the candidate itself, whatever the executor filters; a runner
      // that outlived core still holds the keys and does not get them again.
      const values = await this.deps.credentials.recover(reference)
      if (!values) throw execLost('The turn credentials cannot be recovered')
      const run = await recoveredRun(driver, assignment.plan, turn, values)
      attempt.credentials = run.credentials
      attempt.envValues = runEnvValues(run.prepared.context)
      const execution = await guard.interruptible(
        this.deps.executor.adopt(
          {
            assignmentId: assignment.id,
            fence: grant,
            containerId: turn.containerId!,
            labels: containerLabels(assignment),
            purpose: 'work',
            remainingMs: guard.remainingMs,
            driverId: driver.id,
            credentials: run.credentials,
            ...(attempt.envValues.length ? { envValues: attempt.envValues } : {}),
            ...(takeover.holdsCredentials ? { holdsCredentials: true } : {}),
          },
          guard.signal,
        ),
      )
      if (!execution) throw execLost('The turn container is gone')
      attempt.execution = execution
      attempt.execId = turn.execId
      let events = turn.events
      if (turn.step !== 'quiesced') {
        const agent = await guard.interruptible(
          execution.attach({
            execId: turn.execId!,
            cursor: turn.cursor,
            eventCount: turn.events.length,
          }),
        )
        if (!agent) throw execLost()
        resumed = true
        await attempt.record('resumed', { cursor: turn.cursor })
        events = await attempt.follow(agent, turn.events)
      }
      resumed = true
      // Quiesce and capture are idempotent: a quiesced turn repeats them.
      await attempt.complete(events, run.prepared)
    } catch (error) {
      if (resumed) attempt.failed(error)
      else if (guard.signal.aborted && guard.reason === 'timeout') attempt.giveUp('timeout')
      else if (isDomainError(error) && ['EXEC_LOST', 'CONFLICT'].includes(error.code))
        attempt.giveUp('exec_lost')
      else if (guard.signal.aborted) attempt.failed(error)
      else deferred = true
      this.#warn('turn recovery attempt', logged(error))
    }
    if (deferred) {
      // The executor or a store did not answer: the container stays, the next pass tries again.
      await holdForRecovery(this.deps.leases, grant, turn.step!)
      guard.close()
      return
    }
    await attempt.settle(() =>
      this.#removeContainers(assignment, grant, turn, attempt.execution?.containerId),
    )
  }

  /** Removes whatever is left of the turn, then releases the site; a failed removal holds it. */
  async #giveUp(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    { grant, attempt }: Owner,
    reason: NonNullable<TurnEvidence['reason']>,
    outcome: TurnAssignmentOutcome = 'lost',
  ): Promise<void> {
    attempt.giveUp(reason, outcome)
    await attempt.settle(() => this.#removeContainers(assignment, grant, turn))
  }

  /**
   * A turn whose journal ends before any container: its owner died or gave it up while the
   * prepare might still create one. Recovery frees the site only with proof that none is left —
   * a runner prepare nobody claimed is abandoned, a known or listed container is removed by its
   * id — and otherwise waits, without holding the site, for the deadline and its grace. No
   * attempt is counted and no driver is needed.
   */
  async #vacate(assignment: TurnAssignment, turn: ReplayedTurn, remainingMs: number) {
    await this.#revoke(assignment)
    if (remainingMs + TURN_PUBLICATION_GRACE_MS <= 0) return this.#expire(assignment, turn)
    const outcome: TurnAssignmentOutcome = turn.vacating ? 'failed' : 'lost'
    const reason = turn.reason ?? 'run_failed'
    // Unclaimed after core died: no core waits for it any more, so no runner can take it (P1).
    if (assignment.executor === 'runner' && assignment.runner === null) {
      if (!(await this.deps.assignments.abandon(assignment.id, outcome, reason))) return
      await this.#journal(assignment, turn, 'failed', reason, outcome).catch(() => {})
      await this.#free(assignment)
      return
    }
    const takeover = this.deps.executor.takeover(assignment)
    // Away or silent: its container may still be created. The site is not held meanwhile.
    if (!takeover) return
    const known = turn.containerId ?? assignment.containerId
    if (!known && (await this.#listed(assignment)).length === 0) return
    const owner = await this.#takeOver(assignment, turn, undefined, takeover, remainingMs, {
      countAttempt: false,
      outcome,
    })
    if (owner) await this.#giveUp(assignment, turn, owner, reason, outcome)
  }

  /** The containers of this assignment its executor finds by labels, at its epochs. */
  async #listed(assignment: TurnAssignment): Promise<SandboxInfo[]> {
    const labels = containerLabels(assignment)
    const listed = await this.deps.executor.list({
      siteId: labels.siteId,
      taskId: labels.taskId,
      sessionId: labels.sessionId,
      turn: labels.turn,
    })
    return listed.filter(
      (info) =>
        info.labels.leaseEpoch !== undefined && info.labels.leaseEpoch >= assignment.firstEpoch,
    )
  }

  /**
   * Past the deadline and its grace the VM's watchdog removed the container. The credentials
   * are revoked, `failed` is written under the assignment's epoch — refused if another owner
   * has the site — any hold is taken off and the assignment is closed, also when the lease
   * moved on: an open one would lock this turn of the task for good.
   */
  async #expire(assignment: TurnAssignment, turn: ReplayedTurn): Promise<void> {
    await this.#revoke(assignment)
    const reason = turn.vacating ? (turn.reason ?? 'timeout') : 'timeout'
    const outcome = turn.vacating ? 'failed' : 'lost'
    await this.#journal(assignment, turn, 'failed', reason, outcome).catch(() => {})
    await this.#free(assignment)
    await this.deps.assignments.finish({
      id: assignment.id,
      epoch: assignment.fence.epoch,
      outcome,
    })
  }

  /** A runner away with a turn past its step: it may come back until the deadline and grace. */
  async #expireAfterGrace(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    remainingMs: number,
  ): Promise<void> {
    if (remainingMs + TURN_PUBLICATION_GRACE_MS > 0) return
    return this.#expire(assignment, turn)
  }

  /**
   * Every container of the assignment: the one its journal names and any its executor finds by
   * labels, including one that can no longer run anything. A container of an older assignment
   * of the turn is left to the reconciler; one newer than this epoch keeps the site held.
   */
  async #removeContainers(
    assignment: TurnAssignment,
    grant: SiteLeaseGrant,
    turn: ReplayedTurn,
    removed?: string,
  ): Promise<void> {
    const labels = containerLabels(assignment)
    const found = new Map<string, SandboxLabels>()
    const known = turn.containerId ?? assignment.containerId
    if (known) found.set(known, labels)
    const listed = await this.deps.executor.list({
      siteId: labels.siteId,
      taskId: labels.taskId,
      sessionId: labels.sessionId,
      turn: labels.turn,
    })
    for (const info of listed) {
      const epoch = info.labels.leaseEpoch
      if (epoch === undefined || epoch < assignment.firstEpoch) continue
      if (info.labels.workspaceId !== labels.workspaceId || epoch > grant.epoch)
        throw conflict('Recovery container identity is ambiguous')
      found.set(info.id, info.labels)
    }
    if (removed) found.delete(removed)
    for (const [containerId, containerLabels] of found) {
      // Removal only: null means it is gone, a foreign container keeps the site held.
      const execution = await this.deps.executor.adopt(
        {
          assignmentId: assignment.id,
          fence: grant,
          containerId,
          labels: containerLabels,
          purpose: 'removal',
        },
        AbortSignal.timeout(REMOVAL_MS),
      )
      await execution?.destroy('failed')
    }
  }

  /**
   * A committed checkpoint is published under a newer epoch (TurnPublicationRecovery), only once
   * the turn's container is known to be gone: its owner journaled the removal, recovery removes
   * it now through the executor, or the deadline and grace passed and the VM's watchdog removed
   * it. A runner that is away is waited for with the site held. A turn without a committed
   * manifest of its own waits for an operator, as does a container of another identity; a read
   * of the snapshot that failed is tried again.
   */
  async #publish(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    driver: AgentDriver,
    takeover: TurnTakeover | null,
    remainingMs: number,
  ): Promise<void> {
    await this.#revoke(assignment)
    const removal: PublicationRemoval | null =
      turn.step === 'destroyed' || turn.step === 'publishing'
        ? 'confirmed'
        : takeover
          ? 'adopt'
          : remainingMs + TURN_PUBLICATION_GRACE_MS <= 0
            ? 'expired'
            : null
    if (removal === null) return this.#awaitRunnerToPublish(assignment, turn)
    const { plan } = assignment
    const labels = plan.sandbox.labels
    const snapshot: SnapshotReference = {
      workspaceId: labels.workspaceId,
      sessionId: assignment.sessionId,
      turn: assignment.turn,
      image: plan.sandbox.image,
      driver: { id: driver.id, version: plan.driverVersion },
      home: driver.sessionState((await recoveredRun(driver, plan, turn, null)).prepared),
    }
    if (!(await this.deps.leases.holdForRecovery(assignment.fence))) {
      this.#logger.error(
        `Turn recovery cannot publish a checkpoint whose site lease moved on (epoch ${assignment.fence.epoch}, phase ${turn.step})`,
      )
      return this.#close(assignment, 'lost')
    }
    const containerId = turn.containerId ?? assignment.containerId ?? undefined
    try {
      await this.#publication.recover({
        assignmentId: assignment.id,
        heldFence: assignment.fence,
        ...(takeover?.runnerSession ? { runnerSession: takeover.runnerSession } : {}),
        snapshot,
        workspace: plan.workspace,
        removal,
        remainingMs,
        ...(containerId ? { containerId } : {}),
        labels: containerLabels(assignment),
      })
    } catch (error) {
      // Refused or unanswered takeovers leave the site held where the assignment is.
      const now = await this.#afterTakeOver(assignment, turn.step!)
      // Proven before any takeover: no committed manifest of this turn, or one that fails its own
      // checks. Any other failure to read it — storage, Vault, a timeout — keeps the site held,
      // and the next pass tries again.
      if (isMissingCheckpoint(error))
        return this.#park(assignment, turn.step, 'no committed checkpoint')
      if (isBrokenCheckpoint(error)) return this.#park(assignment, turn.step, 'broken checkpoint')
      // Another identity where the turn's container should be. Any other failed removal left
      // the new epoch held, and the next pass tries again without counting an attempt.
      if (isAmbiguousContainer(error))
        return this.#park(now ?? assignment, turn.step, 'ambiguous container')
      throw error
    }
  }

  /**
   * The runner of a checkpointed turn is away: its container may still exist. The site is held
   * at the assignment's epoch and the wait journaled once; no attempt is counted. The runner's
   * return or the deadline and grace end the wait (#publish).
   */
  async #awaitRunnerToPublish(assignment: TurnAssignment, turn: ReplayedTurn): Promise<void> {
    if (!(await this.deps.leases.holdForRecovery(assignment.fence))) {
      this.#logger.error(
        `Turn recovery cannot publish a checkpoint whose site lease moved on (epoch ${assignment.fence.epoch}, phase ${turn.step})`,
      )
      return this.#close(assignment, 'lost')
    }
    if (turn.lastPhase === 'recovery' && turn.reason === 'awaiting_runner') return
    await this.#journal(assignment, turn, 'recovery', 'awaiting_runner')
  }

  /** An entry under the assignment's own epoch, after the last one its journal holds. */
  #journal(
    assignment: TurnAssignment,
    turn: ReplayedTurn,
    phase: TurnPhase,
    reason: NonNullable<TurnEvidence['reason']>,
    outcome?: TurnEvidence['outcome'],
  ): Promise<void> {
    return this.deps.journal.record({
      fence: assignment.fence,
      sessionId: assignment.sessionId,
      turn: assignment.turn,
      sequence: turn.sequence + 1,
      phase,
      reason,
      ...(outcome ? { outcome } : {}),
    })
  }

  /**
   * Ends a turn whose journal ended: its epoch is taken off the site, held or not, and the
   * assignment closed with what the journal says. While a content write of the turn is
   * unresolved, the lease store frees nothing and the product store closes nothing (the lease
   * names its MCP writer). Such a turn is parked like any other left to an operator, with one
   * log entry, except that every pass still asks the lease store about it (#endUnfreed).
   */
  async #end(
    assignment: TurnAssignment,
    outcome: TurnAssignmentOutcome,
    phase: TurnPhase,
  ): Promise<void> {
    await this.#revoke(assignment)
    const freed = await this.#free(assignment)
    const { id, fence } = assignment
    if (await this.deps.assignments.finish({ id, epoch: fence.epoch, outcome })) return
    // Closed or taken over by another owner meanwhile: the next pass reads it again.
    if (freed || !(await this.#keepsSite(assignment))) return
    this.#parked.add(id)
    this.#unfreed.set(id, { epoch: fence.epoch, outcome })
    this.#logger.error(
      `Turn recovery left a turn to an operator: unresolved site write (epoch ${fence.epoch}, phase ${phase}, attempts ${assignment.recoveryAttempts})`,
    )
  }

  /**
   * A later pass over a turn #end parked: the lease store is asked again, and nothing else — no
   * journal is loaded and no revoke that went through is repeated. Once the site lets the epoch
   * go — the write was resolved, or the site moved on without the turn — the assignment is
   * closed with the outcome its journal named.
   */
  async #endUnfreed(assignment: TurnAssignment, outcome: TurnAssignmentOutcome): Promise<void> {
    await this.#revoke(assignment)
    if (!(await this.#free(assignment)) && (await this.#keepsSite(assignment))) return
    const { id, fence } = assignment
    // A database error leaves the turn parked: the next pass finds the site gone and closes it.
    const closed = await this.deps.assignments.finish({ id, epoch: fence.epoch, outcome })
    this.#unpark(id)
    if (closed)
      this.#logger.warn(`Turn recovery closed a turn its site let go (epoch ${fence.epoch})`)
  }

  /** The site lease is still the assignment's, at its epoch. */
  async #keepsSite({ fence }: TurnAssignment): Promise<boolean> {
    const lease = await this.deps.leases.inspect(fence.siteId)
    return (
      lease !== null &&
      lease.taskId === fence.taskId &&
      lease.epoch === fence.epoch &&
      lease.operation === fence.operation
    )
  }

  #unpark(id: string): void {
    this.#parked.delete(id)
    this.#unfreed.delete(id)
  }

  /**
   * Takes this epoch off the site, held or expired alike, unless another owner has it; moved on
   * or already released, nothing is left to free. One statement, so no step leaves the site held.
   * A database error propagates: the next pass tries again, or its sweep once the turn is closed.
   */
  #free(assignment: TurnAssignment): Promise<boolean> {
    return this.deps.leases.free(assignment.fence)
  }

  async #close(assignment: TurnAssignment, outcome: TurnAssignmentOutcome): Promise<void> {
    await this.#revoke(assignment)
    await this.deps.assignments.finish({
      id: assignment.id,
      epoch: assignment.fence.epoch,
      outcome,
    })
  }

  /**
   * One bounded revoke per recovery pass; an outage never keeps the site's cleanup waiting. One
   * that failed is sent again by the next pass that needs it; one that went through is not sent
   * again by this process.
   */
  #revoke(assignment: TurnAssignment): Promise<void> {
    const pending = this.#revocations.get(assignment.id)
    if (pending) return pending.settled
    const revocation = {
      settled: withTimeout(
        Promise.resolve().then(() => this.deps.credentials.revoke(credentialRef(assignment))),
        5_000,
        'Turn credential revocation timed out',
      ).catch(() => {
        revocation.failed = true
        // Its pass is over already: nothing else forgets it for the next one.
        if (
          !this.#running.has(assignment.id) &&
          this.#revocations.get(assignment.id) === revocation
        )
          this.#revocations.delete(assignment.id)
        this.#warn('llm_turn_credentials_revoke_failed', new Error('unavailable'))
      }),
      failed: false,
    }
    this.#revocations.set(assignment.id, revocation)
    return revocation.settled
  }

  /** Holds the site for an operator; only the epoch, phase and attempts are logged. */
  async #park(assignment: TurnAssignment, phase: TurnPhase | undefined, why: string) {
    this.#parked.add(assignment.id)
    if (why !== 'driver unavailable') await this.#revoke(assignment)
    await holdForRecovery(this.deps.leases, assignment.fence, phase ?? 'recovery')
    this.#logger.error(
      `Turn recovery left a turn to an operator: ${why} (epoch ${assignment.fence.epoch}, phase ${phase ?? 'none'}, attempts ${assignment.recoveryAttempts})`,
    )
  }
}

/** The labels the supervisor created the turn's container with. */
function containerLabels(assignment: TurnAssignment): SandboxLabels {
  return { ...assignment.plan.sandbox.labels, leaseEpoch: assignment.firstEpoch }
}

/** The credentials were issued when the turn started, under its first epoch. */
function credentialRef(assignment: TurnAssignment): TurnCredentialRef {
  return {
    taskId: assignment.fence.taskId,
    sessionId: assignment.sessionId,
    turn: assignment.turn,
    epoch: assignment.firstEpoch,
  }
}

/** Every step the journal reached names the container and exec it needs. */
function consistent(assignment: TurnAssignment, turn: ReplayedTurn): boolean {
  if (turn.containerId && assignment.containerId && turn.containerId !== assignment.containerId)
    return false
  const step = turn.step!
  if (['created', 'restored', 'quiesced', ...agentSteps].includes(step) && !turn.containerId)
    return false
  return !agentSteps.includes(step) || turn.execId !== undefined
}

/**
 * The driver's run of the turn as recovery rebuilds it from the plan. With the credentials it is
 * the supervisor's run and names them for the output and candidate checks. Without them — a
 * checkpoint to publish — only what sessionState reads is known: the driver session.
 */
async function recoveredRun(
  driver: AgentDriver,
  plan: TurnPlan,
  turn: ReplayedTurn,
  values: TurnCredentialValues | null,
): Promise<{ prepared: PreparedRun; credentials: string[] }> {
  const nativeSessionId = turn.nativeSessionId ?? plan.context.nativeSessionId
  const request = withTurnCredentials(plan, values ?? { llmApiKey: '', mcpToken: '' })
  const context = { ...request.context, ...(nativeSessionId ? { nativeSessionId } : {}) }
  if (!values) return { prepared: { context, files: [], env: {}, secrets: [] }, credentials: [] }
  const prepared = await driver.prepare(context)
  return { prepared, credentials: checkPreparedRun(context, prepared, []).credentials }
}
