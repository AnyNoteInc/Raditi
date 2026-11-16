import { performance } from 'node:perf_hooks'

import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  leaseLost,
  snapshotReferenceSchema,
  TURN_PUBLICATION_GRACE_MS,
  turnSnapshotPrefix,
  type SandboxLabels,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotReference,
  type TurnEvidence,
  type TurnPhase,
  type TurnPlan,
  withTimeout,
} from '@repo/domain'

import { holdForRecovery, LeaseGuard } from './lease-guard.ts'
import type { TurnSupervisorDependencies } from './turn-supervisor.ts'
import { gitNotConfigured, publicationOf, type TurnPublication } from './turn-repository.ts'

/**
 * How the turn's container is known to be gone before its checkpoint is taken (spec §8):
 * `confirmed` — its owner journaled the removal; `adopt` — the container of the journal is taken
 * for removal by its id, then any found by labels, and removed now; `expired` — the turn's
 * deadline and grace passed, so the VM's watchdog removed it.
 */
export type PublicationRemoval = 'confirmed' | 'adopt' | 'expired'

export interface TurnRecoveryRequest {
  /** The unfinished assignment of the turn: it moves to the new epoch and ends completed. */
  assignmentId: string
  /** The runner session the assignment moves to, when its runner restarted (TurnTakeover). */
  runnerSession?: string
  /** Exact held epoch from durable evidence. This API never guesses or clears a different hold. */
  heldFence: SiteLeaseFence
  snapshot: SnapshotReference
  removal: PublicationRemoval
  /**
   * What was left of the turn when recovery read its assignment, 0 or less once its deadline
   * passed. The new epoch lives at least that long plus the grace: a container still to be removed
   * may live until then, and the lease must not expire before it (spec §8).
   */
  remainingMs: number
  /** The container the journal or the assignment names. */
  containerId?: string
  /** The labels the turn's container was created with. */
  labels: SandboxLabels
}

/** Taking the container for removal (60 s), removing it (2 min) and reading the checkpoint. */
export const RECOVERY_TIMEOUT_MS = 6 * 60_000

const AMBIGUOUS_CONTAINER = 'ambiguous_container'
const NO_CHECKPOINT = 'no_checkpoint'
const BROKEN_CHECKPOINT = 'broken_checkpoint'

/**
 * The snapshot holds no committed checkpoint of this turn: its manifest is missing — it is
 * written last, so none was committed — or belongs to another turn. No retry changes that; a
 * storage, Vault or timeout error proves nothing and is tried again.
 */
export function isMissingCheckpoint(error: unknown): boolean {
  return (
    isDomainError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === NO_CHECKPOINT
  )
}

const noCheckpoint = (error: DomainError) =>
  new DomainError(error.code, error.message, error.httpStatus, { reason: NO_CHECKPOINT })

/**
 * The committed checkpoint fails its own checks — manifest schema, a part's size or hash, GCM or
 * the archive: SnapshotService.load answers BAD_REQUEST only for these, and reading it again
 * gives the same answer.
 */
export function isBrokenCheckpoint(error: unknown): boolean {
  return (
    isDomainError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === BROKEN_CHECKPOINT
  )
}

/** A container of the turn could not be taken for removal as the turn's own: an operator decides. */
export function isAmbiguousContainer(error: unknown): boolean {
  return (
    isDomainError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === AMBIGUOUS_CONTAINER
  )
}

type RecoveryDependencies = Pick<
  TurnSupervisorDependencies,
  'leases' | 'executor' | 'assignments' | 'snapshots' | 'journal' | 'repository'
>

type Record = (phase: TurnEvidence['phase'], extra?: Partial<TurnEvidence>) => Promise<void>

/** A load of the checkpoint that failed, by what it proves (TurnCheckpointRecovery). */
function checkpointLoadFailure(error: unknown): unknown {
  if (isDomainError(error) && ['NOT_FOUND', 'CONFLICT'].includes(error.code))
    return noCheckpoint(error)
  if (isDomainError(error) && error.code === 'BAD_REQUEST')
    return new DomainError(error.code, error.message, error.httpStatus, {
      reason: BROKEN_CHECKPOINT,
    })
  return error
}

/** Another identity where the turn's container should be: no retry resolves that. */
function ambiguousContainer(error: unknown): unknown {
  if (isDomainError(error) && error.code === 'CONFLICT')
    return new DomainError(error.code, error.message, error.httpStatus, {
      reason: AMBIGUOUS_CONTAINER,
    })
  return error
}

/** A committed checkpoint of a turn with a repository whose publication may be unfinished. */
export interface PublicationRecoveryRequest extends TurnRecoveryRequest {
  /** The plan of the turn: its repository, base and the chat's ref before it (ПР12). */
  plan: TurnPlan
}

/**
 * Finishes the publication of a turn with a repository from its committed, verified checkpoint
 * (docs/plan/84-projects.md, ПР12, §4.3, step 7): a core that died between the snapshot and the
 * publication left the candidate in the snapshot's patch. The trusted git builds the same commit
 * again — the same SHA, or nothing is published — and moves it into the mirror under the chat's
 * ref by CAS. It never reruns an agent.
 */
export class TurnPublicationRecovery {
  constructor(private readonly deps: RecoveryDependencies) {}

  async recover(
    input: PublicationRecoveryRequest,
    signal?: AbortSignal,
  ): Promise<{ manifest: SnapshotManifest; headSha: string | null }> {
    const reference = snapshotReferenceSchema.parse(input.snapshot)
    const repository = input.plan.repository
    if (!repository) throw badRequest('A turn without a repository has no publication to recover')
    if (input.heldFence.operation !== 'turn')
      throw badRequest('Only a held turn publication may be recovered')
    const workspace = this.deps.repository
    if (!workspace) throw gitNotConfigured()
    if (signal?.aborted) throw conflict('Publication recovery was cancelled')
    const loaded = await withTimeout(
      this.deps.snapshots.load(reference),
      RECOVERY_TIMEOUT_MS,
      'Snapshot recovery read timed out',
    ).catch((error: unknown) => {
      throw checkpointLoadFailure(error)
    })
    const { manifest, archives } = loaded
    const git = manifest.git
    if (
      !git ||
      !archives.patch ||
      !archives.untracked ||
      git.baseSha !== repository.baseSha ||
      git.branch !== repository.branch ||
      git.provider !== repository.provider ||
      (git.publication !== undefined && git.publication.taskId !== input.heldFence.taskId)
    )
      throw noCheckpoint(conflict('Checkpoint does not match the requested publication recovery'))
    // The checks refused the changes before the snapshot: there is nothing to publish.
    const metadata = git.publication

    const started = performance.now()
    // Its containers are adopted through the assignment, so it moves with the lease first.
    const taken = await this.deps.assignments.takeOver({
      id: input.assignmentId,
      fence: input.heldFence,
      ttlMs: Math.max(RECOVERY_TIMEOUT_MS, input.remainingMs) + TURN_PUBLICATION_GRACE_MS,
      ...(input.runnerSession ? { runnerSession: input.runnerSession } : {}),
      countAttempt: false,
    })
    if (!taken)
      throw conflict('The turn assignment or its exact held lease moved on without this recovery')
    const lease = taken.grant
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      RECOVERY_TIMEOUT_MS,
      signal,
      performance.now() - started,
    )
    let publication: TurnPublication | undefined
    let completed = false
    // Counted once the containers are gone: a failed removal is tried again for free, a
    // candidate that never matches the checkpoint reaches the attempt limit.
    let counted = false
    let sequence = 0
    let lastPhase: TurnEvidence['phase'] = 'checkpointed'
    const record: Record = async (phase, extra = {}) => {
      lastPhase = phase
      await this.deps.journal.record({
        fence: lease,
        sessionId: reference.sessionId,
        turn: reference.turn,
        sequence: ++sequence,
        phase,
        snapshotPrefix: turnSnapshotPrefix(reference.sessionId, reference.turn),
        candidateHeadSha: git.headSha,
        baseSha: git.baseSha,
        ...(git.sandboxBaseSha ? { sandboxBaseSha: git.sandboxBaseSha } : {}),
        committedAt: input.plan.committedAt,
        recoveredFromEpoch: input.heldFence.epoch,
        ...extra,
      })
    }
    try {
      await guard.assertFence()
      // A pass that fails before `publishing` leaves the journal's confirmed removal as its last
      // step, so the next one publishes without waiting for a runner that is away.
      await record(input.removal === 'confirmed' ? 'destroyed' : 'checkpointed')
      await removeTurnContainers(this.deps, input, reference, lease, guard, record).catch(
        (error: unknown) => {
          throw ambiguousContainer(error)
        },
      )
      counted = await this.deps.assignments.countAttempt({
        id: input.assignmentId,
        epoch: lease.epoch,
      })
      if (!counted) throw conflict('The turn assignment moved on without this recovery')
      if (metadata) {
        await guard.assertFence()
        publication = await guard.interruptibleResource(
          workspace.preparePublication({
            ...publicationOf(input.plan),
            patch: archives.patch,
            untracked: archives.untracked,
            // A replay of a completed snapshot: the checks ran before its checkpoint.
            credentials: [],
            hiddenPaths: repository.hiddenPaths,
          }),
          (late) => late.dispose(),
        )
        if (publication.baseSha !== git.baseSha || publication.headSha !== git.headSha)
          throw conflict('Reconstructed candidate differs from the immutable checkpoint')
        await guard.assertFence()
        await record('publishing')
        await guard.interruptible(publication.publish(() => guard.assertFence()))
      }
      await guard.assertFence()
      await record('publication_recovered')
      if (!(await this.deps.leases.release(lease)))
        throw leaseLost('Recovery lease was lost before completion')
      completed = true
      // A failed update is finished by the next recovery pass from the journal.
      await this.deps.assignments
        .finish({ id: input.assignmentId, epoch: lease.epoch, outcome: 'completed' })
        .catch(() => false)
      return { manifest, headSha: metadata ? git.headSha : null }
    } finally {
      if (!completed) {
        await holdForRecovery(this.deps.leases, lease, lastPhase)
        await record('recovery', {
          reason: counted ? 'publication_ambiguous' : 'destroy_failed',
        }).catch(() => {})
      }
      guard.close()
      await publication?.dispose().catch(() => {})
    }
  }
}

/**
 * A checkpoint of a turn, as recovery finds it (docs/plan/57-browser-tasks.md, Б6): the journal
 * reached `checkpointing`, `checkpointed` or `destroyed`.
 */
export interface CheckpointRecoveryRequest extends TurnRecoveryRequest {
  /** The step the turn's journal reached. */
  step: TurnPhase
}

/** How a recovered checkpoint ended the turn: taken as its own, or lost without one. */
export type CheckpointRecovery =
  { outcome: 'completed'; manifest: SnapshotManifest } | { outcome: 'lost' }

/**
 * Finishes the checkpoint of a turn (docs/plan/57-browser-tasks.md, Б6). It never reruns an
 * agent: under a newer epoch every container of the turn is
 * removed, then the committed manifest is proven by reading the checkpoint back. One that holds
 * no repository ends the turn `checkpoint_recovered`, completed; none — its save never committed
 * — closes the turn `lost`, never billed, and frees the site: only core writes `manifest.json`,
 * so nothing commits it later. A checkpoint that fails its own checks, or holds a repository,
 * waits for an operator; a read that failed otherwise is tried again by the next pass.
 */
export class TurnCheckpointRecovery {
  constructor(
    private readonly deps: Pick<
      RecoveryDependencies,
      'leases' | 'executor' | 'assignments' | 'snapshots' | 'journal'
    >,
  ) {}

  async recover(
    input: CheckpointRecoveryRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointRecovery> {
    const reference = snapshotReferenceSchema.parse(input.snapshot)
    if (input.heldFence.operation !== 'turn')
      throw badRequest('Only a held turn checkpoint may be recovered')
    if (signal?.aborted) throw conflict('Checkpoint recovery was cancelled')
    const started = performance.now()
    // Its containers are adopted through the assignment, so it moves with the lease first: the
    // newer epoch fences out an owner that might still write.
    const taken = await this.deps.assignments.takeOver({
      id: input.assignmentId,
      fence: input.heldFence,
      ttlMs: Math.max(RECOVERY_TIMEOUT_MS, input.remainingMs) + TURN_PUBLICATION_GRACE_MS,
      ...(input.runnerSession ? { runnerSession: input.runnerSession } : {}),
      countAttempt: false,
    })
    if (!taken)
      throw conflict('The turn assignment or its exact held lease moved on without this recovery')
    const lease = taken.grant
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      RECOVERY_TIMEOUT_MS,
      signal,
      performance.now() - started,
    )
    let ended = false
    // Counted once the containers are gone: a failed removal is tried again for free, a read
    // that never succeeds reaches the attempt limit.
    let counted = false
    let sequence = 0
    let lastPhase: TurnPhase = input.step
    const record: Record = async (phase, extra = {}) => {
      lastPhase = phase
      await this.deps.journal.record({
        fence: lease,
        sessionId: reference.sessionId,
        turn: reference.turn,
        sequence: ++sequence,
        phase,
        snapshotPrefix: turnSnapshotPrefix(reference.sessionId, reference.turn),
        recoveredFromEpoch: input.heldFence.epoch,
        ...extra,
      })
    }
    try {
      await guard.assertFence()
      // Where the turn stood: a step past `checkpointing` proves nothing here, the read does.
      await record(input.removal === 'confirmed' ? 'destroyed' : input.step)
      await removeTurnContainers(this.deps, input, reference, lease, guard, record).catch(
        (error: unknown) => {
          throw ambiguousContainer(error)
        },
      )
      counted = await this.deps.assignments.countAttempt({
        id: input.assignmentId,
        epoch: lease.epoch,
      })
      if (!counted) throw conflict('The turn assignment moved on without this recovery')
      await guard.assertFence()
      const loaded = await guard
        .interruptible(
          withTimeout(
            this.deps.snapshots.load(reference),
            RECOVERY_TIMEOUT_MS,
            'Snapshot recovery read timed out',
          ),
        )
        .catch((error: unknown) => {
          const failure = checkpointLoadFailure(error)
          if (isMissingCheckpoint(failure)) return null
          throw failure
        })
      await guard.assertFence()
      if (loaded === null) {
        // The save never committed: no session to continue, nothing the client can be billed for.
        await record('failed', { reason: 'run_failed', outcome: 'lost' })
        if (!(await this.deps.leases.release(lease)))
          throw leaseLost('Recovery lease was lost before completion')
        ended = true
        await this.deps.assignments
          .finish({ id: input.assignmentId, epoch: lease.epoch, outcome: 'lost' })
          .catch(() => false)
        return { outcome: 'lost' }
      }
      if (loaded.manifest.git !== undefined)
        throw new DomainError(
          'CONFLICT',
          'The checkpoint holds a repository the turn has not',
          409,
          {
            reason: BROKEN_CHECKPOINT,
          },
        )
      await record('checkpoint_recovered')
      if (!(await this.deps.leases.release(lease)))
        throw leaseLost('Recovery lease was lost before completion')
      ended = true
      // A failed update is finished by the next recovery pass from the journal.
      await this.deps.assignments
        .finish({ id: input.assignmentId, epoch: lease.epoch, outcome: 'completed' })
        .catch(() => false)
      return { outcome: 'completed', manifest: loaded.manifest }
    } finally {
      if (!ended) {
        await holdForRecovery(this.deps.leases, lease, lastPhase)
        await record('recovery', {
          reason: counted ? 'snapshot_ambiguous' : 'destroy_failed',
        }).catch(() => {})
      }
      guard.close()
    }
  }
}

/**
 * Every container of the turn is gone before a checkpoint is taken as the turn's: the journal's one taken by its id, then any found by labels (confirmed and adopt),
 * or none left after the watchdog.
 */
async function removeTurnContainers(
  deps: Pick<RecoveryDependencies, 'executor'>,
  input: Pick<
    TurnRecoveryRequest,
    'assignmentId' | 'heldFence' | 'removal' | 'containerId' | 'labels'
  >,
  reference: SnapshotReference,
  lease: SiteLeaseFence,
  guard: LeaseGuard,
  record: Record,
): Promise<void> {
  if (input.removal === 'expired') {
    await guard.assertFence()
    await record('destroyed', {
      ...(input.containerId ? { containerId: input.containerId } : {}),
      reason: 'timeout',
    })
    return
  }
  // Only for removal, which reaches even a container that can no longer run anything: null
  // means it is gone, and a changed identity is a CONFLICT that keeps the site held.
  const remove = async (containerId: string, labels: SandboxLabels): Promise<boolean> => {
    await guard.assertFence()
    const stale = await guard.interruptible(
      deps.executor.adopt(
        {
          assignmentId: input.assignmentId,
          fence: lease,
          containerId,
          labels,
          purpose: 'removal',
        },
        guard.signal,
      ),
    )
    if (!stale) return false
    await guard.assertFence()
    await stale.destroy('failed')
    return true
  }
  // The inventory lags behind: the container the journal names is removed by its id.
  const known = input.removal === 'adopt' ? input.containerId : undefined
  if (known) {
    await remove(known, input.labels)
    await record('destroyed', { containerId: known })
  }
  const containers = await deps.executor.list({
    siteId: lease.siteId,
    taskId: lease.taskId,
    sessionId: reference.sessionId,
    turn: reference.turn,
  })
  if (containers.length > 100) throw conflict('Too many containers require manual recovery')
  for (const candidate of containers) {
    if (candidate.id === known) continue
    if (
      candidate.labels.siteId !== lease.siteId ||
      candidate.labels.taskId !== lease.taskId ||
      candidate.labels.sessionId !== reference.sessionId ||
      candidate.labels.turn !== reference.turn ||
      candidate.labels.workspaceId !== reference.workspaceId ||
      (candidate.labels.leaseEpoch !== undefined &&
        candidate.labels.leaseEpoch > input.heldFence.epoch)
    )
      throw conflict('Recovery container identity is ambiguous')
    if (await remove(candidate.id, candidate.labels))
      await record('destroyed', { containerId: candidate.id })
  }
}
