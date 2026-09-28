import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'

import { RedisLifecycle } from './lifecycle.ts'

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
