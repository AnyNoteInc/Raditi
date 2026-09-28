import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { Prisma, type PrismaClient } from '@repo/db'
import { withTimeout, type JobQueue } from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { z } from 'zod'

import { BACKGROUND_JOBS, JOB_QUEUE, PRISMA } from '../infra/tokens.ts'
import { isQueueName } from '../queue/queues.ts'

export const OUTBOX_POLL_INTERVAL_MS = 1_000
export const OUTBOX_BATCH_SIZE = 50
export const OUTBOX_MAX_ATTEMPTS = 10
export const OUTBOX_ENQUEUE_TIMEOUT_MS = 5_000
export const OUTBOX_MAX_BACKOFF_MS = 10 * 60_000
/**
 * Claimed rows belong to one relay this long; after that (a crashed or stuck replica)
 * another relay may claim them again.
 */
export const OUTBOX_LEASE_MS = 60_000
/** Kept in reserve at the end of a lease for marking the last row and releasing the rest. */
export const OUTBOX_LEASE_MARGIN_MS = 10_000
/** Published and failed rows are kept this long, then deleted. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60_000
export const OUTBOX_PURGE_INTERVAL_MS = 60 * 60_000
/** After failed passes (database down) polling slows down: 2 s, 4 s, … up to this. */
export const OUTBOX_MAX_PAUSE_MS = 30_000
const MAX_ERROR_LENGTH = 1_000
/** outbox_events.locked_by is varchar(64). */
const MAX_HOST_LENGTH = 40

/** Columns of outbox_events (packages/db/prisma/schema.prisma) the relay reads. */
const outboxRowsSchema = z.array(
  z.object({
    id: z.string(),
    topic: z.string(),
    type: z.string(),
    payload: z.unknown(),
    dedupe_key: z.string().nullable(),
    attempts: z.number().int(),
    created_at: z.coerce.date(),
  }),
)
type OutboxRow = z.infer<typeof outboxRowsSchema>[number]

type RowUpdate = Pick<
  Prisma.OutboxEventUpdateManyMutationInput,
  'status' | 'attempts' | 'lastError' | 'availableAt' | 'publishedAt' | 'payload'
>

/** Delay before the next try after `attempts` failures: 2 s, 4 s, 8 s, … capped at 10 minutes. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, OUTBOX_MAX_BACKOFF_MS)
}

const truncate = (message: string) =>
  message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message

/**
 * Moves outbox_events to BullMQ (spec §7): web writes a row in the same transaction as the
 * business change, the relay publishes it to the queue named by its topic. A pass claims a
 * batch in one statement (locked_at/locked_by, FOR UPDATE SKIP LOCKED: replicas never claim
 * the same row), then enqueues row by row and marks each row in its own statement. No
 * transaction spans an enqueue, so a slow Redis cannot roll back rows that are already in
 * the queue. A pass stops before its lease runs out and releases what it has not
 * published. A row published twice (marking failed, the lease ran out) is a no-op: the job
 * id is the dedupe_key or row id, and queues that drop finished jobs at once deduplicate
 * by that id for longer. A published row keeps no payload: it may hold one-time links.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  /** locked_by of the rows this process claims. */
  readonly relayId = `${hostname().slice(0, MAX_HOST_LENGTH)}/${process.pid}/${randomUUID().slice(0, 8)}`
  readonly #logger = new Logger(OutboxRelayService.name)
  readonly #prisma: PrismaClient
  readonly #queue: JobQueue
  readonly #background: boolean
  #pollTimer: NodeJS.Timeout | undefined
  #purgeTimer: NodeJS.Timeout | undefined
  #tick: Promise<number> | undefined
  #purge: Promise<number> | undefined
  #stopping = false
  #failedPasses = 0
  #pausedUntil = 0
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  readonly #logPassFailure = (err: unknown) => this.#warn('Outbox relay pass failed', err)

  constructor(
    @Inject(PRISMA) prisma: PrismaClient,
    @Inject(JOB_QUEUE) queue: JobQueue,
    @Inject(BACKGROUND_JOBS) background: boolean,
  ) {
    this.#prisma = prisma
    this.#queue = queue
    this.#background = background
  }

  onApplicationBootstrap(): void {
    if (!this.#background) return
    this.#pollTimer = setInterval(() => void this.tick(), OUTBOX_POLL_INTERVAL_MS)
    this.#purgeTimer = setInterval(() => void this.purge(), OUTBOX_PURGE_INTERVAL_MS)
    void this.purge()
  }

  /**
   * Stops polling, lets the running pass finish its current row and release the rest, and
   * waits for it and for a running purge, before the database pool closes.
   */
  async onModuleDestroy(): Promise<void> {
    this.#stopping = true
    clearInterval(this.#pollTimer)
    clearInterval(this.#purgeTimer)
    await Promise.all([this.#tick, this.#purge])
  }

  /**
   * One relay pass; resolves to the number of rows it claimed. A call while the previous
   * pass is still running, during the pause after a failed pass or after shutdown began
   * returns 0 at once: passes never overlap. Never rejects.
   */
  tick(): Promise<number> {
    if (this.#tick || this.#stopping || Date.now() < this.#pausedUntil) return Promise.resolve(0)
    this.#tick = Promise.resolve()
      .then(() => this.#relay())
      .then((count) => {
        this.#failedPasses = 0
        return count
      })
      .catch((err: unknown) => {
        this.#failedPasses += 1
        const pause = Math.min(
          OUTBOX_POLL_INTERVAL_MS * 2 ** this.#failedPasses,
          OUTBOX_MAX_PAUSE_MS,
        )
        this.#pausedUntil = Date.now() + pause
        this.#logPassFailure(err)
        return 0
      })
      .finally(() => {
        this.#tick = undefined
      })
    return this.#tick
  }

  /**
   * Deletes published and failed rows older than the retention period: failed rows keep
   * their payloads, which may hold one-time links. A call while a purge runs joins it.
   * Never rejects.
   */
  purge(now = new Date()): Promise<number> {
    this.#purge ??= this.#deleteExpired(now).finally(() => {
      this.#purge = undefined
    })
    return this.#purge
  }

  async #deleteExpired(now: Date): Promise<number> {
    const before = new Date(now.getTime() - OUTBOX_RETENTION_MS)
    try {
      const { count } = await this.#prisma.outboxEvent.deleteMany({
        where: {
          OR: [
            { status: 'published', publishedAt: { lt: before } },
            { status: 'failed', createdAt: { lt: before } },
          ],
        },
      })
      if (count > 0) this.#logger.log(`Purged ${count} outbox events`)
      return count
    } catch (err) {
      this.#logger.error(`Outbox purge failed: ${errorMessage(err)}`)
      return 0
    }
  }

  async #relay(): Promise<number> {
    const claimedAt = Date.now()
    const rows = await this.#claim()
    let settled = 0
    try {
      for (const row of rows) {
        if (this.#stopping || !this.#fitsInLease(claimedAt)) break
        const published = await this.#publish(row)
        settled += 1
        // After a failed enqueue the rest waits for the next pass: when Redis is down,
        // a pass costs one timeout, not fifty.
        if (!published) break
      }
    } finally {
      // A row whose marking threw is released too: its job id makes a second publish a no-op.
      const rest = rows.slice(settled)
      if (rest.length > 0) await this.#release(rest).catch(this.#logPassFailure)
    }
    return rows.length
  }

  /** true while one more enqueue, its marking and the release still fit into the lease. */
  #fitsInLease(claimedAt: number): boolean {
    const elapsed = Date.now() - claimedAt
    return elapsed + OUTBOX_ENQUEUE_TIMEOUT_MS + OUTBOX_LEASE_MARGIN_MS <= OUTBOX_LEASE_MS
  }

  /** Claims due rows, oldest first: unlocked ones and those whose lease ran out. */
  async #claim(): Promise<OutboxRow[]> {
    const rows = outboxRowsSchema.parse(
      await this.#prisma.$queryRaw`
        WITH due AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'pending' AND available_at <= now()
            AND (locked_at IS NULL
              OR locked_at < now() - ${OUTBOX_LEASE_MS}::int * interval '1 millisecond')
          ORDER BY created_at
          LIMIT ${OUTBOX_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events AS e
        SET locked_at = now(), locked_by = ${this.relayId}
        FROM due
        WHERE e.id = due.id
        RETURNING e.id, e.topic, e.type, e.payload, e.dedupe_key, e.attempts, e.created_at`,
    )
    return rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
  }

  /** false when the enqueue failed. */
  async #publish(row: OutboxRow): Promise<boolean> {
    if (!isQueueName(row.topic)) {
      await this.#fail(row, `Unknown topic "${row.topic}"`)
      return true
    }
    // enqueueOutbox always writes a payload; only publishing clears it.
    if (row.payload === null) {
      await this.#fail(row, 'Payload is missing')
      return true
    }

    try {
      await withTimeout(
        this.#queue.enqueue(row.topic, row.type, row.payload, { jobId: row.dedupe_key ?? row.id }),
        OUTBOX_ENQUEUE_TIMEOUT_MS,
        `Enqueue to "${row.topic}" timed out`,
      )
    } catch (err) {
      const attempts = row.attempts + 1
      const lastError = truncate(errorMessage(err))
      const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS
      await this.#settle(
        row,
        exhausted
          ? { attempts, lastError, status: 'failed' }
          : { attempts, lastError, availableAt: new Date(Date.now() + outboxBackoffMs(attempts)) },
      )
      this.#logger.warn(
        `Outbox event ${row.id} (${row.topic}/${row.type}) not published, attempt ${attempts}` +
          `${exhausted ? ', marked failed' : ''}: ${lastError}`,
      )
      return false
    }

    // The job carries the payload now; the row keeps no one-time links.
    await this.#settle(row, {
      status: 'published',
      publishedAt: new Date(),
      payload: Prisma.DbNull,
    })
    return true
  }

  /** A row that can never be published: failed at once, without an enqueue. */
  async #fail(row: OutboxRow, reason: string): Promise<void> {
    await this.#settle(row, { status: 'failed', lastError: truncate(reason) })
    this.#logger.error(`Outbox event ${row.id} (${row.topic}/${row.type}) marked failed: ${reason}`)
  }

  /** Writes the outcome and drops the claim, unless the lease ran out and the row moved on. */
  async #settle(row: OutboxRow, data: RowUpdate): Promise<void> {
    const { count } = await this.#prisma.outboxEvent.updateMany({
      where: { id: row.id, lockedBy: this.relayId },
      data: { ...data, lockedAt: null, lockedBy: null },
    })
    if (count === 0) {
      this.#logger.warn(
        `Outbox event ${row.id} was claimed by another relay after the lease ran out`,
      )
    }
  }

  /** Hands claimed rows back for the next pass, as they were. */
  async #release(rows: readonly OutboxRow[]): Promise<void> {
    await this.#prisma.outboxEvent.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, lockedBy: this.relayId },
      data: { lockedAt: null, lockedBy: null },
    })
  }
}
