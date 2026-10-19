import { setTimeout as sleep } from 'node:timers/promises'

import { Logger } from '@nestjs/common'
import {
  conflict,
  DomainError,
  isCoreStopping,
  isDomainError,
  isSnapshotCredential,
  leaseLost,
  MAX_PRESIGN_TTL_MS,
  snapshotSaveWroteNothing,
  TURN_PUBLICATION_GRACE_MS,
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
  type TurnCredentialRef,
  type TurnCredentialSource,
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
import { maskTurnEvents } from './turn-output.ts'
import { readTurnResult } from './turn-result.ts'

export interface TurnSnapshotStore {
  load(reference: SnapshotReference): Promise<LoadedSnapshot>
  /** The checkpoint a turn starts from, for the executor: presigned GETs of its parts that live `ttlMs`. */
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
  credentials: TurnCredentialSource
  logger?: { warn(message: string): void }
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
  /** Issuance identity: recovery keeps the first epoch even after taking the lease over. */
  credentialRef: TurnCredentialRef | undefined
  /** turnCredentials() of the run: a changed file of the candidate must not contain one. */
  credentials: readonly string[] = []
  /**
   * The values of the client's variables the run's commands got (plan 53, Р13, `runEnvValues`):
   * masked in its events, refused in its candidate.
   */
  envValues: readonly string[] = []
  /**
   * The working-set commit the sandbox started from (plan 53, Р11), from the bundle; a recovered
   * owner derives it again from the plan before it captures.
   */
  sandboxBaseSha: string | undefined
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
  /** Settles, never rejects, once the vacating entry was journaled or finally refused. */
  #vacatingRecorded: Promise<void> = Promise.resolve()
  #revocation: Promise<void> | undefined
  readonly #logger: { warn(message: string): void }

  constructor(
    private readonly deps: TurnAttemptDependencies,
    private readonly init: TurnAttemptInit,
  ) {
    this.#sequence = init.sequence ?? 0
    this.#lastPhase = init.phase ?? 'leased'
    this.#logger = deps.logger ?? new Logger('TurnAttempt')
  }

  /** Cleanup continues after five seconds; the durable core sweeper retries the revoke. */
  #revoke(): Promise<void> {
    if (!this.credentialRef) return Promise.resolve()
    return (this.#revocation ??= (async () => {
      try {
        await withTimeout(
          this.deps.credentials.revoke(this.credentialRef!),
          5_000,
          'Turn credential revocation timed out',
        )
      } catch {
        this.#logger.warn('llm_turn_credentials_revoke_failed')
      }
    })())
  }

  /**
   * As #revoke, unless recovery took the turn over under a newer epoch: the credentials are that
   * owner's then, and serve the agent it resumed. TurnCredentialSource.revoke names no epoch, so
   * the lease is read right before it; every other write of an owner that gives its turn up is
   * fenced by its own statement. A vacating turn revokes at once: its agent never started, and
   * recovery only removes what is left of it.
   */
  async #revokeOwned(): Promise<void> {
    if (await this.#superseded()) return
    await this.#revoke()
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
      ...(this.sandboxBaseSha ? { sandboxBaseSha: this.sandboxBaseSha } : {}),
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
    // A runner's container is recorded by the runner API when the runner reports it; core's own
    // is recorded here. The preview of the dialog exports the working tree of the turn by it
    // (Р23): without it every sync of the turn was refused `no_turn` (stand R12).
    if (this.assignment?.executor === 'local')
      await this.deps.assignments.recordContainer({
        id: this.assignment.id,
        epoch: this.init.lease.epoch,
        containerId: execution.containerId,
      })
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
      await this.#revoke()
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
    await this.#revoke()
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
            const masked = maskTurnEvents(batch.events, this.envValues)
            await this.record('output', {
              cursor: batch.to,
              ...(masked.length ? { events: masked } : {}),
            })
            events.push(...masked)
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
    const result = readTurnResult(driver, events)
    for (const event of events) {
      if (event.type === 'started' && event.nativeSessionId)
        run.context.nativeSessionId = event.nativeSessionId
    }
    const home = driver.sessionState(run)
    const sandboxBaseSha = await this.#sandboxBase()
    await guard.assertFence()
    // Refused when the agent copied a turn credential into its home or the site. The patch is
    // against the commit the sandbox holds: the working set's when it got one.
    const captured = await ready.capture({
      home,
      baseSha: plan.workspace.expectedBaseSha,
      ...(sandboxBaseSha ? { sandboxBaseSha } : {}),
      ...(plan.workspace.addOnlyPaths?.length ? { addOnlyPaths: plan.workspace.addOnlyPaths } : {}),
    })
    const refusedValues = await this.#refusedValues()
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
        ...(refusedValues.length ? { refusedValues } : {}),
      }),
      (late) => late.dispose(),
    )
    this.#publication = publication
    // Publication cut the working set again from the full base: the same commit, or the patch
    // was taken against something else.
    if (publication.sandboxBaseSha !== sandboxBaseSha)
      throw conflict('The candidate stands on another working set than the sandbox')
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
          ...(sandboxBaseSha ? { sandboxBaseSha } : {}),
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
    await this.#revoke()
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

  /**
   * The values the candidate must not hold (plan 53, Р13): the ones the turn's commands got and
   * the ones the site's variables hold now — the preview may have shown the agent a value the
   * client changed after the turn's key was issued. Vault that does not answer fails the turn.
   */
  async #refusedValues(): Promise<string[]> {
    const { guard } = this.init
    const current =
      this.credentialRef && this.deps.credentials.siteValues
        ? await guard.interruptible(this.deps.credentials.siteValues(this.credentialRef))
        : []
    return [...new Set([...this.envValues, ...current])]
  }

  /**
   * The working-set commit of the turn: the bundle's, or for a recovered owner the one the plan
   * gives again — deterministic, so the same the sandbox was given (plan 53, Р11).
   */
  async #sandboxBase(): Promise<string | undefined> {
    const { plan, guard } = this.init
    if (this.sandboxBaseSha || !plan.workspace.workingSet) return this.sandboxBaseSha
    if (!this.deps.workspace.sandboxBase)
      throw conflict('The workspace cannot derive a working set')
    const derived = await guard.interruptible(
      this.deps.workspace.sandboxBase(plan.workspace, plan.committedAt),
    )
    if (!derived) throw conflict('The workspace derived no working set')
    this.sandboxBaseSha = derived
    return derived
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
   * When core stops before any checkpoint and after the turn's container was reported, the turn
   * is left as it is to the next core: `held` without a hold or a journal entry. Without a
   * container it settles like any other failure: released at once when the prepare was not
   * dispatched, vacating when it was, and the next core then closes the turn as `failed`.
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
      this.#vacatingRecorded = this.#recordVacating()
      guard.close()
      // Journaled before the supervisor leaves LiveTurns: a recovery pass of this process must
      // replay it, or it would close the turn `lost` instead of `failed`.
      await this.#vacatingRecorded
      await this.#revoke()
      return 'vacating'
    }
    try {
      await this.#destroy()
      if (!this.#completed) await alsoRemove?.()
    } catch (error) {
      if (isCoreStopping(error) && !recovery && !this.#completed) {
        // The runner keeps the turn: the journal stays on its last step and the lease on its
        // epoch, so the next core's recovery resumes the agent or removes the container.
        guard.close()
        await this.#publication?.dispose().catch(() => {})
        return 'held'
      }
      recovery = true
      this.#reason = 'destroy_failed'
    }
    if (!this.#completed) {
      await this.#revokeOwned()
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

  /**
   * The vacating entry, tried again while the database refuses it and the lease lasts (spec §8):
   * by then recovery would close the turn anyway. A domain refusal (another owner has the site)
   * is final.
   */
  async #recordVacating(): Promise<void> {
    const { guard } = this.init
    for (let delayMs = 100; ; delayMs = Math.min(delayMs * 2, 5_000)) {
      try {
        return await this.record('vacating', { reason: this.#reason })
      } catch (error) {
        if (isDomainError(error) || guard.leaseRemainingMs <= delayMs) return
        await sleep(delayMs)
      }
    }
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
