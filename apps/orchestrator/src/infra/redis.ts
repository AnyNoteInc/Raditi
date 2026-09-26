import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'

import { throttledErrorLog } from '../common/error-log.ts'

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
  client.on('error', throttledErrorLog(new Logger('Redis'), 'redis'))
  return client
}
