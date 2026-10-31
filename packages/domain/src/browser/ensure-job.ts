import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'

/**
 * The start of a task's browser (docs/plan/61-chats-first.md, К11, §5.4): the first `web_*` call
 * of a turn writes the row of the session and puts this job; core answers it, because the site's
 * saved sign-in (Б36) is read only there. A queue of its own: in `agent-turns` the turns waiting
 * for their browser would hold the slots of the jobs that start it. Ids only (CLAUDE.md rule 2):
 * the processor reads the state from PostgreSQL.
 */
export const BROWSER_SESSION_QUEUE = 'browser-sessions' satisfies QueueName

/** Start the browser of one session row; nothing when it is up or closed. */
export const BROWSER_ENSURE_JOB = 'browser.ensure'

export const browserEnsureJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** `browser_sessions.id`. */
  sessionId: z.uuid(),
})
export type BrowserEnsureJob = z.infer<typeof browserEnsureJobSchema>

/**
 * A session still `starting` asks for its job again once in this long: `ensure` is idempotent, and
 * a job that was lost does not wait for the collector.
 */
export const BROWSER_ENSURE_WINDOW_MS = 30_000

/** The window a moment falls in (database time): the last part of the outbox key. */
export const browserEnsureWindow = (at: Date): number =>
  Math.floor(at.getTime() / BROWSER_ENSURE_WINDOW_MS)

/** The outbox key: `browser.ensure:<sessionId>:<window>`. */
export const browserEnsureDedupeKey = (job: BrowserEnsureJob, window: number): string =>
  `${BROWSER_ENSURE_JOB}:${job.sessionId}:${window}`
