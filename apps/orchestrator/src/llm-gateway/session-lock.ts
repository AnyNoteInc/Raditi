import { Pool, type PoolClient } from 'pg'

export interface SubscriptionLockLease {
  readonly signal?: AbortSignal
  release(): Promise<void>
}

export interface SubscriptionLocks {
  tryAcquire(accountId: string): Promise<SubscriptionLockLease | null>
  close(): Promise<void>
}

/** A session lock survives the committed refresh marker and the OAuth request. */
export class SessionSubscriptionLock implements SubscriptionLocks {
  readonly #pool: Pool
  readonly #owned: boolean
  readonly #leases = new Map<PoolClient, () => Promise<void>>()
  #closed = false

  constructor(databaseUrlOrPool: string | Pool) {
    this.#owned = typeof databaseUrlOrPool === 'string'
    this.#pool =
      typeof databaseUrlOrPool === 'string'
        ? new Pool({
            connectionString: databaseUrlOrPool,
            // One lease for the serial rotation queue and one for retirement revocation, so a
            // rotation still writing Vault cannot block revoking another account.
            max: 2,
            connectionTimeoutMillis: 5_000,
            statement_timeout: 5_000,
            query_timeout: 6_000,
          })
        : databaseUrlOrPool
    // Idle connection errors have no credential data and are handled by the next acquisition.
    this.#pool.on('error', this.#idleError)
  }

  readonly #idleError = () => undefined

  async tryAcquire(accountId: string): Promise<SubscriptionLockLease | null> {
    if (this.#closed) return null
    const client = await this.#pool.connect()
    if (this.#closed) {
      client.release()
      return null
    }
    const controller = new AbortController()
    const onError = () => controller.abort()
    client.on('error', onError)
    let released = false
    const release = async () => {
      if (released) return
      released = true
      this.#leases.delete(client)
      let destroy = controller.signal.aborted || this.#closed
      try {
        if (!destroy)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('sub-refresh:' || $1, 0))",
            [accountId],
          )
      } catch {
        destroy = true
      } finally {
        client.removeListener('error', onError)
        client.release(destroy)
      }
    }
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('sub-refresh:' || $1, 0)) AS acquired",
        [accountId],
      )
      if (this.#closed || controller.signal.aborted) {
        client.removeListener('error', onError)
        client.release(true)
        return null
      }
      if (!result.rows[0]?.acquired) {
        client.removeListener('error', onError)
        client.release()
        return null
      }
      this.#leases.set(client, async () => {
        controller.abort()
        await release()
      })
      return { signal: controller.signal, release }
    } catch {
      client.removeListener('error', onError)
      client.release(true)
      throw new Error('Subscription refresh lock unavailable')
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#leases.values()].map((release) => release()))
    this.#pool.removeListener('error', this.#idleError)
    if (this.#owned) await this.#pool.end()
  }
}
