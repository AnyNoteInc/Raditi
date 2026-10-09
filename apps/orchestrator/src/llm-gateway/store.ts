import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

import { Prisma, type PrismaClient } from '@repo/db'
import {
  callFitsBudget,
  callReserveRub,
  callSignalSchema,
  callUsageSchema,
  clientIdentitySchema,
  estimatedCacheReadTokens,
  gatewayRefusalSchema,
  limitResetPlausible,
  limitWindowSnapshotSchema,
  llmBackendIdSchema,
  llmCallCostRub,
  poolPolicy,
  refusalForSignal,
  type CallUsage,
  type GatewayRefusal,
  type LimitWindow,
  type LlmModelPrices,
} from '@repo/domain'
import { z } from 'zod'

import {
  decodeLimitWindows,
  GatewayRecordRejected,
  limitWindowColumns,
  policyFlaggedEvent,
  resetsPlausible,
  type GatewayAdmission,
  type GatewayAdmitInput,
  type GatewayFinish,
  type GatewayKey,
  type GatewayProfile,
  type GatewayStore,
} from './types.ts'

type Transaction = Prisma.TransactionClient
type Database = Pick<PrismaClient, '$transaction' | '$queryRaw'>
const transactionOptions = { maxWait: 5_000, timeout: 10_000 }
const int = z.number().int().nonnegative().max(2_147_483_647)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z.string().refine((value) => isIP(value) !== 0)
const usageBreakerMs = 15 * 60_000
// The window the pace of one key is counted in.
const callPaceMs = 30_000
// An exhausted window stays exhausted this long past its reset, as cooling_until does.
const resetMarginMs = 60_000
// Retry-After of a turn held for unknown windows: the CLI's retries outlast one account probe.
const unknownWindowsRetryMs = 30_000
const profileSchema = z.object({
  keyId: z.uuid(),
  modelId: z.uuid(),
  model: z.string().min(1).max(255),
  reasoningEffort: z.string().max(16).nullable(),
  cacheKey: z.string().regex(/^rdt_[a-f0-9]{32}$/),
})
const admitSchema = z.strictObject({
  keyHash: hashSchema,
  source: sourceSchema,
  backendId: llmBackendIdSchema,
  route: z.strictObject({ method: z.enum(['POST', 'GET']), path: z.string().min(1).max(64) }),
  profile: profileSchema,
  requestBytes: int.max(16 * 1024 * 1024),
  estimatedInputTokens: int,
})
/** Every outcome the gateway closes a call with; exported so unit tests hold the server to it. */
export const gatewayFinishSchema = z
  .strictObject({
    state: z.enum(['completed', 'failed', 'aborted', 'lost']),
    usage: callUsageSchema.refine((usage) =>
      Object.values(usage).every((value) => value <= 2_147_483_647),
    ),
    estimated: z.boolean(),
    billable: z.boolean(),
    estimateReason: z
      .enum(['aborted_client', 'aborted_platform', 'lost', 'no_usage', 'invalid_usage'])
      .nullable(),
    responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    signal: callSignalSchema.optional(),
    windows: limitWindowSnapshotSchema.nullable().optional(),
  })
  .refine((value) => value.estimated === (value.estimateReason !== null))
  .refine(
    (value) =>
      value.billable === !['aborted_platform', 'lost'].includes(value.estimateReason ?? ''),
  )
  .refine((value) => value.state !== 'lost' || value.estimateReason === 'lost')

interface KeyRow {
  keyId: string
  taskId: string
  taskAttempt: number
  driverId: string
  modelId: string
  accountId: string
  model: string | null
  modelSlug: string
  reasoningEffort: string | null
  budgetRub: Prisma.Decimal
  expiresAt: Date
  lastCallAt: Date | null
  backendId: string
  providerId: string
  providerEnabled: boolean
  providerKind: string
  modelEnabled: boolean
  reserveOutputTokens: number
  credentialRef: string
  credentialVersion: number
  credentialExpiresAt: Date | null
  clientIdentity: unknown
  maxConcurrentRequests: number
  accountEnabled: boolean
  status: string
  health: string
  healthReason: string | null
  retireRequestedAt: Date | null
  credentialsRevokedAt: Date | null
  coolingUntil: Date | null
  breakerOpenUntil: Date | null
  limitWindows: unknown
  limitsSeenAt: Date | null
  policyFlagged: boolean
  serverNow: Date
}

// The event type goes into SQL as a literal of this constant, never as a bind parameter: only
// then can the planner prove, for every plan, that the partial index on that type applies.
if (!/^[a-z_.]+$/.test(policyFlaggedEvent)) throw new Error('Unsafe policy event literal')
const policyFlaggedLiteral = Prisma.raw(`'${policyFlaggedEvent}'`)

const keyColumns = Prisma.sql`
  k.id AS "keyId", k.task_id AS "taskId", k.task_attempt AS "taskAttempt",
  k.driver_id AS "driverId", k.model_id AS "modelId", k.subscription_account_id AS "accountId",
  k.reasoning_effort AS "reasoningEffort", k.budget_rub AS "budgetRub", k.expires_at AS "expiresAt",
  k.last_call_at AS "lastCallAt",
  m.provider_model_id AS model, m.slug AS "modelSlug", m.enabled AS "modelEnabled",
  m.reserve_output_tokens AS "reserveOutputTokens", p.slug AS "backendId",
  p.id AS "providerId", p.enabled AS "providerEnabled", p.kind::text AS "providerKind",
  a.enabled AS "accountEnabled", a.status::text AS status, a.health::text AS health,
  a.health_reason AS "healthReason", a.retire_requested_at AS "retireRequestedAt",
  a.credentials_revoked_at AS "credentialsRevokedAt", a.cooling_until AS "coolingUntil",
  a.breaker_open_until AS "breakerOpenUntil", a.limit_windows AS "limitWindows",
  a.limits_seen_at AS "limitsSeenAt",
  a.credential_version AS "credentialVersion", a.credential_expires_at AS "credentialExpiresAt",
  a.client_identity AS "clientIdentity",
  a.max_concurrent_requests AS "maxConcurrentRequests", ref.vault_path AS "credentialRef",
  EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = k.task_id
    AND e.type = ${policyFlaggedLiteral}) AS "policyFlagged",
  clock_timestamp() AS "serverNow"`

/** Every admission/close locks key → account → call. Stop flags additionally hold model/provider share locks. */
export class PostgresGatewayStore implements GatewayStore {
  readonly #maxRequestsPerKey: number
  readonly #maxCallsPerKey30s: number
  readonly #maxCallsPerKey: number
  readonly #lostAfterMs: number
  readonly #logger: { warn(message: string): void }

  constructor(
    private readonly db: Database,
    options: {
      maxRequestsPerKey?: number
      /** Calls one key may start within thirty seconds, and at all. */
      maxCallsPerKey30s?: number
      maxCallsPerKey?: number
      lostAfterMs?: number
      logger?: { warn(message: string): void }
    } = {},
  ) {
    this.#logger = options.logger ?? { warn: () => {} }
    this.#maxRequestsPerKey = z
      .number()
      .int()
      .min(1)
      .max(2)
      .parse(options.maxRequestsPerKey ?? 2)
    this.#maxCallsPerKey30s = z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .parse(options.maxCallsPerKey30s ?? 20)
    this.#maxCallsPerKey = z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .parse(options.maxCallsPerKey ?? 600)
    this.#lostAfterMs = z
      .number()
      .int()
      .min(11 * 60_000)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(options.lostAfterMs ?? 11 * 60_000)
  }

  async lookup(keyHash: string, source: string): Promise<GatewayKey | null> {
    hashSchema.parse(keyHash)
    sourceSchema.parse(source)
    const row = await this.#transaction((tx) => this.#readKey(tx, keyHash, source))
    return row === null ? null : toKey(row)
  }

  async admit(input: GatewayAdmitInput): Promise<GatewayAdmission> {
    const value = admitSchema.parse(input)
    return this.#transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; accountId: string }[]>`
        SELECT id, subscription_account_id AS "accountId" FROM llm_keys
        WHERE key_hash = ${value.keyHash} FOR UPDATE`
      const key = locked[0]
      if (!key) return { kind: 'refused', reason: 'unauthorized' }
      // The shared account row serializes slots across different keys and processes.
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${key.accountId}::uuid FOR UPDATE`
      // Fresh statement/clock after both waits: a pre-lock timestamp must never revive a key.
      const row = await this.#readKey(tx, value.keyHash, value.source, true)
      if (!row) return { kind: 'refused', reason: 'unauthorized' }
      const current = toKey(row)
      if (!current) return this.#refused(tx, row.keyId, 'profile')
      if (current.backendId !== value.backendId) {
        await this.#refused(tx, row.keyId, 'profile')
        return { kind: 'refused', keyId: row.keyId, reason: 'backend' }
      }
      if (!sameProfile(current, value.profile)) return this.#refused(tx, row.keyId, 'profile')
      if (!row.providerEnabled || row.providerKind !== 'subscription')
        return this.#refused(tx, row.keyId, 'provider_off')
      if (!row.modelEnabled || row.model === null) return this.#refused(tx, row.keyId, 'profile')
      // The task already failed for content; its next request would repeat it to the account.
      if (row.policyFlagged) return this.#refused(tx, row.keyId, 'policy_flagged')
      // A turn asks once per step, and a model answers in seconds. A key that asks faster, or
      // more often than any turn does, is a CLI repeating itself: each call would spend the
      // account's quota until the money budget ran out. Refused for good, before it waits for
      // a slot; a refusal opens no call and so is not counted.
      const [calls, recentCalls] = await Promise.all([
        tx.llmCall.count({ where: { keyId: row.keyId } }),
        tx.llmCall.count({
          where: {
            keyId: row.keyId,
            startedAt: { gt: new Date(row.serverNow.getTime() - callPaceMs) },
          },
        }),
      ])
      if (calls >= this.#maxCallsPerKey || recentCalls >= this.#maxCallsPerKey30s)
        return {
          ...(await this.#refused(tx, row.keyId, 'budget')),
          limit: calls >= this.#maxCallsPerKey ? 'calls' : 'pace',
        }
      const open = await tx.llmCall.count({ where: { keyId: row.keyId, state: 'open' } })
      if (open >= this.#maxRequestsPerKey) return this.#refused(tx, row.keyId, 'transient', 1_000)
      const price = await tx.llmModelPrice.findFirst({
        where: { modelId: row.modelId, effectiveFrom: { lte: row.serverNow } },
        orderBy: { effectiveFrom: 'desc' },
      })
      if (!price) return this.#refused(tx, row.keyId, 'profile')
      const rates = prices(price)
      const estimate = {
        estimatedInputTokens: value.estimatedInputTokens,
        lastCompletedUsage: await lastCompletedUsage(tx, row.taskId, row.taskAttempt),
      }
      const reservedRub = callReserveRub(
        { ...estimate, reserveOutputTokens: row.reserveOutputTokens },
        rates,
      )
      const [spent, reserved] = await Promise.all([
        tx.tokenUsage.aggregate({ where: { keyId: row.keyId }, _sum: { costRub: true } }),
        tx.llmCall.aggregate({
          where: { keyId: row.keyId, state: 'open' },
          _sum: { reservedRub: true },
        }),
      ])
      if (
        !callFitsBudget({
          budgetRub: current.budgetRub,
          spentRub: spent._sum.costRub?.toFixed(10) ?? '0.0000000000',
          openReservedRub: reserved._sum.reservedRub?.toFixed(10) ?? '0.0000000000',
          reserveRub: reservedRub,
        })
      )
        return { ...(await this.#refused(tx, row.keyId, 'budget')), limit: 'money' }
      const blocked = accountRefusal(row)
      if (blocked === 'windows_unknown') {
        const refused = await this.#refused(tx, row.keyId, 'transient', unknownWindowsRetryMs)
        return { ...refused, probeAccount: true, limitsSeenAt: row.limitsSeenAt }
      }
      if (blocked) return this.#refused(tx, row.keyId, blocked)
      const accountOpen = await tx.llmCall.count({
        where: { subscriptionAccountId: row.accountId, state: 'open' },
      })
      if (accountOpen >= row.maxConcurrentRequests) {
        const refused = await this.#refused(tx, row.keyId, 'transient', 1_000)
        return { ...refused, waitForSlot: true }
      }
      const [finalClock] = await tx.$queryRaw<
        { instant: Date }[]
      >`SELECT clock_timestamp() AS instant`
      if (finalClock!.instant >= row.expiresAt) return { kind: 'refused', reason: 'unauthorized' }
      if (
        row.healthReason === 'refresh_ambiguous' &&
        (row.credentialExpiresAt === null || finalClock!.instant >= row.credentialExpiresAt)
      )
        return this.#refused(tx, row.keyId, 'account')
      if (row.breakerOpenUntil !== null) {
        // The account lock admits exactly one generation trial after the breaker expires.
        // Hold all other keys until this trial supplies real usage, or another 15 minutes pass.
        await tx.subscriptionAccount.update({
          where: { id: row.accountId },
          data: { breakerOpenUntil: new Date(finalClock!.instant.getTime() + usageBreakerMs) },
        })
      }
      const call = await tx.llmCall.create({
        data: {
          keyId: row.keyId,
          subscriptionAccountId: row.accountId,
          modelId: row.modelId,
          route: value.route.path,
          reservedRub,
          requestBytes: value.requestBytes,
          estimatedInputTokens: value.estimatedInputTokens,
          startedAt: row.serverNow,
        },
      })
      await tx.llmKey.update({ where: { id: row.keyId }, data: { lastCallAt: row.serverNow } })
      return {
        kind: 'admitted',
        call: {
          ...current,
          id: call.id,
          priceId: price.id,
          prices: rates,
          estimatedInputTokens: value.estimatedInputTokens,
          estimatedCacheReadTokens: estimatedCacheReadTokens(estimate, rates),
          reservedRub,
          startedAt: row.serverNow,
        },
      }
    })
  }

  async refuse(keyId: string, reason: GatewayRefusal): Promise<void> {
    z.uuid().parse(keyId)
    gatewayRefusalSchema.parse(reason)
    await this.#transaction((tx) => recordRefusal(tx, keyId, reason))
  }

  async finish(callId: string, outcome: GatewayFinish): Promise<boolean> {
    const id = z.uuid().safeParse(callId)
    const value = gatewayFinishSchema.safeParse(outcome)
    if (!id.success || !value.success) throw new GatewayRecordRejected()
    try {
      return await this.#close(callId, value.data)
    } catch (error) {
      throw permanent(error) ? new GatewayRecordRejected() : error
    }
  }

  async collectLost(): Promise<number> {
    const calls = await this.#transaction(
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM llm_calls
      WHERE state = 'open' AND started_at < clock_timestamp() - (${this.#lostAfterMs} * interval '1 millisecond')
      ORDER BY started_at LIMIT 1000`,
    )
    // Only an unreadable list fails the pass. A row that cannot be closed now (a lock held
    // elsewhere, a missing rate) stays open with its reservation counted and is retried next
    // pass; it must not stop the other rows or close admission for every turn.
    let closed = 0
    for (const call of calls) {
      try {
        if (await this.#close(call.id, null)) closed += 1
      } catch {
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' }))
      }
    }
    const keys = await this.#transaction(
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM llm_keys
      WHERE revoked_at IS NOT NULL AND usage_closed_at IS NULL LIMIT 1000`,
    )
    for (const key of keys) {
      try {
        await this.#transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${key.id}::uuid FOR UPDATE`
          // Fresh after the row wait: an older admission may have just committed its open call.
          await tx.$queryRaw`UPDATE llm_keys k SET usage_closed_at = clock_timestamp()
          WHERE k.id = ${key.id}::uuid AND k.revoked_at IS NOT NULL AND k.usage_closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')`
        })
      } catch {
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_row_failed', kind: 'key' }))
      }
    }
    return closed
  }

  #transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      // Prisma's callback timeout cannot cancel an in-flight SQL statement. PostgreSQL
      // must bound row/DDL waits and query execution itself; LOCAL never changes the pool.
      await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true),
        set_config('statement_timeout', '5000ms', true)`
      return work(tx)
    }, transactionOptions)
  }

  async #readKey(
    db: Pick<Transaction, '$queryRaw'>,
    hash: string,
    source: string,
    lock = false,
  ): Promise<KeyRow | null> {
    if (lock)
      await db.$queryRaw`SELECT m.id FROM llm_keys k
      JOIN llm_models m ON m.id = k.model_id JOIN llm_providers p ON p.id = m.provider_id
      WHERE k.key_hash = ${hash} FOR SHARE OF m, p`
    // All locks have already returned. clock_timestamp() and flags belong to this fresh statement.
    const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`SELECT ${keyColumns} FROM llm_keys k
      JOIN llm_models m ON m.id = k.model_id JOIN llm_providers p ON p.id = m.provider_id
      JOIN subscription_accounts a ON a.id = k.subscription_account_id
      JOIN credential_refs ref ON ref.id = a.credential_ref_id
      WHERE k.key_hash = ${hash} AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
        AND k.usage_closed_at IS NULL AND clock_timestamp() < k.expires_at
        AND (k.bound_source IS NULL OR k.bound_source = ${source}::inet)
        AND a.provider_id = p.id AND a.driver_id = k.driver_id`)
    return rows[0] ?? null
  }

  async #refused(
    tx: Transaction,
    keyId: string,
    reason: GatewayRefusal,
    retryAfterMs?: number,
  ): Promise<Extract<GatewayAdmission, { kind: 'refused' }>> {
    await recordRefusal(tx, keyId, reason)
    return {
      kind: 'refused',
      keyId,
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  }

  async #close(callId: string, outcome: GatewayFinish | null): Promise<boolean> {
    return this.#transaction(async (tx) => {
      const selected = await tx.llmCall.findUnique({
        where: { id: callId },
        select: { keyId: true, subscriptionAccountId: true },
      })
      if (!selected) return false
      await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${selected.keyId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${selected.subscriptionAccountId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM llm_calls WHERE id = ${callId}::uuid FOR UPDATE`
      const call = await tx.llmCall.findUniqueOrThrow({
        where: { id: callId },
        include: { key: true, model: true },
      })
      if (call.state !== 'open') return false
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      if (outcome === null && call.startedAt.getTime() >= now.getTime() - this.#lostAfterMs)
        return false
      const price = await tx.llmModelPrice.findFirst({
        where: { modelId: call.modelId, effectiveFrom: { lte: call.startedAt } },
        orderBy: { effectiveFrom: 'desc' },
      })
      if (!price) throw new GatewayRecordRejected('Missing historical LLM accounting rate')
      const rates = prices(price)
      let value: GatewayFinish
      let costRub: string
      if (outcome === null) {
        // est_in excludes image and encrypted bytes; only calls older than it fall back.
        const input = call.estimatedInputTokens ?? Math.ceil(call.requestBytes / 3)
        value = {
          state: 'lost',
          usage: {
            input,
            // The share admission reserved with: the calls completed before this one started.
            cacheRead: estimatedCacheReadTokens(
              {
                estimatedInputTokens: input,
                lastCompletedUsage: await lastCompletedUsage(
                  tx,
                  call.key.taskId,
                  call.key.taskAttempt,
                  call.startedAt,
                ),
              },
              rates,
            ),
            cacheWrite: 0,
            output: call.model.reserveOutputTokens,
            reasoning: 0,
          },
          estimated: true,
          billable: false,
          estimateReason: 'lost',
          responseBytes: 0,
        }
        // A platform failure never takes more of the attempt ceiling than the call reserved,
        // whatever happened to the rows this estimate is rebuilt from.
        const estimate = new Prisma.Decimal(llmCallCostRub(value.usage, rates))
        costRub = Prisma.Decimal.min(estimate, call.reservedRub).toFixed(10)
      } else {
        value = outcome
        costRub = llmCallCostRub(value.usage, rates)
      }
      const updated = await tx.llmCall.updateMany({
        where: { id: callId, state: 'open' },
        data: {
          state: value.state,
          finishedAt: now,
          responseBytes: BigInt(value.responseBytes),
          upstreamStatus: value.upstreamStatus ?? null,
          signal: value.signal?.kind ?? null,
        },
      })
      if (updated.count !== 1) return false
      await tx.tokenUsage.create({
        data: {
          gatewayCallId: callId,
          keyId: call.keyId,
          subscriptionAccountId: call.subscriptionAccountId,
          taskId: call.key.taskId,
          taskAttempt: call.key.taskAttempt,
          driverId: call.key.driverId,
          modelId: call.modelId,
          priceId: price.id,
          inputUncachedTokens: value.usage.input - value.usage.cacheRead - value.usage.cacheWrite,
          cacheReadTokens: value.usage.cacheRead,
          cacheWriteTokens: value.usage.cacheWrite,
          outputTokens: value.usage.output,
          reasoningTokens: value.usage.reasoning,
          costRub,
          estimated: value.estimated,
          billable: value.billable,
          estimateReason: value.estimateReason,
          occurredAt: call.startedAt,
        },
      })
      const accountData: Prisma.SubscriptionAccountUpdateInput = { lastUsedAt: now }
      const account = await tx.subscriptionAccount.findUniqueOrThrow({
        where: { id: call.subscriptionAccountId },
        select: {
          limitWindows: true,
          limitsSeenAt: true,
          coolingUntil: true,
          usageMissingStreak: true,
          breakerOpenUntil: true,
        },
      })
      // Only complete generation terminals test the usage contract. Aborted/failed/lost
      // calls neither increase nor reset the streak, and replayed finishes never reach here.
      if (value.state === 'completed') {
        if (value.estimated) {
          const streak = Math.min(3, account.usageMissingStreak + 1)
          accountData.usageMissingStreak = streak
          if (streak >= 3) {
            const until = new Date(now.getTime() + usageBreakerMs)
            accountData.breakerOpenUntil =
              account.breakerOpenUntil !== null && account.breakerOpenUntil > until
                ? account.breakerOpenUntil
                : until
          }
        } else {
          accountData.usageMissingStreak = 0
          accountData.breakerOpenUntil = null
        }
      }
      if (value.windows !== undefined && value.windows !== null) {
        // A response that named no window (a balance only) leaves the known windows as they are.
        if (value.windows.windows !== null) {
          // Concurrent provider responses may close in a different order from their headers.
          // A late snapshot must never refill an already observed exhausted window.
          const known = decodeLimitWindows(account.limitWindows)
          const unknownSinceCall =
            (known === null || known.length === 0) &&
            account.limitsSeenAt !== null &&
            account.limitsSeenAt >= call.startedAt
          const windows =
            unknownSinceCall || !resetsPlausible(value.windows.windows, now)
              ? []
              : mergeWindows(account.limitWindows, value.windows.windows)
          Object.assign(accountData, limitWindowColumns(windows, now))
        }
        accountData.creditsSeen =
          value.windows.creditsBalance === null
            ? Prisma.JsonNull
            : { balance: value.windows.creditsBalance }
      }
      if (value.signal?.kind === 'window_exhausted') {
        // A reset no window can have is no reset: it must never become a pause of years.
        if (
          value.signal.until !== null &&
          value.signal.until > now &&
          limitResetPlausible(value.signal.until, now)
        ) {
          const until = new Date(value.signal.until.getTime() + 60_000)
          if (account.coolingUntil === null || account.coolingUntil < until)
            accountData.coolingUntil = until
        } else {
          const windows = decodeLimitWindows(accountData.limitWindows ?? account.limitWindows)
          if (!windows?.some((window) => window.usedPct >= 100)) {
            // Authoritative exhaustion with no usable reset cannot reuse an older spare
            // snapshot. Only a fresh B10 probe may restore known capacity.
            Object.assign(accountData, limitWindowColumns([], now))
          }
        }
      }
      await tx.subscriptionAccount.update({
        where: { id: call.subscriptionAccountId },
        data: accountData,
      })
      const refusal =
        value.signal === undefined || value.signal.kind === 'ok'
          ? null
          : refusalForSignal(value.signal)
      if (refusal) await this.#refused(tx, call.keyId, refusal)
      await tx.$queryRaw`UPDATE llm_keys k SET usage_closed_at = ${now}
        WHERE k.id = ${call.keyId}::uuid AND k.revoked_at IS NOT NULL AND k.usage_closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')`
      return true
    })
  }
}

/**
 * last_refusal is the latest reason only. A content refusal also leaves its task the operator
 * event that no later refusal clears: core must never rebind a flagged task (p3-design §2.5).
 */
async function recordRefusal(
  tx: Pick<Transaction, '$queryRaw'>,
  keyId: string,
  reason: GatewayRefusal,
): Promise<void> {
  await tx.$queryRaw`UPDATE llm_keys SET last_refusal = ${reason}, last_refusal_at = clock_timestamp()
    WHERE id = ${keyId}::uuid`
  if (reason !== 'policy_flagged') return
  // The key row lock above serializes this check for the key; a task holds one live key.
  await tx.$queryRaw(Prisma.sql`INSERT INTO task_events (task_id, type, payload, client_visible)
    SELECT k.task_id, ${policyFlaggedLiteral},
      jsonb_build_object('attempt', k.task_attempt, 'turn', k.turn_no), false
    FROM llm_keys k WHERE k.id = ${keyId}::uuid AND NOT EXISTS (
      SELECT 1 FROM task_events e WHERE e.task_id = k.task_id
        AND e.type = ${policyFlaggedLiteral})`)
}

/**
 * Data and integrity errors (SQLSTATE classes 22 and 23), a vanished row and an invalid query
 * repeat for the same write. Connection, lock, timeout and serialization failures may pass.
 */
function permanent(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientValidationError) return true
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code === 'P2025') return true
  const adapter = error.meta?.driverAdapterError
  const cause =
    adapter && typeof adapter === 'object' && 'cause' in adapter ? adapter.cause : undefined
  const code =
    cause && typeof cause === 'object' && 'originalCode' in cause ? cause.originalCode : undefined
  return typeof code === 'string' && /^2[23]/.test(code)
}

function toKey(row: KeyRow): GatewayKey | null {
  const backend = llmBackendIdSchema.safeParse(row.backendId)
  const identity = clientIdentitySchema.safeParse(row.clientIdentity)
  if (!backend.success || !identity.success || row.model === null) return null
  return {
    keyId: row.keyId,
    modelId: row.modelId,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    cacheKey: `rdt_${createHash('sha256').update(`raditi:${row.taskId}`).digest('hex').slice(0, 32)}`,
    backendId: backend.data,
    providerId: row.providerId,
    taskId: row.taskId,
    taskAttempt: row.taskAttempt,
    driverId: row.driverId,
    accountId: row.accountId,
    modelSlug: row.modelSlug,
    reserveOutputTokens: row.reserveOutputTokens,
    budgetRub: row.budgetRub.toFixed(10),
    credentialRef: row.credentialRef,
    credentialVersion: row.credentialVersion,
    clientIdentity: identity.data,
    maxConcurrentRequests: row.maxConcurrentRequests,
    // Windows nobody has dated are unknown ones: admission asks for their probe itself. A key
    // that admission is going to refuse for a stop flag asks for nothing: a provider, a model
    // or an account that is switched off gets no request on its behalf, a quota request neither.
    staleWindows:
      row.lastCallAt === null &&
      row.limitsSeenAt !== null &&
      row.serverNow.getTime() - row.limitsSeenAt.getTime() > poolPolicy.windowsFreshMs &&
      row.providerEnabled &&
      row.providerKind === 'subscription' &&
      row.modelEnabled &&
      !accountOff(row),
  }
}

/** Switched off by the operator, out of the pool, unhealthy, or without live credentials. */
const accountOff = (row: KeyRow): boolean =>
  !row.accountEnabled ||
  row.status !== 'active' ||
  row.health !== 'ok' ||
  row.credentialsRevokedAt !== null ||
  row.credentialVersion < 1

function sameProfile(key: GatewayKey, profile: GatewayProfile): boolean {
  return (
    key.keyId === profile.keyId &&
    key.modelId === profile.modelId &&
    key.model === profile.model &&
    key.reasoningEffort === profile.reasoningEffort &&
    key.cacheKey === profile.cacheKey
  )
}

function prices(value: {
  inputPer1m: Prisma.Decimal
  cacheReadPer1m: Prisma.Decimal | null
  cacheWritePer1m: Prisma.Decimal | null
  outputPer1m: Prisma.Decimal
}): LlmModelPrices {
  return {
    inputPer1m: value.inputPer1m.toFixed(6),
    cacheReadPer1m: value.cacheReadPer1m?.toFixed(6) ?? null,
    cacheWritePer1m: value.cacheWritePer1m?.toFixed(6) ?? null,
    outputPer1m: value.outputPer1m.toFixed(6),
  }
}

/**
 * Usage of the last completed call of an attempt, across its turn keys: the cache share of the
 * next reserve. `before` rebuilds what admission saw for a call that started then.
 */
async function lastCompletedUsage(
  tx: Transaction,
  taskId: string,
  taskAttempt: number,
  before?: Date,
): Promise<CallUsage | null> {
  const row = await tx.tokenUsage.findFirst({
    where: {
      taskId,
      taskAttempt,
      estimated: false,
      call: { state: 'completed', ...(before ? { finishedAt: { lte: before } } : {}) },
    },
    orderBy: [{ call: { finishedAt: 'desc' } }, { gatewayCallId: 'desc' }],
  })
  return row ? usageFromRow(row) : null
}

function usageFromRow(value: {
  inputUncachedTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}): CallUsage {
  return {
    input: value.inputUncachedTokens + value.cacheReadTokens + value.cacheWriteTokens,
    cacheRead: value.cacheReadTokens,
    cacheWrite: value.cacheWriteTokens,
    output: value.outputTokens,
    reasoning: value.reasoningTokens,
  }
}

/**
 * Admission of a running turn (p3-design §3.2 step 8): only a confirmed limit refuses for good.
 * A window past its reset has rolled over, so its old usage no longer applies; the next
 * response or probe reports the new period. Unknown windows hold the turn as short-lived until
 * a fresh probe, because an authoritative exhaustion or a malformed report clears them.
 */
function accountRefusal(row: KeyRow): GatewayRefusal | 'windows_unknown' | null {
  if (accountOff(row)) return 'account'
  // Existing keys drain normally during retirement or an ambiguous refresh. New issue
  // rejects both in pickAccount; an existing ambiguous credential must still be live.
  if (
    row.healthReason === 'refresh_ambiguous' &&
    (row.credentialExpiresAt === null || row.credentialExpiresAt <= row.serverNow)
  )
    return 'account'
  if (row.breakerOpenUntil !== null && row.breakerOpenUntil > row.serverNow) return 'account'
  if (row.coolingUntil !== null && row.coolingUntil > row.serverNow) return 'subscription_limit'
  const windows = decodeLimitWindows(row.limitWindows)
  if (windows === null || windows.length === 0) return 'windows_unknown'
  const now = row.serverNow.getTime()
  if (
    windows.some(
      (window) =>
        window.usedPct >= 100 &&
        (window.resetsAt === null || window.resetsAt.getTime() + resetMarginMs > now),
    )
  )
    return 'subscription_limit'
  return null
}

function mergeWindows(current: unknown, incoming: readonly LimitWindow[]): LimitWindow[] {
  // An explicitly unknown snapshot is never interpreted as unlimited capacity.
  if (incoming.length === 0) return []
  const known = decodeLimitWindows(current)
  if (known === null || known.length === 0) return [...incoming]
  const merged = new Map(known.map((window) => [window.name, window]))
  for (const next of incoming) {
    const previous = merged.get(next.name)
    if (!previous) {
      merged.set(next.name, next)
      continue
    }
    const before = previous.resetsAt?.getTime() ?? null
    const after = next.resetsAt?.getTime() ?? null
    if (before !== null && after !== null && after > before) merged.set(next.name, next)
    else if (before !== null && after !== null && after < before) continue
    else
      merged.set(next.name, {
        ...next,
        resetsAt: next.resetsAt ?? previous.resetsAt,
        usedPct: Math.max(previous.usedPct, next.usedPct),
      })
  }
  // Keep reported windows that an incomplete late snapshot omitted.
  return [...merged.values()]
}
