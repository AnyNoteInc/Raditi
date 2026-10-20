import { badRequest, type EnqueueOptions, type JobQueue, type QueueName } from '@repo/domain'
import type { JobsOptions, Queue } from 'bullmq'

/**
 * BullMQ rejects custom job ids that contain ':' or look like integers, while ours are
 * dedupe keys such as `auth.welcome:<userId>` or `turn:<taskId>:<n>`. The mapping is
 * injective: '%' and ':' are percent-encoded, and integer-like ids get a '%N' prefix that
 * the encoding never produces on its own.
 */
export function toBullJobId(id: string): string {
  const encoded = id.replaceAll('%', '%25').replaceAll(':', '%3A')
  return /^-?\d+$/.test(encoded) ? `%N${encoded}` : encoded
}

/** JobQueue port over BullMQ queues registered by QueueModule. */
export class BullMqJobQueue implements JobQueue {
  readonly #queues: ReadonlyMap<QueueName, Queue>
  readonly #deduplicationTtlMs: Partial<Record<QueueName, number>>

  /** `deduplicationTtlMs`: queues where a job id is also a deduplication id, and for how long. */
  constructor(
    queues: ReadonlyMap<QueueName, Queue>,
    deduplicationTtlMs: Partial<Record<QueueName, number>> = {},
  ) {
    this.#queues = queues
    this.#deduplicationTtlMs = deduplicationTtlMs
  }

  async enqueue(
    queue: QueueName,
    name: string,
    payload: unknown,
    opts: EnqueueOptions = {},
  ): Promise<void> {
    const target = this.#queues.get(queue)
    if (!target) throw badRequest(`Unknown queue "${queue}"`)
    const jobOptions: JobsOptions = {}
    if (opts.jobId !== undefined) {
      jobOptions.jobId = toBullJobId(opts.jobId)
      // A job id dedupes only while the job is in Redis; the deduplication key outlives it.
      const ttl = this.#deduplicationTtlMs[queue]
      if (ttl !== undefined) jobOptions.deduplication = { id: jobOptions.jobId, ttl }
    }
    if (opts.delayMs !== undefined) jobOptions.delay = opts.delayMs
    if (opts.priority !== undefined) jobOptions.priority = opts.priority
    // An existing jobId (or deduplication id) makes this a no-op: enqueueing stays idempotent.
    await target.add(name, payload, jobOptions)
  }
}
