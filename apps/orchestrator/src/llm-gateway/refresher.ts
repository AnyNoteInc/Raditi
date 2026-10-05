import { type Prisma, type PrismaClient } from '@repo/db'
import {
  credentialMetadataSchema,
  type CredentialMetadata,
  type EgressHttp,
  type LlmBackend,
  type SecretStore,
  type SubscriptionCredential,
} from '@repo/domain'

import { subscriptionCredentialPath } from '../llm/turn-key.ts'
import {
  decodeSubscriptionCredential,
  encodeSubscriptionCredential,
  type CredentialContext,
  type MutableCredentialSource,
} from './credentials.ts'
import { EgressNotSentError } from './egress.ts'
import type { SubscriptionLockLease, SubscriptionLocks } from './session-lock.ts'

type Account = Prisma.SubscriptionAccountGetPayload<{
  include: { provider: true; credentialRef: true }
}>
type RefreshReason = 'scheduled' | 'auth'
type RefreshEvent =
  | 'refresh_ambiguous'
  | 'refresh_not_sent'
  | 'vault_write_pending'
  | 'refresh_unpersisted'
  | 'refresh_final'
  | 'refresh_conflict'
  | 'revoke_failed'

/** The account row no longer matches either side of this rotation; retrying cannot help. */
class PersistenceConflict extends Error {
  constructor() {
    super('Subscription database version conflict')
  }
}

export interface SubscriptionRefresherOptions {
  prisma: PrismaClient
  secrets: SecretStore
  credentials: MutableCredentialSource
  backends: readonly LlmBackend[]
  http: EgressHttp
  channelHealthy: () => boolean
  onRegion: (accountId: string) => void
  locks: SubscriptionLocks
  logger?: (event: RefreshEvent) => void
  now?: () => number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const HOUR = 3_600_000
/** A refused revocation is retried after 1, 5 and then every 15 minutes, not every timer tick. */
const revokeBackoffMs = [60_000, 5 * 60_000, 15 * 60_000] as const
const ownReasons = new Set(['refresh_ambiguous', 'vault_write_pending', 'refresh_region'])
// A healthy account's credit warning shares health_reason; refresh state takes priority over it.
const overridableReasons = [...ownReasons, 'credits_balance']
const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })

/** Whether a control request may have reached the provider, and the requests still in flight. */
interface RequestTrace {
  sent: boolean
  inFlight: Set<Promise<void>>
}
const newTrace = (): RequestTrace => ({ sent: false, inFlight: new Set() })
// The adapter has already aborted these requests: a transport settles them at once. One that
// does not within this bound has proved nothing, and its request stays "sent".
const settleMs = 1_000
async function settled(trace: RequestTrace): Promise<void> {
  if (trace.inFlight.size === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(trace.inFlight),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, settleMs))),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Rotation is a single-writer operation; an unknown provider outcome is never retried. */
export class SubscriptionRefresher {
  readonly #options: SubscriptionRefresherOptions
  readonly #controller = new AbortController()
  readonly #pending = new Map<string, Promise<SubscriptionCredential | null>>()
  readonly #deliveries = new Map<string, (credential: SubscriptionCredential | null) => void>()
  readonly #jobs = new Set<Promise<void>>()
  readonly #jitter = new Map<string, number>()
  readonly #revokeBackoff = new Map<string, { failures: number; next: number }>()
  #tail: Promise<void> = Promise.resolve()
  #closed = false
  #ticking: Promise<void> | null = null
  #retiring: Promise<void> | null = null

  constructor(options: SubscriptionRefresherOptions) {
    this.#options = options
  }

  refresh(
    accountId: string,
    reason: RefreshReason,
    observedVersion?: number,
  ): Promise<SubscriptionCredential | null> {
    if (this.#closed) return Promise.resolve(null)
    const pending = this.#pending.get(accountId)
    if (pending) return pending
    let deliver!: (credential: SubscriptionCredential | null) => void
    const result = new Promise<SubscriptionCredential | null>((resolve) => (deliver = resolve))
    this.#pending.set(accountId, result)
    this.#deliveries.set(accountId, deliver)
    const job = this.#enqueue(async () => {
      try {
        await this.#refresh(accountId, reason, observedVersion, deliver)
      } catch {
        // Transport/database errors have no safe printable details.
      } finally {
        deliver(null)
        this.#pending.delete(accountId)
        this.#deliveries.delete(accountId)
      }
    })
    void job.catch(() => undefined)
    return result
  }

  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#ticking) return this.#ticking
    this.#ticking = this.#tick().finally(() => (this.#ticking = null))
    return this.#ticking
  }

  async #tick(): Promise<void> {
    const providers = this.#options.backends
      .filter((backend) => backend.refresh)
      .map((backend) => backend.id)
    for await (const account of this.#accounts({
      enabled: true,
      status: 'active',
      credentialsRevokedAt: null,
      provider: { enabled: true, kind: 'subscription', slug: { in: providers } },
      OR: [
        { health: 'ok' },
        { healthReason: { in: ['refresh_ambiguous', 'vault_write_pending'] } },
      ],
    })) {
      if (this.#closed) break
      const backend = this.#backend(account)
      if (!backend?.refresh || !this.#due(account)) continue
      await this.refresh(account.id, 'scheduled')
      // Do not queue a second account while the first rotation is still being persisted.
      await this.#tail
    }
  }

  retire(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#retiring) return this.#retiring
    this.#retiring = this.#retire().finally(() => (this.#retiring = null))
    return this.#retiring
  }

  async #retire(): Promise<void> {
    if (!this.#options.channelHealthy()) return
    const providers = this.#options.backends
      .filter((backend) => backend.revoke)
      .map((backend) => backend.id)
    for await (const account of this.#accounts({
      enabled: false,
      retireRequestedAt: { not: null },
      credentialsRevokedAt: null,
      provider: { slug: { in: providers } },
    })) {
      if (this.#closed) break
      if (!this.#backend(account)?.revoke) continue
      const backoff = this.#revokeBackoff.get(account.id)
      if (backoff && this.#now() < backoff.next) continue
      // Not behind the rotation queue: a rotation waiting for Vault must not delay revocation.
      await this.#track(async () => {
        const lease = await this.#options.locks.tryAcquire(account.id)
        if (!lease) return
        try {
          const current = await this.#account(account.id)
          if (
            !current ||
            current.enabled ||
            !current.retireRequestedAt ||
            current.credentialsRevokedAt ||
            !this.#options.channelHealthy()
          )
            return
          const backend = this.#backend(current)
          if (!backend?.revoke) return
          const stored = await this.#options.secrets.kvRead(current.credentialRef.vaultPath)
          const credential = decodeSubscriptionCredential(stored, backend)
          await backend.revoke(credential, this.#http(lease))
          // A completed revocation is recorded even after lock loss or during shutdown.
          const now = await this.#databaseNow()
          await this.#transaction(async (tx) => {
            await tx.subscriptionAccount.updateMany({
              where: {
                id: current.id,
                enabled: false,
                retireRequestedAt: { not: null },
                credentialsRevokedAt: null,
              },
              data: { credentialsRevokedAt: now },
            })
          })
          this.#options.credentials.invalidate(current.id)
          this.#revokeBackoff.delete(current.id)
        } catch {
          // A failed revoke stays pending (Kimi remains an explicit operator action). The event
          // is aggregate: no account ID, provider body or token reaches the process log.
          const failures = (this.#revokeBackoff.get(account.id)?.failures ?? 0) + 1
          this.#revokeBackoff.set(account.id, {
            failures,
            next: this.#now() + revokeBackoffMs[Math.min(failures, 3) - 1]!,
          })
          this.#log('revoke_failed')
        } finally {
          await lease.release()
        }
      })
    }
  }

  async #refresh(
    accountId: string,
    reason: RefreshReason,
    observedVersion: number | undefined,
    deliver: (credential: SubscriptionCredential | null) => void,
  ): Promise<void> {
    if (this.#closed) return
    const lease = await this.#options.locks.tryAcquire(accountId)
    if (!lease) return
    try {
      const account = await this.#account(accountId)
      if (
        !account ||
        !account.enabled ||
        account.status !== 'active' ||
        account.credentialsRevokedAt ||
        !account.provider.enabled ||
        account.provider.kind !== 'subscription' ||
        (account.health !== 'ok' && !ownReasons.has(account.healthReason ?? ''))
      )
        return
      const backend = this.#backend(account)
      if (!backend?.refresh) return
      this.#context(account)
      const stored = await this.#options.secrets.kvRead(account.credentialRef.vaultPath)
      const credential = decodeSubscriptionCredential(stored, backend)
      if (!stored || stored.version < account.credentialVersion) return
      const metadata = this.#metadata(backend, credential)
      if (stored.version > account.credentialVersion) {
        // A completed CAS followed by a crash needs only a database repair, never OAuth.
        const context = this.#context(account, stored.version)
        this.#options.credentials.install(context, backend, credential, account.credentialVersion)
        if (!this.#identityFailure(account, metadata)) deliver(credential)
        await this.#persist(account, backend, credential, stored.version, lease, false)
        return
      }
      const identityFailure = this.#identityFailure(account, metadata)
      if (identityFailure) {
        await this.#mark(account.id, {
          health: 'suspended',
          healthReason: identityFailure,
          healthChangedAt: await this.#databaseNow(),
        })
        this.#options.credentials.invalidate(account.id)
        return
      }
      if (reason === 'auth' && observedVersion !== undefined && stored.version > observedVersion) {
        if (!this.#identityFailure(account, metadata)) deliver(credential)
        return
      }
      const unfinished =
        account.refreshStartedAt !== null &&
        (account.refreshFinishedAt === null || account.refreshStartedAt > account.refreshFinishedAt)
      if (unfinished) {
        const expired =
          metadata.accessExpiresAt === null || +metadata.accessExpiresAt <= this.#now()
        await this.#mark(account.id, {
          health:
            reason === 'auth' || expired || account.health === 'needs_relogin'
              ? 'needs_relogin'
              : 'ok',
          healthReason: 'refresh_ambiguous',
          healthChangedAt: await this.#databaseNow(),
        })
        this.#log('refresh_ambiguous')
        return
      }
      if (
        account.health !== 'ok' ||
        this.#identityFailure(account, metadata) ||
        !this.#options.channelHealthy() ||
        (reason === 'scheduled' && !this.#due(account)) ||
        this.#closed ||
        lease.signal?.aborted
      )
        return
      const started = await this.#databaseNow()
      const marked = await this.#transaction(async (tx) =>
        tx.subscriptionAccount.updateMany({
          where: {
            id: account.id,
            enabled: true,
            health: 'ok',
            status: 'active',
            credentialsRevokedAt: null,
            credentialVersion: account.credentialVersion,
          },
          data: { refreshStartedAt: started },
        }),
      )
      if (marked.count !== 1) return
      // Shutdown or a lost lock now only stops a request that has not been sent; an answer
      // that arrives is always recorded, because the provider may have rotated the token.
      const trace = newTrace()
      let outcome: Awaited<ReturnType<NonNullable<LlmBackend['refresh']>>>
      try {
        outcome = await backend.refresh(credential, this.#http(lease, trace))
      } catch {
        outcome = { kind: 'ambiguous' }
      }
      // The adapter's own deadline may answer before the transport has said whether the
      // request left. The verdict is read once the transport has spoken, not by a race.
      if (outcome.kind === 'ambiguous' && trace.sent) await settled(trace)
      if (outcome.kind === 'ambiguous' && !trace.sent) {
        // The refresh token never left this process: it is still the only valid one, retry later.
        await this.#mark(account.id, {
          refreshFinishedAt: await this.#databaseNow(),
          refreshFailures: { increment: 1 },
        })
        this.#log('refresh_not_sent')
        return
      }
      if (outcome.kind === 'ambiguous') {
        const expired =
          metadata.accessExpiresAt === null || +metadata.accessExpiresAt <= this.#now()
        await this.#mark(account.id, {
          health: reason === 'auth' || expired ? 'needs_relogin' : 'ok',
          healthReason: 'refresh_ambiguous',
          refreshFailures: { increment: 1 },
          healthChangedAt: await this.#databaseNow(),
        })
        this.#log('refresh_ambiguous')
        return
      }
      if (outcome.kind === 'final') {
        const finished = await this.#databaseNow()
        if (outcome.reason === 'region') {
          this.#options.onRegion(account.id)
          await this.#mark(account.id, {
            refreshFinishedAt: finished,
            refreshFailures: { increment: 1 },
            healthReason: 'refresh_region',
            coolingUntil: new Date(+finished + 10 * 60_000),
          })
        } else {
          await this.#mark(account.id, {
            refreshFinishedAt: finished,
            refreshFailures: { increment: 1 },
            health: 'needs_relogin',
            healthReason: 'refresh_auth',
            healthChangedAt: finished,
          })
          this.#options.credentials.invalidate(account.id)
        }
        this.#log('refresh_final')
        return
      }
      const nextMetadata = this.#metadata(backend, outcome.credential)
      const context = this.#context(account, stored.version + 1)
      this.#options.credentials.install(context, backend, outcome.credential, stored.version)
      if (!this.#identityFailure(account, nextMetadata)) deliver(outcome.credential)
      else {
        try {
          await this.#mark(account.id, {
            health: 'suspended',
            healthReason: this.#identityFailure(account, nextMetadata),
            healthChangedAt: await this.#databaseNow(),
          })
        } catch {
          // CAS persistence must continue even while the database cannot record the suspension.
        }
      }
      await this.#persist(account, backend, outcome.credential, stored.version + 1, lease, true)
    } finally {
      await lease.release()
    }
  }

  async #persist(
    account: Account,
    backend: LlmBackend,
    credential: SubscriptionCredential,
    version: number,
    lease: SubscriptionLockLease,
    writeVault: boolean,
  ): Promise<void> {
    const context = this.#context(account, version)
    const metadata = this.#metadata(backend, credential)
    const envelope = encodeSubscriptionCredential(credential)
    const refreshed = new Date(this.#now())
    const started = this.#now()
    let persisted = !writeVault
    let delay = 1_000
    let alerted = false
    // A lost session lock does not stop this loop: Vault CAS and the version checks below
    // reject a competing writer, while giving up would discard the only valid refresh token.
    while (true) {
      try {
        if (!persisted) {
          try {
            const written = await this.#options.secrets.kvWrite(context.credentialRef, envelope, {
              cas: version - 1,
            })
            if (written.version !== version) throw new Error('Subscription CAS conflict')
            persisted = true
          } catch {
            // The response may be lost after CAS committed. Compare the exact canonical value.
            const actual = await this.#options.secrets.kvRead(context.credentialRef)
            if (actual && actual.version >= version) {
              if (
                actual.version !== version ||
                Object.keys(actual.data).length !== 1 ||
                actual.data.credential !== envelope.credential
              ) {
                const now = await this.#databaseNow()
                await this.#transaction(async (tx) => {
                  // A login that already committed the newer credential keeps its health.
                  await tx.subscriptionAccount.updateMany({
                    where: {
                      id: account.id,
                      credentialVersion: account.credentialVersion,
                      OR: [
                        { healthReason: null },
                        { healthReason: { notIn: ['import_pending', 'relogin_pending'] } },
                      ],
                    },
                    data: {
                      health: 'needs_relogin',
                      healthReason: 'refresh_conflict',
                      healthChangedAt: now,
                    },
                  })
                })
                this.#options.credentials.invalidate(account.id)
                this.#log('refresh_conflict')
                return
              }
              persisted = true
            } else throw new Error('Subscription persistence unavailable')
          }
        }
        const finished = await this.#databaseNow()
        await this.#transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${account.id}::uuid FOR UPDATE`
          const current = await tx.subscriptionAccount.findUnique({ where: { id: account.id } })
          if (
            !current ||
            (current.credentialVersion !== account.credentialVersion &&
              current.credentialVersion !== version)
          )
            throw new PersistenceConflict()
          const failure = this.#identityFailure(account, metadata)
          await tx.subscriptionAccount.update({
            where: { id: account.id },
            data: {
              credentialVersion: version,
              credentialExpiresAt: metadata.accessExpiresAt,
              credentialRefreshedAt: refreshed,
              refreshFinishedAt: finished,
              refreshFailures: 0,
              ...(failure
                ? { health: 'suspended', healthReason: failure, healthChangedAt: finished }
                : (current.health === 'ok' && ownReasons.has(current.healthReason ?? '')) ||
                    (current.health === 'needs_relogin' &&
                      current.healthReason === 'refresh_ambiguous')
                  ? { health: 'ok', healthReason: null, healthChangedAt: finished }
                  : {}),
            },
          })
          await tx.credentialRef.update({
            where: { id: account.credentialRefId },
            data: { keyVersion: version },
          })
        })
        this.#options.credentials.commit(context)
        return
      } catch (error) {
        if (error instanceof PersistenceConflict) {
          // A newer login replaced (or an operator removed) the account: this rotation is moot.
          this.#options.credentials.invalidate(account.id)
          this.#log('refresh_conflict')
          return
        }
        if (this.#closed) {
          // Shutdown after at least one attempt; the next start records the ambiguity.
          this.#log('refresh_unpersisted')
          return
        }
        if (!alerted && this.#now() - started >= 120_000) {
          alerted = true
          this.#log('vault_write_pending')
          try {
            await this.#transaction(async (tx) => {
              await tx.subscriptionAccount.updateMany({
                where: {
                  id: account.id,
                  health: 'ok',
                  OR: [{ healthReason: null }, { healthReason: { in: overridableReasons } }],
                },
                data: { healthReason: 'vault_write_pending' },
              })
            })
          } catch {
            // Keep the in-memory rotation and the session lock while persistence recovers.
          }
        }
        await (this.#options.sleep ?? sleep)(delay, this.#controller.signal)
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  #due(account: Account): boolean {
    const now = this.#now()
    if (
      account.refreshStartedAt &&
      (!account.refreshFinishedAt || account.refreshStartedAt > account.refreshFinishedAt)
    )
      return true // Recovery runs even when a regular rotation is not due.
    if (account.healthReason === 'vault_write_pending') return true
    if (account.healthReason === 'refresh_region')
      return account.refreshFinishedAt !== null && now >= +account.refreshFinishedAt + 600_000
    const refreshed = account.credentialRefreshedAt
    if (refreshed && now - +refreshed < 6 * HOUR) return false
    let jitter = this.#jitter.get(account.id)
    if (jitter === undefined) {
      const random = (this.#options.random ?? Math.random)()
      jitter = (Math.max(0, Math.min(1, random)) * 2 - 1) * 30 * 60_000
      this.#jitter.set(account.id, jitter)
    }
    if (!refreshed || now - +refreshed >= 8 * 24 * HOUR + jitter) return true
    const expires = account.credentialExpiresAt
    if (!expires) return false
    const life = +expires - +refreshed
    return +expires - now <= Math.max(0, Math.min(48 * HOUR, life / 2) + jitter)
  }

  #backend(account: Account): LlmBackend | undefined {
    return this.#options.backends.find((backend) => backend.id === account.provider.slug)
  }

  async *#accounts(
    where: Omit<Prisma.SubscriptionAccountWhereInput, 'id'>,
  ): AsyncGenerator<Account> {
    let after: string | undefined
    while (!this.#closed) {
      const page = await this.#transaction((tx) =>
        tx.subscriptionAccount.findMany({
          where: { ...where, ...(after ? { id: { gt: after } } : {}) },
          orderBy: { id: 'asc' },
          take: 100,
          include: { provider: true, credentialRef: true },
        }),
      )
      const last = page.at(-1)
      if (!last) return
      // ids stay stable when refresh metadata/status changes, or the cursor row is deleted.
      after = last.id
      yield* page
      if (page.length < 100) return
    }
  }

  #metadata(backend: LlmBackend, credential: SubscriptionCredential): CredentialMetadata {
    return credentialMetadataSchema.parse(backend.credentialMetadata(credential))
  }

  #identityFailure(account: Account, metadata: CredentialMetadata): string | null {
    if (metadata.externalAccountId !== account.externalAccountId) return 'external_account_changed'
    if (metadata.plan !== account.plan) return 'plan_changed'
    return null
  }

  #context(account: Account, version = account.credentialVersion): CredentialContext {
    const backend = this.#backend(account)
    if (
      !backend ||
      account.credentialRef.vaultPath !== subscriptionCredentialPath(backend.id, account.id)
    )
      throw new Error('Subscription credential unavailable')
    return {
      accountId: account.id,
      credentialRef: account.credentialRef.vaultPath,
      credentialVersion: version,
    }
  }

  async #account(id: string): Promise<Account | null> {
    return this.#transaction((tx) =>
      tx.subscriptionAccount.findUnique({
        where: { id },
        include: { provider: true, credentialRef: true },
      }),
    )
  }

  async #databaseNow(): Promise<Date> {
    const rows = await this.#transaction(
      (tx) => tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`,
    )
    if (!rows[0]) throw new Error('Subscription database unavailable')
    return rows[0].now
  }

  async #transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.#options.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
        return operation(tx)
      },
      { maxWait: 5_000, timeout: 8_000 },
    )
  }

  async #mark(id: string, data: Prisma.SubscriptionAccountUpdateManyMutationInput): Promise<void> {
    await this.#transaction(async (tx) => {
      const reason = data.healthReason
      if (typeof reason !== 'string' || (!ownReasons.has(reason) && reason !== 'refresh_auth')) {
        await tx.subscriptionAccount.updateMany({ where: { id }, data })
        return
      }
      const { health, healthReason, healthChangedAt, coolingUntil, ...progress } = data
      // A refresh records its progress even if a simultaneous risk probe suspended the account.
      if (Object.keys(progress).length)
        await tx.subscriptionAccount.updateMany({ where: { id }, data: progress })
      // Cooling is only ever extended; an exhausted window may already hold it for days.
      if (coolingUntil instanceof Date)
        await tx.subscriptionAccount.updateMany({
          where: { id, OR: [{ coolingUntil: null }, { coolingUntil: { lt: coolingUntil } }] },
          data: { coolingUntil },
        })
      await tx.subscriptionAccount.updateMany({
        where: {
          id,
          health: { in: ['ok', 'needs_relogin'] },
          OR: [{ healthReason: null }, { healthReason: { in: overridableReasons } }],
        },
        data: {
          healthReason,
          ...(health === undefined ? {} : { health }),
          ...(healthChangedAt === undefined ? {} : { healthChangedAt }),
        },
      })
    })
  }

  /**
   * `trace.sent` is true from the moment a request is handed to the transport until the
   * transport proves it never left: the adapter's own deadline may answer while the transport
   * is still unsettled, and a request in flight may have reached the provider. A request in
   * flight is bounded only by its 20 s timeout: aborting it on shutdown or lock loss would turn
   * a rotation the provider may already have made into a lost refresh token.
   */
  #http(lease: SubscriptionLockLease, trace: RequestTrace = newTrace()): EgressHttp {
    return {
      request: async (request, options) => {
        // Checked synchronously with the transport gate, so a refusal there is never "sent".
        if (this.#closed || lease.signal?.aborted || !this.#options.channelHealthy())
          throw new EgressNotSentError()
        const before = trace.sent
        trace.sent = true
        const flight = Promise.withResolvers<void>()
        trace.inFlight.add(flight.promise)
        try {
          return await this.#options.http.request(request, {
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
          })
        } catch (error) {
          if (error instanceof EgressNotSentError) trace.sent = before
          throw error
        } finally {
          trace.inFlight.delete(flight.promise)
          flight.resolve()
        }
      },
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const job = this.#tail.then(async () => {
      if (!this.#closed) await operation()
    })
    this.#tail = job.catch(() => undefined)
    return this.#track(() => job)
  }

  /** Every job is awaited by close(), whether or not it runs behind the rotation queue. */
  #track(operation: () => Promise<void>): Promise<void> {
    const job = operation()
    this.#jobs.add(job)
    void job.finally(() => this.#jobs.delete(job)).catch(() => undefined)
    return job
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  #log(event: RefreshEvent): void {
    this.#options.logger?.(event)
  }

  /**
   * Stops new work and wakes persistence back-off. An OAuth request already in flight may finish
   * (20 s bound) and its result gets at least one Vault write before the locks are released.
   */
  async close(): Promise<void> {
    this.#closed = true
    this.#controller.abort()
    for (const deliver of this.#deliveries.values()) deliver(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.#jobs]),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, 25_000))),
      ])
    } finally {
      clearTimeout(timer)
      this.#pending.clear()
      await this.#options.locks.close()
    }
  }
}
