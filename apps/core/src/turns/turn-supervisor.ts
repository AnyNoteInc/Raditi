import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'

import {
  assertSandboxSpec,
  badRequest,
  conflict,
  containsCredential,
  driverPrepareInvalid,
  MAX_PRESIGN_TTL_MS,
  preparedRunExposesSecret,
  preparedRunLimits,
  preparedRunSchema,
  requirementsOf,
  turnMayHoldInbox,
  runEnvValues,
  siteBusy,
  siteHeld,
  snapshotPlanSchema,
  snapshotReferenceSchema,
  toTurnPlan,
  TURN_FINALIZE_MS,
  turnCredentials,
  turnCredentialPolicySchema,
  withTurnCredentials,
  type AgentDriver,
  type PreparedFiles,
  type PreparedRun,
  type RunContext,
  type TurnExecutor,
  type TurnPlan,
  type TurnBundleSource,
  type TurnRequest,
  type UnkeyedTurnRequest,
  type TurnCredentialPolicy,
  type TurnRestoreSource,
} from '@repo/domain'

import { newTurnKeys } from '@repo/turn-keys'
import { LeaseGuard, TURN_LEASE_MS, turnRenewal } from './lease-guard.ts'
import type { LiveTurns } from './live-turns.ts'
import type { TurnInbox } from './turn-inbox.ts'
import type { TurnProjectFiles } from './turn-project-files.ts'
import { bundleOfPlan, gitNotConfigured, plannedSnapshotGit } from './turn-repository.ts'
import {
  TurnAttempt,
  type CompletedTurn,
  type TurnAttemptDependencies,
  type TurnSnapshotStore,
} from './turn-attempt.ts'

export type { CompletedTurn, TurnRequest, UnkeyedTurnRequest, TurnSnapshotStore }

export interface TurnSupervisorDependencies extends TurnAttemptDependencies {
  /** Owns the turn's container: in core's process (PoC) or on a runner VM. */
  executor: TurnExecutor
  driver: AgentDriver
  /** Shared with TurnExecRecovery: it never takes over a turn this process drives. */
  live: LiveTurns
  /** Required for a plan that names files of the client (`input.attachments`). */
  inbox?: TurnInbox
  /** Required for a plan that names files of the chat's project (`input.projectFiles`). */
  projectFiles?: TurnProjectFiles
}

/** A presigned URL never outlives the lease that allowed it (spec §14). */
const presignTtlMs = (guard: LeaseGuard) => Math.min(MAX_PRESIGN_TTL_MS, guard.leaseRemainingMs)

const renewLogger = new Logger('TurnLease')
const supervisorLogger = new Logger('TurnSupervisor')

/** What the caller of a turn may follow while it runs. */
export interface TurnRunHooks {
  /**
   * The turn holds its keys (docs/plan/74, Д2): `refusal` reads the values of the site's variables
   * now and answers what tells a text that holds a key or a value — the client may change a
   * variable while the turn runs. Rejects when Vault does not answer. Called at most once.
   */
  onArmed?: (refusal: () => Promise<(text: string) => 'turn_key' | 'client_value' | null>) => void
}

/** PoC execution only: task billing, queue dispatch and product task transitions belong to P12. */
export class TurnSupervisor {
  constructor(private readonly deps: TurnSupervisorDependencies) {}

  async run(
    request: UnkeyedTurnRequest,
    policy: TurnCredentialPolicy,
    signal?: AbortSignal,
    hooks: TurnRunHooks = {},
  ): Promise<CompletedTurn> {
    const plan = this.validate(request)
    const parsed = turnCredentialPolicySchema.safeParse(policy)
    if (!parsed.success || parsed.data.driverId !== this.deps.driver.id)
      throw badRequest('Invalid turn credential policy')
    if (
      plan.context.llm.reasoningEffort !== undefined &&
      plan.context.llm.reasoningEffort !== parsed.data.reasoningEffort
    )
      throw badRequest('Turn reasoning effort differs from credential policy')
    // Persist the same profile the key allows, including an explicit provider default.
    // Older saved plans can still omit this field when recovery adopts their existing exec.
    plan.context.llm.reasoningEffort = parsed.data.reasoningEffort
    // A turn with a repository needs the trusted git; one without needs none. Refused before the
    // lease, so a core without git still runs turns without a repository.
    const git = this.deps.repository
    if (plan.repository && !git) throw gitNotConfigured()
    await this.assertLaunchable(plan)
    const labels = request.sandbox.labels
    // A pool that would send the pass back does so before anything of the turn is written: no
    // lease, no lifecycle entry, no assignment, the task's turn number unmoved.
    await this.deps.credentials.admit?.(labels.taskId, parsed.data)
    const acquiredAt = performance.now()
    const lease = await this.deps.leases.acquire({
      siteId: labels.siteId,
      taskId: labels.taskId,
      operation: 'turn',
      ttlMs: TURN_LEASE_MS,
    })
    if (!lease) {
      // Only to tell the client why; a failed lookup is still just a busy chat. A hold the
      // operator must settle ends the turn's chat.
      const current = await this.deps.leases.inspect(labels.siteId).catch(() => null)
      throw current?.heldForOperator ? siteHeld() : siteBusy()
    }
    // Before the assignment exists: recovery never takes over a turn this process drives.
    this.deps.live.enter(lease)
    // No time limit (ВР1): the turn lives while this process renews it.
    const guard = new LeaseGuard(
      lease,
      this.deps.leases,
      turnRenewal(this.deps.assignments, lease, labels.turn),
      signal,
      performance.now() - acquiredAt,
    )
    const attempt = new TurnAttempt(this.deps, { lease, guard, plan, driver: this.deps.driver })
    // Each renewal moves the container's deadline and its gateway's with it (ВР4, ВР5). A failed
    // extension is retried by the next renewal; the container ends at its last one otherwise.
    guard.onRenewed((remainingMs) => {
      void attempt.execution
        ?.extend(remainingMs)
        .catch(() => renewLogger.warn('turn_extend_failed'))
    })
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
      attempt.credentialRef = {
        taskId: labels.taskId,
        sessionId: labels.sessionId,
        turn: labels.turn,
        epoch: opened.firstEpoch,
      }
      let boundSource: string | null = null
      if (this.deps.executor.kind === 'runner') {
        if (!this.deps.executor.credentialAddress)
          throw badRequest('Runner credential source unavailable')
        // A slot of a runner VM is reserved, and the key below is bound to that VM's address.
        // Nothing durable binds the turn to the runner until executor.prepare hands the command
        // out: a turn given up, or left by a core that died, before that was never handed out,
        // and its site is freed at once (spec §8).
        boundSource = await guard.interruptible(
          this.deps.executor.credentialAddress(opened.id, guard.signal),
        )
      }
      await guard.assertFence()
      const values = await guard.interruptible(
        this.deps.credentials.issue(attempt.credentialRef, {
          ...parsed.data,
          ttlMs: Math.min(parsed.data.ttlMs, guard.remainingMs),
          deadlineAt: opened.deadlineAt,
          boundSource,
        }),
      )
      const keyed = withTurnCredentials(plan, values)
      if (
        containsCredential(Object.values(request.sandbox.env), turnCredentials(keyed.context, []))
      )
        throw badRequest('Sandbox env contains a turn credential')
      let restore: TurnRestoreSource | undefined
      if (request.previous) {
        await guard.assertFence()
        const source = await guard.interruptible(
          this.deps.snapshots.restoreSource(request.previous, presignTtlMs(guard)),
        )
        // Only the session comes back (TurnRestoreSource): the working copy of a turn with a
        // repository comes from its bundle. A turn with one goes on from a checkpoint of a turn
        // with a repository, unless the repository of the chat changed since (ПР32) — then only
        // the session of that checkpoint is taken. A turn without one never reads a working copy.
        // The name of the branch may differ: the chat's branch row was named after the agent
        // renamed the chat (the chat of 21.11.2026); the bundle brings the working copy all the
        // same, so only the session is taken and the pass goes on.
        if (plan.repository && plan.repository.repositoryChanged !== true) {
          const saved = source.manifest.git
          if (saved === undefined)
            throw conflict('Previous checkpoint differs from the repository of the turn')
          if (saved.branch !== plan.repository.branch)
            supervisorLogger.warn(`turn_checkpoint_branch_renamed task=${labels.taskId}`)
        }
        // The data key leaves core only while this owner still holds the site.
        restore = {
          ...source,
          dataKey: async () => {
            await guard.assertFence()
            return source.dataKey()
          },
        }
      }
      // Built again by the trusted git from the plan (ПР12): the same bytes the plan names, from
      // the cache of the bundles, or a conflict. The executor gets the objects only.
      let bundle: TurnBundleSource | undefined
      if (plan.repository && git) {
        await guard.assertFence()
        bundle = await guard.interruptible(bundleOfPlan(git, plan.repository))
      }
      // The files the plan names, checked against the database again under the lease; each is
      // read only when the executor writes it into the sandbox.
      const inbox = request.input.attachments.length
        ? await guard.interruptible(
            this.deps.inbox!.files(labels.taskId, request.input.attachments),
          )
        : []
      // The files of the chat's project (docs/plan/84-projects.md, ПР8): checked the same way,
      // against the project the chat is in now.
      const projectPaths = request.input.projectFiles ?? []
      const projectFiles = projectPaths.length
        ? await guard.interruptible(this.deps.projectFiles!.files(labels.taskId, projectPaths))
        : []
      const context = {
        ...keyed.context,
        ...(restore?.manifest.driver.nativeSessionId
          ? { nativeSessionId: restore.manifest.driver.nativeSessionId }
          : {}),
      }
      const prepared = await this.deps.driver.prepare(context)
      const argv = this.deps.driver.command(prepared, request.input)
      const { files, credentials } = checkPreparedRun(context, prepared, argv)
      attempt.credentials = credentials
      attempt.envValues = runEnvValues(context)
      // The texts of the turn are checked while it runs (docs/plan/74, Д2): with what the turn
      // holds, once it holds it. Not armed — the end of the turn checks them, as before.
      hooks.onArmed?.(() => attempt.liveRefusal())
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
            ...(restore ? { restore } : {}),
            ...(bundle ? { bundle } : {}),
            ...(inbox.length ? { inbox } : {}),
            ...(projectFiles.length ? { projectFiles } : {}),
            driverId: this.deps.driver.id,
            prepared: files,
            argv,
            credentials,
            ...(attempt.envValues.length ? { envValues: attempt.envValues } : {}),
            created: (created) => attempt.created(created),
            // Until a container is reported, only these tell whether the site may be freed.
            dispatched: () => attempt.dispatched(),
            vacated: () => attempt.vacated(),
          },
          guard.signal,
        ),
      )
      attempt.execution = ready
      // Recovery derives the session state from the driver session this turn resumed.
      await attempt.record(
        'restored',
        context.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {},
      )
      await guard.assertFence()
      // The agent has no time limit (ВР1): it ends itself, is cancelled or runs out of credits,
      // or the turn is lost with its lease.
      const agent = await ready.launch()
      attempt.execId = agent.execId
      await attempt.record('running')
      const events = await attempt.follow(agent)
      // The agent ended: the platform's steps after it have their own limit (ВР7).
      guard.finalize(TURN_FINALIZE_MS)
      return await attempt.complete(events, prepared)
    } catch (error) {
      guard.finalize(TURN_FINALIZE_MS)
      attempt.failed(error)
      throw error
    } finally {
      try {
        await attempt.settle()
      } finally {
        if (attempt.assignment) this.deps.executor.forgetCredentialAddress?.(attempt.assignment.id)
        this.deps.live.leave(lease)
      }
    }
  }

  /**
   * What the driver would refuse after the lease and the key, it refuses here: a dry run of its prepare and command over the plan, with stand-ins for the
   * two credentials no turn has before its lease — a pair of the turn's own formats, never
   * stored or admitted anywhere. A profile or an input the CLI cannot be launched with then
   * costs no turn number. Nothing of the run is kept.
   */
  private async assertLaunchable(plan: TurnPlan): Promise<void> {
    const keyed = withTurnCredentials(plan, newTurnKeys())
    const { input } = keyed
    // The session of an action comes out of its checkpoint, under the lease: a stand-in here.
    const context = input.action ? { ...keyed.context, nativeSessionId: 'dry-run' } : keyed.context
    const prepared = await this.deps.driver.prepare(context)
    checkPreparedRun(context, prepared, this.deps.driver.command(prepared, input))
  }

  /** Everything checked before the lease; the plan is what the assignment keeps. */
  private validate(request: UnkeyedTurnRequest): TurnPlan {
    assertSandboxSpec(request.sandbox)
    const labels = request.sandbox.labels
    // A turn names its repository exactly when it needs one (docs/plan/84-projects.md, §4.3).
    if (requirementsOf(request).repository !== (request.repository !== undefined))
      throw badRequest('A turn has its repository exactly when it needs one')
    // `/undo` goes back to the checkpoint the undone turn started from (docs/plan/61, §5.14).
    if (request.rewound !== undefined && labels.turn < 2)
      throw badRequest('Only a later turn is rewound')
    // The client's files go only to the turn of their chat (docs/plan/61, К16).
    if (request.input.attachments.length && !turnMayHoldInbox(labels))
      throw badRequest('Files of the client go only to the turn of their chat')
    if (request.input.attachments.length && !this.deps.inbox)
      throw badRequest('Files of the client need the inbox of core')
    // The files of a project go to the turn of its chat only (docs/plan/84-projects.md, ПР8).
    if (request.input.projectFiles?.length && !turnMayHoldInbox(labels))
      throw badRequest('Files of a project go only to the turn of its chat')
    if (request.input.projectFiles?.length && !this.deps.projectFiles)
      throw badRequest('Files of a project need the inbox of core')
    // A compaction shortens a session: only a checkpoint brings one (docs/plan/61, §5.14).
    if (request.input.action !== undefined && !request.previous)
      throw badRequest('An action of a turn needs the checkpoint of an earlier turn')
    // A turn after an unsuccessful one starts a new session (plan 57, Б3, Б4); the assignment
    // store checks that the turn before it did not complete.
    if (!request.previous && request.context.nativeSessionId)
      throw badRequest('A new session must start fresh')
    if (request.sandbox.secrets.length !== 0)
      throw badRequest('Turn secrets are installed only after restore')
    if ('apiKey' in request.context.llm || 'token' in request.context.mcp)
      throw badRequest('Turn credentials must be issued by the supervisor')
    if (
      request.context.taskId !== labels.taskId ||
      request.context.sessionId !== labels.sessionId ||
      request.context.turn !== labels.turn
    )
      throw badRequest('Turn context differs from sandbox identity')
    // The manifest's own rules: a turn must not end with a checkpoint save() refuses. A turn
    // with a repository saves its `git` too.
    const git = plannedSnapshotGit(request)
    const plan = snapshotPlanSchema.safeParse({
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: labels.turn,
      image: request.sandbox.image,
      driver: { id: this.deps.driver.id, version: request.driverVersion },
      ...(git ? { git } : {}),
    })
    if (!plan.success) throw badRequest('Invalid turn snapshot metadata')
    if (request.previous) {
      // A reference that fails its schema — one that names a driver the platform does not
      // have, say — is refused like any other checkpoint this turn cannot continue. The image
      // may differ: a release brings a new sandbox image, and the session of the CLI belongs to
      // the driver and its version, not to the image (the chat of 16.11.2026 failed every pass
      // after v1.61.0). The reference keeps the image the checkpoint was sealed with.
      const { data: prior } = snapshotReferenceSchema.safeParse(request.previous)
      if (
        !prior ||
        prior.workspaceId !== labels.workspaceId ||
        prior.sessionId !== labels.sessionId ||
        (request.rewound ? prior.turn >= labels.turn - 1 : prior.turn !== labels.turn - 1) ||
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
  // The runner protocol carries each credential within this limit: so does the local executor.
  if (credentials.some((value) => value.length > preparedRunLimits.secretChars))
    throw driverPrepareInvalid('A turn credential is too long')
  if (preparedRunExposesSecret(parsed.data, credentials, argv))
    throw driverPrepareInvalid('Prepared turn files, env or command contain a turn credential')
  const { files, env, secrets } = parsed.data
  return { files: { files, env, secrets }, credentials }
}
