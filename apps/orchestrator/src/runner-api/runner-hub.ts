import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { Logger, type OnApplicationShutdown } from '@nestjs/common'
import {
  conflict,
  execLost,
  isDomainError,
  leaseLost,
  MAX_SANDBOX_TURN_MS,
  runnerCommandSchema,
  runnerFailure,
  runnerLimits,
  runnerTimings,
  runnerUnavailable,
  TURN_PUBLICATION_GRACE_MS,
  type RunnerCommand,
  type RunnerPollRequest,
  type RunnerReport,
  type SandboxInfo,
  type SandboxLabels,
  type SiteLeaseFence,
  type SiteLeaseStore,
  type TurnAssignmentStore,
  type TurnBundleSource,
  type runnerReconcileRequestSchema,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'
import { z } from 'zod'

import { ExecStream } from './exec-stream.ts'
import { RunnerApiError } from './runner-api-error.ts'

type Envelope = 'commandId' | 'assignmentId' | 'fence' | 'ttlMs'
type Body<C> = C extends unknown ? Omit<C, Envelope> : never
/** A command as the executor writes it; the hub adds its id, assignment, fence and TTL. */
export type RunnerCommandBody = Body<RunnerCommand>
export type RunnerReportType = RunnerReport['type']
export type ReportOf<T extends RunnerReportType> = Extract<RunnerReport, { type: T }>
export type RunnerReconcileRequest = z.infer<typeof runnerReconcileRequestSchema>
export type CandidatePart = 'patch' | 'untracked'
export type CandidateParts = Partial<Record<CandidatePart, { bytes: Uint8Array; sha256: string }>>
export interface ClaimedRunner {
  id: string
  session: string
}

/** A delivered command older than this on receipt is dropped by the runner. */
const COMMAND_TTL_MS = 60_000
const SWEEP_MS = 5_000
/** A claim that lost its race to a runner waits this long for that runner's poll. */
const CLAIM_RACE_MS = 5_000
const RETIRED_SESSIONS = 16

const binaryHeadersSchema = z.object({
  session: z.uuid(),
  epoch: z.coerce.number().int().positive().max(2_147_483_647),
  command: z.uuid(),
})
export type RunnerBinaryHeaders = Record<keyof z.infer<typeof binaryHeadersSchema>, unknown>

interface RunnerSession {
  readonly runnerId: string
  readonly id: string
  lastSeen: number
  polling: number
  /** Only the newest poll of a session waits; an older one answers empty. */
  generation: number
  inventory: RunnerReconcileRequest['inventory']
  inventoryAt: number
  queue: RunnerCommand[]
  wake: (() => void) | undefined
  gone: boolean
}

interface OpenCommand {
  /** Queued as sent; a prepare or an adoption for work is rewritten when a poll takes it. */
  command: RunnerCommand
  readonly answers: readonly RunnerReportType[]
  settled: boolean
  /** A poll took it: the runner may carry it out from now on. */
  delivered: boolean
  /** performance.now() by which the turn ends: its remaining time is counted at delivery. */
  readonly deadline?: number
  resolve(report: RunnerReport): void
  reject(error: unknown): void
  cleanup(): void
  readonly bundle?: TurnBundleSource
  readonly dataKey?: () => Promise<Uint8Array>
  readonly candidates?: CandidateParts
  readonly onCreated?: (containerId: string) => Promise<void>
  readonly onDispatched?: () => void
  readonly onVacated?: () => void
  created?: Promise<void>
}

interface PendingClaim {
  done: boolean
  expiring: boolean
  resolve(runner: ClaimedRunner): void
  reject(error: unknown): void
}

export interface SendOptions<T extends RunnerReportType> {
  answers: readonly T[]
  /** How long core waits for the answer; the command's TTL is at most this. */
  replyMs: number
  signal?: AbortSignal
  /** The epoch the caller drives: refused once recovery took the turn over under a newer one. */
  epoch?: number
  /**
   * performance.now() by which the turn ends. The remaining time of a prepare or an adoption for
   * work is counted when a poll takes it; one that ran out by then is never delivered.
   */
  deadline?: number
  /** Served at runnerBundlePath() while a prepare is open. */
  bundle?: TurnBundleSource
  /** Served at runnerKeyPath() while a prepare with restore or a seal is open. */
  dataKey?: () => Promise<Uint8Array>
  /** Filled by runnerCandidatePath() uploads while a capture is open. */
  candidates?: CandidateParts
  /** Runs once, on the `created` report of a prepare. */
  onCreated?: (containerId: string) => Promise<void>
  /** Runs once, when a poll takes the command: from then on the runner may carry it out. */
  onDispatched?: () => void
  /**
   * Runs when the runner answers a prepare with `failed{absent}` before any container of the
   * turn was reported: proof that it left none (spec §8). Never on `destroyed`.
   */
  onVacated?: () => void
}

/** The core side of one turn on a runner: its fence, runner session and open commands. */
export class LiveAssignment {
  containerId: string | undefined
  /** A `destroyed` report arrived: the container is gone. */
  gone = false
  /**
   * The container core knew that the runner reported removed: proof that it is gone. A report
   * for a container core did not know only sets `gone`, which a newer epoch asks again.
   */
  goneContainer: string | undefined
  exec: ExecStream | undefined
  readonly commands = new Map<string, OpenCommand>()
  readonly answered = new Set<string>()

  constructor(
    readonly id: string,
    public fence: SiteLeaseFence,
    public runner: ClaimedRunner,
    public credentials: readonly string[],
    public expiresAt: number,
  ) {}
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const clampMs = (ms: number) => Math.max(1, Math.min(MAX_SANDBOX_TURN_MS, Math.floor(ms)))
const superseded = () => conflict('The turn was taken over under a newer fence')

/** The command with what is left of its turn when a poll takes it. */
function withRemaining(command: RunnerCommand, remainingMs: number): RunnerCommand {
  if (command.type === 'prepare')
    return {
      ...command,
      remainingMs,
      ttlMs: Math.min(COMMAND_TTL_MS, remainingMs),
      sandbox: {
        ...command.sandbox,
        hardTimeoutMs: Math.min(command.sandbox.hardTimeoutMs, remainingMs),
      },
    }
  if (command.type === 'adopt' && command.work)
    return { ...command, work: { ...command.work, remainingMs } }
  return command
}

/** Only a code: messages of storage and database errors stay out of the log. */
const logged = (error: unknown) =>
  new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown')

function lostLease(error: unknown): boolean {
  return (
    isDomainError(error) &&
    (error.code === 'LEASE_LOST' ||
      (error.code === 'TURN_INTERRUPTED' && error.message === 'lease_lost'))
  )
}

export interface RunnerHubDependencies {
  assignments: TurnAssignmentStore
  leases: Pick<SiteLeaseStore, 'assert'>
  logger?: { warn(message: string): void }
}

/**
 * Core's side of the pull protocol (spec §8 «Раннер на песочной ВМ»), independent of HTTP.
 * Runners long-poll for commands and post reports; executors send commands and await their
 * answers. Every runner request is checked along token → runner id → the assignment's runner
 * session → epoch. P2 runs one core replica, so commands and output live in memory: a restarted
 * core leaves unfinished turns to recovery.
 */
export class RunnerHub implements OnApplicationShutdown {
  readonly #sessions = new Map<string, RunnerSession>()
  readonly #retired = new Map<string, string[]>()
  readonly #live = new Map<string, LiveAssignment>()
  readonly #pending = new Map<string, PendingClaim>()
  #sweep: NodeJS.Timeout | undefined
  #closed = false
  readonly #warn: ThrottledLog

  constructor(private readonly deps: RunnerHubDependencies) {
    const logger = deps.logger ?? new Logger('RunnerHub')
    this.#warn = throttledLogger((line) => logger.warn(line))
  }

  // --- Executor side ----------------------------------------------------------------------------

  /**
   * Waits until a runner claims the assignment. Unclaimed after runnerTimings.claimTimeoutMs, or
   * when `signal` aborts, the assignment is failed so that no runner takes it any more.
   */
  awaitClaim(assignmentId: string, signal: AbortSignal): Promise<ClaimedRunner> {
    this.#assertOpen()
    signal.throwIfAborted()
    if (this.#pending.has(assignmentId)) throw conflict('The turn already waits for a runner')
    const deferred = Promise.withResolvers<ClaimedRunner>()
    let race: NodeJS.Timeout | undefined
    const done = () => {
      pending.done = true
      this.#pending.delete(assignmentId)
      clearTimeout(timer)
      clearTimeout(race)
      signal.removeEventListener('abort', onAbort)
    }
    const pending: PendingClaim = {
      done: false,
      expiring: false,
      resolve: (runner) => {
        if (pending.done) return
        done()
        deferred.resolve(runner)
      },
      reject: (error) => {
        if (pending.done) return
        done()
        deferred.reject(error)
      },
    }
    const expire = (error: unknown) => {
      if (pending.done || pending.expiring) return
      pending.expiring = true
      this.deps.assignments.abandon(assignmentId).then(
        (abandoned) => {
          if (pending.done) return
          if (abandoned) pending.reject(error)
          // A runner claimed it meanwhile: its poll resolves the claim, or nobody will.
          else race = setTimeout(() => pending.reject(error), CLAIM_RACE_MS)
        },
        () => pending.reject(error),
      )
    }
    const onAbort = () => expire(signal.reason)
    const timer = setTimeout(() => expire(runnerUnavailable()), runnerTimings.claimTimeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    this.#pending.set(assignmentId, pending)
    for (const session of this.#sessions.values()) session.wake?.()
    return deferred.promise
  }

  /** The live state of an assignment under `fence`; a newer epoch drops the older commands. */
  attach(input: {
    id: string
    fence: SiteLeaseFence
    runner: ClaimedRunner
    credentials: readonly string[]
    remainingMs: number
    containerId?: string
  }): LiveAssignment {
    this.#assertOpen()
    const expiresAt = performance.now() + input.remainingMs + TURN_PUBLICATION_GRACE_MS
    // Only the fence goes on the wire: a lease grant also carries its expiry and clock.
    const { siteId, taskId, operation, epoch } = input.fence
    const fence = { siteId, taskId, operation, epoch }
    let live = this.#live.get(input.id)
    if (!live) {
      live = new LiveAssignment(input.id, fence, input.runner, input.credentials, expiresAt)
      this.#live.set(input.id, live)
    } else {
      if (live.fence.epoch !== fence.epoch) {
        const error = superseded()
        for (const open of live.commands.values()) this.#reject(open, error)
        live.exec?.fail(error)
        live.exec = undefined
        // Only a proven removal carries over; the new owner asks the runner about the rest.
        if (live.goneContainer === undefined) live.gone = false
      }
      live.fence = fence
      live.runner = input.runner
      live.expiresAt = expiresAt
      if (input.credentials.length > 0) live.credentials = input.credentials
    }
    if (input.containerId) live.containerId = input.containerId
    this.#ensureSweep()
    return live
  }

  /** Queues a command for the assignment's runner session and waits for one of `answers`. */
  send<T extends RunnerReportType>(
    live: LiveAssignment,
    body: RunnerCommandBody,
    options: SendOptions<T>,
  ): Promise<ReportOf<T>> {
    this.#assertOpen()
    if (options.epoch !== undefined && options.epoch !== live.fence.epoch)
      return Promise.reject(superseded())
    if (live.gone) return Promise.reject(execLost('The runner removed the turn container'))
    const session = this.#connected(live)
    if (!session)
      return Promise.reject(runnerUnavailable('The sandbox runner of the turn is not connected'))
    options.signal?.throwIfAborted()
    const replyMs = clampMs(options.replyMs)
    const command = runnerCommandSchema.parse({
      ...body,
      commandId: randomUUID(),
      assignmentId: live.id,
      fence: live.fence,
      ttlMs: Math.min(COMMAND_TTL_MS, replyMs),
    })
    const deferred = Promise.withResolvers<ReportOf<T>>()
    const onAbort = () => this.#reject(open, options.signal?.reason)
    const timer = setTimeout(
      () => this.#reject(open, runnerUnavailable('The sandbox runner did not answer in time')),
      replyMs,
    )
    const open: OpenCommand = {
      command,
      answers: options.answers,
      settled: false,
      delivered: false,
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      resolve: (report) => deferred.resolve(report as ReportOf<T>),
      reject: (error) => deferred.reject(error),
      cleanup: () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        // By id: a poll that failed to deliver it put back the copy it rewrote.
        const index = session.queue.findIndex((queued) => queued.commandId === command.commandId)
        if (index >= 0) session.queue.splice(index, 1)
      },
      ...(options.bundle ? { bundle: options.bundle } : {}),
      ...(options.dataKey ? { dataKey: options.dataKey } : {}),
      ...(options.candidates ? { candidates: options.candidates } : {}),
      ...(options.onCreated ? { onCreated: options.onCreated } : {}),
      ...(options.onDispatched ? { onDispatched: options.onDispatched } : {}),
      ...(options.onVacated ? { onVacated: options.onVacated } : {}),
    }
    live.commands.set(command.commandId, open)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    session.queue.push(command)
    session.wake?.()
    return deferred.promise
  }

  /** A command without an answer (abort): delivered if the runner session is still there. */
  post(live: LiveAssignment, body: RunnerCommandBody, epoch = live.fence.epoch): void {
    const session = this.#connected(live)
    if (!session || live.gone || epoch !== live.fence.epoch) return
    const command = runnerCommandSchema.parse({
      ...body,
      commandId: randomUUID(),
      assignmentId: live.id,
      fence: live.fence,
      ttlMs: COMMAND_TTL_MS,
    })
    live.answered.add(command.commandId)
    session.queue.push(command)
    session.wake?.()
  }

  /**
   * Forgets the assignment once its container is gone or core gave it up, only while `epoch`
   * still drives it: an older owner never drops what recovery took over under a newer one.
   */
  release(live: LiveAssignment, epoch: number): void {
    if (live.fence.epoch === epoch) this.#forget(live)
  }

  #forget(live: LiveAssignment): void {
    if (this.#live.get(live.id) !== live) return
    this.#live.delete(live.id)
    const released = conflict('The turn is no longer driven by this core')
    for (const open of live.commands.values()) this.#reject(open, released)
    live.exec?.fail(released)
  }

  /**
   * The runner's connected session, if it has one; with `freshWithinMs`, only while it polls or
   * polled that recently.
   */
  session(runnerId: string, freshWithinMs = Number.POSITIVE_INFINITY): string | undefined {
    const session = this.#sessions.get(runnerId)
    if (!session || session.gone) return undefined
    const fresh = session.polling > 0 || performance.now() - session.lastSeen <= freshWithinMs
    return fresh ? session.id : undefined
  }

  /** Turn containers the connected runners reported in their last poll. */
  inventory(filter: Partial<SandboxLabels>): SandboxInfo[] {
    const now = performance.now()
    const found: SandboxInfo[] = []
    for (const session of this.#sessions.values()) {
      if (session.gone) continue
      for (const container of session.inventory) {
        const labels = container.labels as SandboxLabels
        if (
          (Object.entries(filter) as [keyof SandboxLabels, unknown][]).some(
            ([key, value]) => value !== undefined && labels[key] !== value,
          )
        )
          continue
        found.push({
          id: container.containerId,
          labels: { ...labels },
          createdAt: new Date(Date.now() - container.ageMs - (now - session.inventoryAt)),
        })
      }
    }
    return found
  }

  // --- Runner side ------------------------------------------------------------------------------

  /** The long poll: claims waiting turns for free slots and returns queued commands. */
  async poll(
    runnerId: string,
    request: RunnerPollRequest,
    signal: AbortSignal,
  ): Promise<{ commands: RunnerCommand[] }> {
    this.#assertServing()
    const session = this.#session(runnerId, request.runnerSession)
    session.inventory = request.inventory
    session.inventoryAt = performance.now()
    session.lastSeen = performance.now()
    session.polling += 1
    const generation = ++session.generation
    session.wake?.()
    const active = new Set(request.active.map((entry) => entry.assignmentId))
    await this.deps.assignments
      .seen({ runnerId, runnerSession: session.id, ids: [...active] })
      .catch((error: unknown) => this.#warn('runner heartbeat', logged(error)))
    const deadline = performance.now() + runnerTimings.pollHoldMs
    const over = () =>
      session.gone || this.#closed || signal.aborted || session.generation !== generation
    try {
      for (;;) {
        if (over()) return { commands: [] }
        await this.#claim(session, request.capacity, active)
        // Closed while the claim ran: a prepare it queued waits for the next poll, undispatched.
        if (over()) return { commands: [] }
        const commands = this.#deliver(session)
        if (commands.length > 0) return { commands }
        const remaining = deadline - performance.now()
        if (remaining <= 0) return { commands: [] }
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', wake)
            if (session.wake === wake) session.wake = undefined
            resolve()
          }
          const timer = setTimeout(wake, remaining)
          signal.addEventListener('abort', wake, { once: true })
          session.wake = wake
          // Aborted while the claim ran: that abort event does not fire again.
          if (signal.aborted) wake()
        })
      }
    } finally {
      session.polling -= 1
      session.lastSeen = performance.now()
    }
  }

  /** Commands a failed poll response did not deliver go back to the front of the queue. */
  requeue(runnerId: string, runnerSession: string, commands: readonly RunnerCommand[]): void {
    const session = this.#sessions.get(runnerId)
    if (!session || session.id !== runnerSession || session.gone) return
    const undelivered = commands.filter((command) => {
      const live = this.#live.get(command.assignmentId)
      if (!live) return false
      const open = live.commands.get(command.commandId)
      return open ? !open.settled : command.type === 'abort'
    })
    session.queue.unshift(...undelivered)
  }

  async report(runnerId: string, report: RunnerReport): Promise<void> {
    const live = await this.#authorize(
      runnerId,
      report.runnerSession,
      report.assignmentId,
      report.epoch,
    )
    switch (report.type) {
      case 'created':
      case 'prepared': {
        const open = this.#answering(live, report.commandId, ['prepare'])
        if (!open) return
        await this.#created(live, open, report.containerId)
        if (report.type === 'prepared') this.#settle(live, open, report)
        return
      }
      case 'adopted': {
        const open = this.#answering(live, report.commandId, ['adopt'])
        if (!open) return
        if (open.command.type === 'adopt' && open.command.containerId !== report.containerId)
          throw RunnerApiError.of('BAD_REQUEST')
        live.containerId = report.containerId
        this.#settle(live, open, report)
        return
      }
      case 'running': {
        const open = this.#answering(live, report.commandId, ['launch', 'resume'])
        if (!open) return
        const command = open.command
        if (command.type === 'resume' && command.execId !== report.execId)
          throw RunnerApiError.of('BAD_REQUEST')
        if (!open.settled) {
          live.exec?.fail(conflict('The agent was re-attached'))
          live.exec = new ExecStream(
            command.type === 'resume'
              ? { execId: report.execId, cursor: command.cursor, eventCount: command.eventCount }
              : { execId: report.execId, cursor: { stdout: 0, stderr: 0 }, eventCount: 0 },
            live.credentials,
          )
        }
        this.#settle(live, open, report)
        return
      }
      case 'output':
      case 'exited': {
        const exec = live.exec
        if (!exec || exec.execId !== report.execId) throw RunnerApiError.of('COMMAND_CLOSED')
        if (report.type === 'output') await exec.deliver(report)
        else await exec.exited(report.exit)
        return
      }
      case 'quiesced':
      case 'sealed': {
        const open = this.#answering(live, report.commandId, [
          report.type === 'quiesced' ? 'quiesce' : 'seal',
        ])
        if (open) this.#settle(live, open, report)
        return
      }
      case 'captured': {
        const open = this.#answering(live, report.commandId, ['capture'])
        if (!open) return
        for (const part of ['patch', 'untracked'] as const) {
          const uploaded = open.candidates?.[part]
          if (
            !uploaded ||
            uploaded.sha256 !== report[part].sha256 ||
            uploaded.bytes.byteLength !== report[part].sizeBytes
          )
            throw RunnerApiError.of('BAD_REQUEST')
        }
        this.#settle(live, open, report)
        return
      }
      case 'destroyed': {
        if (live.containerId !== undefined && live.containerId !== report.containerId)
          throw RunnerApiError.of('BAD_REQUEST')
        // Proof only for the container core knew; a prepare's never ends here (its `created`).
        if (live.containerId !== undefined) live.goneContainer = report.containerId
        live.containerId = report.containerId
        live.gone = true
        const removed = execLost('The runner removed the turn container')
        live.exec?.fail(removed)
        for (const open of [...live.commands.values()]) {
          if (open.command.type === 'destroy' || open.command.type === 'adopt')
            this.#settle(live, open, report)
          else this.#reject(open, removed)
        }
        if (report.commandId) live.answered.add(report.commandId)
        return
      }
      case 'failed': {
        const error = runnerFailure(report.code)
        if (report.commandId) {
          const open = this.#answering(live, report.commandId, [])
          if (!open) return
          // The prepare left no container (P3): believed only before any container was reported.
          if (report.absent && open.command.type === 'prepare' && live.containerId === undefined)
            open.onVacated?.()
          this.#reject(open, error)
          live.commands.delete(report.commandId)
          live.answered.add(report.commandId)
        } else if (live.exec) live.exec.fail(error)
        else
          for (const open of live.commands.values())
            if (open.command.type !== 'destroy') this.#reject(open, error)
        return
      }
    }
  }

  /** Containers no unfinished assignment of this runner owns at its epochs; the runner removes them. */
  async reconcile(
    runnerId: string,
    request: RunnerReconcileRequest,
  ): Promise<{ remove: string[] }> {
    this.#assertServing()
    this.#rejectRetired(runnerId, request.runnerSession)
    let owners
    try {
      owners = await this.deps.assignments.unfinished({ runnerId })
    } catch (error) {
      this.#warn('runner reconcile', logged(error))
      // Fails closed: nothing is removed while the owners are unknown.
      throw RunnerApiError.of('UNAVAILABLE')
    }
    const remove: string[] = []
    for (const container of request.inventory) {
      const { labels } = container
      const owner = owners.find(
        (row) =>
          row.fence.siteId === labels.siteId &&
          row.fence.taskId === labels.taskId &&
          row.sessionId === labels.sessionId &&
          row.turn === labels.turn,
      )
      const live = owner ? this.#live.get(owner.id) : undefined
      const epoch = live?.fence.epoch ?? owner?.fence.epoch ?? 0
      const known = live?.containerId ?? owner?.containerId ?? null
      const owned =
        owner !== undefined &&
        owner.deadlineAt.getTime() > owner.serverNow.getTime() &&
        (known === null || known === container.containerId) &&
        labels.leaseEpoch !== undefined &&
        labels.leaseEpoch >= owner.firstEpoch &&
        labels.leaseEpoch <= epoch
      if (!owned) remove.push(container.containerId)
    }
    return { remove }
  }

  /** The base bundle of an open prepare, after a strict lease check. */
  async bundle(
    runnerId: string,
    assignmentId: string,
    headers: RunnerBinaryHeaders,
  ): Promise<TurnBundleSource> {
    const { live, open } = await this.#binary(runnerId, assignmentId, headers, 'prepare')
    if (!open.bundle) throw RunnerApiError.of('COMMAND_CLOSED')
    await this.#assertLease(live)
    return open.bundle
  }

  /**
   * The data key of an open restore or seal, after a strict lease check. The caller writes it
   * once and zeroes it; the hub keeps no reference.
   */
  async key(
    runnerId: string,
    assignmentId: string,
    purpose: 'restore' | 'seal',
    headers: RunnerBinaryHeaders,
  ): Promise<Uint8Array> {
    const { live, open } = await this.#binary(
      runnerId,
      assignmentId,
      headers,
      purpose === 'restore' ? 'prepare' : 'seal',
    )
    if (!open.dataKey) throw RunnerApiError.of('COMMAND_CLOSED')
    await this.#assertLease(live)
    let key: Uint8Array
    try {
      key = await open.dataKey()
    } catch (error) {
      throw lostLease(error) ? RunnerApiError.leaseLost() : RunnerApiError.of('UNAVAILABLE')
    }
    if (key.byteLength !== 32) {
      key.fill(0)
      throw RunnerApiError.of('INTERNAL')
    }
    return key
  }

  /** Authorizes an upload of an open capture before its body is read. */
  async candidate(
    runnerId: string,
    assignmentId: string,
    part: CandidatePart,
    headers: RunnerBinaryHeaders,
  ): Promise<(bytes: Uint8Array) => void> {
    const { open } = await this.#binary(runnerId, assignmentId, headers, 'capture')
    const parts = open.candidates
    if (!parts) throw RunnerApiError.of('COMMAND_CLOSED')
    return (bytes) => {
      if (!open.settled) parts[part] = { bytes, sha256: sha256(bytes) }
    }
  }

  onApplicationShutdown(): void {
    this.close()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#sweep)
    const closing = runnerUnavailable('Core is shutting down')
    for (const pending of this.#pending.values()) pending.reject(closing)
    for (const session of this.#sessions.values()) this.#retire(session, closing)
    for (const live of [...this.#live.values()]) this.#forget(live)
  }

  // --- Internals --------------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw runnerUnavailable('Core is shutting down')
  }

  /**
   * A runner request after close: its sessions were retired only in this core's memory, so the
   * runner retries against the next core instead of hearing that its turns are lost.
   */
  #assertServing(): void {
    if (this.#closed) throw RunnerApiError.of('UNAVAILABLE')
  }

  /**
   * Takes queued commands one by one for a poll's answer. A prepare or an adoption for work
   * carries what is left of its turn now, never what was left when it was queued; one that ran
   * out is refused here and never reaches the runner.
   */
  #deliver(session: RunnerSession): RunnerCommand[] {
    const now = performance.now()
    const out: RunnerCommand[] = []
    while (session.queue.length > 0 && out.length < runnerLimits.commands) {
      let queued = session.queue.shift()!
      const open = this.#live.get(queued.assignmentId)?.commands.get(queued.commandId)
      if (open?.deadline !== undefined) {
        const remainingMs = Math.floor(open.deadline - now)
        if (remainingMs <= 0) {
          this.#reject(open, runnerUnavailable('The turn ran out of time before a runner took it'))
          continue
        }
        queued = runnerCommandSchema.parse(withRemaining(queued, remainingMs))
        open.command = queued
      }
      if (open && !open.delivered) {
        open.delivered = true
        open.onDispatched?.()
      }
      out.push(queued)
    }
    return out
  }

  #connected(live: LiveAssignment): RunnerSession | undefined {
    const session = this.#sessions.get(live.runner.id)
    return session && session.id === live.runner.session && !session.gone ? session : undefined
  }

  /** The runner's current session; a new one retires the previous (a restarted runner). */
  #session(runnerId: string, sessionId: string): RunnerSession {
    this.#rejectRetired(runnerId, sessionId)
    let session = this.#sessions.get(runnerId)
    if (session?.id === sessionId) return session
    if (session) {
      this.#retire(session, runnerUnavailable('The sandbox runner restarted'))
      const retired = this.#retired.get(runnerId) ?? []
      this.#retired.set(runnerId, [session.id, ...retired].slice(0, RETIRED_SESSIONS))
    }
    session = {
      runnerId,
      id: sessionId,
      lastSeen: performance.now(),
      polling: 0,
      generation: 0,
      inventory: [],
      inventoryAt: performance.now(),
      queue: [],
      wake: undefined,
      gone: false,
    }
    this.#sessions.set(runnerId, session)
    this.#ensureSweep()
    return session
  }

  /**
   * A zombie of a restarted runner, or a session core gave up as silent, stops without touching
   * any container — the newer session or recovery may hold them — and restarts under a new one.
   */
  #rejectRetired(runnerId: string, sessionId: string): void {
    const current = this.#sessions.get(runnerId)
    if (
      this.#retired.get(runnerId)?.includes(sessionId) ||
      (current?.id === sessionId && current.gone)
    )
      throw RunnerApiError.sessionRetired()
  }

  /** Reports and transfers come only from the runner's current session, once it polled. */
  #assertCurrent(runnerId: string, sessionId: string): void {
    this.#rejectRetired(runnerId, sessionId)
    const current = this.#sessions.get(runnerId)
    if (current && current.id !== sessionId) throw RunnerApiError.sessionRetired()
  }

  #retire(session: RunnerSession, error: unknown): void {
    if (session.gone) return
    session.gone = true
    session.queue.length = 0
    session.wake?.()
    for (const live of this.#live.values()) {
      if (live.runner.id !== session.runnerId || live.runner.session !== session.id) continue
      for (const open of live.commands.values()) this.#reject(open, error)
      live.exec?.fail(error)
    }
  }

  async #claim(
    session: RunnerSession,
    capacity: number,
    active: ReadonlySet<string>,
  ): Promise<void> {
    const ids = [...this.#pending].filter(([, pending]) => !pending.done).map(([id]) => id)
    if (ids.length === 0) return
    // Prepares this session got but does not report as active yet still take a slot.
    let delivering = 0
    for (const live of this.#live.values())
      if (
        live.runner.id === session.runnerId &&
        live.runner.session === session.id &&
        !active.has(live.id) &&
        [...live.commands.values()].some((open) => !open.settled && open.command.type === 'prepare')
      )
        delivering += 1
    const limit = Math.min(capacity - delivering, runnerLimits.capacity)
    if (limit <= 0) return
    let claimed
    try {
      claimed = await this.deps.assignments.claim({
        ids,
        runnerId: session.runnerId,
        runnerSession: session.id,
        limit,
      })
    } catch (error) {
      this.#warn('runner claim', logged(error))
      return
    }
    for (const row of claimed)
      this.#pending.get(row.id)?.resolve({ id: session.runnerId, session: session.id })
  }

  async #authorize(
    runnerId: string,
    sessionId: string,
    assignmentId: string,
    epoch: number,
  ): Promise<LiveAssignment> {
    this.#assertServing()
    this.#assertCurrent(runnerId, sessionId)
    const live = this.#live.get(assignmentId)
    if (live) {
      if (live.runner.id !== runnerId) throw RunnerApiError.leaseLost()
      // Another session of this runner holds the turn: this one must not touch its container.
      if (live.runner.session !== sessionId) throw RunnerApiError.sessionRetired()
      if (epoch === live.fence.epoch) return live
      if (epoch < live.fence.epoch) throw RunnerApiError.superseded(live.fence)
      throw RunnerApiError.leaseLost()
    }
    let row
    try {
      row = await this.deps.assignments.get(assignmentId)
    } catch (error) {
      this.#warn('runner assignment lookup', logged(error))
      throw RunnerApiError.of('UNAVAILABLE')
    }
    if (
      row &&
      row.outcome === null &&
      row.runner?.id === runnerId &&
      row.runner.session !== sessionId
    )
      throw RunnerApiError.sessionRetired()
    if (!row || row.outcome !== null || row.runner?.id !== runnerId || epoch > row.fence.epoch)
      throw RunnerApiError.leaseLost()
    // Unfinished and still this runner's, but no core drives it now: recovery takes it over.
    throw RunnerApiError.of('UNAVAILABLE')
  }

  async #binary(
    runnerId: string,
    assignmentId: string,
    headers: RunnerBinaryHeaders,
    type: RunnerCommand['type'],
  ): Promise<{ live: LiveAssignment; open: OpenCommand }> {
    const parsed = binaryHeadersSchema.safeParse(headers)
    if (!parsed.success) throw RunnerApiError.of('BAD_REQUEST')
    const live = await this.#authorize(
      runnerId,
      parsed.data.session,
      assignmentId,
      parsed.data.epoch,
    )
    const open = live.commands.get(parsed.data.command)
    if (!open || open.settled || open.command.type !== type)
      throw RunnerApiError.of('COMMAND_CLOSED')
    return { live, open }
  }

  /** Strict: only a confirmed fence lets a key or the bundle leave core. */
  async #assertLease(live: LiveAssignment): Promise<void> {
    const owned = await this.deps.leases.assert(live.fence).catch(() => null)
    if (owned === null) throw RunnerApiError.of('UNAVAILABLE')
    if (!owned) throw RunnerApiError.leaseLost()
  }

  /** null for a repeated answer; COMMAND_CLOSED for a command core does not know. */
  #answering(
    live: LiveAssignment,
    commandId: string,
    types: readonly RunnerCommand['type'][],
  ): OpenCommand | null {
    if (live.answered.has(commandId)) return null
    const open = live.commands.get(commandId)
    if (!open) throw RunnerApiError.of('COMMAND_CLOSED')
    if (types.length > 0 && !types.includes(open.command.type))
      throw RunnerApiError.of('BAD_REQUEST')
    return open
  }

  /**
   * The container of a prepare exists. The supervisor takes it over first (its `created` hook),
   * so it removes the container even when anything after this fails; the answer to the runner
   * stands either way, and a failure fails only the prepare.
   */
  async #created(live: LiveAssignment, open: OpenCommand, containerId: string): Promise<void> {
    if (live.containerId !== undefined && live.containerId !== containerId)
      throw RunnerApiError.of('BAD_REQUEST')
    live.containerId = containerId
    open.created ??= (async () => {
      await open.onCreated?.(containerId)
      const recorded = await this.deps.assignments.recordContainer({
        id: live.id,
        epoch: live.fence.epoch,
        containerId,
      })
      if (!recorded) throw leaseLost('The turn assignment no longer owns its container')
    })()
    await open.created.catch((error: unknown) => this.#reject(open, error))
  }

  #settle(live: LiveAssignment, open: OpenCommand, report: RunnerReport): void {
    if (!open.settled) {
      if (!open.answers.includes(report.type)) {
        this.#reject(open, conflict('The runner answered the command unexpectedly'))
      } else {
        open.settled = true
        open.cleanup()
        open.resolve(report)
      }
    }
    live.commands.delete(open.command.commandId)
    live.answered.add(open.command.commandId)
  }

  /** Core stops waiting; the command stays known, so late reports are acknowledged. */
  #reject(open: OpenCommand, error: unknown): void {
    if (open.settled) return
    open.settled = true
    open.cleanup()
    open.reject(error)
  }

  #ensureSweep(): void {
    if (this.#sweep || this.#closed) return
    this.#sweep = setInterval(() => this.#sweepOnce(), SWEEP_MS)
    this.#sweep.unref()
  }

  /** Runners silent past runnerTimings.silentAfterMs lose their turns; expired state goes. */
  #sweepOnce(): void {
    const now = performance.now()
    for (const session of this.#sessions.values())
      if (
        !session.gone &&
        session.polling === 0 &&
        now - session.lastSeen > runnerTimings.silentAfterMs
      )
        this.#retire(session, runnerUnavailable('The sandbox runner stopped answering'))
    for (const live of [...this.#live.values()]) if (now > live.expiresAt) this.#forget(live)
  }
}
