import { performance } from 'node:perf_hooks'

import {
  badRequest,
  conflict,
  leaseLost,
  publicationSourceSchema,
  snapshotReferenceSchema,
  TURN_PUBLICATION_GRACE_MS,
  turnSnapshotPrefix,
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

export interface PublicationRecoveryRequest {
  /** The unfinished assignment of the turn: it moves to the new epoch and ends completed. */
  assignmentId: string
  /** The runner session the assignment moves to, when its runner restarted (TurnTakeover). */
  runnerSession?: string
  /** Exact held epoch from durable evidence. This API never guesses or clears a different hold. */
  heldFence: SiteLeaseFence
  snapshot: SnapshotReference
  workspace: TurnWorkspaceSource
}

const RECOVERY_TIMEOUT_MS = 120_000

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
    )
    const { manifest, archives } = loaded
    const metadata = manifest.git.publication
    if (
      !metadata ||
      metadata.taskId !== input.heldFence.taskId ||
      manifest.git.baseSha !== input.workspace.expectedBaseSha ||
      manifest.git.provider !== input.workspace.repo.provider ||
      manifest.git.branch !== input.workspace.branch
    )
      throw conflict('Checkpoint does not match the requested publication recovery')

    const started = performance.now()
    const lease = await this.deps.leases.reclaimForRecovery(
      input.heldFence,
      RECOVERY_TIMEOUT_MS + TURN_PUBLICATION_GRACE_MS,
    )
    if (!lease) throw conflict('The exact held lease is no longer available for recovery')
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      RECOVERY_TIMEOUT_MS,
      signal,
      performance.now() - started,
    )
    let publication: TurnPublication | undefined
    let completed = false
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
        committedAt: metadata.committedAt,
        recoveredFromEpoch: input.heldFence.epoch,
        ...extra,
      })
    }
    try {
      // Its containers are adopted through the assignment, so it moves to this epoch first.
      const advanced = await this.deps.assignments.advance({
        id: input.assignmentId,
        fromEpoch: input.heldFence.epoch,
        epoch: lease.epoch,
        ...(input.runnerSession ? { runnerSession: input.runnerSession } : {}),
      })
      if (!advanced) throw conflict('The turn assignment moved on without this recovery')
      await guard.assertFence()
      await record('checkpointed')
      const containers = await this.deps.executor.list({
        siteId: lease.siteId,
        taskId: lease.taskId,
        sessionId: reference.sessionId,
        turn: reference.turn,
      })
      if (containers.length > 100) throw conflict('Too many containers require manual recovery')
      for (const candidate of containers) {
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
        await guard.assertFence()
        // Only for removal, which reaches even a container that can no longer run anything:
        // null means it is gone, and a changed identity is a CONFLICT that keeps the site held.
        const stale = await guard.interruptible(
          this.deps.executor.adopt(
            {
              assignmentId: input.assignmentId,
              fence: lease,
              containerId: candidate.id,
              labels: candidate.labels,
              purpose: 'removal',
            },
            guard.signal,
          ),
        )
        if (!stale) continue
        await guard.assertFence()
        await stale.destroy('failed')
        await record('destroyed', { containerId: stale.containerId })
      }
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
      if (
        publication.baseSha !== manifest.git.baseSha ||
        publication.headSha !== manifest.git.headSha
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
        await record('recovery', { reason: 'publication_ambiguous' }).catch(() => {})
      }
      guard.close()
      await publication?.dispose().catch(() => {})
    }
  }
}
