import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  SITE_FILES_BLOB_JOB,
  SITE_FILES_QUEUE,
  SITE_FILES_TREE_JOB,
  siteFilesBlobJobSchema,
  siteFilesTreeJobSchema,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import { SiteFiles } from './site-files.ts'

/** Lists and files of different projects are read side by side; each is a read of the mirror. */
export const SITE_FILES_CONCURRENCY = 4

/**
 * Works the `site-files` queue (06.11.2026): the list of the files of a commit of a site, or one
 * file of it, for the section «Терминал» of the project. A failed job is not retried: web puts it
 * again while the client looks. The payload names ids and a path; the logs — the job only.
 */
@Processor(SITE_FILES_QUEUE, { concurrency: SITE_FILES_CONCURRENCY })
export class SiteFilesProcessor extends WorkerHost {
  readonly #logger = new Logger(SiteFilesProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(SiteFiles) private readonly files: SiteFiles) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === SITE_FILES_TREE_JOB) {
      const parsed = siteFilesTreeJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
      return this.files.tree(parsed.data)
    }
    if (job.name === SITE_FILES_BLOB_JOB) {
      const parsed = siteFilesBlobJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
      return this.files.blob(parsed.data)
    }
    throw new UnrecoverableError(`Unknown ${SITE_FILES_QUEUE} job "${job.name}"`)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`${SITE_FILES_QUEUE} ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${SITE_FILES_QUEUE}`, err)
  }
}
