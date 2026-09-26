import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

import {
  assertSandboxSpec,
  badRequest,
  conflict,
  DomainError,
  SANDBOX_SECRETS_DIR,
  SANDBOX_WORKDIR,
  snapshotReferenceSchema,
  TURN_PUBLICATION_GRACE_MS,
  turnResultSchema,
  turnSnapshotPrefix,
  type AgentDriver,
  type PreparedRun,
  type RunContext,
  type Sandbox,
  type SandboxFile,
  type SandboxProvider,
  type SandboxSpec,
  type SiteLeaseStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnEvidence,
  type TurnInput,
  type TurnJournal,
  type TurnPhase,
  type TurnPublication,
  type TurnResult,
  type TurnWorkspace,
  type TurnWorkspaceSource,
} from '@repo/domain'

import type { SandboxSnapshotTransport, SnapshotArchives } from '../sessions/sandbox-snapshot.ts'
import type { LoadedSnapshot } from '../sessions/snapshot.service.ts'
import { LeaseGuard } from './lease-guard.ts'
import { readTurnOutput } from './turn-output.ts'

export interface TurnRequest {
  sandbox: SandboxSpec
  context: RunContext
  input: TurnInput
  driverVersion: string
  workspace: TurnWorkspaceSource
  /** Trusted persisted time; retries use the identical value for deterministic publication. */
  committedAt: string
  previous?: SnapshotReference
}

export interface TurnSnapshotStore {
  load(reference: SnapshotReference): Promise<LoadedSnapshot>
  save(metadata: SnapshotMetadata, archives: SnapshotArchives): Promise<SnapshotManifest>
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
  constructor(
    private readonly deps: TurnSupervisorDependencies,
    private readonly leaseTtlMs = 60_000,
  ) {
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 30 * 60_000)
      throw badRequest('Invalid turn lease duration')
  }

  async run(request: TurnRequest, signal?: AbortSignal): Promise<CompletedTurn> {
    this.validate(request)
    const labels = request.sandbox.labels
    const leaseTtlMs = Math.max(
      this.leaseTtlMs,
      request.sandbox.hardTimeoutMs + TURN_PUBLICATION_GRACE_MS,
    )
    const acquiredAt = performance.now()
    const lease = await this.deps.leases.acquire({
      siteId: labels.siteId,
      taskId: labels.taskId,
      operation: 'turn',
      ttlMs: leaseTtlMs,
    })
    if (!lease) throw conflict('The site is already running an operation or requires recovery')
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      leaseTtlMs,
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
    let reason: TurnEvidence['reason'] = 'run_failed'
    let execId: string | undefined
    let candidateHeadSha: string | undefined
    const record = async (phase: TurnPhase, extra: Partial<TurnEvidence> = {}) => {
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
        previous = await this.deps.snapshots.load(request.previous)
        if (previous.manifest.git.headSha !== request.workspace.expectedBaseSha)
          throw conflict('Previous checkpoint differs from the expected checkout')
      }
      await guard.assertFence()
      await this.deps.workspace.prepareWorkspace(sandbox, request.workspace)
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
      await this.writePrepared(sandbox, prepared, guard)
      await guard.assertFence()
      const handle = await sandbox.exec({
        argv: this.deps.driver.command(prepared, request.input),
        cwd: SANDBOX_WORKDIR,
        env: prepared.env,
        timeoutMs: guard.remainingMs,
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
                await guard.assertFence()
                await record('output', { cursor, ...(events.length ? { events } : {}) })
              },
              () => guard.assertActive(),
              [
                context.llm.apiKey,
                context.mcp.token,
                ...prepared.secrets.map((file) => file.content),
              ],
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
      const archives = await this.deps.transport.capture(
        sandbox,
        home,
        request.workspace.expectedBaseSha,
      )
      await guard.assertFence()
      publication = await this.deps.workspace.preparePublication({
        ...request.workspace,
        taskId: labels.taskId,
        turn: labels.turn,
        createdAt: request.committedAt,
        patch: archives.patch,
        untracked: archives.untracked,
      })
      candidateHeadSha = publication.headSha
      await guard.assertFence()
      await record('checkpointing')
      checkpointStarted = true
      const manifest = await this.deps.snapshots.save(
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
      )
      await guard.assertFence()
      await record('checkpointed', {
        snapshotPrefix: turnSnapshotPrefix(labels.sessionId, labels.turn),
      })
      await destroy(true)
      await record('destroyed')
      await guard.assertFence()
      await record('publishing')
      publishStarted = true
      await publication.publish(() => guard.assertFence())
      await guard.assertFence()
      await record('completed', { result })
      if (!(await this.deps.leases.release(lease)))
        throw conflict('Lease was lost before turn completion')
      completed = true
      return { result, manifest }
    } catch (error) {
      reason = guard.signal.aborted
        ? guard.reason
        : publishStarted
          ? 'publication_ambiguous'
          : checkpointStarted
            ? 'snapshot_ambiguous'
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
        if (recovery) await this.deps.leases.holdForRecovery(lease).catch(() => false)
        try {
          await record(recovery ? 'recovery' : 'failed', { reason })
        } catch {
          recovery = true
          await this.deps.leases.holdForRecovery(lease).catch(() => false)
        }
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
    if (
      request.context.taskId !== labels.taskId ||
      request.context.sessionId !== labels.sessionId ||
      request.context.turn !== labels.turn
    )
      throw badRequest('Turn context differs from sandbox identity')
    if (
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(request.workspace.expectedBaseSha) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(request.committedAt) ||
      !Number.isFinite(Date.parse(request.committedAt))
    )
      throw badRequest('Invalid trusted publication metadata')
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

  private async writePrepared(
    sandbox: Sandbox,
    prepared: PreparedRun,
    guard: LeaseGuard,
  ): Promise<void> {
    const files = [...prepared.files, ...prepared.secrets]
    if (
      files.length > 256 ||
      files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 4 * 1024 * 1024
    )
      throw badRequest('Prepared turn files exceed their limits')
    const seen = new Set<string>()
    const write = async (file: SandboxFile, secret: boolean) => {
      const path = file.path
      const parts = path.split('/').slice(1)
      const allowed = secret
        ? path.startsWith(`${SANDBOX_SECRETS_DIR}/`)
        : ['/agent-home/', '/workspace/'].some((root) => path.startsWith(root))
      if (
        !allowed ||
        path.length > 1024 ||
        path.includes('\\') ||
        [...path].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        parts.some(
          (part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git',
        ) ||
        seen.has(path)
      )
        throw badRequest('Invalid prepared turn file path')
      if (
        file.mode !== undefined &&
        (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
      )
        throw badRequest('Invalid prepared file mode')
      seen.add(path)
      await guard.assertFence()
      await sandbox.fs.write(path, Buffer.from(file.content), {
        mode: secret ? 0o600 : (file.mode ?? 0o600),
      })
    }
    for (const file of prepared.files) await write(file, false)
    for (const file of prepared.secrets) await write(file, true)
  }
}
