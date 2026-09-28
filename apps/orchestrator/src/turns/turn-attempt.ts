import {
  conflict,
  DomainError,
  isDomainError,
  isSnapshotCredential,
  leaseLost,
  MAX_PRESIGN_TTL_MS,
  snapshotSaveWroteNothing,
  TURN_PUBLICATION_GRACE_MS,
  turnResultSchema,
  turnSnapshotPrefix,
  withTimeout,
  type AgentDriver,
  type AgentEvent,
  type DestroyReason,
  type PreparedRun,
  type SiteLeaseGrant,
  type SiteLeaseStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnAgentExec,
  type TurnAssignment,
  type TurnAssignmentOutcome,
  type TurnAssignmentStore,
  type TurnEvidence,
  type TurnExecution,
  type TurnJournal,
  type TurnPhase,
  type TurnPlan,
  type TurnPublication,
  type TurnRestoreSource,
  type TurnResult,
  type TurnWorkspace,
} from '@repo/domain'

import type {
  LoadedSnapshot,
  SealedElsewhere,
  SnapshotParts,
} from '../sessions/snapshot.service.ts'
import { holdForRecovery, type LeaseGuard } from './lease-guard.ts'

export interface TurnSnapshotStore {
  load(reference: SnapshotReference): Promise<LoadedSnapshot>
  /** Turn n−1 for the executor: presigned GETs of its parts that live `ttlMs`. */
  restoreSource(reference: SnapshotReference, ttlMs: number): Promise<TurnRestoreSource>
  /** An aborted `signal` must stop any S3 write that has not started yet (see SnapshotService). */
  save(
    metadata: SnapshotMetadata,
    parts: SnapshotParts<SealedElsewhere>,
    signal: AbortSignal,
  ): Promise<SnapshotManifest>
}

export interface TurnAttemptDependencies {
  leases: SiteLeaseStore
  /** Where the turn is held for recovery: its plan without credentials, epochs and deadline. */
  assignments: TurnAssignmentStore
  workspace: TurnWorkspace
  snapshots: TurnSnapshotStore
  journal: TurnJournal
}

export interface CompletedTurn {
  result: TurnResult
  manifest: SnapshotManifest
}

export interface TurnAttemptInit {
  lease: SiteLeaseGrant
  guard: LeaseGuard
  plan: TurnPlan
  /** None for recovery that only removes a given-up turn's container. */
  driver?: AgentDriver
  /** The last sequence the turn's journal holds: a recovered owner continues after it. */
  sequence?: number
  /** Every entry of a recovered owner names the epoch it took the turn over from. */
  recoveredFromEpoch?: number
  /** The step the journal ended with, for a recovered owner. */
  phase?: TurnPhase
}

/** A presigned URL never outlives the lease that allowed it (spec §14). */
const presignTtlMs = (guard: LeaseGuard) => Math.min(MAX_PRESIGN_TTL_MS, guard.leaseRemainingMs)

/**
 * One owner's run of a turn under one fence: the supervisor's from the lease on, recovery's from
 * the epoch it took the turn over with. It journals every step, runs the agent's output, capture,
 * checkpoint and publication, and when the turn ends removes its container, then releases the
 * site or holds it for recovery when S3 or Git may have been written. A turn given up while its
 * prepare was out and without proof that no container is left is vacating: the lease is neither
 * released nor held until that proof comes, and otherwise expires by itself (spec §8).
 */
export class TurnAttempt {
  execution: TurnExecution | undefined
  execId: string | undefined
  /** Finished with the turn's outcome once its container is gone; a held turn stays assigned. */
  assignment: TurnAssignment | undefined
  /** turnCredentials() of the run: a changed file of the candidate must not contain one. */
  credentials: readonly string[] = []
  #publication: TurnPublication | undefined
  #abandoned = false
  #destroyed = false
  #checkpointStarted = false
  #publishStarted = false
  #completed = false
  #sequence: number
  #lastPhase: TurnPhase
  #reason: TurnEvidence['reason'] = 'run_failed'
  #outcome: TurnAssignmentOutcome = 'failed'
  #candidateHeadSha: string | undefined
  /** A container of the prepare may exist from now on. */
  #dispatched = false
  /** Proof that the prepare left no container and never will. */
  #vacated = false
  /** Given up while the prepare was out and without that proof. */
  #vacating = false
  /** A late container could not be removed: the site is held for recovery. */
  #heldByAttempt = false
  #ended = false
  /** Settles, never rejects, once the vacating entry was journaled or refused. */
  #vacatingRecorded: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: TurnAttemptDependencies,
    private readonly init: TurnAttemptInit,
  ) {
    this.#sequence = init.sequence ?? 0
    this.#lastPhase = init.phase ?? 'leased'
  }

  async record(phase: TurnPhase, extra: Partial<TurnEvidence> = {}): Promise<void> {
    const { lease, plan, recoveredFromEpoch } = this.init
    const labels = plan.sandbox.labels
    this.#lastPhase = phase
    await this.deps.journal.record({
      fence: lease,
      sessionId: labels.sessionId,
      turn: labels.turn,
      sequence: ++this.#sequence,
      phase,
      ...(this.execution ? { containerId: this.execution.containerId } : {}),
      ...(this.execId ? { execId: this.execId } : {}),
      ...(this.#candidateHeadSha ? { candidateHeadSha: this.#candidateHeadSha } : {}),
      baseSha: plan.workspace.expectedBaseSha,
      committedAt: plan.committedAt,
      ...(this.#checkpointStarted
        ? { snapshotPrefix: turnSnapshotPrefix(labels.sessionId, labels.turn) }
        : {}),
      ...(recoveredFromEpoch ? { recoveredFromEpoch } : {}),
      ...extra,
    })
  }

  /** The executor handed the prepare out: from now on a container of it may exist. */
  dispatched(): void {
    this.#dispatched = true
  }

  /** The executor proved the prepare left no container: a vacating turn ends now. */
  vacated(): void {
    this.#vacated = true
    if (this.#vacating && !this.#heldByAttempt) void this.#endVacating()
  }

  /** The executor reports the container: from now on this attempt removes it. */
  async created(execution: TurnExecution): Promise<void> {
    if (this.#abandoned) {
      await this.#removeLate(execution)
      throw new DomainError('TURN_INTERRUPTED', this.init.guard.reason, 409)
    }
    this.execution = execution
    await this.init.guard.assertFence()
    await this.record('created')
  }

  /** The turn was given up while its container was being created: remove it now. */
  async #removeLate(execution: TurnExecution): Promise<void> {
    const { containerId } = execution
    if (this.#vacating) {
      // After the first vacating entry, or replay would end on one without the container.
      await this.#vacatingRecorded
      await this.record('vacating', { reason: this.#reason, containerId }).catch(() => {})
    }
    try {
      await execution.destroy(this.#destroyReason())
    } catch {
      // Recovery took the turn over under a newer epoch: the container is its to remove.
      if (await this.#superseded()) return
      this.#heldByAttempt = true
      await holdForRecovery(this.deps.leases, this.init.lease, this.#lastPhase)
      await this.record('recovery', { reason: 'destroy_failed', containerId }).catch(() => {})
      return
    }
    this.#vacated = true
    if (this.#vacating) await this.#endVacating()
  }

  async #superseded(): Promise<boolean> {
    const { lease } = this.init
    const now = await this.deps.leases.inspect(lease.siteId).catch(() => null)
    return now !== null && now.taskId === lease.taskId && now.epoch > lease.epoch
  }

  /**
   * The proof came: `failed`, then the site is released and the assignment finished. Never while
   * the site is held at this epoch: recovery took the turn and finishes it, so its takeover never
   * loses to this attempt's finish.
   */
  async #endVacating(): Promise<void> {
    if (this.#ended || this.#heldByAttempt) return
    this.#ended = true
    const { lease } = this.init
    await this.#vacatingRecorded
    await this.record('failed', { reason: this.#reason, outcome: 'failed' }).catch(() => {})
    const released = await this.deps.leases.release(lease).catch(() => false)
    if (!released) {
      const now = await this.deps.leases.inspect(lease.siteId).catch(() => null)
      if (!now || (now.heldForOperator && now.epoch === lease.epoch)) return
    }
    if (this.assignment)
      await this.deps.assignments
        .finish({ id: this.assignment.id, epoch: lease.epoch, outcome: 'failed' })
        .catch(() => false)
  }

  /**
   * Journals the agent's output until it exits successfully. `journaled` are its events recorded
   * before a restart: the result and the failure check span both.
   */
  async follow(agent: TurnAgentExec, journaled: readonly AgentEvent[] = []): Promise<AgentEvent[]> {
    const { guard } = this.init
    const kill = () => {
      void agent.kill().catch(() => {})
    }
    guard.signal.addEventListener('abort', kill, { once: true })
    const events = [...journaled]
    try {
      const [exit] = await guard.interruptible(
        Promise.all([
          agent.wait(),
          agent.output(async (batch) => {
            // Like the periodic probe: only an explicit loss stops the agent here, a read
            // error just warns. The journal INSERT below is fenced by itself.
            await guard.checkFence()
            // Operational evidence, never shown verbatim: a `failed` event's reason is raw
            // CLI/provider text; the chat shows a Russian text chosen by the event type.
            await this.record('output', {
              cursor: batch.to,
              ...(batch.events.length ? { events: batch.events } : {}),
            })
            events.push(...batch.events)
          }),
        ]),
      )
      if (
        exit.reason !== 'exited' ||
        exit.code !== 0 ||
        events.some((event) => event.type === 'failed')
      ) {
        throw new DomainError(
          'TURN_EXEC_FAILED',
          'The agent process did not finish successfully',
          502,
        )
      }
    } catch (error) {
      await agent.kill().catch(() => {})
      throw error
    } finally {
      guard.signal.removeEventListener('abort', kill)
    }
    return events
  }

  /**
   * Quiesce, capture, candidate, checkpoint, removal and publication of a turn whose agent
   * finished. `run` is the driver's run of the turn; its session state names the home to save.
   */
  async complete(events: readonly AgentEvent[], run: PreparedRun): Promise<CompletedTurn> {
    const { guard, plan, driver, lease } = this.init
    const { workspace, snapshots } = this.deps
    const labels = plan.sandbox.labels
    const ready = this.execution
    if (!ready) throw conflict('The turn has no container')
    if (!driver) throw conflict('The turn has no driver')
    await guard.assertFence()
    await ready.quiesce()
    await this.record('quiesced')
    const result = turnResultSchema.parse(driver.extractResult(events, null))
    for (const event of events) {
      if (event.type === 'started' && event.nativeSessionId)
        run.context.nativeSessionId = event.nativeSessionId
    }
    const home = driver.sessionState(run)
    await guard.assertFence()
    // Refused when the agent copied a turn credential into its home or the site.
    const captured = await ready.capture({ home, baseSha: plan.workspace.expectedBaseSha })
    await guard.assertFence()
    const publication = await guard.interruptibleResource(
      workspace.preparePublication({
        ...plan.workspace,
        taskId: labels.taskId,
        turn: labels.turn,
        createdAt: plan.committedAt,
        patch: captured.patch,
        untracked: captured.untracked,
        // Binary edits of tracked files are compressed in the patch: checked there in full.
        credentials: this.credentials,
      }),
      (late) => late.dispose(),
    )
    this.#publication = publication
    this.#candidateHeadSha = publication.headSha
    await guard.assertFence()
    await this.record('checkpointing')
    this.#checkpointStarted = true
    const saving = snapshots.save(
      {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: labels.turn,
        image: plan.sandbox.image,
        driver: {
          id: driver.id,
          version: plan.driverVersion,
          ...(run.context.nativeSessionId ? { nativeSessionId: run.context.nativeSessionId } : {}),
        },
        home,
        git: {
          provider: plan.workspace.repo.provider,
          branch: plan.workspace.branch,
          baseSha: publication.baseSha,
          headSha: publication.headSha,
          publication: { taskId: labels.taskId, committedAt: plan.committedAt },
        },
      },
      {
        // Sealed where the archive stayed; its AAD binds the candidate's headSha.
        home: {
          sizeBytes: captured.homeBytes,
          ttlMs: () => presignTtlMs(guard),
          // The PUT and the data key leave core only while this owner still holds the site.
          seal: async (input) => {
            await guard.assertFence()
            return ready.seal({
              ...input,
              dataKey: async () => {
                await guard.assertFence()
                return input.dataKey()
              },
            })
          },
        },
        patch: publication.patch,
        untracked: publication.untracked,
      },
      // Stops a save still pending on Vault from writing after the attempt gave up on it.
      guard.signal,
    )
    const manifest = await guard.interruptible(saving).catch(async (error: unknown) => {
      let outcome = error
      if (guard.signal.aborted) {
        // The save got the abort too: before its reservation it gives up without writing.
        // Wait for that answer while the lease lasts; a write or no answer keeps the hold.
        const waitMs = Math.min(TURN_PUBLICATION_GRACE_MS, guard.leaseRemainingMs)
        outcome = await withTimeout(saving, waitMs, 'Interrupted snapshot save is pending').then(
          () => 'written',
          (late: unknown) => late,
        )
      }
      // Nothing reached storage: an ordinary failed turn, the site needs no recovery.
      if (snapshotSaveWroteNothing(outcome)) this.#checkpointStarted = false
      throw error
    })
    await guard.assertFence()
    await this.record('checkpointed', {
      snapshotPrefix: turnSnapshotPrefix(labels.sessionId, labels.turn),
    })
    await this.#destroy(true)
    await this.record('destroyed')
    await guard.assertFence()
    await this.record('publishing')
    this.#publishStarted = true
    await guard.interruptible(publication.publish(() => guard.assertFence()))
    await guard.assertFence()
    await this.record('completed', { result })
    if (!(await this.deps.leases.release(lease)))
      throw leaseLost('Lease was lost before turn completion')
    this.#completed = true
    return { result, manifest }
  }

  /** Why the turn failed, from where it stopped. */
  failed(error: unknown): void {
    const { guard } = this.init
    this.#reason = guard.signal.aborted
      ? guard.reason
      : this.#publishStarted
        ? 'publication_ambiguous'
        : this.#checkpointStarted
          ? 'snapshot_ambiguous'
          : isSnapshotCredential(error)
            ? 'snapshot_credential'
            : isDomainError(error) && error.code === 'LEASE_LOST'
              ? 'lease_lost'
              : 'run_failed'
  }

  /**
   * Recovery gives the turn up: it ends as `lost`, never billed (P12), or as `failed` when its
   * owner gave it up first (vacating).
   */
  giveUp(
    reason: NonNullable<TurnEvidence['reason']>,
    outcome: TurnAssignmentOutcome = 'lost',
  ): void {
    this.#reason = reason
    this.#outcome = outcome
  }

  /**
   * Removes the container (and, unless the turn completed, whatever `alsoRemove` removes), then
   * releases the site, or holds it when a removal failed or S3 or Git may have been written.
   * Without its last journal entry the site stays held only in the latter cases; a failed
   * release expires by its TTL. A turn whose prepare is out without a container reported is
   * vacating: nothing is released or finished until vacated() or a late container's removal.
   */
  async settle(
    alsoRemove?: () => Promise<void>,
  ): Promise<'completed' | 'released' | 'held' | 'vacating'> {
    const { lease, guard } = this.init
    // A container the executor reports from now on is removed by the `created` hook.
    this.#abandoned = true
    let recovery = this.#checkpointStarted && !this.#completed
    // Decided before any await, so that a late `created` or vacated() sees the same answer.
    if (!this.#completed && !recovery && !this.execution && this.#dispatched && !this.#vacated) {
      this.#vacating = true
      this.#vacatingRecorded = this.record('vacating', { reason: this.#reason }).catch(() => {})
      guard.close()
      // Journaled before the supervisor leaves LiveTurns: a recovery pass of this process must
      // replay it, or it would close the turn `lost` instead of `failed`.
      await this.#vacatingRecorded
      return 'vacating'
    }
    try {
      await this.#destroy()
      if (!this.#completed) await alsoRemove?.()
    } catch {
      recovery = true
      this.#reason = 'destroy_failed'
    }
    if (!this.#completed) {
      if (recovery) await holdForRecovery(this.deps.leases, lease, this.#lastPhase)
      await this.record(
        recovery ? 'recovery' : 'failed',
        recovery
          ? { reason: this.#reason }
          : { reason: this.#reason, outcome: this.#outcome === 'lost' ? 'lost' : 'failed' },
      ).catch(() => {})
      if (!recovery) await this.deps.leases.release(lease).catch(() => false)
    }
    // A held turn stays assigned for recovery; a failed update is left to it as well.
    if (this.assignment && (this.#completed || !recovery))
      await this.deps.assignments
        .finish({
          id: this.assignment.id,
          epoch: lease.epoch,
          outcome: this.#completed ? 'completed' : this.#outcome,
        })
        .catch(() => false)
    guard.close()
    await this.#publication?.dispose().catch(() => {})
    return this.#completed ? 'completed' : recovery ? 'held' : 'released'
  }

  #destroyReason(checkpointComplete = false): DestroyReason {
    const { guard } = this.init
    return guard.signal.aborted
      ? guard.reason === 'timeout'
        ? 'timeout'
        : 'cancelled'
      : checkpointComplete
        ? 'completed'
        : 'failed'
  }

  async #destroy(checkpointComplete = false): Promise<void> {
    if (!this.execution || this.#destroyed) return
    await this.execution.destroy(this.#destroyReason(checkpointComplete))
    this.#destroyed = true
  }
}
