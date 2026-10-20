import {
  conflict,
  containsCredential,
  isDomainError,
  runnerLimits,
  turnOutputRejected,
  turnOutputTooLarge,
  type AgentEvent,
  type ExecCursor,
  type ExecExit,
  type TurnAttachState,
  type TurnOutputBatch,
} from '@repo/domain'

import { RunnerApiError } from './runner-api-error.ts'

/** A report waits this long for the supervisor to start reading the output. */
const CONSUMER_WAIT_MS = 30_000

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, into)
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) strings(item, into)
  return into
}

/** The fence of this owner is gone: the runner kills the exec and removes the container. */
function lostLease(error: unknown): boolean {
  return (
    isDomainError(error) &&
    (error.code === 'LEASE_LOST' ||
      (error.code === 'TURN_INTERRUPTED' && error.message === 'lease_lost'))
  )
}

/**
 * The agent's output as core accepts it from a runner, in the order of the journal. A batch is
 * acknowledged only after the supervisor journaled it, and only when it starts at the journal
 * cursor: an earlier batch is a replay, a later one a gap (CURSOR_MISMATCH). Core checks the
 * event limit and the turn credentials again, whatever the runner already filtered.
 */
export class ExecStream {
  readonly execId: string
  #cursor: ExecCursor
  #eventCount: number
  #record: ((batch: TurnOutputBatch) => Promise<void>) | undefined
  readonly #reading = Promise.withResolvers<void>()
  readonly #ended = Promise.withResolvers<void>()
  readonly #exit = Promise.withResolvers<ExecExit>()
  #chain: Promise<void> = Promise.resolve()
  #closed = false

  constructor(
    start: TurnAttachState,
    private readonly credentials: readonly string[],
    private readonly consumerWaitMs = CONSUMER_WAIT_MS,
  ) {
    this.execId = start.execId
    this.#cursor = { ...start.cursor }
    this.#eventCount = start.eventCount
    // Nobody may read a stream that fails before the supervisor attached to it.
    this.#ended.promise.catch(() => {})
  }

  get cursor(): ExecCursor {
    return { ...this.#cursor }
  }

  /** TurnAgentExec.output: resolves once the runner reported the exit after its last batch. */
  consume(record: (batch: TurnOutputBatch) => Promise<void>): Promise<void> {
    if (this.#record) throw conflict('The agent output is already being read')
    this.#record = record
    this.#reading.resolve()
    return this.#ended.promise
  }

  wait(): Promise<ExecExit> {
    return this.#exit.promise
  }

  /** One batch at a time: a retry that overtakes its original finds it journaled (replay). */
  deliver(batch: { from: ExecCursor; to: ExecCursor; events: AgentEvent[] }): Promise<void> {
    const next = this.#chain.then(() => this.#deliver(batch))
    this.#chain = next.catch(() => {})
    return next
  }

  /** After every batch before it; later output is refused. */
  exited(exit: ExecExit): Promise<void> {
    const next = this.#chain.then(() => {
      if (this.#closed) return
      this.#closed = true
      this.#exit.resolve(exit)
      this.#ended.resolve()
    })
    this.#chain = next
    return next
  }

  /** The output fails with `error`; the agent counts as lost. */
  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#ended.reject(error)
    this.#exit.resolve({ code: null, reason: 'lost' })
  }

  async #deliver(batch: { from: ExecCursor; to: ExecCursor; events: AgentEvent[] }) {
    const cursor = this.#cursor
    if (batch.to.stdout <= cursor.stdout && batch.to.stderr <= cursor.stderr) return
    if (this.#closed) throw RunnerApiError.of('COMMAND_CLOSED')
    if (batch.from.stdout !== cursor.stdout || batch.from.stderr !== cursor.stderr)
      throw RunnerApiError.conflict({ error: 'CURSOR_MISMATCH', expected: this.cursor })
    if (this.#eventCount + batch.events.length > runnerLimits.events) {
      this.fail(turnOutputTooLarge('Agent event limit exceeded'))
      throw RunnerApiError.of('COMMAND_CLOSED')
    }
    if (containsCredential(strings(batch.events), this.credentials)) {
      this.fail(turnOutputRejected('Agent output contains a turn credential'))
      throw RunnerApiError.of('COMMAND_CLOSED')
    }
    if (!this.#record) {
      let timer: NodeJS.Timeout | undefined
      const ready = await Promise.race([
        this.#reading.promise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.consumerWaitMs)
        }),
      ])
      clearTimeout(timer)
      if (!ready) throw RunnerApiError.of('UNAVAILABLE')
    }
    if (this.#closed) throw RunnerApiError.of('COMMAND_CLOSED')
    try {
      await this.#record!({ from: { ...batch.from }, to: { ...batch.to }, events: batch.events })
    } catch (error) {
      this.fail(error)
      throw lostLease(error)
        ? RunnerApiError.conflict({ error: 'LEASE_LOST' })
        : RunnerApiError.of('COMMAND_CLOSED')
    }
    this.#cursor = { ...batch.to }
    this.#eventCount += batch.events.length
  }
}
