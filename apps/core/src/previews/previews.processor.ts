import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  PREVIEW_BROWSER_JOB,
  PREVIEW_QUEUE,
  PREVIEW_SYNC_JOB,
  previewBrowserJobSchema,
  previewSyncJobSchema,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import type { z } from 'zod'

import { PreviewManager } from './preview-manager.ts'

/** Previews of different dialogs are built side by side; one preview by one holder at a time. */
export const PREVIEW_CONCURRENCY = 4

/**
 * The lock of a job outlives the longest build: a copy of the site's database (30 min), the
 * tree, the load of the seed. A job whose worker died is not run again: the sweep finds the
 * preview its holder left (`maxStalledCount` 0).
 */
export const PREVIEW_LOCK_MS = 75 * 60_000

function parsed<T>(schema: z.ZodType<T>, job: Job): T {
  const result = schema.safeParse(job.data)
  if (!result.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
  return result.data
}

/**
 * Works the `previews` queue (docs/plan/53-chat-preview-release.md, «Очереди и задания»):
 * `preview.sync` brings a preview to what its dialog needs now — a build, a rebuild, a reset,
 * its end — and `preview.browser` answers one browser request of the agent. The payload names
 * the row; what to do is read from PostgreSQL.
 */
@Processor(PREVIEW_QUEUE, {
  concurrency: PREVIEW_CONCURRENCY,
  lockDuration: PREVIEW_LOCK_MS,
  maxStalledCount: 0,
})
export class PreviewsProcessor extends WorkerHost {
  readonly #logger = new Logger(PreviewsProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(PreviewManager) private readonly manager: PreviewManager | null) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case PREVIEW_SYNC_JOB: {
        const { previewId } = parsed(previewSyncJobSchema, job)
        // Held elsewhere: the holder sees the counter of requests this job was put with.
        await this.manager?.refresh(previewId, { requested: true })
        return
      }
      case PREVIEW_BROWSER_JOB: {
        const { requestId } = parsed(previewBrowserJobSchema, job)
        // Not served now (the preview is held): the loop of request rows serves it.
        await this.manager?.serveBrowser(requestId)
        return
      }
      default:
        throw new UnrecoverableError(`Unknown ${PREVIEW_QUEUE} job "${job.name}"`)
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`${PREVIEW_QUEUE} ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${PREVIEW_QUEUE}`, err)
  }
}
