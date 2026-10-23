import { WorkerHost } from '@nestjs/bullmq'
import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import type { QueueName } from '@repo/domain'
import type { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'

import { REDIS } from '../infra/infra.tokens.ts'
import { BULL_QUEUES } from './queue.tokens.ts'

/** The host's worker; undefined when workers were not started (BACKGROUND_JOBS off). */
function workerOf(host: WorkerHost): Worker | undefined {
  try {
    return host.worker
  } catch {
    // The getter throws until BullRegistrar has registered the workers.
    return undefined
  }
}

/**
 * Closes BullMQ workers and queues before @nestjs/bullmq does. A graceful close waits for
 * the running jobs and sends QUIT; with Redis unreachable QUIT queues up behind the pending
 * commands (an add in flight) and waits forever. So then workers and queues are closed by
 * force: running jobs come back as stalled, a pending add never settles (its caller has
 * its own timeout). Runs before onApplicationShutdown, where @nestjs/bullmq's own close
 * finds everything already closed.
 */
@Injectable()
export class BullMqShutdownService implements BeforeApplicationShutdown {
  readonly #logger = new Logger('BullMQ')
  readonly #discovery: DiscoveryService
  readonly #redis: Pick<Redis, 'status'>
  readonly #queues: ReadonlyMap<QueueName, Queue>

  constructor(
    @Inject(DiscoveryService) discovery: DiscoveryService,
    @Inject(REDIS) redis: Pick<Redis, 'status'>,
    @Inject(BULL_QUEUES) queues: ReadonlyMap<QueueName, Queue>,
  ) {
    this.#discovery = discovery
    this.#redis = redis
    this.#queues = queues
  }

  async beforeApplicationShutdown(): Promise<void> {
    const force = this.#redis.status !== 'ready'
    const workers = this.#discovery
      .getProviders()
      .map((wrapper): unknown => wrapper.instance)
      .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
      .map(workerOf)
      .filter((worker): worker is Worker => worker !== undefined)
    if (!force) {
      await Promise.all(workers.map((worker) => worker.close(false)))
      return
    }
    this.#logger.warn('Redis is unreachable: closing workers and queues without waiting')
    await Promise.all([
      ...workers.map((worker) => worker.close(true)),
      // Queue.close() has no force flag; its backend does.
      ...[...this.#queues.values()].map((queue) => queue.getBackend().close(true)),
    ])
  }
}
