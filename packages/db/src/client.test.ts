import { describe, expect, it } from 'vitest'

import { dbConfigFromEnv } from './client.ts'

describe('dbConfigFromEnv', () => {
  it('accepts a postgresql connection string', () => {
    expect(
      dbConfigFromEnv({ DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi' }),
    ).toEqual({
      databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi',
    })
  })

  it('fails with a clear message when DATABASE_URL is missing', () => {
    expect(() => dbConfigFromEnv({})).toThrow(
      '[db] invalid configuration: DATABASE_URL: is not set',
    )
  })

  it('rejects a non-postgres URL', () => {
    expect(() => dbConfigFromEnv({ DATABASE_URL: 'mysql://localhost/raditi' })).toThrow(
      'DATABASE_URL: must be a postgresql:// connection string',
    )
  })
})

describe('importing @repo/db', () => {
  it('does not need DATABASE_URL until the client is used', async () => {
    const saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      const db = await import('./index.ts')
      expect(db.TaskStatus.queued).toBe('queued')
      expect(() => db.prisma.$connect).toThrow('DATABASE_URL: is not set')
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved
    }
  })
})
