import { performance } from 'node:perf_hooks'

import {
  badRequest,
  conflict,
  snapshotReferenceSchema,
  TURN_PUBLICATION_GRACE_MS,
  turnSnapshotPrefix,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotReference,
  type TurnEvidence,
  type TurnPublication,
  type TurnWorkspaceSource,
} from '@repo/domain'

import { withTimeout } from '../common/async.ts'
import { LeaseGuard } from './lease-guard.ts'
import type { TurnSupervisorDependencies } from './turn-supervisor.ts'

export interface PublicationRecoveryRequest {
  /** Exact held epoch from durable evidence. This API never guesses or clears a different hold. */
  heldFence: SiteLeaseFence
  snapshot: SnapshotReference
  workspace: TurnWorkspaceSource
}

type RecoveryDependencies = Pick<
  TurnSupervisorDependencies,
  'leases' | 'sandboxes' | 'workspace' | 'snapshots' | 'journal'
>

/**
 * Recovers publication of an already committed, verified P2 checkpoint. It never reruns an
 * agent, clears an unfinished S3 reservation or pretends to recover the product task result.
 */
export class TurnPublicationRecovery {
  constructor(
    private readonly deps: RecoveryDependencies,
    private readonly timeoutMs = 120_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20 * 60_000)
      throw badRequest('Invalid recovery timeout')
  }

  async recover(
    input: PublicationRecoveryRequest,
    signal?: AbortSignal,
  ): Promise<{ manifest: SnapshotManifest; headSha: string }> {
    const reference = snapshotReferenceSchema.parse(input.snapshot)
    if (input.heldFence.operation !== 'turn')
      throw badRequest('Only a held turn publication may be recovered')
    if (signal?.aborted) throw conflict('Publication recovery was cancelled')
    const loaded = await withTimeout(
      this.deps.snapshots.load(reference),
      this.timeoutMs,
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
    const ttlMs = this.timeoutMs + TURN_PUBLICATION_GRACE_MS
    const lease = await this.deps.leases.reclaimForRecovery(input.heldFence, ttlMs)
    if (!lease) throw conflict('The exact held lease is no longer available for recovery')
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      ttlMs,
      this.timeoutMs,
      signal,
      performance.now() - started,
    )
    let publication: TurnPublication | undefined
    let completed = false
    let sequence = 0
    const record = async (phase: TurnEvidence['phase'], extra: Partial<TurnEvidence> = {}) =>
      this.deps.journal.record({
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
    try {
      await guard.assertFence()
      await record('checkpointed')
      const containers = await this.deps.sandboxes.list({
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
        const sandbox = await this.deps.sandboxes.get(candidate.id)
        if (!sandbox) continue
        if (
          sandbox.id !== candidate.id ||
          Object.entries(candidate.labels).some(
            ([key, value]) => sandbox.labels[key as keyof typeof sandbox.labels] !== value,
          )
        )
          throw conflict('Recovery container identity changed')
        await guard.assertFence()
        await sandbox.destroy('failed')
        await record('destroyed', { containerId: sandbox.id })
      }
      await guard.assertFence()
      const pending = this.deps.workspace.preparePublication({
        ...input.workspace,
        taskId: metadata.taskId,
        turn: reference.turn,
        createdAt: metadata.committedAt,
        patch: archives.patch,
        untracked: archives.untracked,
      })
      // If the caller times out while Git is preparing, the eventual host workspace is disposed.
      void pending
        .then((prepared) => {
          if (guard.signal.aborted) return prepared.dispose()
          return undefined
        })
        .catch(() => {})
      publication = await guard.interruptible(pending)
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
        throw conflict('Recovery lease was lost before completion')
      completed = true
      return { manifest, headSha: publication.headSha }
    } finally {
      if (!completed) {
        await this.deps.leases.holdForRecovery(lease).catch(() => false)
        await record('recovery', { reason: 'publication_ambiguous' }).catch(() => {})
      }
      guard.close()
      await publication?.dispose().catch(() => {})
    }
  }
}
