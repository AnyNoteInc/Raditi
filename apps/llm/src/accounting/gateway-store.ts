import { isIP } from 'node:net'

import { Prisma, type PrismaClient } from '@repo/db'
import {
  callFitsBudget,
  callReserveRub,
  estimatedCacheReadTokens,
  gatewayRefusalSchema,
  llmBackendIdSchema,
  llmCapacitySchema,
  poolPolicy,
  type GatewayRefusal,
  type LlmCapacity,
} from '@repo/domain'
import {
  decodeLimitWindows,
  gatewayTransaction,
  lastCompletedUsage,
  LlmCallLedger,
  modelPrices,
  policyFlaggedLiteral,
  recordRefusal,
  USAGE_BREAKER_MS,
  type GatewayFinish,
} from '@repo/turn-keys'
import { z } from 'zod'

import type {
  GatewayAdmission,
  GatewayAdmitInput,
  GatewayKey,
  GatewayProfile,
  GatewayStore,
} from './gateway-types.ts'

type Transaction = Prisma.TransactionClient
type Database = Pick<PrismaClient, '$transaction' | '$queryRaw'>
const int = z.number().int().nonnegative().max(2_147_483_647)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z.string().refine((value) => isIP(value) !== 0)
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
})
const admitSchema = z.strictObject({
  keyHash: hashSchema,
  source: sourceSchema,
  backendId: llmBackendIdSchema,
  capacity: llmCapacitySchema,
  route: z.strictObject({ method: z.enum(['POST', 'GET']), path: z.string().min(1).max(64) }),
  fallback: z.boolean().optional(),
  profile: profileSchema,
  requestBytes: int.max(16 * 1024 * 1024),
  estimatedInputTokens: int,
})
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
  /** The backend of the account the row was read with: the key's own, or its fallback's. */
  accountBackendId: string
  fallbackAccountId: string | null
  fallbackBackendId: string | null
  providerId: string
  providerEnabled: boolean
  providerKind: string
  modelEnabled: boolean
  reserveOutputTokens: number
  credentialRef: string
  credentialVersion: number
  maxConcurrentRequests: number
  accountEnabled: boolean
  status: string
  health: string
  retireRequestedAt: Date | null
  credentialsRevokedAt: Date | null
  coolingUntil: Date | null
  breakerOpenUntil: Date | null
  limitWindows: unknown
  limitsSeenAt: Date | null
  policyFlagged: boolean
  serverNow: Date
}

const keyColumns = Prisma.sql`
  k.id AS "keyId", k.task_id AS "taskId", k.task_attempt AS "taskAttempt",
  k.driver_id AS "driverId", k.model_id AS "modelId", a.id AS "accountId",
  ap.slug AS "accountBackendId", k.fallback_account_id AS "fallbackAccountId",
  (SELECT fp.slug FROM subscription_accounts fa JOIN llm_providers fp ON fp.id = fa.provider_id
    WHERE fa.id = k.fallback_account_id) AS "fallbackBackendId",
  k.reasoning_effort AS "reasoningEffort", k.budget_rub AS "budgetRub", k.expires_at AS "expiresAt",
  k.last_call_at AS "lastCallAt",
  m.provider_model_id AS model, m.slug AS "modelSlug", m.enabled AS "modelEnabled",
  m.reserve_output_tokens AS "reserveOutputTokens", p.slug AS "backendId",
  p.id AS "providerId", p.enabled AS "providerEnabled", p.kind::text AS "providerKind",
  a.enabled AS "accountEnabled", a.status::text AS status, a.health::text AS health,
  a.retire_requested_at AS "retireRequestedAt",
  a.credentials_revoked_at AS "credentialsRevokedAt", a.cooling_until AS "coolingUntil",
  a.breaker_open_until AS "breakerOpenUntil", a.limit_windows AS "limitWindows",
  a.limits_seen_at AS "limitsSeenAt",
  a.credential_version AS "credentialVersion",
  a.max_concurrent_requests AS "maxConcurrentRequests", ref.vault_path AS "credentialRef",
  EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = k.task_id
    AND e.type = ${policyFlaggedLiteral}) AS "policyFlagged",
  clock_timestamp() AS "serverNow"`

/**
 * Admission of the requests of a turn key: every admission locks key → account → call, as the
 * close of the call ledger does. Stop flags additionally hold model/provider share locks. The
 * calls it admits close through the call ledger of @repo/turn-keys: the reserve here and the
 * settlement there share its rates and its estimate of cache reads.
 */
export class PostgresGatewayStore implements GatewayStore {
  readonly #maxRequestsPerKey: number
  readonly #maxCallsPerKey30s: number | null
  readonly #maxCallsPerKey: number | null
  readonly #ledger: LlmCallLedger

  private readonly db: Database

  constructor(
    db: Database,
    options: {
      maxRequestsPerKey?: number
      /** Calls one key may start within thirty seconds, and at all; null or left out — no limit. */
      maxCallsPerKey30s?: number | null
      maxCallsPerKey?: number | null
      lostAfterMs?: number
      logger?: { warn(message: string): void }
    } = {},
  ) {
    this.db = db
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
      .nullable()
      .parse(options.maxCallsPerKey30s ?? null)
    this.#maxCallsPerKey = z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .nullable()
      .parse(options.maxCallsPerKey ?? null)
    this.#ledger = new LlmCallLedger(db, {
      ...(options.lostAfterMs === undefined ? {} : { lostAfterMs: options.lostAfterMs }),
      ...(options.logger ? { logger: options.logger } : {}),
    })
  }

  async lookup(keyHash: string, source: string): Promise<GatewayKey | null> {
    hashSchema.parse(keyHash)
    sourceSchema.parse(source)
    const row = await gatewayTransaction(this.db, (tx) => this.#readKey(tx, keyHash, source))
    return row === null ? null : toKey(row)
  }

  async admit(input: GatewayAdmitInput): Promise<GatewayAdmission> {
    const value = admitSchema.parse(input)
    return gatewayTransaction(this.db, async (tx) => {
      const fallback = value.fallback === true
      const locked = await tx.$queryRaw<{ id: string; accountId: string | null }[]>`
        SELECT id, ${fallback ? Prisma.sql`fallback_account_id` : Prisma.sql`subscription_account_id`} AS "accountId"
        FROM llm_keys WHERE key_hash = ${value.keyHash} FOR UPDATE`
      const key = locked[0]
      if (!key) return { kind: 'refused', reason: 'unauthorized' }
      // A key without a fallback has nowhere else to go: what its own account says stands.
      if (key.accountId === null) return this.#refused(tx, key.id, 'subscription_limit')
      // The shared account row serializes slots across different keys and processes.
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${key.accountId}::uuid FOR UPDATE`
      // Fresh statement/clock after both waits: a pre-lock timestamp must never revive a key.
      const row = await this.#readKey(tx, value.keyHash, value.source, true, fallback)
      if (!row) return { kind: 'refused', reason: 'unauthorized' }
      const current = toKey(row)
      if (!current) return this.#refused(tx, row.keyId, 'profile')
      // On its fallback the call takes the route of that account's backend (ВР25).
      if ((fallback ? row.accountBackendId : current.backendId) !== value.backendId) {
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
      // No limit by default (КР10): only a stand that bounds its own requests sets one.
      const maxCalls = this.#maxCallsPerKey
      const maxPace = this.#maxCallsPerKey30s
      const [calls, recentCalls] = await Promise.all([
        maxCalls === null ? 0 : tx.llmCall.count({ where: { keyId: row.keyId } }),
        maxPace === null
          ? 0
          : tx.llmCall.count({
              where: {
                keyId: row.keyId,
                startedAt: { gt: new Date(row.serverNow.getTime() - callPaceMs) },
              },
            }),
      ])
      const overCalls = maxCalls !== null && calls >= maxCalls
      const overPace = maxPace !== null && recentCalls >= maxPace
      if (overCalls || overPace)
        return {
          ...(await this.#refused(tx, row.keyId, 'budget')),
          limit: overCalls ? 'calls' : 'pace',
        }
      const open = await tx.llmCall.count({ where: { keyId: row.keyId, state: 'open' } })
      if (open >= this.#maxRequestsPerKey) return this.#refused(tx, row.keyId, 'transient', 1_000)
      const price = await tx.llmModelPrice.findFirst({
        where: { modelId: row.modelId, effectiveFrom: { lte: row.serverNow } },
        orderBy: { effectiveFrom: 'desc' },
      })
      if (!price) return this.#refused(tx, row.keyId, 'profile')
      const rates = modelPrices(price)
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
      const blocked = accountRefusal(row, value.capacity)
      if (blocked === 'windows_unknown') {
        const refused = await this.#refused(tx, row.keyId, 'transient', unknownWindowsRetryMs)
        return { ...refused, probeAccount: true, limitsSeenAt: row.limitsSeenAt }
      }
      if (blocked) {
        // Out on its own account, with somewhere to go: not a refusal of the key (ВР25).
        if (blocked === 'subscription_limit' && !fallback && row.fallbackAccountId !== null)
          return { kind: 'refused', keyId: row.keyId, reason: blocked, fallBack: true }
        return this.#refused(tx, row.keyId, blocked)
      }
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
      if (row.breakerOpenUntil !== null) {
        // The account lock admits exactly one generation trial after the breaker expires.
        // Hold all other keys until this trial supplies real usage, or another 15 minutes pass.
        await tx.subscriptionAccount.update({
          where: { id: row.accountId },
          data: { breakerOpenUntil: new Date(finalClock!.instant.getTime() + USAGE_BREAKER_MS) },
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
    await gatewayTransaction(this.db, (tx) => recordRefusal(tx, keyId, reason))
  }

  finish(callId: string, outcome: GatewayFinish): Promise<boolean> {
    return this.#ledger.finish(callId, outcome)
  }

  collectLost(): Promise<number> {
    return this.#ledger.collectLost()
  }

  /**
   * `fallback`: the key read with its fallback account (ВР25) — an account of another, enabled
   * provider — instead of its own, which is of the provider of its model.
   */
  async #readKey(
    db: Pick<Transaction, '$queryRaw'>,
    hash: string,
    source: string,
    lock = false,
    fallback = false,
  ): Promise<KeyRow | null> {
    if (lock)
      await db.$queryRaw`SELECT m.id FROM llm_keys k
      JOIN llm_models m ON m.id = k.model_id JOIN llm_providers p ON p.id = m.provider_id
      WHERE k.key_hash = ${hash} FOR SHARE OF m, p`
    // All locks have already returned. clock_timestamp() and flags belong to this fresh statement.
    const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`SELECT ${keyColumns} FROM llm_keys k
      JOIN llm_models m ON m.id = k.model_id JOIN llm_providers p ON p.id = m.provider_id
      JOIN subscription_accounts a ON a.id = ${fallback ? Prisma.sql`k.fallback_account_id` : Prisma.sql`k.subscription_account_id`}
      JOIN llm_providers ap ON ap.id = a.provider_id
      JOIN credential_refs ref ON ref.id = a.credential_ref_id
      WHERE k.key_hash = ${hash} AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
        AND k.usage_closed_at IS NULL AND clock_timestamp() < k.expires_at
        AND (k.bound_source IS NULL OR k.bound_source = ${source}::inet)
        AND a.driver_id = k.driver_id
        AND ${
          fallback
            ? Prisma.sql`ap.id <> p.id AND ap.enabled AND ap.kind = 'subscription'`
            : Prisma.sql`a.provider_id = p.id`
        }`)
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
}

function toKey(row: KeyRow): GatewayKey | null {
  const backend = llmBackendIdSchema.safeParse(row.backendId)
  if (!backend.success || row.model === null) return null
  return {
    keyId: row.keyId,
    modelId: row.modelId,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
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
    maxConcurrentRequests: row.maxConcurrentRequests,
    fallback: fallbackOf(row),
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

function fallbackOf(row: KeyRow): GatewayKey['fallback'] {
  const backend = llmBackendIdSchema.safeParse(row.fallbackBackendId)
  return row.fallbackAccountId !== null && backend.success
    ? { accountId: row.fallbackAccountId, backendId: backend.data }
    : null
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
    key.reasoningEffort === profile.reasoningEffort
  )
}

/**
 * Admission of a running turn (p3-design §3.2 step 8): only a confirmed limit refuses for good.
 * A window past its reset has rolled over, so its old usage no longer applies; the next
 * probe reports the new period. Unknown windows hold the turn as short-lived until
 * a fresh probe, because an authoritative exhaustion or a malformed report clears them.
 * A backend without windows is held by the account's own pauses alone.
 */
function accountRefusal(
  row: KeyRow,
  capacity: LlmCapacity,
): GatewayRefusal | 'windows_unknown' | null {
  if (accountOff(row)) return 'account'
  // Existing keys drain normally during retirement; a new issue rejects it in pickAccount.
  if (row.breakerOpenUntil !== null && row.breakerOpenUntil > row.serverNow) return 'account'
  if (row.coolingUntil !== null && row.coolingUntil > row.serverNow) return 'subscription_limit'
  if (capacity === 'none') return null
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
