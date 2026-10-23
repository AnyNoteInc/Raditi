import type { PrismaClient } from '@repo/db'
import {
  probeResultSchema,
  type CallSignal,
  type EgressHttp,
  type GatewayRefusal,
  type LimitWindow,
  type LlmBackend,
  type ProbeResult,
} from '@repo/domain'
import type { GatewayFinish } from '@repo/turn-keys'

import type { GatewayCall } from '../accounting/gateway-types.ts'
import type { CredentialSource } from './credentials.ts'
import {
  paymentPauseMs,
  PostgresPoolHealthStore,
  type PoolHealthStore,
} from './pool-health-store.ts'

const probeIntervalMs = 5 * 60_000
// A turn held for unknown windows retries every 30 s: a probe that left them unknown, or
// brought no answer, is repeated for it this soon instead of after the whole interval.
const unknownWindowsProbeMs = 20_000
const transientDelays = [30_000, 60_000, 120_000] as const
const unknownProbe = (): ProbeResult => ({ status: 'unknown', windows: null, plan: null })

/** The exhausted window that resets last, when one has a known reset. */
function lastExhausted(
  windows: readonly LimitWindow[],
): { name: LimitWindow['name']; resetsAt: Date } | undefined {
  let binding: { name: LimitWindow['name']; resetsAt: Date } | undefined
  for (const { name, usedPct, resetsAt } of windows)
    if (usedPct >= 100 && resetsAt !== null && !(binding && binding.resetsAt >= resetsAt))
      binding = { name, resetsAt }
  return binding
}

/** Why a probe is asked for now: the caller read the account's windows as unknown. */
export interface UnknownWindows {
  /** limits_seen_at of the snapshot the caller read, when it has one. */
  limitsSeenAt?: Date | null
  /** A response has just cleared the windows: no probe answered before it says anything. */
  cleared?: true
}

/** A request signal waits for its confirmation, a snapshot has grown old, or windows are unknown. */
type ProbeReason = 'signal' | 'refresh' | UnknownWindows

interface ProbeMemo {
  at: number
  promise: Promise<ProbeResult | null>
  settled: boolean
  /** Sent to confirm a request signal; any other probe was sent for the account's windows. */
  confirming: boolean
  /** limits_seen_at as the applied probe left it; undefined while in flight or not applied. */
  limitsSeenAt?: number | null
}

export interface SubscriptionPoolHealthOptions {
  prisma: Pick<PrismaClient, '$transaction'>
  backends: readonly LlmBackend[]
  credentials: CredentialSource
  http: EgressHttp
  /** Gated by the channel alone: the one account probe that may lift a region block. */
  regionHttp?: EgressHttp
  channelHealthy: () => boolean
  onRegion: (accountId: string) => void
  logger?: { warn(message: string): void }
  /** In-memory clock only; durable facts and decisions use PostgreSQL's clock. */
  now?: () => number
  store?: PoolHealthStore
}

/** Request signals request independent confirmation; they never directly remove an account. */
export class SubscriptionPoolHealth {
  readonly #store: PoolHealthStore
  readonly #backends: ReadonlyMap<string, LlmBackend>
  readonly #now: () => number
  readonly #pauses = new Map<
    string,
    {
      until: number
      transientStreak: number
      seenAt: number
      /** Database clock of the latest 402; only a call admitted later proves payment again. */
      paymentAt?: number
    }
  >()
  readonly #probes = new Map<string, ProbeMemo>()
  /** The last confirming probe of an account: a later probe for its windows does not replace it. */
  readonly #confirmed = new Map<string, ProbeMemo>()
  readonly #observed = new Map<string, number>()
  readonly #shutdown = new AbortController()
  #closing = false

  constructor(private readonly options: SubscriptionPoolHealthOptions) {
    this.#store = options.store ?? new PostgresPoolHealthStore(options.prisma)
    this.#backends = new Map(options.backends.map((backend) => [backend.id, backend]))
    this.#now = options.now ?? Date.now
  }

  pause(accountId: string): { reason: GatewayRefusal; retryAfterMs?: number } | null {
    const paused = this.#pauses.get(accountId)
    const now = this.#now()
    if (!paused || paused.until <= now) return null
    return { reason: 'transient', retryAfterMs: Math.min(30_000, paused.until - now) }
  }

  #alert(reason: string, details: Record<string, number> = {}): void {
    // Account details live in SQL; neither IDs nor provider bodies enter process logs.
    this.options.logger?.warn(JSON.stringify({ event: 'llm_pool_health', reason, ...details }))
  }

  async observe(call: GatewayCall, finish: GatewayFinish): Promise<void> {
    if (this.#closing || this.#observed.has(call.id)) return
    this.#observed.set(call.id, this.#now())
    while (this.#observed.size > 10_000) this.#observed.delete(this.#observed.keys().next().value!)
    try {
      const signal = finish.signal
      if (signal?.kind === 'transient') await this.#pauseTransient(call.accountId, finish)
      else if (finish.state === 'completed' && !finish.estimated) this.#liftPause(call)
      if (signal) await this.#confirmSignal(call.accountId, signal)
    } catch {
      this.#alert('health_update_failed')
    }
  }

  async #pauseTransient(accountId: string, finish: GatewayFinish): Promise<void> {
    const current = this.#pauses.get(accountId)
    if (finish.upstreamStatus === 402) {
      const payment = await this.#store.payment(accountId)
      const delay = paymentPauseMs[Math.min(Math.max(payment.count, 1), 3) - 1]!
      this.#pauses.set(accountId, {
        until: Math.max(current?.until ?? 0, this.#now() + delay),
        transientStreak: current?.transientStreak ?? 0,
        seenAt: this.#now(),
        paymentAt: Math.max(current?.paymentAt ?? 0, payment.at.getTime()),
      })
      if (payment.suspended) this.#alert('payment_pending')
      return
    }
    const streak = Math.min((current?.transientStreak ?? 0) + 1, 3)
    this.#pauses.set(accountId, {
      ...current,
      until: Math.max(current?.until ?? 0, this.#now() + transientDelays[streak - 1]!),
      transientStreak: streak,
      seenAt: this.#now(),
    })
  }

  #liftPause(call: GatewayCall): void {
    const paused = this.#pauses.get(call.accountId)
    // A stream admitted before the 402 says nothing about the membership check since.
    if (paused?.paymentAt === undefined || call.startedAt.getTime() > paused.paymentAt)
      this.#pauses.delete(call.accountId)
  }

  async #confirmSignal(accountId: string, signal: CallSignal): Promise<void> {
    if (signal.kind === 'window_exhausted') await this.#coolExhausted(accountId, signal.until)
    else if (signal.kind === 'balance_exhausted') {
      // The provider's own word on money, not a downgrade to confirm: no probe sees a balance.
      // The account waits, durably, and comes back by itself after a top-up; the operator is
      // told once per pause how many such checks the day has seen.
      const balance = await this.#store.balance(accountId)
      if (balance.pausedUntil !== null) this.#alert('balance_exhausted', { checks: balance.count })
    } else if (['auth', 'account_risk', 'region', 'unconfirmed_block'].includes(signal.kind))
      await this.probeAccount(accountId)
  }

  async #coolExhausted(accountId: string, until: Date | null): Promise<void> {
    if (until !== null) {
      await this.#store.cool(accountId, until)
      return
    }
    // The store has just dropped the windows it knew: an earlier probe says nothing.
    // Only one still in flight is shared, so responses closing together probe once.
    const result = await this.probeAccount(accountId, { cleared: true })
    // The exhausted window that resets last; the store bounds its reset by that window.
    const binding = lastExhausted(result?.windows ?? [])
    if (binding) await this.#store.cool(accountId, binding.resetsAt, binding.name)
    else await this.#store.cool(accountId, null)
  }

  /**
   * One probe per account in five minutes confirms request signals: without `unknownWindows`
   * the caller is such a signal. A probe sent for the account's windows was sent before the
   * refusal it would have to confirm, so it answers no signal once it has settled; nor does it
   * end the five minutes of the confirming probe sent before it. A caller that read the windows
   * as unknown is not answered by a probe its state postdates, and a probe that left them
   * unknown is repeated for it after twenty seconds. A response that has just cleared the
   * windows is answered only by a probe still in flight or a new one.
   */
  probeAccount(accountId: string, unknownWindows?: UnknownWindows): Promise<ProbeResult | null> {
    return this.#ask(accountId, unknownWindows ?? 'signal')
  }

  /**
   * The window snapshot has only grown old (poolPolicy.windowsFreshMs): any probe of the last
   * five minutes has refreshed it already, whatever it was sent for.
   */
  refreshAccount(accountId: string): Promise<ProbeResult | null> {
    return this.#ask(accountId, 'refresh')
  }

  #ask(accountId: string, why: ProbeReason): Promise<ProbeResult | null> {
    if (this.#closing || !this.options.channelHealthy()) return Promise.resolve(null)
    const current = this.#probes.get(accountId)
    const remembered =
      current && this.#remembered(current, why) ? current : this.#confirming(accountId, why)
    if (remembered)
      // A remembered region answer still holds: a reopened egress closes again.
      return remembered.promise.then((result) => {
        if (result?.status === 'region' && !this.#closing) this.options.onRegion(accountId)
        return result
      })
    return this.#start(accountId, this.options.http, why === 'signal')
  }

  /** The confirming probe of the last five minutes, when a probe for the windows came after it. */
  #confirming(accountId: string, why: ProbeReason): ProbeMemo | undefined {
    const memo = why === 'signal' ? this.#confirmed.get(accountId) : undefined
    return memo && this.#now() - memo.at < probeIntervalMs ? memo : undefined
  }

  #remembered(memo: ProbeMemo, why: ProbeReason): boolean {
    const age = this.#now() - memo.at
    // A probe in flight is shared. Sent for unknown windows, it restores them; windows cleared
    // after it was sent stay unknown, and the floor below admits the next probe.
    if (why === 'refresh' || !memo.settled) return age < probeIntervalMs
    // Signals closing together share the probe the first of them started, for five minutes.
    if (why === 'signal') return memo.confirming && age < probeIntervalMs
    const unknownWindows = why
    if (unknownWindows.cleared) return false
    const seen = unknownWindows.limitsSeenAt?.getTime()
    // The windows were cleared after this probe was applied. A probe that was not applied
    // proves nothing either way and is bounded by the floor alone.
    if (
      seen !== undefined &&
      memo.limitsSeenAt !== undefined &&
      seen > (memo.limitsSeenAt ?? -Infinity)
    )
      return false
    return age < unknownWindowsProbeMs
  }

  #start(
    accountId: string,
    egress: EgressHttp,
    confirming: boolean,
    unavailable?: () => void,
  ): ProbeMemo['promise'] {
    const memo: ProbeMemo = {
      at: this.#now(),
      settled: false,
      confirming,
      promise: Promise.resolve(null),
    }
    memo.promise = this.#probe(accountId, egress, memo, unavailable).finally(() => {
      memo.settled = true
    })
    this.#probes.set(accountId, memo)
    if (confirming) this.#confirmed.set(accountId, memo)
    return memo.promise
  }

  /**
   * The half-open check of a region block: one probe of the account that confirmed it, through
   * the channel alone. Any applied provider answer other than a region refusal lifts the block.
   * When that account can no longer be probed the block stays (fail closed) and the reason is
   * logged: until a restart clears the in-memory block, egress stays closed.
   */
  async recheckRegion(accountId: string): Promise<boolean> {
    if (this.#closing || !this.options.regionHttp) return false
    const result = await this.#start(accountId, this.options.regionHttp, true, () =>
      this.#alert('region_recheck_unavailable'),
    )
    return result !== null && result.status !== 'region'
  }

  async #probe(
    accountId: string,
    egress: EgressHttp,
    memo: ProbeMemo,
    unavailable?: () => void,
  ): Promise<ProbeResult | null> {
    try {
      const account = await this.#store.account(accountId)
      if (this.#closing) return null
      const backend = account && this.#backends.get(account.backendId)
      if (!account || !backend) {
        unavailable?.()
        return null
      }
      const credential = await this.options.credentials.get(account, backend)
      if (this.#closing) return null
      const http: EgressHttp = {
        request: (request, { signal }) =>
          egress.request(request, {
            signal: AbortSignal.any([signal, this.#shutdown.signal]),
          }),
      }
      const parsed = probeResultSchema.safeParse(await backend.probe(credential, http))
      const result = parsed.success ? parsed.data : unknownProbe()
      if (this.#closing) return null
      const update = await this.#store.probe(account, result)
      if (update.alert) this.#alert(update.alert)
      if (update.applied) memo.limitsSeenAt = update.limitsSeenAt?.getTime() ?? null
      if (update.applied && result.status === 'region') this.options.onRegion(accountId)
      return update.applied ? result : null
    } catch {
      this.#alert('probe_failed')
      return null
    }
  }

  tick(): Promise<void> {
    const now = this.#now()
    for (const [id, pause] of this.#pauses)
      if (pause.until <= now && now - pause.seenAt >= 10 * 60_000) this.#pauses.delete(id)
    for (const probes of [this.#probes, this.#confirmed])
      for (const [id, probe] of probes) if (now - probe.at >= probeIntervalMs) probes.delete(id)
    for (const [id, at] of this.#observed)
      if (now - at >= 24 * 60 * 60_000) this.#observed.delete(id)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.#closing = true
    this.#shutdown.abort()
    this.#pauses.clear()
    this.#probes.clear()
    this.#confirmed.clear()
    this.#observed.clear()
    return Promise.resolve()
  }
}
