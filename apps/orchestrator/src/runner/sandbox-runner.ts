import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'
import {
  DomainError,
  isDomainError,
  isSnapshotCredential,
  MAX_PRESIGN_TTL_MS,
  runnerCommandSchema,
  runnerLimits,
  runnerPollRequestSchema,
  runnerReportSchema,
  snapshotPartFiles,
  TURN_PUBLICATION_GRACE_MS,
  turnOutputTooLarge,
  turnSnapshotPrefix,
  type DestroyReason,
  type ExecCursor,
  type PresignedRequest,
  type RunnerCommand,
  type RunnerFailureCode,
  type RunnerPollRequest,
  type RunnerReport,
  type runnerAssignmentPhases,
  type SandboxInfo,
  type SandboxLabels,
  type SiteLeaseFence,
  type SnapshotPartName,
  type TurnAgentExec,
  type TurnExecution,
  type TurnExecutor,
  type TurnRestoreSource,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'
import { z } from 'zod'

import { RunnerCallError, type RunnerCommandFence, type RunnerTransport } from './core-client.ts'

type Phase = (typeof runnerAssignmentPhases)[number]
type Command<T extends RunnerCommand['type']> = Extract<RunnerCommand, { type: T }>
type Envelope = 'runnerSession' | 'assignmentId' | 'epoch'
type ReportBody = RunnerReport extends infer R
  ? R extends unknown
    ? Omit<R, Envelope>
    : never
  : never
type Answer = ReportBody extends infer R
  ? R extends { commandId?: string }
    ? Omit<R, 'commandId'>
    : never
  : never
export type RunnerInventory = RunnerPollRequest['inventory']

export interface RunnerLogger {
  log(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface SandboxRunnerDependencies {
  transport: RunnerTransport
  /** LocalTurnExecutor over this VM's Docker: the same sandbox steps core runs in the PoC. */
  executor: TurnExecutor
  /** RUNNER_MAX_TURNS. */
  maxTurns: number
  /** RUNNER_S3_ORIGIN: presigned URLs of any other origin are refused; unset outside production. */
  s3Origin?: string
  /** Core retired this session (a newer one of this runner polls): restart under a new one. */
  onRetired?: () => void
  logger?: RunnerLogger
}

const REPORT_BACKOFF_MS = { first: 500, max: 15_000 }
const POLL_BACKOFF_MS = { first: 1_000, max: 30_000 }
/** An adoption only for removal gets this long to be destroyed. */
const REMOVAL_MS = 2 * 60_000
const SEEN_COMMANDS = 1024
const GONE_ASSIGNMENTS = 64

const inventoryEntry = runnerPollRequestSchema.shape.inventory.element
const pollAnswer = z.object({ commands: z.array(z.unknown()).max(runnerLimits.commands) }).strict()

/** Only a code or a status: messages may carry storage or Docker details, never a secret. */
const logged = (error: unknown): Error =>
  new Error(
    error instanceof RunnerCallError
      ? error.message
      : isDomainError(error)
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown',
  )

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

const digest = (bytes: Uint8Array) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.byteLength,
})

/** A failure core may learn the cause of; everything else is reported as `fallback`. */
export function runnerFailureCode(
  error: unknown,
  fallback: RunnerFailureCode,
  passes: readonly RunnerFailureCode[] = [],
): RunnerFailureCode {
  if (isSnapshotCredential(error))
    return passes.includes('SNAPSHOT_CREDENTIAL') ? 'SNAPSHOT_CREDENTIAL' : fallback
  if (isDomainError(error) && (passes as readonly string[]).includes(error.code))
    return error.code as RunnerFailureCode
  return fallback
}

const passes = {
  prepare: [
    'CONFLICT',
    'DRIVER_PREPARE_INVALID',
    'SNAPSHOT_LOAD_FAILED',
    'REPOSITORY_TOO_LARGE',
    'REPOSITORY_UNSUPPORTED',
  ],
  output: ['TURN_OUTPUT_REJECTED', 'TURN_OUTPUT_TOO_LARGE'],
  capture: [
    'SNAPSHOT_CREDENTIAL',
    'SNAPSHOT_NOT_WRITTEN',
    'SNAPSHOT_TOO_LARGE',
    'PUBLICATION_TOO_LARGE',
  ],
  seal: ['SNAPSHOT_TOO_LARGE'],
} satisfies Record<string, RunnerFailureCode[]>

/**
 * The URL names exactly this object of this turn: `sessions/<sid>/turns/<NNNN>/<part>`, at the
 * platform's S3 when `origin` pins it. Core signs only such URLs; the runner refuses anything
 * else before a byte moves, so even a forged core cannot send a turn's home elsewhere.
 */
export function isTurnSnapshotUrl(
  url: string,
  sessionId: string,
  turn: number,
  part: SnapshotPartName,
  origin?: string,
): boolean {
  const parsed = URL.parse(url)
  if (!parsed || (origin !== undefined && parsed.origin !== origin)) return false
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return false
  }
  return path.endsWith(`/${turnSnapshotPrefix(sessionId, turn)}${snapshotPartFiles[part]}`)
}

/** The labelled turn containers of this VM as a poll or reconcile reports them. */
export function runnerInventory(listed: readonly SandboxInfo[]): RunnerInventory {
  const now = Date.now()
  const inventory: RunnerInventory = []
  for (const info of listed) {
    const entry = inventoryEntry.safeParse({
      containerId: info.id,
      labels: info.labels,
      ageMs: Math.max(0, Math.floor(now - info.createdAt.getTime())),
    })
    if (entry.success) inventory.push(entry.data)
    if (inventory.length === runnerLimits.inventory) break
  }
  return inventory
}

type Failure =
  | { reason: 'lost' | 'retired' | 'closed' | 'refused' | 'gave_up' }
  | { reason: 'superseded'; fence: SiteLeaseFence }
  | { reason: 'mismatch'; expected: ExecCursor }
type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Failure)

function classify(error: unknown): Failure | { reason: 'retry' } {
  if (!(error instanceof RunnerCallError)) return { reason: 'refused' }
  if (error.status === null || [500, 502, 503, 504].includes(error.status))
    return { reason: 'retry' }
  const refusal = error.refusal
  if (error.status === 409 && refusal)
    switch (refusal.error) {
      case 'LEASE_LOST':
        return { reason: 'lost' }
      case 'SESSION_RETIRED':
        return { reason: 'retired' }
      case 'FENCE_SUPERSEDED':
        return { reason: 'superseded', fence: refusal.fence }
      case 'CURSOR_MISMATCH':
        return { reason: 'mismatch', expected: refusal.expected }
    }
  return { reason: error.status === 410 ? 'closed' : 'refused' }
}

/** Where a report goes: an assignment and how long it is worth retrying. */
interface Target {
  readonly id: string
  deadline: number
}

interface Pump {
  readonly execId: string
  readonly agent: TurnAgentExec
  /** The epoch of the launch or resume that started it: its reports carry it. */
  readonly epoch: number
  readonly stop: AbortController
  /** The agent ended or was killed. */
  done: boolean
  /** What core acknowledged last. */
  acked: { cursor: ExecCursor; eventCount: number }
}

/** One turn this runner session holds. */
class Held implements Target {
  phase: Phase = 'preparing'
  execution: TurnExecution | undefined
  containerId: string | undefined
  pump: Pump | undefined
  destroying: Promise<void> | undefined
  lost = false
  /** Stops a prepare that is still running when the turn is removed. */
  readonly abort = new AbortController()
  /** Settles once the prepare's own work ended, before it answers core. */
  preparing: Promise<void> | undefined

  constructor(
    readonly id: string,
    public fence: SiteLeaseFence,
    readonly labels: SandboxLabels,
    /** performance.now() by which the container is gone: from the command's remaining time. */
    public deadline: number,
  ) {}
}

const STOP = new Error('The output is no longer read')
class Reattach extends Error {
  constructor(readonly expected: ExecCursor) {
    super('Core expects the output from another cursor')
  }
}

/**
 * The runner role on a sandbox VM (spec §8 «Раннер на песочной ВМ»): long-polls core for turn
 * commands and carries them out with a local TurnExecutor over the VM's Docker. It keeps no
 * platform credentials: snapshot parts move through presigned requests, data keys and the base
 * bundle come from core per command. Commands run concurrently — a destroy may arrive while a
 * prepare still waits for core to take its container over — and every report is retried until
 * the turn's deadline. Nothing it logs names a URL, a key, a token or a turn.
 */
export class SandboxRunner {
  /** A fresh session per process start: a restarted runner is a new session for core. */
  readonly session = randomUUID()
  readonly #held = new Map<string, Held>()
  readonly #gone = new Map<string, string>()
  readonly #seen = new Set<string>()
  readonly #stop = new AbortController()
  readonly #logger: RunnerLogger
  readonly #warn: ThrottledLog
  #inventory: RunnerInventory = []
  #loop: Promise<void> | undefined
  #retired = false
  /** Ends the waiting poll: on stop, or when a turn freed a slot its capacity did not count. */
  #polling: AbortController | undefined

  constructor(private readonly deps: SandboxRunnerDependencies) {
    this.#logger = deps.logger ?? new Logger('Runner')
    this.#warn = throttledLogger((line) => this.#logger.warn(line))
  }

  start(): void {
    this.#loop ??= this.#run()
  }

  /** Stops polling. Containers stay: core recovers the turns of a restarted runner. */
  async stop(): Promise<void> {
    this.#stop.abort()
    this.#polling?.abort()
    await this.#loop
  }

  /** A container of a turn this session holds: its own commands remove it, not a reconcile. */
  holds(containerId: string): boolean {
    for (const held of this.#held.values()) if (held.containerId === containerId) return true
    return false
  }

  // --- Poll loop --------------------------------------------------------------------------------

  async #run(): Promise<void> {
    for (let failures = 0; !this.#stop.signal.aborted;) {
      this.#expire()
      const polling = new AbortController()
      this.#polling = polling
      const request = await this.#pollRequest()
      // Stopped, or a slot was freed after its capacity was counted.
      if (polling.signal.aborted) continue
      let answer: unknown
      // A prepare's remaining time counts from here: core took it off its queue only later.
      const sentAt = performance.now()
      try {
        answer = await this.deps.transport.poll(request, polling.signal)
      } catch (error) {
        if (this.#stop.signal.aborted) return
        // Core requeues whatever an ended poll did not deliver.
        if (polling.signal.aborted) continue
        // A poll is about no single turn: a lost lease there, too, means the session is over.
        if (['retired', 'lost'].includes(classify(error).reason)) return this.#retire()
        this.#warn('poll', logged(error))
        const wait = Math.min(POLL_BACKOFF_MS.max, POLL_BACKOFF_MS.first * 2 ** failures++)
        await sleep(wait, this.#stop.signal)
        continue
      }
      failures = 0
      const receivedAt = performance.now()
      const parsed = pollAnswer.safeParse(answer)
      if (!parsed.success) {
        this.#warn('poll', new Error('invalid answer'))
        continue
      }
      for (const command of parsed.data.commands) this.#dispatch(command, receivedAt, sentAt)
    }
  }

  async #pollRequest(): Promise<RunnerPollRequest> {
    try {
      this.#inventory = runnerInventory(await this.deps.executor.list({}))
    } catch (error) {
      // The last inventory stands in while Docker does not answer.
      this.#warn('container inventory', logged(error))
    }
    return {
      runnerSession: this.session,
      capacity: Math.max(0, this.deps.maxTurns - this.#held.size),
      inventory: this.#inventory,
      active: [...this.#held.values()]
        .slice(0, runnerLimits.capacity)
        .map((held) => ({ assignmentId: held.id, epoch: held.fence.epoch, phase: held.phase })),
    }
  }

  /**
   * Core retired this session (SESSION_RETIRED): a newer one of this runner polls, or core gave
   * it up as silent. It drops its turns without touching their containers — the newer session or
   * recovery may hold them — and stops.
   */
  #retire(): void {
    if (this.#retired) return
    this.#retired = true
    this.#logger.error('Core retired this runner session: it stops and restarts under a new one')
    this.#stop.abort()
    for (const held of this.#held.values()) {
      held.pump?.stop.abort()
      held.abort.abort()
    }
    this.#held.clear()
    this.deps.onRetired?.()
  }

  /** Turns past their deadline and the publication grace: the container must be gone. */
  #expire(): void {
    const now = performance.now()
    for (const held of [...this.#held.values()]) {
      if (held.destroying || now <= held.deadline + TURN_PUBLICATION_GRACE_MS) continue
      void this.#removeOnOwn(held, 'timeout')
    }
  }

  /**
   * A command's TTL counts from receipt: a poll is held for up to 25 seconds. What is left of
   * a turn counts from the poll's sending, which is never later than core's delivery.
   */
  #dispatch(raw: unknown, receivedAt: number, sentAt: number): void {
    const parsed = runnerCommandSchema.safeParse(raw)
    if (!parsed.success) {
      this.#warn('command', new Error('invalid command'))
      return
    }
    const command = parsed.data
    if (this.#seen.has(command.commandId)) return
    remember(this.#seen, command.commandId, SEEN_COMMANDS)
    void this.#execute(command, receivedAt + command.ttlMs, sentAt).catch((error: unknown) =>
      this.#warn(`${command.type} command`, logged(error)),
    )
  }

  async #execute(command: RunnerCommand, expiresAt: number, sentAt: number): Promise<void> {
    if (this.#retired) return
    if (command.type === 'prepare') return this.#prepare(command, sentAt, expiresAt)
    // An expired command is dropped unanswered: core stopped waiting for it.
    if (performance.now() > expiresAt) return
    if (command.type === 'adopt') return this.#adopt(command, sentAt)
    const held = this.#held.get(command.assignmentId)
    if (!held) return this.#unknown(command)
    // A stale owner's command, or another turn's fence: dropped.
    if (
      command.fence.epoch < held.fence.epoch ||
      command.fence.siteId !== held.fence.siteId ||
      command.fence.taskId !== held.fence.taskId
    )
      return
    this.#supersede(held, command.fence)
    switch (command.type) {
      case 'launch':
        return this.#launch(held, command)
      case 'resume':
        return this.#resume(held, command)
      case 'quiesce':
        return this.#quiesce(held, command)
      case 'capture':
        return this.#capture(held, command)
      case 'seal':
        return this.#seal(held, command)
      case 'abort':
        return this.#abortAgent(held)
      case 'destroy':
        return this.#destroy(held, command)
    }
  }

  // --- Commands ---------------------------------------------------------------------------------

  /**
   * A prepare that creates no container — expired, without a free slot, or failed before its
   * provider was asked or with the provider's proof that nothing is left — answers
   * `failed{absent}`: core may then free the site at once (spec §8).
   */
  async #prepare(command: Command<'prepare'>, sentAt: number, expiresAt: number): Promise<void> {
    if (this.#held.has(command.assignmentId)) return
    const held = new Held(
      command.assignmentId,
      command.fence,
      command.sandbox.labels,
      sentAt + command.remainingMs,
    )
    const answer = this.#answer(held, command)
    if (performance.now() > expiresAt || this.#held.size >= this.deps.maxTurns) {
      await answer({ type: 'failed', code: 'SANDBOX_COMMAND_FAILED', absent: true })
      return
    }
    this.#held.set(held.id, held)
    const ended = Promise.withResolvers<void>()
    held.preparing = ended.promise
    const fence = this.#fence(command)
    let created: Outcome<void> | undefined
    let dispatched = false
    let vacated = false
    try {
      const restore = command.restore ? this.#restoreSource(held, command, fence) : undefined
      const execution = await this.deps.executor.prepare(
        {
          assignmentId: held.id,
          fence: command.fence,
          sandbox: command.sandbox,
          remainingMs: Math.max(1, Math.floor(held.deadline - performance.now())),
          bundle: {
            ...command.bundle,
            read: () => this.deps.transport.bundle(held.id, fence, command.bundle.sizeBytes),
          },
          ...(restore ? { restore } : {}),
          driverId: command.driverId,
          prepared: command.prepared,
          argv: command.argv,
          credentials: command.credentials,
          // Core takes the container over before anything is imported into it.
          created: async (execution) => {
            held.execution = execution
            held.containerId = execution.containerId
            created = await answer({ type: 'created', containerId: execution.containerId })
            if (!created.ok) throw new Error('Core did not take the container over')
          },
          dispatched: () => {
            dispatched = true
          },
          vacated: () => {
            vacated = true
          },
        },
        held.abort.signal,
      )
      ended.resolve()
      held.phase = 'prepared'
      await answer({ type: 'prepared', containerId: execution.containerId })
    } catch (error) {
      held.phase = 'failed'
      const code = runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED', passes.prepare)
      if (!held.execution) {
        this.#forget(held)
        ended.resolve()
        const absent = !dispatched || vacated
        await answer({ type: 'failed', code, ...(absent ? { absent: true as const } : {}) })
        return
      }
      ended.resolve()
      const handover = created as Outcome<void> | undefined
      if (handover && !handover.ok) {
        // Nobody in core owns the container: remove it here. A lost lease already does, and a
        // turn recovery took over under a newer fence sends its own commands.
        if (handover.reason !== 'lost' && handover.reason !== 'superseded')
          await this.#removeOnOwn(held, 'failed')
        return
      }
      // Removed meanwhile by a destroy: core no longer waits for this prepare.
      if (held.abort.signal.aborted) return
      await answer({ type: 'failed', code })
    }
  }

  /** Turn n−1: only the three parts of the previous turn of this session. */
  #restoreSource(
    held: Held,
    command: Command<'prepare'>,
    fence: RunnerCommandFence,
  ): TurnRestoreSource {
    const { manifest, parts } = command.restore!
    const labels = command.sandbox.labels
    const expiresAt = new Date(Date.now() + MAX_PRESIGN_TTL_MS)
    const part = (name: SnapshotPartName): PresignedRequest => {
      if (
        manifest.sessionId !== labels.sessionId ||
        manifest.turn !== labels.turn - 1 ||
        !isTurnSnapshotUrl(
          parts[name].url,
          manifest.sessionId,
          manifest.turn,
          name,
          this.deps.s3Origin,
        )
      )
        throw new DomainError(
          'SNAPSHOT_LOAD_FAILED',
          'Restore source is not the previous turn',
          502,
        )
      // The URL signs its own expiry; the runner only knows an upper bound.
      return { ...parts[name], expiresAt }
    }
    return {
      manifest,
      parts: { home: part('home'), untracked: part('untracked'), patch: part('patch') },
      dataKey: () => this.#key(held, 'restore', fence),
    }
  }

  async #adopt(command: Command<'adopt'>, sentAt: number): Promise<void> {
    const deadline = command.work
      ? sentAt + command.work.remainingMs
      : performance.now() + REMOVAL_MS
    const preparing = this.#held.get(command.assignmentId)
    if (!command.work && preparing?.preparing && preparing.containerId === undefined) {
      // Removal of a turn still being prepared: stop the prepare, whose failure removes what it
      // created, and answer from what is left once it ended.
      preparing.abort.abort()
      await preparing.preparing
    }
    const known = this.#held.get(command.assignmentId)
    if (known) {
      const answer = this.#answer(known, command)
      // This session prepared or adopted the turn: it still holds the container and the agent.
      if (known.containerId !== command.containerId) {
        await answer({ type: 'failed', code: 'CONFLICT' })
        return
      }
      this.#supersede(known, command.fence)
      if (command.work) known.deadline = deadline
      await answer({ type: 'adopted', containerId: command.containerId })
      return
    }
    // A restarted runner takes the container over from Docker, checked by id and labels.
    const held = new Held(command.assignmentId, command.fence, command.labels, deadline)
    const answer = this.#answer(held, command)
    // Only the session that launched the agent held its credentials: without them its output
    // cannot be filtered, and the turn is given up.
    if (command.work && !command.work.credentials) {
      await answer({ type: 'failed', code: 'CREDENTIALS_LOST' })
      return
    }
    try {
      const base = {
        assignmentId: held.id,
        fence: command.fence,
        containerId: command.containerId,
        labels: command.labels,
      }
      const execution = await this.deps.executor.adopt(
        command.work
          ? {
              ...base,
              purpose: 'work',
              remainingMs: command.work.remainingMs,
              driverId: command.work.driverId,
              credentials: command.work.credentials ?? [],
            }
          : { ...base, purpose: 'removal' },
        this.#stop.signal,
      )
      if (!execution) {
        await answer({ type: 'destroyed', containerId: command.containerId })
        return
      }
      held.execution = execution
      held.containerId = execution.containerId
      held.phase = 'prepared'
      this.#held.set(held.id, held)
      await answer({ type: 'adopted', containerId: execution.containerId })
    } catch (error) {
      // EXEC_LOST: the container can no longer run the agent; only removal reaches it.
      await answer({
        type: 'failed',
        code: runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED', ['CONFLICT', 'EXEC_LOST']),
      })
    }
  }

  async #launch(held: Held, command: Command<'launch'>): Promise<void> {
    const answer = this.#answer(held, command)
    if (!held.execution || held.pump) {
      await answer({ type: 'failed', code: 'SANDBOX_COMMAND_FAILED' })
      return
    }
    let agent: TurnAgentExec
    try {
      // Core's limit, never past the container's own deadline.
      const timeoutMs = Math.min(command.timeoutMs, Math.floor(held.deadline - performance.now()))
      agent = await held.execution.launch(Math.max(1, timeoutMs))
    } catch (error) {
      await answer({ type: 'failed', code: runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED') })
      return
    }
    held.phase = 'running'
    const pump = this.#pump(held, agent, command.fence.epoch, {
      cursor: { stdout: 0, stderr: 0 },
      eventCount: 0,
    })
    // Core reads output only once it knows the exec.
    if ((await answer({ type: 'running', execId: agent.execId })).ok) this.#drain(held, pump)
  }

  /** Re-attach to the agent after core recovered the turn, from its journal cursor. */
  async #resume(held: Held, command: Command<'resume'>): Promise<void> {
    const answer = this.#answer(held, command)
    if (!held.execution) {
      await answer({ type: 'failed', code: 'EXEC_LOST' })
      return
    }
    held.pump?.stop.abort()
    let agent: TurnAgentExec | null
    try {
      agent = await held.execution.attach({
        execId: command.execId,
        cursor: command.cursor,
        eventCount: command.eventCount,
      })
    } catch (error) {
      await answer({ type: 'failed', code: runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED') })
      return
    }
    if (!agent) {
      await answer({ type: 'failed', code: 'EXEC_LOST' })
      return
    }
    held.phase = 'running'
    const pump = this.#pump(held, agent, command.fence.epoch, {
      cursor: command.cursor,
      eventCount: command.eventCount,
    })
    if ((await answer({ type: 'running', execId: agent.execId })).ok) this.#drain(held, pump)
  }

  async #quiesce(held: Held, command: Command<'quiesce'>): Promise<void> {
    const answer = this.#answer(held, command)
    try {
      if (!held.execution) throw new Error('No container')
      await held.execution.quiesce()
    } catch (error) {
      await answer({ type: 'failed', code: runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED') })
      return
    }
    held.phase = 'quiesced'
    await answer({ type: 'quiesced' })
  }

  /** The candidate parts go to core as untrusted data; home stays here until seal. */
  async #capture(held: Held, command: Command<'capture'>): Promise<void> {
    const answer = this.#answer(held, command)
    const fence = this.#fence(command)
    try {
      if (!held.execution) throw new Error('No container')
      const captured = await held.execution.capture({
        home: command.home,
        baseSha: command.baseSha,
      })
      for (const part of ['patch', 'untracked'] as const) {
        const uploaded = await this.#call(held, () =>
          this.deps.transport.candidate(held.id, part, fence, captured[part]),
        )
        if (uploaded.ok) continue
        if (uploaded.reason === 'refused') throw new Error('Core refused a candidate part')
        return
      }
      held.phase = 'captured'
      await answer({
        type: 'captured',
        homeBytes: captured.homeBytes,
        patch: digest(captured.patch),
        untracked: digest(captured.untracked),
      })
    } catch (error) {
      await answer({
        type: 'failed',
        code: runnerFailureCode(error, 'SNAPSHOT_NOT_WRITTEN', passes.capture),
      })
    }
  }

  /** Home of this very turn, under its own key, through one create-only PUT. */
  async #seal(held: Held, command: Command<'seal'>): Promise<void> {
    const answer = this.#answer(held, command)
    const fence = this.#fence(command)
    const { sessionId, turn } = held.labels
    try {
      if (!held.execution) throw new Error('No container')
      if (
        command.base.sessionId !== sessionId ||
        command.base.turn !== turn ||
        !isTurnSnapshotUrl(command.put.url, sessionId, turn, 'home', this.deps.s3Origin)
      )
        throw new Error('Seal target is not this turn')
      const sealed = await held.execution.seal({
        base: command.base,
        dataKey: () => this.#key(held, 'seal', fence),
        put: { ...command.put, expiresAt: new Date(Date.now() + MAX_PRESIGN_TTL_MS) },
      })
      held.phase = 'sealed'
      await answer({ type: 'sealed', ...sealed })
    } catch (error) {
      await answer({
        type: 'failed',
        code: runnerFailureCode(error, 'SNAPSHOT_SAVE_FAILED', passes.seal),
      })
    }
  }

  /** No answer of its own: the output ends with `exited`. */
  #abortAgent(held: Held): void {
    const pump = held.pump
    if (pump && !pump.done)
      void pump.agent.kill().catch((error: unknown) => this.#warn('abort', logged(error)))
  }

  async #destroy(held: Held, command: Command<'destroy'>): Promise<void> {
    const answer = this.#answer(held, command)
    const containerId = held.containerId
    if (!containerId) {
      held.abort.abort()
      await answer({ type: 'failed', code: 'EXEC_LOST' })
      return
    }
    try {
      await this.#teardown(held, command.reason)
    } catch (error) {
      await answer({ type: 'failed', code: runnerFailureCode(error, 'SANDBOX_COMMAND_FAILED') })
      return
    }
    await answer({ type: 'destroyed', containerId })
  }

  /** A command for a turn this session does not hold: removed already, or never its own. */
  async #unknown(command: RunnerCommand): Promise<void> {
    if (command.type === 'abort') return
    const target: Target = { id: command.assignmentId, deadline: performance.now() + REMOVAL_MS }
    const answer = this.#answer(target, command)
    const containerId = this.#gone.get(command.assignmentId)
    if (command.type === 'destroy' && containerId) await answer({ type: 'destroyed', containerId })
    else await answer({ type: 'failed', code: 'EXEC_LOST' })
  }

  // --- Agent output -----------------------------------------------------------------------------

  #pump(
    held: Held,
    agent: TurnAgentExec,
    epoch: number,
    start: { cursor: ExecCursor; eventCount: number },
  ): Pump {
    const pump: Pump = {
      execId: agent.execId,
      agent,
      epoch,
      stop: new AbortController(),
      done: false,
      acked: { cursor: { ...start.cursor }, eventCount: start.eventCount },
    }
    held.pump = pump
    return pump
  }

  /** Output batches in order, each only after core journaled the one before; then the exit. */
  #drain(held: Held, pump: Pump): void {
    void (async () => {
      try {
        await pump.agent.output(async (batch) => {
          if (pump.stop.signal.aborted) throw STOP
          if (Buffer.byteLength(JSON.stringify(batch.events)) > runnerLimits.outputBatchBytes)
            throw turnOutputTooLarge('Agent output batch exceeds its limit')
          const sent = await this.#report(
            held,
            pump.epoch,
            { type: 'output', execId: pump.execId, ...batch },
            pump.stop.signal,
          )
          if (sent.ok) {
            pump.acked = {
              cursor: { ...batch.to },
              eventCount: pump.acked.eventCount + batch.events.length,
            }
            return
          }
          if (sent.reason === 'mismatch') throw new Reattach(sent.expected)
          // Core no longer reads this exec here: a lost lease, a newer fence or a closed exec.
          pump.stop.abort()
          throw STOP
        })
        if (pump.stop.signal.aborted) return
        const exit = await pump.agent.wait()
        pump.done = true
        held.phase = 'exited'
        await this.#report(
          held,
          pump.epoch,
          { type: 'exited', execId: pump.execId, exit },
          pump.stop.signal,
        )
      } catch (error) {
        if (error === STOP || pump.stop.signal.aborted) return
        if (error instanceof Reattach) return this.#reattach(held, pump, error.expected)
        // The output is refused here (a credential, a limit, a broken stream): the agent stops.
        pump.done = true
        pump.stop.abort()
        await pump.agent.kill().catch(() => {})
        await this.#report(held, pump.epoch, {
          type: 'failed',
          code: runnerFailureCode(error, 'EXEC_LOST', passes.output),
        })
      }
    })()
  }

  /** A gap in core's journal: read again from where core stands. */
  async #reattach(held: Held, pump: Pump, expected: ExecCursor): Promise<void> {
    pump.stop.abort()
    const agent = await held.execution
      ?.attach({ execId: pump.execId, cursor: expected, eventCount: pump.acked.eventCount })
      .catch(() => null)
    if (!agent) {
      await this.#report(held, pump.epoch, { type: 'failed', code: 'EXEC_LOST' })
      return
    }
    this.#drain(
      held,
      this.#pump(held, agent, pump.epoch, { cursor: expected, eventCount: pump.acked.eventCount }),
    )
  }

  // --- Removal ----------------------------------------------------------------------------------

  /** Kill a running agent, remove the container, forget the turn; shared by every remover. */
  #teardown(held: Held, reason: DestroyReason): Promise<void> {
    held.abort.abort()
    // A retired session leaves every container to the newer one.
    if (this.#retired) return Promise.resolve()
    held.destroying ??= (async () => {
      const pump = held.pump
      if (pump && !pump.done) {
        pump.done = true
        pump.stop.abort()
        await pump.agent.kill().catch(() => {})
      }
      await held.execution?.destroy(reason)
      this.#forget(held)
    })().catch((error: unknown) => {
      held.destroying = undefined
      throw error
    })
    return held.destroying
  }

  /** The runner removes a container on its own and tells core, without a command. */
  async #removeOnOwn(held: Held, reason: DestroyReason): Promise<void> {
    try {
      await this.#teardown(held, reason)
    } catch (error) {
      this.#warn('container removal', logged(error))
      return
    }
    if (held.containerId)
      await this.#report(held, held.fence.epoch, {
        type: 'destroyed',
        containerId: held.containerId,
      })
  }

  /** LEASE_LOST: another owner holds the site, so the agent must not act on it any more. */
  async #leaseLost(held: Held): Promise<void> {
    if (held.lost || this.#retired) return
    held.lost = true
    this.#logger.warn('A turn lost its site lease: its agent is stopped and its container removed')
    await this.#removeOnOwn(held, 'failed')
  }

  #forget(held: Held): void {
    if (this.#held.get(held.id) === held) {
      this.#held.delete(held.id)
      // The freed slot takes the next turn now, not when core ends the poll it holds.
      this.#polling?.abort()
    }
    if (held.containerId) {
      this.#gone.set(held.id, held.containerId)
      if (this.#gone.size > GONE_ASSIGNMENTS) this.#gone.delete(this.#gone.keys().next().value!)
    }
  }

  /** Recovery took the turn over under a newer fence of the same lease. */
  #supersede(held: Held, fence: SiteLeaseFence): void {
    if (
      fence.epoch <= held.fence.epoch ||
      fence.siteId !== held.fence.siteId ||
      fence.taskId !== held.fence.taskId
    )
      return
    held.fence = { ...fence }
    // Output of the older epoch is sent again only after the next resume.
    if (held.pump && held.pump.epoch < fence.epoch) held.pump.stop.abort()
  }

  // --- Calls to core ----------------------------------------------------------------------------

  #fence(command: RunnerCommand): RunnerCommandFence {
    return { session: this.session, epoch: command.fence.epoch, command: command.commandId }
  }

  #answer(target: Target, command: RunnerCommand) {
    return (body: Answer) =>
      this.#report(target, command.fence.epoch, {
        ...body,
        commandId: command.commandId,
      } as ReportBody)
  }

  /** The data key of an open command: only this copy exists here, zeroed by whoever uses it. */
  async #key(held: Held, purpose: 'restore' | 'seal', fence: RunnerCommandFence) {
    const key = await this.#call(held, () => this.deps.transport.key(held.id, purpose, fence))
    if (!key.ok) throw new Error('No data key')
    return key.value
  }

  #report(
    target: Target,
    epoch: number,
    body: ReportBody,
    signal?: AbortSignal,
  ): Promise<Outcome<void>> {
    return this.#call(
      target,
      () =>
        this.deps.transport.report(
          runnerReportSchema.parse({
            ...body,
            runnerSession: this.session,
            assignmentId: target.id,
            epoch,
          }),
        ),
      signal,
    )
  }

  /** Retries while core is unreachable or busy, until the turn's deadline and grace. */
  async #call<T>(
    target: Target,
    send: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<Outcome<T>> {
    const stop = signal ? AbortSignal.any([this.#stop.signal, signal]) : this.#stop.signal
    for (let attempt = 0; ; attempt++) {
      if (this.#retired) return { ok: false, reason: 'gave_up' }
      try {
        return { ok: true, value: await send() }
      } catch (error) {
        const failure = classify(error)
        if (failure.reason === 'retry') {
          const wait = Math.min(REPORT_BACKOFF_MS.max, REPORT_BACKOFF_MS.first * 2 ** attempt)
          if (
            stop.aborted ||
            performance.now() + wait > target.deadline + TURN_PUBLICATION_GRACE_MS
          ) {
            this.#warn('core', logged(error))
            return { ok: false, reason: 'gave_up' }
          }
          await sleep(wait, stop)
          continue
        }
        if (failure.reason === 'retired') {
          this.#retire()
          return { ok: false, ...failure }
        }
        if (target instanceof Held) {
          if (failure.reason === 'lost') void this.#leaseLost(target)
          if (failure.reason === 'superseded') this.#supersede(target, failure.fence)
        }
        if (failure.reason === 'refused') this.#warn('core refused', logged(error))
        return { ok: false, ...failure }
      }
    }
  }
}

function remember(set: Set<string>, value: string, limit: number): void {
  set.add(value)
  if (set.size > limit) set.delete(set.values().next().value!)
}
