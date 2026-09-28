import { Logger } from '@nestjs/common'
import { throttledLogger } from '@repo/observability'
import { Redis } from 'ioredis'

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
