import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import type { Redis } from 'ioredis'
import pg from 'pg'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { REDIS } from '../infra/infra.tokens.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { OutboxRelayService } from '../outbox/outbox-relay.service.ts'
import { TaskSignalRelay } from './task-signal-relay.ts'

/** Starts the relay with the application and stops it with it. */
@Injectable()
class TaskSignalsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #relay: TaskSignalRelay

  constructor(@Inject(TaskSignalRelay) relay: TaskSignalRelay) {
    this.#relay = relay
  }

  onApplicationBootstrap(): void {
    this.#relay.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#relay.stop()
  }
}

/**
 * The signals of chats, from PostgreSQL to Redis (task-signal-relay.ts): the pages of web read a
 * chat as soon as it changes instead of polling it every two seconds. AppModule imports it in the
 * process that runs the workers.
 */
@Module({
  imports: [OutboxModule],
  providers: [
    {
      provide: TaskSignalRelay,
      useFactory: (config: CoreConfig, redis: Redis, outbox: OutboxRelayService) => {
        const logger = new Logger('TaskSignals')
        return new TaskSignalRelay({
          // A connection that hangs is given up as Prisma's are, and a dead one is found by TCP.
          listener: () =>
            new pg.Client({
              connectionString: config.db.databaseUrl,
              connectionTimeoutMillis: 5_000,
              keepAlive: true,
            }),
          publish: (channel, message) => redis.publish(channel, message),
          outbox: () => outbox.wake(),
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
      inject: [CORE_CONFIG, REDIS, OutboxRelayService],
    },
    TaskSignalsLifecycle,
  ],
})
export class TaskSignalsModule {}
