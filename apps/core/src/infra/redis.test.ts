import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'

import { RedisLifecycle, redisCheck } from './redis.ts'

function fakeRedis(status: string, quit = vi.fn().mockResolvedValue('OK')) {
  return { status, quit, disconnect: vi.fn() }
}

describe('RedisLifecycle', () => {
  it('sends QUIT over a live connection', async () => {
    const redis = fakeRedis('ready')

    await new RedisLifecycle(redis as unknown as Redis).onApplicationShutdown()

    expect(redis.quit).toHaveBeenCalledOnce()
    expect(redis.disconnect).not.toHaveBeenCalled()
  })

  it('just stops reconnecting when Redis is away, so shutdown does not wait', async () => {
    const redis = fakeRedis('reconnecting')

    await new RedisLifecycle(redis as unknown as Redis).onApplicationShutdown()

    expect(redis.quit).not.toHaveBeenCalled()
    expect(redis.disconnect).toHaveBeenCalledOnce()
  })

  it('falls back to disconnect when QUIT fails', async () => {
    const redis = fakeRedis('ready', vi.fn().mockRejectedValue(new Error('Connection is closed.')))

    await new RedisLifecycle(redis as unknown as Redis).onApplicationShutdown()

    expect(redis.disconnect).toHaveBeenCalledOnce()
  })
})

describe('checks', () => {
  it('redis pings the shared client and passes its failure on', async () => {
    const down = (): Promise<'PONG'> => Promise.reject(new Error('Connection is closed'))

    await expect(redisCheck({ ping: async () => 'PONG' })()).resolves.toBe(true)
    await expect(redisCheck({ ping: down })()).rejects.toThrow('Connection is closed')
  })
})
