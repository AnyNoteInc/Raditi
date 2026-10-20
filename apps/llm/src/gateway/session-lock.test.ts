import { EventEmitter } from 'node:events'

import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { SessionSubscriptionLock } from './session-lock.ts'

function fixture(acquired = true) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ acquired }] }),
    release: vi.fn(),
  })
  const pool = Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
  })
  return { client, pool, locks: new SessionSubscriptionLock(pool as unknown as Pool) }
}

describe('dedicated PostgreSQL subscription session lock', () => {
  it('holds the session connection until explicit unlock and makes release idempotent', async () => {
    const f = fixture()
    const lease = await f.locks.tryAcquire('synthetic-account')
    expect(f.client.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock(hashtextextended('sub-refresh:' || $1, 0)) AS acquired",
      ['synthetic-account'],
    )
    expect(f.client.release).not.toHaveBeenCalled()
    await lease!.release()
    await lease!.release()
    expect(f.client.query).toHaveBeenCalledTimes(2)
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false)
    await f.locks.close()
    expect(f.pool.end).not.toHaveBeenCalled()
  })

  it('returns a failed acquisition to the pool without trying to unlock another owner', async () => {
    const f = fixture(false)
    expect(await f.locks.tryAcquire('synthetic-account')).toBeNull()
    expect(f.client.query).toHaveBeenCalledTimes(1)
    expect(f.client.release).toHaveBeenCalledTimes(1)
    await f.locks.close()
  })

  it('destroys the connection when unlock fails instead of pooling a locked session', async () => {
    const f = fixture()
    const lease = await f.locks.tryAcquire('synthetic-account')
    f.client.query.mockRejectedValue(new Error('synthetic database failure'))
    await lease!.release()
    expect(f.client.release).toHaveBeenCalledWith(true)
    await f.locks.close()
  })

  it('aborts the provider operation when the locked PostgreSQL session is lost', async () => {
    const f = fixture()
    const lease = await f.locks.tryAcquire('synthetic-account')
    f.client.emit('error', new Error('synthetic disconnect'))
    expect(lease!.signal!.aborted).toBe(true)
    await lease!.release()
    expect(f.client.release).toHaveBeenCalledWith(true)
    await f.locks.close()
  })

  it('aborts and destroys leased sessions on close and rejects further acquisitions', async () => {
    const f = fixture()
    const lease = await f.locks.tryAcquire('synthetic-account')
    await f.locks.close()
    expect(lease!.signal!.aborted).toBe(true)
    expect(f.client.release).toHaveBeenCalledWith(true)
    expect(await f.locks.tryAcquire('synthetic-account')).toBeNull()
  })

  it('destroys a lock acquired concurrently with close', async () => {
    const f = fixture()
    let finish!: (value: { rows: { acquired: boolean }[] }) => void
    f.client.query.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const acquiring = f.locks.tryAcquire('synthetic-account')
    await Promise.resolve()
    await f.locks.close()
    finish({ rows: [{ acquired: true }] })
    expect(await acquiring).toBeNull()
    expect(f.client.release).toHaveBeenCalledWith(true)
  })
})
