import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  admitAvatarUpload,
  AVATAR_UPLOAD_WINDOW_MS,
  AVATAR_UPLOADS_PER_WINDOW,
} from './avatar-upload-limit'

const databaseUrl = process.env.DATABASE_URL

describe('avatar upload limit', () => {
  it('admits up to the limit by the returned count and names the user in the key', async () => {
    const userId = randomUUID()
    const $queryRaw = vi.fn(async () => [{ count: AVATAR_UPLOADS_PER_WINDOW }])
    const db = { $queryRaw } as unknown as Pick<PrismaClient, '$queryRaw'>
    await expect(admitAvatarUpload(db, userId)).resolves.toBe(true)
    expect($queryRaw.mock.calls[0]).toContain(`avatar-upload:${userId}`)

    $queryRaw.mockResolvedValueOnce([{ count: AVATAR_UPLOADS_PER_WINDOW + 1 }])
    await expect(admitAvatarUpload(db, userId)).resolves.toBe(false)
  })

  it('fails closed when the counter gives no answer', async () => {
    const db = { $queryRaw: vi.fn(async () => []) } as unknown as Pick<PrismaClient, '$queryRaw'>
    await expect(admitAvatarUpload(db, randomUUID())).rejects.toThrow('no row')
  })
})

// The statement itself needs PostgreSQL: run with DATABASE_URL of a disposable database.
describe.skipIf(!databaseUrl)('avatar upload limit in PostgreSQL', () => {
  let db: PrismaClient
  const users = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const
  const keys = users.map((id) => `avatar-upload:${id}`)

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.rateLimit.deleteMany({ where: { key: { in: keys } } })
    await db.$disconnect()
  })

  it('admits the limit within a window, refuses the rest and starts over after the window', async () => {
    const [user, other] = users
    const start = 1_800_000_000_000
    for (let attempt = 0; attempt < AVATAR_UPLOADS_PER_WINDOW; attempt += 1)
      expect(await admitAvatarUpload(db, user, start + attempt)).toBe(true)
    expect(await admitAvatarUpload(db, user, start + 1_000)).toBe(false)
    // The window is fixed by its first upload: refused attempts do not extend it.
    expect(await admitAvatarUpload(db, user, start + AVATAR_UPLOAD_WINDOW_MS - 1)).toBe(false)
    expect(await admitAvatarUpload(db, other, start + 1_000)).toBe(true)

    expect(await admitAvatarUpload(db, user, start + AVATAR_UPLOAD_WINDOW_MS)).toBe(true)
    const row = await db.rateLimit.findUniqueOrThrow({ where: { key: keys[0]! } })
    expect(row.count).toBe(1)
    // The row keeps the end of its window, see the next test.
    expect(row.lastRequest).toBe(BigInt(start + 2 * AVATAR_UPLOAD_WINDOW_MS))
  })

  it('keeps its count while better-auth prunes the counters it shares the table with', async () => {
    const user = users[3]
    const start = 1_800_000_000_000
    for (let attempt = 0; attempt < AVATAR_UPLOADS_PER_WINDOW; attempt += 1)
      expect(await admitAvatarUpload(db, user, start + attempt)).toBe(true)

    // Whenever one of its own counters starts a new window, better-auth deletes every row of
    // rate_limits whose last_request is older than its longest window, one minute
    // (better-auth 1.7 api/rate-limiter, deleteExpiredRows).
    const later = start + 2 * 60_000
    await db.$executeRaw`
      DELETE FROM rate_limits
      WHERE key = ${`avatar-upload:${user}`} AND last_request < ${BigInt(later - 60_000)}
    `

    expect(await admitAvatarUpload(db, user, later)).toBe(false)
  })

  it('never admits more than the limit when attempts arrive together', async () => {
    const admitted = await Promise.all(
      Array.from({ length: AVATAR_UPLOADS_PER_WINDOW * 3 }, () =>
        admitAvatarUpload(db, users[2], 1_800_000_000_000),
      ),
    )
    expect(admitted.filter(Boolean)).toHaveLength(AVATAR_UPLOADS_PER_WINDOW)
    // The stored count stops just above the limit, however long the flood lasts.
    const row = await db.rateLimit.findUniqueOrThrow({ where: { key: keys[2]! } })
    expect(row.count).toBe(AVATAR_UPLOADS_PER_WINDOW + 1)
  })
})
