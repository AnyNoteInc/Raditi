import type { TurnAssignmentRunner, TurnExecutorKind, TurnPlan } from './turn-executor.ts'
import type { SiteLeaseFence } from './turn-runner.ts'

/** How an assignment ended. `lost`: recovery gave the turn up, never billed (P12). */
export const turnAssignmentOutcomes = ['completed', 'failed', 'lost'] as const
export type TurnAssignmentOutcome = (typeof turnAssignmentOutcomes)[number]

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
   * Binds unclaimed runner assignments among `ids` to a runner session, oldest first and at
   * most `limit`. Rows another claimant holds are skipped, never waited for.
   */
  claim(input: {
    ids: readonly string[]
    runnerId: string
    runnerSession: string
    limit: number
  }): Promise<TurnAssignment[]>
  /** Fails a runner assignment nobody claimed; false when a runner took it meanwhile. */
  abandon(id: string): Promise<boolean>
  /** The turn's container, once; false for another container or a stale epoch. */
  recordContainer(input: { id: string; epoch: number; containerId: string }): Promise<boolean>
  /** A poll of the runner session listed these assignments as active. */
  seen(input: { runnerId: string; runnerSession: string; ids: readonly string[] }): Promise<void>
  /**
   * Recovery takes the turn over under a newer epoch of the same lease, optionally for a
   * restarted session of the same runner, and counts the attempt.
   */
  advance(input: {
    id: string
    fromEpoch: number
    epoch: number
    runnerSession?: string
  }): Promise<TurnAssignment | null>
  finish(input: { id: string; epoch: number; outcome: TurnAssignmentOutcome }): Promise<boolean>
  /** Oldest first; for recovery and a runner's reconcile. */
  unfinished(filter?: { runnerId?: string }): Promise<TurnAssignment[]>
}
