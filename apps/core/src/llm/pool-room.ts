import type { PrismaClient } from '@repo/db'
import {
  pickAccount,
  poolWaitIsLimitsOut,
  type LlmBackend,
  type PoolAccountSnapshot,
  platformDriverIds,
} from '@repo/domain'
import { decodeLimitWindows } from '@repo/turn-keys'

import { forecastOnlyWait, forecastWindows } from './pool-forecast.ts'
import type { PoolProbeClient } from './pool-probe-client.ts'

/**
 * Whether the pool of `backend` may take a new turn, or has its limits out (owner's answers of
 * 10.11.2026, docs/plan/68-agent-limits-out.md, and 13.11.2026, docs/plan/70-turn-without-time-
 * limit.md, ВР24): every account of it waits further than a pass waits for — the window of the
 * plan, an empty balance — or none of them is enabled. A pool that is only busy, or whose windows
 * are unknown, has room: its turns wait or probe as before. Read without a lock: the issue of the
 * key decides again under it; this only picks which backend a pass plans on.
 *
 * The pool is read as the issue reads it: windows with their forecast between probes and the
 * measured cost of a turn of the profile (`turnCostCredits`). On 19.11.2026 the probe alone said
 * «room», the forecast in the issue said «none», and a chat ended with its limits out while the
 * API stood by. A pool closed only by the forecast is probed first (`probe`), then read again;
 * without a probe it has room — the issue probes it before it refuses.
 */
export async function poolHasRoom(
  db: Pick<PrismaClient, '$queryRaw'>,
  backend: Pick<LlmBackend, 'id' | 'capacity'>,
  now: Date,
  options: { turnCostCredits?: number | null; probe?: PoolProbeClient; probed?: boolean } = {},
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
      closedPlanCredits: string | null
      openPlanCredits: string | null
    }>
  >`
    SELECT a.id, (a.enabled AND a.credential_version > 0 AND a.credentials_revoked_at IS NULL) AS enabled,
      a.status::text AS status, a.health::text AS health, a.health_reason AS "healthReason",
      a.health_changed_at AS "healthChangedAt", a.retire_requested_at AS "retireRequestedAt",
      a.cooling_until AS "coolingUntil", a.breaker_open_until AS "breakerOpenUntil",
      a.limit_windows AS "limitWindows", a.max_concurrent_turns AS "maxConcurrentTurns",
      a.last_used_at AS "lastUsedAt", p.enabled AS "providerEnabled",
      COALESCE((SELECT SUM(u.plan_credits) FROM token_usage u
        WHERE u.subscription_account_id = a.id AND a.limits_seen_at IS NOT NULL
          AND u.occurred_at >= a.limits_seen_at), 0)::text AS "closedPlanCredits",
      COALESCE((SELECT SUM(c.reserved_plan_credits) FROM llm_calls c
        WHERE c.subscription_account_id = a.id AND c.state = 'open'), 0)::text AS "openPlanCredits",
      (SELECT count(*) FROM llm_keys k
        WHERE k.subscription_account_id = a.id AND k.revoke_requested_at IS NULL
          AND k.revoked_at IS NULL AND k.expires_at > clock_timestamp()) AS "activeTurns"
    FROM subscription_accounts a JOIN llm_providers p ON p.id = a.provider_id
    WHERE p.slug = ${backend.id} AND p.kind = 'subscription'
      -- An account of quick edits never serves a turn (docs/plan/98-quick-edits.md, БПр16).
      AND a.driver_id <> ALL(${[...platformDriverIds]}::text[])`
  if (!accounts.some((account) => account.providerEnabled)) return false
  // No account that could serve a turn at all: the backend is no way out either.
  if (!accounts.some((account) => account.enabled && account.status === 'active')) return false
  const reported = accounts.map(
    ({ providerEnabled: _enabled, closedPlanCredits: _closed, openPlanCredits: _open, ...a }) => ({
      ...a,
      backend: backend.id,
      activeTurns: Number(a.activeTurns),
      limitWindows: decodeLimitWindows(a.limitWindows),
    }),
  )
  const pick = (snapshots: PoolAccountSnapshot[]) =>
    pickAccount({
      backend: backend.id,
      capacity: backend.capacity,
      providerEnabled: true,
      now,
      boundAccountId: null,
      rebinds: 0,
      policyFlagged: false,
      turnCostCredits: options.turnCostCredits ?? null,
      accounts: snapshots,
    })
  const decision = pick(
    reported.map((a, index) => ({
      ...a,
      limitWindows: forecastWindows(a.limitWindows, {
        closedSinceProbe: accounts[index]!.closedPlanCredits ?? '0',
        openReserved: accounts[index]!.openPlanCredits ?? '0',
      }),
    })),
  )
  if (decision.kind !== 'wait') return decision.kind !== 'operator'
  if (decision.reason === 'limits_unknown') return true
  // None enabled, or every one waits past what a pass waits for.
  const out = decision.reason === 'provider_disabled' || poolWaitIsLimitsOut(decision.retryAt, now)
  if (!out) return true
  const forecastOnly =
    backend.capacity === 'windows' ? forecastOnlyWait(decision, pick(reported)) : null
  // Probed already and still closed by the forecast (the probe failed or the role kept to its
  // five minutes): the next backend is the way out, as for any pool with its limits out.
  if (forecastOnly === null || options.probed === true) return false
  if (!options.probe) return true
  // What Z.ai reports decides: the role keeps to one probe per account in five minutes.
  const started = Date.now()
  await options.probe([forecastOnly], { stale: true }).catch(() => undefined)
  return poolHasRoom(db, backend, new Date(now.getTime() + (Date.now() - started)), {
    turnCostCredits: options.turnCostCredits ?? null,
    probed: true,
  })
}
