import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionSubscriptionLock } from './session-lock.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

/**
 * The lock of an account on a real PostgreSQL. The unit test holds the same rules on a stand-in
 * client; only a server shows that a destroyed connection gives the lock back.
 */
describe.skipIf(!enabled)('subscription session lock on independent PostgreSQL sessions', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
  })

  /** A lock over its own pool: another process, as far as PostgreSQL can tell. */
  function independent(max: number) {
    const pool = new Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 3_000 })
    const locks = new SessionSubscriptionLock(pool)
    cleanup.push(async () => {
      await locks.close()
      await pool.end()
    })
    return locks
  }

  it('holds two leases on different accounts at the same time', async () => {
    const locks = new SessionSubscriptionLock(databaseUrl ?? '')
    cleanup.push(() => locks.close())
    const first = await locks.tryAcquire(randomUUID())
    const second = await locks.tryAcquire(randomUUID())
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    await second!.release()
    await first!.release()
  })

  it('refuses a second session while the lock is held and gives it the lock after release', async () => {
    const accountId = randomUUID()
    const holder = independent(1)
    const contender = independent(1)
    const held = await holder.tryAcquire(accountId)
    expect(held).not.toBeNull()
    expect(await contender.tryAcquire(accountId)).toBeNull()
    await held!.release()
    const lease = await contender.tryAcquire(accountId)
    expect(lease).not.toBeNull()
    await lease!.release()
  })

  it('releases the server-side advisory lock when its connection is destroyed', async () => {
    const accountId = randomUUID()
    const holder = independent(2)
    const first = await holder.tryAcquire(accountId)
    expect(first).not.toBeNull()
    const other = independent(1)
    expect(await other.tryAcquire(accountId)).toBeNull()
    await holder.close()
    const recovered = { lease: null as Awaited<ReturnType<typeof other.tryAcquire>> }
    // Destroying the client socket precedes PostgreSQL observing its disconnect.
    await expect
      .poll(
        async () => {
          recovered.lease ??= await other.tryAcquire(accountId)
          return recovered.lease !== null
        },
        { timeout: 2000, interval: 20 },
      )
      .toBe(true)
    await recovered.lease!.release()
  })
})
