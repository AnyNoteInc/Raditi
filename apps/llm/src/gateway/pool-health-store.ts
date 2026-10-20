import type { Prisma, PrismaClient } from '@repo/db'
import {
  limitResetPlausible,
  llmBackendIdSchema,
  probeResultSchema,
  type LimitWindow,
  type LlmBackendId,
  type ProbeResult,
} from '@repo/domain'

import { decodeLimitWindows, limitWindowColumns, resetsPlausible } from '@repo/turn-keys'

type Database = Pick<PrismaClient, '$transaction'>
type Transaction = Prisma.TransactionClient

export interface PoolHealthAccount {
  accountId: string
  backendId: LlmBackendId
  credentialRef: string
  credentialVersion: number
  limitsSeenAt: Date | null
  /** Whether the snapshot held readable, non-empty windows: what an overtaken probe may not restore. */
  windowsKnown: boolean
}

export interface PoolHealthUpdate {
  applied: boolean
  alert: 'auth_confirmed' | 'risk_confirmed' | 'plan_changed' | null
  /** The account's limits_seen_at as an applied probe left it: a later one is a newer state. */
  limitsSeenAt?: Date | null
}

/** The snapshot fences a control response against a replaced credential and newer usage. */
export interface PoolHealthStore {
  account(accountId: string): Promise<PoolHealthAccount | null>
  probe(account: PoolHealthAccount, result: ProbeResult): Promise<PoolHealthUpdate>
  /**
   * Pauses the account until the reset of an exhausted window, or for an hour when no usable
   * reset is known. `window` is the one the reset belongs to; a reset a signal names has none.
   */
  cool(accountId: string, until: Date | null, window?: LimitWindow['name']): Promise<void>
  /** `count` is the number of payment checks today; `at` is the database clock of this one. */
  payment(accountId: string): Promise<{ count: number; suspended: boolean; at: Date }>
  /**
   * The provider said the account's balance is spent: a durable pause, longer with each such
   * check of the last day. `count` is that number of checks; `pausedUntil` is the end of the
   * pause this call began, null when one was already holding the account.
   */
  balance(accountId: string): Promise<{ count: number; pausedUntil: Date | null }>
}

/** Pauses after the first, second and third payment check (p3-design §2.4 signal table). */
export const paymentPauseMs = [5 * 60_000, 15 * 60_000, 45 * 60_000] as const
/**
 * Pauses after the first, second, third and every later check that found the balance spent.
 * Durable (cooling_until), so core's selection sees them too; a top-up is visible to nobody
 * but the next call after the pause, which then simply succeeds.
 */
export const balancePauseMs = [5 * 60_000, 15 * 60_000, 45 * 60_000, 60 * 60_000] as const
const dayMs = 24 * 60 * 60_000

/**
 * A probe overtaken by a newer snapshot may increase consumption but cannot replenish capacity:
 * windows cleared after it was sent stay unknown until a later probe. Windows already unknown
 * when it was sent are the reason it was asked for; a late response in between restores
 * nothing, so the probe's windows apply.
 */
function mergeConcurrentWindows(
  current: unknown,
  incoming: readonly LimitWindow[],
  knownAtProbe: boolean,
): LimitWindow[] {
  const known = decodeLimitWindows(current)
  if (known === null || known.length === 0) return knownAtProbe ? [] : [...incoming]
  const merged = new Map(known.map((window) => [window.name, window]))
  for (const next of incoming) {
    const previous = merged.get(next.name)
    if (!previous) {
      merged.set(next.name, next)
      continue
    }
    if (previous.resetsAt && next.resetsAt && next.resetsAt < previous.resetsAt) continue
    // A different period might have started since the probe was sent. Keep the newer snapshot.
    if (previous.resetsAt && next.resetsAt && next.resetsAt > previous.resetsAt) continue
    merged.set(next.name, {
      ...next,
      usedPct: Math.max(previous.usedPct, next.usedPct),
      resetsAt: previous.resetsAt ?? next.resetsAt,
    })
  }
  return [...merged.values()]
}

/** Small, bounded transactions; no subscription secret or network operation enters SQL. */
export class PostgresPoolHealthStore implements PoolHealthStore {
  constructor(private readonly prisma: Database) {}

  #transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true),
          set_config('statement_timeout', '5000ms', true)`
        return operation(tx)
      },
      { maxWait: 1_000, timeout: 8_000 },
    )
  }

  account(accountId: string): Promise<PoolHealthAccount | null> {
    return this.#transaction(async (tx) => {
      const account = await tx.subscriptionAccount.findUnique({
        where: { id: accountId },
        include: { provider: true, credentialRef: true },
      })
      if (!account || account.credentialsRevokedAt !== null) return null
      const backend = llmBackendIdSchema.safeParse(account.provider.slug)
      if (!backend.success || account.credentialVersion < 1) return null
      return {
        accountId,
        backendId: backend.data,
        credentialRef: account.credentialRef.vaultPath,
        credentialVersion: account.credentialVersion,
        limitsSeenAt: account.limitsSeenAt,
        windowsKnown: (decodeLimitWindows(account.limitWindows)?.length ?? 0) > 0,
      }
    })
  }

  probe(snapshot: PoolHealthAccount, value: ProbeResult): Promise<PoolHealthUpdate> {
    const result = probeResultSchema.parse(value)
    return this.#transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscription_accounts
        WHERE id = ${snapshot.accountId}::uuid FOR UPDATE`
      const account = await tx.subscriptionAccount.findUnique({ where: { id: snapshot.accountId } })
      if (
        !account ||
        account.credentialVersion !== snapshot.credentialVersion ||
        account.credentialsRevokedAt !== null
      )
        return { applied: false, alert: null }
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      const data: Prisma.SubscriptionAccountUpdateInput = {}
      let limitsSeenAt = account.limitsSeenAt
      const sameSnapshot = account.limitsSeenAt?.getTime() === snapshot.limitsSeenAt?.getTime()
      let alert: PoolHealthUpdate['alert'] = null
      if (result.status === 'ok' || result.status === 'unknown') {
        const windows =
          result.status === 'unknown' ||
          result.windows === null ||
          !resetsPlausible(result.windows, now)
            ? sameSnapshot
              ? []
              : null
            : sameSnapshot
              ? result.windows
              : mergeConcurrentWindows(account.limitWindows, result.windows, snapshot.windowsKnown)
        if (windows !== null) {
          Object.assign(data, limitWindowColumns(windows, now))
          limitsSeenAt = now
          const exhausted = windows.filter((window) => window.usedPct >= 100)
          if (exhausted.length > 0) {
            const reset = exhausted.map((window) => window.resetsAt?.getTime() ?? 0)
            const until = new Date(
              Math.max(now.getTime(), ...reset) + (reset.includes(0) ? 60 * 60_000 : 60_000),
            )
            if (account.coolingUntil === null || account.coolingUntil < until)
              data.coolingUntil = until
          } else if (
            windows.length > 0 &&
            account.coolingUntil !== null &&
            account.coolingUntil <= now
          )
            data.coolingUntil = null
        }
      }
      if (result.status === 'ok') {
        if (result.plan !== null && result.plan !== account.plan && account.health === 'ok') {
          data.health = 'suspended'
          data.healthReason = 'plan_changed'
          data.healthChangedAt = now
          alert = 'plan_changed'
        }
      } else if (
        (result.status === 'auth' || result.status === 'suspended') &&
        account.health === 'ok'
      ) {
        data.health = result.status === 'auth' ? 'needs_relogin' : 'suspended'
        data.healthReason = result.status === 'auth' ? 'auth_confirmed' : 'risk_confirmed'
        data.healthChangedAt = now
        alert = result.status === 'auth' ? 'auth_confirmed' : 'risk_confirmed'
      }
      if (Object.keys(data).length > 0)
        await tx.subscriptionAccount.update({ where: { id: snapshot.accountId }, data })
      return { applied: true, alert, limitsSeenAt }
    })
  }

  cool(accountId: string, until: Date | null, window?: LimitWindow['name']): Promise<void> {
    return this.#transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
      const account = await tx.subscriptionAccount.findUnique({ where: { id: accountId } })
      if (!account) return
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      // The adapters' bound, checked again before the write: a reset further ahead than its
      // window is long (the weekly horizon when no window is named) is no reset.
      const target =
        until && until > now && limitResetPlausible(until, now, window)
          ? new Date(until.getTime() + 60_000)
          : new Date(now.getTime() + 60 * 60_000)
      if (account.coolingUntil === null || account.coolingUntil < target)
        await tx.subscriptionAccount.update({
          where: { id: accountId },
          data: { coolingUntil: target },
        })
    })
  }

  payment(accountId: string): Promise<{ count: number; suspended: boolean; at: Date }> {
    return this.#transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      const account = await tx.subscriptionAccount.findUnique({ where: { id: accountId } })
      if (!account) return { count: 0, suspended: false, at: now }
      const failures = await tx.llmCall.findMany({
        where: {
          subscriptionAccountId: accountId,
          upstreamStatus: 402,
          state: { not: 'open' },
          finishedAt: { gte: new Date(now.getTime() - dayMs) },
        },
        select: { finishedAt: true },
        orderBy: { finishedAt: 'asc' },
        take: 1_000,
      })
      const count = checks(failures, paymentPauseMs)
      const suspended = count >= 3 && account.health === 'ok'
      if (suspended)
        await tx.subscriptionAccount.update({
          where: { id: accountId },
          data: { health: 'suspended', healthReason: 'payment_pending', healthChangedAt: now },
        })
      return { count, suspended, at: now }
    })
  }

  balance(accountId: string): Promise<{ count: number; pausedUntil: Date | null }> {
    return this.#transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      const account = await tx.subscriptionAccount.findUnique({ where: { id: accountId } })
      if (!account) return { count: 0, pausedUntil: null }
      // llm_calls.signal keeps the kind of every closed call: no table of its own is needed.
      const failures = await tx.llmCall.findMany({
        where: {
          subscriptionAccountId: accountId,
          signal: 'balance_exhausted',
          state: { not: 'open' },
          finishedAt: { gte: new Date(now.getTime() - dayMs) },
        },
        select: { finishedAt: true },
        orderBy: { finishedAt: 'asc' },
        take: 1_000,
      })
      const count = checks(failures, balancePauseMs)
      // A call admitted before the pause began and answered within it is the same check.
      if (account.coolingUntil !== null && account.coolingUntil > now)
        return { count, pausedUntil: null }
      const pausedUntil = new Date(
        now.getTime() + balancePauseMs[Math.min(Math.max(count, 1), balancePauseMs.length) - 1]!,
      )
      await tx.subscriptionAccount.update({
        where: { id: accountId },
        data: { coolingUntil: pausedUntil },
      })
      return { count, pausedUntil }
    })
  }
}

/**
 * Failed checks among the refusals of one kind, oldest first: requests answered together, or
 * within the pause the first of them began, are one check, not several.
 */
function checks(failures: { finishedAt: Date | null }[], pauses: readonly number[]): number {
  let count = 0
  let nextCheck = -Infinity
  for (const { finishedAt } of failures) {
    if (!finishedAt || finishedAt.getTime() < nextCheck) continue
    count += 1
    nextCheck = finishedAt.getTime() + pauses[Math.min(count, pauses.length) - 1]!
  }
  return count
}
