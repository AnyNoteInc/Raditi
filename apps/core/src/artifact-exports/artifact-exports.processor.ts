import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  ARTIFACT_EXPORT_JOB,
  ARTIFACT_QUEUE,
  artifactExportJobSchema,
} from '@repo/domain/artifacts'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { ArtifactExports } from './artifact-exports.ts'
import { ARTIFACT_EXPORTS } from './artifact-exports.tokens.ts'

/**
 * Works the queue `artifacts`: `artifact.export` builds one workbook of a table (retried by the
 * queue's backoff; after the last try the row is `failed`). Two at a time in this process. Logs
 * carry the job name and id, never a cell.
 */
@Processor(ARTIFACT_QUEUE, { concurrency: 2 })
export class ArtifactExportsProcessor extends WorkerHost {
  readonly #logger = new Logger(ArtifactExportsProcessor.name)
  readonly #exports: Pick<ArtifactExports, 'build' | 'gaveUp'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(ARTIFACT_EXPORTS) exports: Pick<ArtifactExports, 'build' | 'gaveUp'>) {
    super()
    this.#exports = exports
  }

  async process(job: Job): Promise<void> {
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
