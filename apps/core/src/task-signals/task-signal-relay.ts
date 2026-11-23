import {
  parseTaskSignal,
  TASK_SIGNAL_PG_CHANNEL,
  TASK_SIGNALS_RESYNC_CHANNEL,
  taskSignalChannel,
} from '@repo/domain'
import {
  ARTIFACT_SIGNAL_PG_CHANNEL,
  artifactSignalChannel,
  parseArtifactSignal,
} from '@repo/domain/artifacts'
import { throttledLogger } from '@repo/observability'

/** Only the name of an error: messages of Redis and the database stay out of the log. */
const nameOf = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

/** The channel of PostgreSQL that says new rows of the outbox committed. */
export const OUTBOX_PG_CHANNEL = 'raditi_outbox'

/** The part of a `pg` client the relay uses: one connection that LISTENs. */
export interface SignalListener {
  connect(): Promise<unknown>
  query(sql: string): Promise<unknown>
  on(
    event: 'notification',
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
  end(): Promise<unknown>
}

export interface TaskSignalRelayDependencies {
  /** A new, unconnected client of the database: one per connection, a new one after a loss. */
  listener: () => SignalListener
  publish: (channel: string, message: string) => Promise<unknown>
  /** Rows of the outbox committed (NOTIFY raditi_outbox): its relay runs a pass at once. */
  outbox?: () => void
  logger: { log(line: string): void; warn(line: string): void }
  /** Signals of one task and kind, or of one artifact, within this long go out as one. */
  coalesceMs?: number
  /** The first wait after a lost connection; it doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
}

/**
 * The relay of the signals of chats (spec §7, «Лента для клиента»): PostgreSQL notifies on
 * `raditi_task` when a change of a chat commits, and every web replica listens on Redis — this
 * relay is the one listener of the database. Signals of one task and kind that come together go
 * out once. After every connection — the first one and every one after a loss — it says `resync`
 * on Redis: what was notified while nobody listened is lost, and the open pages read again by their
 * cursors. Nothing here is durable: a signal only says «read now».
 *
 * The second channel is of artifacts (docs/plan/88-artifacts.md, Ар20, §7.4): a committed batch of
 * operations notifies `raditi_artifact` with the artifact's id, relayed as `changes` on the Redis
 * channel of the artifact; `resync` covers its pages too.
 */
export class TaskSignalRelay {
  readonly #deps: TaskSignalRelayDependencies
  /** `<Redis channel> <message>` of what goes out at the next flush, each once. */
  readonly #pending = new Set<string>()
  #client: SignalListener | null = null
  #flush: NodeJS.Timeout | undefined
  #retry: NodeJS.Timeout | undefined
  #retryMs: number
  #stopped = false
  /** While Redis is away every signal fails: said once a minute, not a few times a second. */
  readonly #unpublished: (source: string, error: unknown) => void

  constructor(deps: TaskSignalRelayDependencies) {
    this.#deps = deps
    this.#retryMs = deps.retryMs ?? 1_000
    this.#unpublished = throttledLogger((line) => deps.logger.warn(line))
  }

  start(): void {
    this.#stopped = false
    void this.#connect()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#retry)
    clearTimeout(this.#flush)
    this.#flush = undefined
    const client = this.#client
    this.#client = null
    await client?.end().catch(() => undefined)
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return
    const client = this.#deps.listener()
    this.#client = client
    client.on('notification', (message) => {
      if (message.channel === OUTBOX_PG_CHANNEL) return this.#deps.outbox?.()
      if (message.channel === ARTIFACT_SIGNAL_PG_CHANNEL)
        return this.#heardArtifact(message.payload ?? '')
      this.#heard(message.payload ?? '')
    })
    client.on('error', (error) => this.#lost(client, error))
    client.on('end', () => this.#lost(client))
    try {
      await client.connect()
      await client.query(`LISTEN ${TASK_SIGNAL_PG_CHANNEL}`)
      await client.query(`LISTEN ${ARTIFACT_SIGNAL_PG_CHANNEL}`)
      if (this.#deps.outbox) await client.query(`LISTEN ${OUTBOX_PG_CHANNEL}`)
    } catch (error) {
      this.#lost(client, error)
      return
    }
    if (this.#client !== client) return
    this.#retryMs = this.#deps.retryMs ?? 1_000
    this.#deps.logger.log('task_signals_listening')
    // What was added to the outbox while nobody listened is relayed now, not at the next poll.
    this.#deps.outbox?.()
    await this.#deps
      .publish(TASK_SIGNALS_RESYNC_CHANNEL, 'resync')
      .catch((error: unknown) =>
        this.#unpublished('task_signals_resync_not_published', nameOf(error)),
      )
  }

  /** The connection is gone: a new one after a wait that doubles while it keeps failing. */
  #lost(client: SignalListener, error?: unknown): void {
    if (this.#client !== client) return
    this.#client = null
    void client.end().catch(() => undefined)
    if (this.#stopped) return
    const cause = error instanceof Error ? error.name : 'end'
    this.#deps.logger.warn(`task_signals_lost cause=${cause} retry_ms=${this.#retryMs}`)
    this.#retry = setTimeout(() => void this.#connect(), this.#retryMs)
    this.#retry.unref()
    this.#retryMs = Math.min(this.#retryMs * 2, this.#deps.maxRetryMs ?? 30_000)
  }

  #heard(payload: string): void {
    const signal = parseTaskSignal(payload)
    if (signal === null) return
    this.#add(taskSignalChannel(signal.taskId), signal.kind)
  }

  #heardArtifact(payload: string): void {
    const artifactId = parseArtifactSignal(payload)
    if (artifactId === null) return
    this.#add(artifactSignalChannel(artifactId), 'changes')
  }

  #add(channel: string, message: string): void {
    this.#pending.add(`${channel} ${message}`)
    this.#flush ??= setTimeout(() => this.#send(), this.#deps.coalesceMs ?? 50)
  }

  #send(): void {
    this.#flush = undefined
    const signals = [...this.#pending]
    this.#pending.clear()
    for (const key of signals) {
      const at = key.indexOf(' ')
      this.#deps
        .publish(key.slice(0, at), key.slice(at + 1))
        .catch((error: unknown) => this.#unpublished('task_signal_not_published', nameOf(error)))
    }
  }
}
