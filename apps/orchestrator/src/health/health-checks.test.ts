import { describe, expect, it } from 'vitest'

import { CORE_BUCKETS, redisCheck } from './health-checks.ts'

describe('checks', () => {
  it('redis pings the shared client and passes its failure on', async () => {
    const down = (): Promise<'PONG'> => Promise.reject(new Error('Connection is closed'))

    await expect(redisCheck({ ping: async () => 'PONG' })()).resolves.toBe(true)
    await expect(redisCheck({ ping: down })()).rejects.toThrow('Connection is closed')
  })

  it('core checks its own buckets: no backups, no platform', () => {
    expect(CORE_BUCKETS).toEqual(['inbox', 'sessions', 'logs', 'artifacts'])
  })
})
