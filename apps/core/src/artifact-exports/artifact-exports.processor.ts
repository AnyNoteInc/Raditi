import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  ARTIFACT_EXPORT_JOB,
  ARTIFACT_QUEUE,
  ARTIFACT_THUMBS_JOB,
  artifactExportJobSchema,
  artifactThumbsJobSchema,
} from '@repo/domain/artifacts'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { ArtifactExports } from './artifact-exports.ts'
import { ARTIFACT_EXPORTS, ARTIFACT_THUMBS } from './artifact-exports.tokens.ts'
import type { ArtifactThumbs } from './artifact-thumbs.ts'

/**
 * Works the queue `artifacts`: `artifact.export` builds one export — the PDF or PPTX of slides, the
 * PNG of a picture — (retried by the queue's backoff; after the last try the row is `failed`). Two
 * at a time in this process. Logs carry the job name and id, never the content.
 */
@Processor(ARTIFACT_QUEUE, { concurrency: 2 })
export class ArtifactExportsProcessor extends WorkerHost {
  readonly #logger = new Logger(ArtifactExportsProcessor.name)
  readonly #exports: Pick<ArtifactExports, 'build' | 'gaveUp'>
  readonly #thumbs: Pick<ArtifactThumbs, 'draw'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(ARTIFACT_EXPORTS) exports: Pick<ArtifactExports, 'build' | 'gaveUp'>,
    @Inject(ARTIFACT_THUMBS) thumbs: Pick<ArtifactThumbs, 'draw'>,
  ) {
    super()
    this.#exports = exports
    this.#thumbs = thumbs
  }

  async process(job: Job): Promise<void> {
    if (job.name === ARTIFACT_THUMBS_JOB) {
      const data = artifactThumbsJobSchema.safeParse(job.data)
      if (!data.success) throw new UnrecoverableError('Invalid artifact.thumbs job')
      await this.#thumbs.draw(data.data.artifactId)
      return
    }
    if (job.name !== ARTIFACT_EXPORT_JOB)
      throw new UnrecoverableError(`Unknown artifacts job "${job.name}"`)
    const data = artifactExportJobSchema.safeParse(job.data)
    if (!data.success) throw new UnrecoverableError('Invalid artifact.export job')
    await this.#exports.build(data.data.exportId)
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    this.#logger.warn(
      `Artifacts job ${job?.name ?? '?'} (job ${job?.id ?? '?'}, attempt ${job?.attemptsMade ?? '?'}) ` +
        `failed: ${errorMessage(err)}`,
    )
    const data = artifactExportJobSchema.safeParse(job?.data)
    const last = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1)
    if (data.success && (last || err instanceof UnrecoverableError))
      await this.#exports.gaveUp(data.data.exportId)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${ARTIFACT_QUEUE}`, err)
  }
}
