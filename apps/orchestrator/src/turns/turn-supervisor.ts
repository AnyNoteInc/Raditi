import { performance } from 'node:perf_hooks'

import {
  assertSandboxSpec,
  badRequest,
  conflict,
  containsCredential,
  driverPrepareInvalid,
  MAX_PRESIGN_TTL_MS,
  preparedRunExposesSecret,
  preparedRunSchema,
  publicationMetadataSchema,
  siteBusy,
  siteHeld,
  snapshotPlanSchema,
  snapshotReferenceSchema,
  toTurnPlan,
  TURN_FINALIZE_RESERVE_MS,
  TURN_PUBLICATION_GRACE_MS,
  turnCredentials,
  type AgentDriver,
  type PreparedFiles,
  type PreparedRun,
  type RunContext,
  type TurnBundleSource,
  type TurnExecutor,
  type TurnPlan,
  type TurnRequest,
  type TurnRestoreSource,
} from '@repo/domain'

import { LeaseGuard } from './lease-guard.ts'
import type { LiveTurns } from './live-turns.ts'
import {
  TurnAttempt,
  type CompletedTurn,
  type TurnAttemptDependencies,
  type TurnSnapshotStore,
} from './turn-attempt.ts'

export type { CompletedTurn, TurnRequest, TurnSnapshotStore }

export interface TurnSupervisorDependencies extends TurnAttemptDependencies {
  /** Owns the turn's container: in core's process (PoC) or on a runner VM. */
  executor: TurnExecutor
  driver: AgentDriver
  /** Shared with TurnExecRecovery: it never takes over a turn this process drives. */
  live: LiveTurns
}

/** A presigned URL never outlives the lease that allowed it (spec §14). */
const presignTtlMs = (guard: LeaseGuard) => Math.min(MAX_PRESIGN_TTL_MS, guard.leaseRemainingMs)

/** PoC execution only: task billing, queue dispatch and product task transitions belong to P12. */
export class TurnSupervisor {
  constructor(private readonly deps: TurnSupervisorDependencies) {}

  async run(request: TurnRequest, signal?: AbortSignal): Promise<CompletedTurn> {
    const plan = this.validate(request)
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
    // Before the assignment exists: recovery never takes over a turn this process drives.
    this.deps.live.enter(lease)
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      request.sandbox.hardTimeoutMs,
      signal,
      performance.now() - acquiredAt,
    )
    const attempt = new TurnAttempt(this.deps, { lease, guard, plan, driver: this.deps.driver })
    try {
      await guard.assertFence()
      await attempt.record('leased')
      const opened = await this.deps.assignments.open({
        fence: lease,
        sessionId: labels.sessionId,
        turn: labels.turn,
        executor: this.deps.executor.kind,
        plan,
        remainingMs: guard.remainingMs,
      })
      if (!opened) {
        await guard.assertFence()
        throw conflict('The turn already has an unfinished assignment')
      }
      attempt.assignment = opened
      // Cloned on the host with a short read-only credential; the executor gets objects only.
      let bundle: TurnBundleSource | undefined = await guard.interruptible(
        this.deps.workspace.buildBaseBundle(request.workspace),
      )
      let restore: TurnRestoreSource | undefined
      if (request.previous) {
        await guard.assertFence()
        const source = await guard.interruptible(
          this.deps.snapshots.restoreSource(request.previous, presignTtlMs(guard)),
        )
        if (source.manifest.git.headSha !== request.workspace.expectedBaseSha)
          throw conflict('Previous checkpoint differs from the expected checkout')
        // The data key leaves core only while this owner still holds the site.
        restore = {
          ...source,
          dataKey: async () => {
            await guard.assertFence()
            return source.dataKey()
          },
        }
      }
      const context = {
        ...request.context,
        ...(restore?.manifest.driver.nativeSessionId
          ? { nativeSessionId: restore.manifest.driver.nativeSessionId }
          : {}),
      }
      const prepared = await this.deps.driver.prepare(context)
      const argv = this.deps.driver.command(prepared, request.input)
      const { files, credentials } = checkPreparedRun(context, prepared, argv)
      attempt.credentials = credentials
      await guard.assertFence()
      const ready = await guard.interruptible(
        this.deps.executor.prepare(
          {
            assignmentId: opened.id,
            fence: lease,
            sandbox: {
              ...request.sandbox,
              hardTimeoutMs: guard.remainingMs,
              labels: { ...labels, leaseEpoch: lease.epoch },
              secrets: [],
            },
            remainingMs: guard.remainingMs,
            bundle,
            ...(restore ? { restore } : {}),
            driverId: this.deps.driver.id,
            prepared: files,
            argv,
            credentials,
            created: (created) => attempt.created(created),
            // Until a container is reported, only these tell whether the site may be freed.
            dispatched: () => attempt.dispatched(),
            vacated: () => attempt.vacated(),
          },
          guard.signal,
        ),
      )
      attempt.execution = ready
      bundle = undefined
      // Recovery derives the session state from the driver session this turn resumed.
      await attempt.record(
        'restored',
        context.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {},
      )
      await guard.assertFence()
      // The turn limit includes publication: the agent's exec ends the reserve early, while the
      // container keeps the whole limit and outlives the agent for capture, save and push.
      const agent = await ready.launch(guard.remainingBeforeReserveMs(TURN_FINALIZE_RESERVE_MS))
      attempt.execId = agent.execId
      await attempt.record('running')
      const events = await attempt.follow(agent)
      return await attempt.complete(events, prepared)
    } catch (error) {
      attempt.failed(error)
      throw error
    } finally {
      await attempt.settle()
      this.deps.live.leave(lease)
    }
  }

  /** Everything checked before the lease; the plan is what the assignment keeps. */
  private validate(request: TurnRequest): TurnPlan {
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
    return toTurnPlan(request, this.deps.driver.id)
  }
}

/**
 * The driver's files for the executor and the turn's credentials, which the output journal and
 * the snapshot must never contain either. Nothing reaches a sandbox when the driver's run or
 * command is unsafe.
 */
export function checkPreparedRun(
  context: RunContext,
  prepared: PreparedRun,
  argv: readonly string[],
): { files: PreparedFiles; credentials: string[] } {
  // Files only under /agent-home and secrets only in their tmpfs, never the working copy:
  // capture would publish platform files to the client's repository.
  const parsed = preparedRunSchema.safeParse(prepared)
  if (!parsed.success) throw driverPrepareInvalid('Invalid prepared turn file path, mode or size')
  // Credentials only as secret files: /agent-home is packed into the S3 snapshot (rule 2),
  // env and argv show up in docker inspect and process listings.
  const credentials = turnCredentials(context, parsed.data.secrets)
  if (preparedRunExposesSecret(parsed.data, credentials, argv))
    throw driverPrepareInvalid('Prepared turn files, env or command contain a turn credential')
  const { files, env, secrets } = parsed.data
  return { files: { files, env, secrets }, credentials }
}
