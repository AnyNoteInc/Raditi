// Of the role apps only core connects to Redis (BullMQ and the health of its connection), so the
// shared client, its health check and its shutdown live here, not in @repo/service-runtime.
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import { throttledLogger, type HealthCheck } from '@repo/observability'
import { Redis } from 'ioredis'

import { REDIS } from './tokens.ts'

/**
 * Client for health checks and pub/sub. Commands fail fast while Redis is away instead of
 * piling up; reconnects continue in the background. BullMQ keeps its own connections.
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  })
  const logger = new Logger('Redis')
  const warn = throttledLogger((line) => logger.warn(line))
  client.on('error', (error) => warn('redis', error))
  return client
}

/** The shared client fails fast while Redis is away (enableOfflineQueue is off). */
export const redisCheck =
  (redis: Pick<Redis, 'ping'>): HealthCheck =>
  async () =>
    (await redis.ping()) === 'PONG'

/** Closes the shared client after the HTTP server and the workers have stopped. */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  readonly #redis: Redis

  constructor(@Inject(REDIS) redis: Redis) {
    this.#redis = redis
  }

  async onApplicationShutdown(): Promise<void> {
    // QUIT needs a live connection; otherwise just stop reconnecting.
    if (this.#redis.status !== 'ready') {
      this.#redis.disconnect()
      return
    }
    await this.#redis.quit().catch(() => this.#redis.disconnect())
  }
}
