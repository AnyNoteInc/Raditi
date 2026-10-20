import { performance } from 'node:perf_hooks'

import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  leaseLost,
  publicationSourceSchema,
  snapshotReferenceSchema,
  TURN_PUBLICATION_GRACE_MS,
  turnSnapshotPrefix,
  type SandboxLabels,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotReference,
  type TurnEvidence,
  type TurnPublication,
  type TurnWorkspaceSource,
  withTimeout,
} from '@repo/domain'

import { holdForRecovery, LeaseGuard } from './lease-guard.ts'
import type { TurnSupervisorDependencies } from './turn-supervisor.ts'

/**
 * How the turn's container is known to be gone before anything is published (spec §8):
 * `confirmed` — its owner journaled the removal; `adopt` — the container of the journal is taken
 * for removal by its id, then any found by labels, and removed now; `expired` — the turn's
 * deadline and grace passed, so the VM's watchdog removed it.
 */
export type PublicationRemoval = 'confirmed' | 'adopt' | 'expired'

export interface PublicationRecoveryRequest {
  /** The unfinished assignment of the turn: it moves to the new epoch and ends completed. */
  assignmentId: string
  /** The runner session the assignment moves to, when its runner restarted (TurnTakeover). */
  runnerSession?: string
  /** Exact held epoch from durable evidence. This API never guesses or clears a different hold. */
  heldFence: SiteLeaseFence
  snapshot: SnapshotReference
  workspace: TurnWorkspaceSource
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

/** Taking the container for removal (60 s), removing it (2 min), the candidate and the push. */
export const RECOVERY_TIMEOUT_MS = 6 * 60_000

const AMBIGUOUS_CONTAINER = 'ambiguous_container'
const NO_CHECKPOINT = 'no_checkpoint'
const BROKEN_CHECKPOINT = 'broken_checkpoint'

/**
 * The snapshot holds no committed checkpoint of this publication: its manifest is missing — it
 * is written last, so none was committed — or belongs to another turn. No retry changes that; a
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
  'leases' | 'executor' | 'assignments' | 'workspace' | 'snapshots' | 'journal'
>

/**
 * Recovers publication of an already committed, verified P2 checkpoint. It never reruns an
 * agent, clears an unfinished S3 reservation or pretends to recover the product task result.
 */
export class TurnPublicationRecovery {
  constructor(private readonly deps: RecoveryDependencies) {}

  async recover(
    input: PublicationRecoveryRequest,
    signal?: AbortSignal,
  ): Promise<{ manifest: SnapshotManifest; headSha: string }> {
    const reference = snapshotReferenceSchema.parse(input.snapshot)
    // Protected paths are required: a replay must apply the same SiteAdapter policy.
    if (!publicationSourceSchema.safeParse(input.workspace).success)
      throw badRequest('Invalid publication recovery source')
    if (input.heldFence.operation !== 'turn')
      throw badRequest('Only a held turn publication may be recovered')
    if (signal?.aborted) throw conflict('Publication recovery was cancelled')
    const loaded = await withTimeout(
      this.deps.snapshots.load(reference),
      RECOVERY_TIMEOUT_MS,
      'Snapshot recovery read timed out',
    ).catch((error: unknown) => {
      if (isDomainError(error) && ['NOT_FOUND', 'CONFLICT'].includes(error.code))
        throw noCheckpoint(error)
      if (isDomainError(error) && error.code === 'BAD_REQUEST')
        throw new DomainError(error.code, error.message, error.httpStatus, {
          reason: BROKEN_CHECKPOINT,
        })
      throw error
    })
    const { manifest, archives } = loaded
    const metadata = manifest.git.publication
    if (
      !metadata ||
      metadata.taskId !== input.heldFence.taskId ||
      manifest.git.baseSha !== input.workspace.expectedBaseSha ||
      manifest.git.provider !== input.workspace.repo.provider ||
      manifest.git.branch !== input.workspace.branch
    )
      throw noCheckpoint(conflict('Checkpoint does not match the requested publication recovery'))

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
    const record = async (phase: TurnEvidence['phase'], extra: Partial<TurnEvidence> = {}) => {
      lastPhase = phase
      await this.deps.journal.record({
        fence: lease,
        sessionId: reference.sessionId,
        turn: reference.turn,
        sequence: ++sequence,
        phase,
        snapshotPrefix: turnSnapshotPrefix(reference.sessionId, reference.turn),
        candidateHeadSha: manifest.git.headSha,
        baseSha: manifest.git.baseSha,
        ...(manifest.git.sandboxBaseSha ? { sandboxBaseSha: manifest.git.sandboxBaseSha } : {}),
        committedAt: metadata.committedAt,
        recoveredFromEpoch: input.heldFence.epoch,
        ...extra,
      })
    }
    try {
      await guard.assertFence()
      // A pass that fails before `publishing` leaves the journal's confirmed removal as its last
      // step, so the next one publishes without waiting for a runner that is away.
      await record(input.removal === 'confirmed' ? 'destroyed' : 'checkpointed')
      await this.#removeContainers(input, reference, lease, guard, record).catch(
        (error: unknown) => {
          // Another identity where the turn's container should be: no retry resolves that.
          if (isDomainError(error) && error.code === 'CONFLICT')
            throw new DomainError(error.code, error.message, error.httpStatus, {
              reason: AMBIGUOUS_CONTAINER,
            })
          throw error
        },
      )
      counted = await this.deps.assignments.countAttempt({
        id: input.assignmentId,
        epoch: lease.epoch,
      })
      if (!counted) throw conflict('The turn assignment moved on without this recovery')
      await guard.assertFence()
      publication = await guard.interruptibleResource(
        this.deps.workspace.preparePublication({
          ...input.workspace,
          taskId: metadata.taskId,
          turn: reference.turn,
          createdAt: metadata.committedAt,
          patch: archives.patch,
          untracked: archives.untracked,
          // A replay of a completed snapshot: the credential check ran before its checkpoint.
          credentials: [],
        }),
        (late) => late.dispose(),
      )
      // The working set is derived again too (plan 53, Р11): the one the checkpoint names.
      if (
        publication.baseSha !== manifest.git.baseSha ||
        publication.headSha !== manifest.git.headSha ||
        publication.sandboxBaseSha !== manifest.git.sandboxBaseSha
      )
        throw conflict('Reconstructed candidate differs from the immutable checkpoint')
      await guard.assertFence()
      await record('publishing')
      await guard.interruptible(publication.publish(() => guard.assertFence()))
      await guard.assertFence()
      await record('publication_recovered')
      if (!(await this.deps.leases.release(lease)))
        throw leaseLost('Recovery lease was lost before completion')
      completed = true
      // A failed update is finished by the next recovery pass from the journal.
      await this.deps.assignments
        .finish({ id: input.assignmentId, epoch: lease.epoch, outcome: 'completed' })
        .catch(() => false)
      return { manifest, headSha: publication.headSha }
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

  /**
   * Every container of the turn is gone before anything is published: the journal's one taken by
   * its id, then any found by labels (confirmed and adopt), or none left after the watchdog.
   */
  async #removeContainers(
    input: PublicationRecoveryRequest,
    reference: SnapshotReference,
    lease: SiteLeaseFence,
    guard: LeaseGuard,
    record: (phase: TurnEvidence['phase'], extra?: Partial<TurnEvidence>) => Promise<void>,
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
        this.deps.executor.adopt(
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
    const containers = await this.deps.executor.list({
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
}
