import type { TurnAssignmentRunner, TurnExecutorKind, TurnPlan } from './turn-executor.ts'
import type { SiteLeaseFence, SiteLeaseGrant, TurnEvidence } from './turn-runner.ts'

/** How an assignment ended. `lost`: recovery gave the turn up, never billed (P12). */
export const turnAssignmentOutcomes = ['completed', 'failed', 'lost'] as const
export type TurnAssignmentOutcome = (typeof turnAssignmentOutcomes)[number]

/**
 * Trusted host undo before a replacement run. Admitted by the fence of the site lease the new
 * turn holds, never by a credential of the turn: its token stays out of the plan and out of
 * this call (spec §8, §11).
 */
export interface TurnContentRollback {
  rollback(input: { fence: SiteLeaseFence; turn: number }): Promise<void>
}

/**
 * One turn's hold on an executor — spec §8 «Раннер на песочной ВМ». Recovery reads the
 * unfinished ones: the plan without credentials, the epochs of the journal and the deadline.
 */
export interface TurnAssignment {
  id: string
  /** The fence that owns the turn now; recovery moves it to a newer epoch. */
  fence: SiteLeaseFence
  /** The epoch the turn started under: its journal spans firstEpoch…fence.epoch. */
  firstEpoch: number
  sessionId: string
  turn: number
  executor: TurnExecutorKind
  plan: TurnPlan
  /** Absolute database time by which the turn's container is gone. */
  deadlineAt: Date
  /** The database clock of the same statement. */
  serverNow: Date
  /** The runner session holding the turn; null until claimed and for the local executor. */
  runner: TurnAssignmentRunner | null
  containerId: string | null
  recoveryAttempts: number
  outcome: TurnAssignmentOutcome | null
}

export interface OpenTurnAssignment {
  fence: SiteLeaseFence
  sessionId: string
  turn: number
  executor: TurnExecutorKind
  plan: TurnPlan
  /** What remains of the turn: deadline_at is fixed by the database clock from it. */
  remainingMs: number
}

/** Durable assignments. Every write is conditional on its epoch, never on the id alone. */
export interface TurnAssignmentStore {
  /**
   * Only the owner of the fence opens its turn, and a turn has at most one unfinished
   * assignment. null when either is not the case.
   */
  open(input: OpenTurnAssignment): Promise<TurnAssignment | null>
  get(id: string): Promise<TurnAssignment | null>
  /**
   * Binds unclaimed runner assignments among `ids` (at most runnerLimits.claimIds) to a runner
   * session, oldest first and at most `limit`. Rows another claimant holds are skipped, never
   * waited for.
   */
  claim(input: {
    ids: readonly string[]
    runnerId: string
    runnerSession: string
    limit: number
  }): Promise<TurnAssignment[]>
  /**
   * Closes a runner assignment nobody claimed, `failed` unless `outcome` says otherwise; false
   * when a runner took it meanwhile. `reason` is why the caller gives it up, one of the
   * journal's fixed reasons: nobody has journaled it yet, so a store that also closes the
   * product TaskTurn records it there (`cancelled`, `timeout`); other stores ignore it.
   */
  abandon(
    id: string,
    outcome?: TurnAssignmentOutcome,
    reason?: NonNullable<TurnEvidence['reason']>,
  ): Promise<boolean>
  /** The turn's container, once; false for another container or a stale epoch. */
  recordContainer(input: { id: string; epoch: number; containerId: string }): Promise<boolean>
  /**
   * Recovery takes the turn over: the site lease held for recovery at the assignment's epoch
   * (`fence`) is reclaimed under the next one for `ttlMs`, and the assignment moves there — both
   * or neither, so the lease and the assignment never end up on different epochs. Optionally for
   * a restarted session of the same runner; counts the attempt unless `countAttempt` is false:
   * removing a given-up turn's container, or publishing its checkpoint before the removal. null
   * when the assignment finished or moved on, or the lease is not held at `fence`.
   */
  takeOver(input: {
    id: string
    fence: SiteLeaseFence
    ttlMs: number
    runnerSession?: string
    countAttempt?: boolean
  }): Promise<{ assignment: TurnAssignment; grant: SiteLeaseGrant } | null>
  /** Counts a recovery attempt under the assignment's current epoch; false once it moved on. */
  countAttempt(input: { id: string; epoch: number }): Promise<boolean>
  finish(input: { id: string; epoch: number; outcome: TurnAssignmentOutcome }): Promise<boolean>
  /**
   * Frees every turn lease held at the epoch of a finished assignment whose task has no
   * unfinished one on the site. An assignment is finished only once its epoch is released or not
   * held, so such a hold is what a recovery left when it stopped between the two or lost a race
   * with the turn's owner. Returns how many were freed.
   */
  freeOrphanedHolds(): Promise<number>
  /**
   * Every unfinished assignment, oldest first: for recovery and a runner's reconcile, which would
   * take an owner left out for none.
   */
  unfinished(filter?: { runnerId?: string }): Promise<TurnAssignment[]>
}
