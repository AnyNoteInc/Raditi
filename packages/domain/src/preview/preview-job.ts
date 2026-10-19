import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'

/**
 * Jobs of the `previews` queue (docs/plan/53-chat-preview-release.md, «Очереди и задания»):
 * building, refreshing and syncing a preview, and starting the browser of the agent. Ids only
 * (CLAUDE.md rule 2): the processor reads the state from PostgreSQL, never from the payload.
 */
export const PREVIEW_QUEUE = 'previews' satisfies QueueName

/** Bring the preview to its revision: build, rebuild, reset, apply a sync request. */
export const PREVIEW_SYNC_JOB = 'preview.sync'
/** Start (or stop when idle) the browser of the agent for one request row. */
export const PREVIEW_BROWSER_JOB = 'preview.browser'

export const previewSyncJobSchema = z.strictObject({
  previewId: z.uuid(),
  /** The revision the preview is asked to show (0 — the base, before any candidate). */
  revision: z.number().int().min(0),
  /** Enqueue counter of the row: a second request for the same revision is not lost. */
  seq: z.number().int().min(1),
})
export type PreviewSyncJob = z.infer<typeof previewSyncJobSchema>

export const previewBrowserJobSchema = z.strictObject({
  previewId: z.uuid(),
  /** `preview_browser_requests.id`. */
  requestId: z.uuid(),
})
export type PreviewBrowserJob = z.infer<typeof previewBrowserJobSchema>

/** The outbox key: `preview.sync:<previewId>:<revision>:<seq>`. */
export const previewSyncDedupeKey = (job: PreviewSyncJob): string =>
  `${PREVIEW_SYNC_JOB}:${job.previewId}:${job.revision}:${job.seq}`

/** The outbox key: `preview.browser:<previewId>:<requestId>`. */
export const previewBrowserDedupeKey = (job: PreviewBrowserJob): string =>
  `${PREVIEW_BROWSER_JOB}:${job.previewId}:${job.requestId}`
