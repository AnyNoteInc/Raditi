import type { PrismaClient } from '@repo/db'
import {
  pickAccount,
  poolWaitIsLimitsOut,
  type LlmBackend,
  type PoolAccountSnapshot,
} from '@repo/domain'
import { decodeLimitWindows } from '@repo/turn-keys'

/**
 * Whether the pool of `backend` may take a new turn, or has its limits out (owner's answers of
 * 10.11.2026, docs/plan/68-agent-limits-out.md, and 13.11.2026, docs/plan/70-turn-without-time-
 * limit.md, ВР24): every account of it waits further than a pass waits for — the window of the
 * plan, an empty balance — or none of them is enabled. A pool that is only busy, or whose windows
 * are unknown, has room: its turns wait or probe as before. Read without a lock: the issue of the
 * key decides again under it; this only picks which backend a pass plans on.
 */
export async function poolHasRoom(
  db: Pick<PrismaClient, '$queryRaw'>,
  backend: Pick<LlmBackend, 'id' | 'capacity'>,
  now: Date,
): Promise<boolean> {
  const accounts = await db.$queryRaw<
    Array<{
      id: string
      enabled: boolean
      status: PoolAccountSnapshot['status']
      health: PoolAccountSnapshot['health']
      healthReason: string | null
      healthChangedAt: Date | null
      retireRequestedAt: Date | null
      coolingUntil: Date | null
      breakerOpenUntil: Date | null
      limitWindows: unknown
      activeTurns: bigint
      maxConcurrentTurns: number
      lastUsedAt: Date | null
      providerEnabled: boolean
    }>
  >`
    SELECT a.id, (a.enabled AND a.credential_version > 0 AND a.credentials_revoked_at IS NULL) AS enabled,
      a.status::text AS status, a.health::text AS health, a.health_reason AS "healthReason",
      a.health_changed_at AS "healthChangedAt", a.retire_requested_at AS "retireRequestedAt",
      a.cooling_until AS "coolingUntil", a.breaker_open_until AS "breakerOpenUntil",
      a.limit_windows AS "limitWindows", a.max_concurrent_turns AS "maxConcurrentTurns",
      a.last_used_at AS "lastUsedAt", p.enabled AS "providerEnabled",
      (SELECT count(*) FROM llm_keys k
        WHERE k.subscription_account_id = a.id AND k.revoke_requested_at IS NULL
          AND k.revoked_at IS NULL AND k.expires_at > clock_timestamp()) AS "activeTurns"
    FROM subscription_accounts a JOIN llm_providers p ON p.id = a.provider_id
    WHERE p.slug = ${backend.id} AND p.kind = 'subscription'`
  if (!accounts.some((account) => account.providerEnabled)) return false
  // No account that could serve a turn at all: the backend is no way out either.
  if (!accounts.some((account) => account.enabled && account.status === 'active')) return false
  const decision = pickAccount({
    backend: backend.id,
    capacity: backend.capacity,
    providerEnabled: true,
    now,
    boundAccountId: null,
    rebinds: 0,
    policyFlagged: false,
    accounts: accounts.map(({ providerEnabled: _enabled, ...account }) => ({
      ...account,
      backend: backend.id,
      activeTurns: Number(account.activeTurns),
      limitWindows: decodeLimitWindows(account.limitWindows),
    })),
  })
  if (decision.kind !== 'wait') return decision.kind !== 'operator'
  if (decision.reason === 'limits_unknown') return true
  // None enabled, or every one waits past what a pass waits for.
  return decision.reason !== 'provider_disabled' && !poolWaitIsLimitsOut(decision.retryAt, now)
}
