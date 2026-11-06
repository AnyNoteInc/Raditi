import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common'
import { closeBrowserSession, type PrismaClient } from '@repo/db'
import {
  BROWSER_ENSURE_JOB,
  BROWSER_SESSION_QUEUE,
  browserEnsureJobSchema,
  terminalTaskStatuses,
  type TaskStatus,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { PRISMA } from '@repo/service-runtime'
import { UnrecoverableError, type Job } from 'bullmq'

import { BROWSER_START_FAILED, BrowserSessions } from './browser-sessions.ts'

/** Browsers of different tasks start side by side: as many as a worker holds by default. */
export const BROWSER_ENSURE_CONCURRENCY = 8

/**
 * The lock of a job outlives its longest start: four cold starts of 90 s and the pauses between
 * them. A job whose worker died is not run again (`maxStalledCount` 0): the call that waits for the
 * session puts another one.
 */
export const BROWSER_ENSURE_LOCK_MS = 7 * 60_000

/**
 * Works the `browser-sessions` queue (docs/plan/61-chats-first.md, §5.4): starts the browser of the
 * session the first `web_*` call of a turn opened. Here and not in the role `mcp` because the site's
 * saved sign-in (Б36) is read only by core. The payload names the row; ids in the logs.
 */
@Processor(BROWSER_SESSION_QUEUE, {
  concurrency: BROWSER_ENSURE_CONCURRENCY,
  lockDuration: BROWSER_ENSURE_LOCK_MS,
  maxStalledCount: 0,
})
export class BrowserSessionsProcessor extends WorkerHost implements OnModuleDestroy {
  readonly #logger = new Logger(BrowserSessionsProcessor.name)
  readonly #shutdown = new AbortController()
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(BrowserSessions) private readonly sessions: BrowserSessions | null,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name !== BROWSER_ENSURE_JOB)
      throw new UnrecoverableError(`Unknown ${BROWSER_SESSION_QUEUE} job "${job.name}"`)
    const parsed = browserEnsureJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
    const task = await this.db.task.findUnique({
      where: { id: parsed.data.taskId },
      select: { status: true },
    })
    // The collector closes the session of a task that ended.
    if (!task || (terminalTaskStatuses as readonly TaskStatus[]).includes(task.status)) return
    if (this.sessions) return this.sessions.start(parsed.data, this.#shutdown.signal)
    // mcp knows a worker core does not: the waiting call must not wait out its budget.
    await closeBrowserSession(this.db, {
      sessionId: parsed.data.sessionId,
      status: 'failed',
      reason: 'crashed',
      errorCode: BROWSER_START_FAILED,
      onlyStarting: true,
    })
  }

  /**
   * Shutdown of core: a start may run for minutes and the worker's close waits for it, past the
   * hard stop of the process (30 s). Starts stop here, before BullMQ closes the worker; the row
   * stays and the next `web_*` call puts the job again.
   */
  onModuleDestroy(): void {
    this.#shutdown.abort()
  }

  /** The worker is closing and waits for its jobs (also outside a Nest shutdown). */
  @OnWorkerEvent('closing')
  onClosing(): void {
    this.#shutdown.abort()
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`${BROWSER_SESSION_QUEUE} ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${BROWSER_SESSION_QUEUE}`, err)
  }
}
