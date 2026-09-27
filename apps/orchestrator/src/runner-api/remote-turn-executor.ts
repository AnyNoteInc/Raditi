import { performance } from 'node:perf_hooks'

import {
  badRequest,
  conflict,
  isDomainError,
  leaseLost,
  presignedGetSchema,
  presignedPutSchema,
  sandboxSpecSchema,
  sessionStateSchema,
  snapshotSealBaseSchema,
  type CapturedTurn,
  type DestroyReason,
  type PresignedRequest,
  type SandboxInfo,
  type SandboxLabels,
  type SealedTurnPart,
  type SessionState,
  type SiteLeaseStore,
  type TurnAdoptInput,
  type TurnAgentExec,
  type TurnAssignmentRunner,
  type TurnAssignmentStore,
  type TurnAttachState,
  type TurnExecution,
  type TurnExecutor,
  type TurnOutputBatch,
  type TurnPrepareInput,
  type TurnSealInput,
  type TurnTakeover,
} from '@repo/domain'

import type { ExecStream } from './exec-stream.ts'
import type { CandidateParts, LiveAssignment, RunnerHub } from './runner-hub.ts'

/** How long core waits for a runner to answer a step of a running turn. */
export const runnerReplyMs = Object.freeze({
  launch: 60_000,
  resume: 60_000,
  adopt: 60_000,
  quiesce: 2 * 60_000,
  capture: 5 * 60_000,
  seal: 5 * 60_000,
  destroy: 2 * 60_000,
})

type Purpose = 'turn' | 'work' | 'removal'

/** Only what the runner needs: the expiry is signed into the URL. */
const wire = ({ method, url, headers }: PresignedRequest) => ({
  method,
  url,
  headers: { ...headers },
})
const get = (request: PresignedRequest) => presignedGetSchema.parse(wire(request))

/**
 * TurnExecutor over the pull protocol: the same steps as LocalTurnExecutor, carried out by the
 * runner VM that claimed the turn's assignment (spec §8 «Раннер на песочной ВМ»). Launch is
 * issued only after a strict lease check; output reaches the supervisor through the journal
 * cursor of an ExecStream.
 */
export class RemoteTurnExecutor implements TurnExecutor {
  readonly kind = 'runner'

  constructor(
    private readonly hub: RunnerHub,
    private readonly leases: Pick<SiteLeaseStore, 'assert'>,
    private readonly assignments: Pick<TurnAssignmentStore, 'get'>,
  ) {}

  async prepare(input: TurnPrepareInput, signal: AbortSignal): Promise<TurnExecution> {
    if (input.sandbox.secrets.length !== 0)
      throw badRequest('Turn secrets are installed only after restore')
    const started = performance.now()
    const runner = await this.hub.awaitClaim(input.assignmentId, signal)
    signal.throwIfAborted()
    const remainingMs = Math.floor(input.remainingMs - (performance.now() - started))
    const live = this.hub.attach({
      id: input.assignmentId,
      fence: input.fence,
      runner,
      credentials: input.credentials,
      remainingMs,
    })
    const execution = new RemoteTurnExecution(this.hub, this.leases, live, 'turn')
    await this.hub.send(
      live,
      {
        type: 'prepare',
        sandbox: sandboxSpecSchema.parse({
          ...input.sandbox,
          hardTimeoutMs: Math.max(1, Math.min(input.sandbox.hardTimeoutMs, remainingMs)),
          secrets: [],
        }),
        remainingMs: Math.max(1, remainingMs),
        bundle: {
          baseSha: input.bundle.baseSha,
          branch: input.bundle.branch,
          sha256: input.bundle.sha256,
          sizeBytes: input.bundle.sizeBytes,
        },
        ...(input.restore
          ? {
              restore: {
                manifest: input.restore.manifest,
                parts: {
                  home: get(input.restore.parts.home),
                  untracked: get(input.restore.parts.untracked),
                  patch: get(input.restore.parts.patch),
                },
              },
            }
          : {}),
        driverId: input.driverId,
        prepared: input.prepared,
        argv: input.argv,
        credentials: [...input.credentials],
      },
      {
        answers: ['prepared'],
        replyMs: remainingMs,
        signal,
        // The runner gets what is left when its poll takes the prepare, not what was left here.
        deadline: started + input.remainingMs,
        bundle: input.bundle,
        ...(input.restore ? { dataKey: input.restore.dataKey } : {}),
        // Runs even after the supervisor gave up, so that it removes the container.
        onCreated: () => input.created(execution),
      },
    )
    return execution
  }

  async adopt(input: TurnAdoptInput, signal: AbortSignal): Promise<TurnExecution | null> {
    signal.throwIfAborted()
    if (input.labels.siteId !== input.fence.siteId || input.labels.taskId !== input.fence.taskId)
      throw badRequest('Adopted container labels differ from the fence')
    const started = performance.now()
    const assignment = await this.assignments.get(input.assignmentId)
    if (!assignment?.runner || assignment.outcome !== null)
      throw conflict('The turn is not held by a runner')
    const live = this.hub.attach({
      id: input.assignmentId,
      fence: input.fence,
      runner: assignment.runner,
      credentials: input.purpose === 'work' ? (input.credentials ?? []) : [],
      remainingMs: input.purpose === 'work' ? input.remainingMs : runnerReplyMs.destroy,
      containerId: input.containerId,
    })
    const answer = await this.hub.send(
      live,
      {
        type: 'adopt',
        containerId: input.containerId,
        labels: input.labels,
        purpose: input.purpose,
        ...(input.purpose === 'work'
          ? {
              work: {
                remainingMs: input.remainingMs,
                driverId: input.driverId,
                ...(input.credentials?.length ? { credentials: [...input.credentials] } : {}),
              },
            }
          : {}),
      },
      {
        answers: ['adopted', 'destroyed'],
        replyMs: runnerReplyMs.adopt,
        signal,
        ...(input.purpose === 'work' ? { deadline: started + input.remainingMs } : {}),
      },
    )
    if (answer.type === 'destroyed') {
      this.hub.release(live, input.fence.epoch)
      return null
    }
    return new RemoteTurnExecution(this.hub, this.leases, live, input.purpose)
  }

  async list(filter: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
    return this.hub.inventory(filter)
  }

  /**
   * The assignment's runner under its current session: the one that launched the agent still
   * holds its credentials, a restarted one does not. An assignment nobody claimed has no runner
   * and no container.
   */
  takeover(assignment: { runner: TurnAssignmentRunner | null }): TurnTakeover | null {
    if (!assignment.runner) return { holdsCredentials: false }
    const session = this.hub.session(assignment.runner.id)
    if (!session) return null
    return { runnerSession: session, holdsCredentials: session === assignment.runner.session }
  }
}

/**
 * One owner's hold on the turn's container, under the epoch it was created or adopted with: once
 * recovery took the turn over under a newer one, this owner's commands are refused as CONFLICT.
 */
class RemoteTurnExecution implements TurnExecution {
  #homeBytes: number | undefined
  readonly #epoch: number

  constructor(
    private readonly hub: RunnerHub,
    private readonly leases: Pick<SiteLeaseStore, 'assert'>,
    private readonly live: LiveAssignment,
    private readonly purpose: Purpose,
  ) {
    this.#epoch = live.fence.epoch
  }

  get containerId(): string {
    const id = this.live.containerId
    if (!id) throw conflict('The runner has not reported the turn container')
    return id
  }

  async launch(timeoutMs: number): Promise<TurnAgentExec> {
    this.#allow('turn')
    // Strict: the agent starts only under a confirmed fence; a failed read counts as lost.
    if (!(await this.leases.assert(this.live.fence).catch(() => false)))
      throw leaseLost('Site lease is no longer owned before the agent starts')
    await this.hub.send(
      this.live,
      { type: 'launch', timeoutMs },
      { answers: ['running'], replyMs: runnerReplyMs.launch, epoch: this.#epoch },
    )
    return this.#agent()
  }

  async attach(from: TurnAttachState): Promise<TurnAgentExec | null> {
    this.#allow('turn', 'work')
    try {
      await this.hub.send(
        this.live,
        { type: 'resume', execId: from.execId, cursor: from.cursor, eventCount: from.eventCount },
        { answers: ['running'], replyMs: runnerReplyMs.resume, epoch: this.#epoch },
      )
    } catch (error) {
      // A missing or foreign exec is lost; anything else may be retried.
      if (isDomainError(error) && error.code === 'EXEC_LOST') return null
      throw error
    }
    return this.#agent()
  }

  async quiesce(): Promise<void> {
    this.#allow('turn', 'work')
    await this.hub.send(
      this.live,
      { type: 'quiesce' },
      { answers: ['quiesced'], replyMs: runnerReplyMs.quiesce, epoch: this.#epoch },
    )
  }

  async capture(input: { home: SessionState; baseSha: string }): Promise<CapturedTurn> {
    this.#allow('turn', 'work')
    // Refused here as the local capture refuses it, before the runner is asked.
    const home = sessionStateSchema.safeParse(input.home)
    if (!home.success) throw badRequest('Invalid snapshot session state')
    const candidates: CandidateParts = {}
    const captured = await this.hub.send(
      this.live,
      { type: 'capture', home: home.data, baseSha: input.baseSha },
      { answers: ['captured'], replyMs: runnerReplyMs.capture, candidates, epoch: this.#epoch },
    )
    // The hub checked both uploads against the report.
    this.#homeBytes = captured.homeBytes
    return {
      patch: candidates.patch!.bytes,
      untracked: candidates.untracked!.bytes,
      homeBytes: captured.homeBytes,
    }
  }

  async seal({ base, dataKey, put }: TurnSealInput): Promise<SealedTurnPart> {
    this.#allow('turn', 'work')
    if (this.#homeBytes === undefined) throw conflict('Nothing was captured to seal')
    const sealed = await this.hub.send(
      this.live,
      {
        type: 'seal',
        base: snapshotSealBaseSchema.parse(base),
        sizeBytes: this.#homeBytes,
        put: presignedPutSchema.parse(wire(put)),
      },
      { answers: ['sealed'], replyMs: runnerReplyMs.seal, dataKey, epoch: this.#epoch },
    )
    return { sha256: sealed.sha256, sizeBytes: sealed.sizeBytes, iv: sealed.iv, tag: sealed.tag }
  }

  async destroy(reason: DestroyReason): Promise<void> {
    if (!this.live.gone)
      await this.hub.send(
        this.live,
        { type: 'destroy', reason },
        { answers: ['destroyed'], replyMs: runnerReplyMs.destroy, epoch: this.#epoch },
      )
    this.hub.release(this.live, this.#epoch)
  }

  #agent(): TurnAgentExec {
    const stream = this.live.exec
    if (!stream) throw conflict('The runner did not start the agent')
    return new RemoteAgentExec(this.hub, this.live, stream, this.#epoch)
  }

  #allow(...purposes: Purpose[]): void {
    if (!purposes.includes(this.purpose))
      throw conflict(
        this.purpose === 'removal'
          ? 'The container was adopted only for removal'
          : 'An adopted turn re-attaches to its agent',
      )
  }
}

class RemoteAgentExec implements TurnAgentExec {
  constructor(
    private readonly hub: RunnerHub,
    private readonly live: LiveAssignment,
    private readonly stream: ExecStream,
    private readonly epoch: number,
  ) {}

  get execId(): string {
    return this.stream.execId
  }

  output(record: (batch: TurnOutputBatch) => Promise<void>): Promise<void> {
    return this.stream.consume(record)
  }

  wait() {
    return this.stream.wait()
  }

  /** The runner kills the exec; its output then ends with the exit report. */
  async kill(): Promise<void> {
    this.hub.post(this.live, { type: 'abort' }, this.epoch)
  }
}
