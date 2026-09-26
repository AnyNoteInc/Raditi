import { BullModule, getQueueToken } from '@nestjs/bullmq'
import { Logger, Module, type DynamicModule } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { queueNames, type QueueName } from '@repo/domain'
import type { Queue } from 'bullmq'

import { throttledErrorLog } from '../common/error-log.ts'
import { BULL_QUEUES, JOB_QUEUE } from '../infra/tokens.ts'
import { BullMqJobQueue } from './bullmq-job-queue.ts'
import { BullMqShutdownService } from './bullmq-shutdown.service.ts'
import { queueDeduplicationTtlMs, queueJobDefaults } from './queues.ts'

export interface QueueModuleOptions {
  redisUrl: string
  /** false: queues only, no workers (tests compile the app without Redis). */
  background: boolean
}

/** Queues are injected in `queueNames` order; errors are logged, never thrown. */
function collectQueues(...queues: Queue[]): ReadonlyMap<QueueName, Queue> {
  const logger = new Logger('BullMQ')
  const byName = new Map<QueueName, Queue>()
  queueNames.forEach((name, index) => {
    const queue = queues[index]
    if (!queue) throw new Error(`Queue "${name}" is not registered`)
    // Without a listener BullMQ prints every reconnect failure to the console.
    queue.on('error', throttledErrorLog(logger, `queue ${name}`))
    byName.set(name, queue)
  })
  return byName
}

/** BullMQ on REDIS_URL (spec §7): one queue per name in queueNames, the JobQueue port. */
@Module({})
export class QueueModule {
  static forRoot(options: QueueModuleOptions): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [
        DiscoveryModule,
        BullModule.forRoot({
          // BullMQ requires maxRetriesPerRequest: null: commands wait for a reconnect.
          connection: { url: options.redisUrl, maxRetriesPerRequest: null },
          extraOptions: { manualRegistration: !options.background },
        }),
        BullModule.registerQueue(
          ...queueNames.map((name) => ({ name, defaultJobOptions: queueJobDefaults[name] })),
        ),
      ],
      providers: [
        {
          provide: BULL_QUEUES,
          useFactory: collectQueues,
          inject: queueNames.map((name) => getQueueToken(name)),
        },
        {
          provide: JOB_QUEUE,
          useFactory: (queues: ReadonlyMap<QueueName, Queue>) =>
            new BullMqJobQueue(queues, queueDeduplicationTtlMs),
          inject: [BULL_QUEUES],
        },
        BullMqShutdownService,
      ],
      exports: [BullModule, JOB_QUEUE],
    }
  }
}
