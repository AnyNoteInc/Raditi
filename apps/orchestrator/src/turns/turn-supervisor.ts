import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

import {
  assertSandboxSpec,
  badRequest,
  conflict,
  containsCredential,
  DomainError,
  driverPrepareInvalid,
  isDomainError,
  isSnapshotCredential,
  leaseLost,
  preparedRunExposesSecret,
  preparedRunSchema,
  publicationMetadataSchema,
  SANDBOX_WORKDIR,
  siteBusy,
  siteHeld,
  snapshotPlanSchema,
  snapshotReferenceSchema,
  snapshotSaveWroteNothing,
  TURN_FINALIZE_RESERVE_MS,
  TURN_PUBLICATION_GRACE_MS,
  turnCredentials,
  turnResultSchema,
  turnSnapshotPrefix,
  withTimeout,
  type AgentDriver,
  type PreparedRun,
  type RunContext,
  type Sandbox,
  type SandboxProvider,
  type SiteLeaseStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnEvidence,
  type TurnJournal,
  type TurnPhase,
  type TurnPublication,
  type TurnRequest,
  type TurnResult,
  type TurnWorkspace,
} from '@repo/domain'

import type { SandboxSnapshotTransport, SnapshotArchives } from '../sessions/sandbox-snapshot.ts'
import type { LoadedSnapshot } from '../sessions/snapshot.service.ts'
import { holdForRecovery, LeaseGuard } from './lease-guard.ts'
import { readTurnOutput } from './turn-output.ts'

export type { TurnRequest }

export interface TurnSnapshotStore {
  load(reference: SnapshotReference): Promise<LoadedSnapshot>
  /** An aborted `signal` must stop any S3 write that has not started yet (see SnapshotService). */
  save(
    metadata: SnapshotMetadata,
    archives: SnapshotArchives,
    signal: AbortSignal,
  ): Promise<SnapshotManifest>
}

export interface TurnSupervisorDependencies {
  leases: SiteLeaseStore
  sandboxes: SandboxProvider
  driver: AgentDriver
  workspace: TurnWorkspace
  snapshots: TurnSnapshotStore
  transport: Pick<SandboxSnapshotTransport, 'capture' | 'restore'>
  journal: TurnJournal
}

export interface CompletedTurn {
  result: TurnResult
  manifest: SnapshotManifest
}

/** PoC execution only: task billing, queue dispatch and product task transitions belong to P12. */
export class TurnSupervisor {
  constructor(private readonly deps: TurnSupervisorDependencies) {}

  async run(request: TurnRequest, signal?: AbortSignal): Promise<CompletedTurn> {
    this.validate(request)
    const labels = request.sandbox.labels
    const acquiredAt = performance.now()
    const lease = await this.deps.leases.acquire({
      siteId: labels.siteId,
      taskId: labels.taskId,
      operation: 'turn',
      ttlMs: request.sandbox.hardTimeoutMs + TURN_PUBLICATION_GRACE_MS,
    })
    if (!lease) {
      // Only to tell the client why; a failed lookup is still just a busy site.
      const current = await this.deps.leases.inspect(labels.siteId).catch(() => null)
      throw current?.heldForOperator ? siteHeld() : siteBusy()
    }
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      request.sandbox.hardTimeoutMs,
      signal,
      performance.now() - acquiredAt,
    )
    let sandbox: Sandbox | undefined
    let publication: TurnPublication | undefined
    let destroyed = false
    let checkpointStarted = false
    let publishStarted = false
    let completed = false
    let sequence = 0
    let lastPhase: TurnPhase = 'leased'
    let reason: TurnEvidence['reason'] = 'run_failed'
    let execId: string | undefined
    let candidateHeadSha: string | undefined
    const record = async (phase: TurnPhase, extra: Partial<TurnEvidence> = {}) => {
      lastPhase = phase
      await this.deps.journal.record({
        fence: lease,
        sessionId: labels.sessionId,
        turn: labels.turn,
        sequence: ++sequence,
        phase,
        ...(sandbox ? { containerId: sandbox.id } : {}),
        ...(execId ? { execId } : {}),
        ...(candidateHeadSha ? { candidateHeadSha } : {}),
        baseSha: request.workspace.expectedBaseSha,
        committedAt: request.committedAt,
        ...(checkpointStarted
          ? { snapshotPrefix: turnSnapshotPrefix(labels.sessionId, labels.turn) }
          : {}),
        ...extra,
      })
    }
    const destroy = async (checkpointComplete = false) => {
      if (!sandbox || destroyed) return
      await sandbox.destroy(
        guard.signal.aborted
          ? guard.reason === 'timeout'
            ? 'timeout'
            : 'cancelled'
          : checkpointComplete
            ? 'completed'
            : 'failed',
      )
      destroyed = true
    }
    try {
      await guard.assertFence()
      await record('leased')
      sandbox = await this.deps.sandboxes.create(
        {
          ...request.sandbox,
          hardTimeoutMs: guard.remainingMs,
          labels: { ...labels, leaseEpoch: lease.epoch },
          secrets: [],
        },
        guard.signal,
      )
      await guard.assertFence()
      await record('created')

      let previous: LoadedSnapshot | undefined
      if (request.previous) {
        previous = await guard.interruptible(this.deps.snapshots.load(request.previous))
        if (previous.manifest.git.headSha !== request.workspace.expectedBaseSha)
          throw conflict('Previous checkpoint differs from the expected checkout')
      }
      await guard.assertFence()
      await guard.interruptible(this.deps.workspace.prepareWorkspace(sandbox, request.workspace))
      if (previous) {
        await guard.assertFence()
        await this.deps.transport.restore(sandbox, previous.manifest.home, previous.archives)
      }
      await record('restored')
      await guard.assertFence()
      const context = {
        ...request.context,
        ...(previous?.manifest.driver.nativeSessionId
          ? { nativeSessionId: previous.manifest.driver.nativeSessionId }
          : {}),
      }
      const prepared = await this.deps.driver.prepare(context)
      const argv = this.deps.driver.command(prepared, request.input)
      const credentials = await this.writePrepared(sandbox, context, prepared, argv, guard)
      await guard.assertFence()
      const handle = await sandbox.exec({
        argv,
        cwd: SANDBOX_WORKDIR,
        env: prepared.env,
        // The turn limit includes publication: the agent's exec ends the reserve early, while the
        // container keeps the whole limit and outlives the agent for capture, save and push.
        timeoutMs: guard.remainingBeforeReserveMs(TURN_FINALIZE_RESERVE_MS),
        signal: guard.signal,
      })
      execId = handle.id
      await record('running')
      const kill = () => {
        void handle.kill('SIGKILL').catch(() => {})
      }
      guard.signal.addEventListener('abort', kill, { once: true })
      let output: Awaited<ReturnType<typeof readTurnOutput>>
      try {
        const [exit, collected] = await guard.interruptible(
          Promise.all([
            handle.wait(),
            readTurnOutput(
              handle,
              this.deps.driver,
              async (cursor, events) => {
                // Like the periodic probe: only an explicit loss stops the agent here, a read
                // error just warns. The journal INSERT below is fenced by itself.
                await guard.checkFence()
                // Operational evidence, never shown verbatim: a `failed` event's reason is raw
                // CLI/provider text; the chat shows a Russian text chosen by the event type.
                await record('output', { cursor, ...(events.length ? { events } : {}) })
              },
              () => guard.assertActive(),
              credentials,
            ),
          ]),
        )
        if (
          exit.reason !== 'exited' ||
          exit.code !== 0 ||
          collected.events.some((event) => event.type === 'failed')
        ) {
          throw new DomainError(
            'TURN_EXEC_FAILED',
            'The agent process did not finish successfully',
            502,
          )
        }
        output = collected
      } catch (error) {
        await handle.kill('SIGKILL').catch(() => {})
        throw error
      } finally {
        guard.signal.removeEventListener('abort', kill)
      }

      await guard.assertFence()
      await sandbox.quiesce()
      await record('quiesced')
      const result = turnResultSchema.parse(this.deps.driver.extractResult(output.events, null))
      for (const event of output.events) {
        if (event.type === 'started' && event.nativeSessionId)
          prepared.context.nativeSessionId = event.nativeSessionId
      }
      const home = this.deps.driver.sessionState(prepared)
      await guard.assertFence()
      // The agent may have copied a turn credential into its home or the site: never save it.
      const archives = await this.deps.transport.capture(
        sandbox,
        home,
        request.workspace.expectedBaseSha,
        credentials,
      )
      await guard.assertFence()
      publication = await guard.interruptibleResource(
        this.deps.workspace.preparePublication({
          ...request.workspace,
          taskId: labels.taskId,
          turn: labels.turn,
          createdAt: request.committedAt,
          patch: archives.patch,
          untracked: archives.untracked,
          // Binary edits of tracked files are compressed in the patch: checked there in full.
          credentials,
        }),
        (late) => late.dispose(),
      )
      candidateHeadSha = publication.headSha
      await guard.assertFence()
      await record('checkpointing')
      checkpointStarted = true
      const saving = this.deps.snapshots.save(
        {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: labels.turn,
          image: request.sandbox.image,
          driver: {
            id: this.deps.driver.id,
            version: request.driverVersion,
            ...(prepared.context.nativeSessionId
              ? { nativeSessionId: prepared.context.nativeSessionId }
              : {}),
          },
          home,
          git: {
            provider: request.workspace.repo.provider,
            branch: request.workspace.branch,
            baseSha: publication.baseSha,
            headSha: publication.headSha,
            publication: { taskId: labels.taskId, committedAt: request.committedAt },
          },
        },
        { home: archives.home, patch: publication.patch, untracked: publication.untracked },
        // Stops a save still pending on Vault from writing after the supervisor gave up on it.
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
        if (snapshotSaveWroteNothing(outcome)) checkpointStarted = false
        throw error
      })
      await guard.assertFence()
      await record('checkpointed', {
        snapshotPrefix: turnSnapshotPrefix(labels.sessionId, labels.turn),
      })
      await destroy(true)
      await record('destroyed')
      await guard.assertFence()
      await record('publishing')
      publishStarted = true
      await guard.interruptible(publication.publish(() => guard.assertFence()))
      await guard.assertFence()
      await record('completed', { result })
      if (!(await this.deps.leases.release(lease)))
        throw leaseLost('Lease was lost before turn completion')
      completed = true
      return { result, manifest }
    } catch (error) {
      reason = guard.signal.aborted
        ? guard.reason
        : publishStarted
          ? 'publication_ambiguous'
          : checkpointStarted
            ? 'snapshot_ambiguous'
            : isSnapshotCredential(error)
              ? 'snapshot_credential'
              : isDomainError(error) && error.code === 'LEASE_LOST'
                ? 'lease_lost'
                : 'run_failed'
      throw error
    } finally {
      let recovery = checkpointStarted && !completed
      try {
        await destroy()
      } catch {
        recovery = true
        reason = 'destroy_failed'
      }
      if (!completed) {
        if (recovery) await holdForRecovery(this.deps.leases, lease, lastPhase)
        // Without its last journal entry the site stays held only if S3 or Git may have been
        // written (above); otherwise it is released, and a failed release expires by its TTL.
        await record(recovery ? 'recovery' : 'failed', { reason }).catch(() => {})
        if (!recovery) await this.deps.leases.release(lease).catch(() => false)
      }
      guard.close()
      await publication?.dispose().catch(() => {})
    }
  }

  private validate(request: TurnRequest): void {
    assertSandboxSpec(request.sandbox)
    const labels = request.sandbox.labels
    if (labels.turn > 1 && !request.previous)
      throw badRequest('A resumed turn requires the previous checkpoint')
    if (request.sandbox.secrets.length !== 0)
      throw badRequest('Turn secrets are installed only after restore')
    // Container env is visible in docker inspect: credentials reach the sandbox as files only.
    if (
      containsCredential(Object.values(request.sandbox.env), turnCredentials(request.context, []))
    )
      throw badRequest('Sandbox env contains a turn credential')
    if (request.sandbox.hardTimeoutMs <= TURN_FINALIZE_RESERVE_MS)
      throw badRequest('Turn limit leaves no time for the agent')
    if (
      request.context.taskId !== labels.taskId ||
      request.context.sessionId !== labels.sessionId ||
      request.context.turn !== labels.turn
    )
      throw badRequest('Turn context differs from sandbox identity')
    // The same rules preparePublication applies, checked before the lease and the agent's turn.
    const publication = publicationMetadataSchema.safeParse({
      ...request.workspace,
      taskId: labels.taskId,
      turn: labels.turn,
      createdAt: request.committedAt,
    })
    if (!publication.success) throw badRequest('Invalid trusted publication metadata')
    // The manifest's own rules: a 20-minute turn must not end with a checkpoint save() refuses.
    const plan = snapshotPlanSchema.safeParse({
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: labels.turn,
      image: request.sandbox.image,
      driver: { id: this.deps.driver.id, version: request.driverVersion },
      git: {
        provider: request.workspace.repo.provider,
        branch: request.workspace.branch,
        baseSha: request.workspace.expectedBaseSha,
        publication: { taskId: labels.taskId, committedAt: request.committedAt },
      },
    })
    if (!plan.success) throw badRequest('Invalid turn snapshot metadata')
    if (request.previous) {
      const prior = snapshotReferenceSchema.parse(request.previous)
      if (
        prior.workspaceId !== labels.workspaceId ||
        prior.sessionId !== labels.sessionId ||
        prior.turn !== labels.turn - 1 ||
        prior.image !== request.sandbox.image ||
        prior.driver.id !== this.deps.driver.id ||
        prior.driver.version !== request.driverVersion
      )
        throw badRequest('Incompatible previous turn snapshot')
    }
  }

  /**
   * Returns the turn's credentials, which the output journal and the snapshot must never contain
   * either. Nothing is written when the driver's run or command is unsafe.
   */
  private async writePrepared(
    sandbox: Sandbox,
    context: RunContext,
    prepared: PreparedRun,
    argv: readonly string[],
    guard: LeaseGuard,
  ): Promise<string[]> {
    // Files only under /agent-home and secrets only in their tmpfs, never the working copy:
    // capture would publish platform files to the client's repository.
    const parsed = preparedRunSchema.safeParse(prepared)
    if (!parsed.success) throw driverPrepareInvalid('Invalid prepared turn file path, mode or size')
    // Credentials only as secret files: /agent-home is packed into the S3 snapshot (rule 2),
    // env and argv show up in docker inspect and process listings.
    const credentials = turnCredentials(context, parsed.data.secrets)
    if (preparedRunExposesSecret(parsed.data, credentials, argv))
      throw driverPrepareInvalid('Prepared turn files, env or command contain a turn credential')
    const { files, secrets } = parsed.data
    for (const [file, mode] of [
      ...files.map((file) => [file, file.mode ?? 0o600] as const),
      ...secrets.map((file) => [file, 0o600] as const),
    ]) {
      await guard.assertFence()
      await sandbox.fs.write(file.path, Buffer.from(file.content), { mode })
    }
    return credentials
  }
}
