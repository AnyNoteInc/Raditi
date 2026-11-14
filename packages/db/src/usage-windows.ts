import {
  subscriptionAllowsTasks,
  usageWindowKinds,
  usageWindowLengthMs,
  windowCreditsSchema,
  windowLimitsOf,
  workspaceTierOfPlan,
  type SubscriptionStatus,
  type UsageWindowKind,
  type UsageWindowState,
  type WorkspaceTier,
} from '@repo/domain'

import { Prisma } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The windows of 5 hours and of the week of a workspace in SQL (docs/plan/71-usage-limits.md,
// §2.2): one place that reads them for the gateway `llm` (admission of a call), `@repo/billing`
// (a placement and the pages) and core (the pool and the operator) — `llm` may not reach
// `@repo/billing`, so the queries live here.

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>

/**
 * A call that took the quota of a subscription plan: its account's provider has plan rates
 * (`llm_plan_rates`). A call through an API paid by the token (`zai-api`) is not one: the
 * windows of a workspace share the plan, and a call of the API is bounded by credits alone
 * (owner's answer of 13.11.2026). Without plan rates no call counts — the gateway logs
 * `llm_plan_rates_missing` then (docs/plan/71-usage-limits.md).
 */
const PLAN_CALL = Prisma.sql`EXISTS (SELECT 1 FROM subscription_accounts a
  JOIN llm_plan_rates r ON r.provider_id = a.provider_id
  WHERE a.id = u.subscription_account_id)`

/** What a workspace is bounded by: the tier of its live paid tariff and its windows. */
export interface WorkspaceUsageTerms {
  tier: WorkspaceTier
  limits: Record<UsageWindowKind, number | null>
}

/**
 * The terms of the workspace at this moment (Л18): the plan of its live subscription while it
 * takes tasks, else those without a tariff. A change of the tariff applies at once, also inside an
 * open window.
 */
export async function workspaceUsageTerms(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  workspaceId: string,
): Promise<WorkspaceUsageTerms> {
  const rows = await db.$queryRaw<
    Array<{
      status: SubscriptionStatus
      slug: string
      creditsPer5h: number | null
      creditsPerWeek: number | null
    }>
  >`
    SELECT s.status::text AS status, p.slug, p.credits_per_5h AS "creditsPer5h",
      p.credits_per_week AS "creditsPerWeek"
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.workspace_id = ${workspaceId}::uuid
      AND s.status IN ('trial', 'active', 'past_due')
    LIMIT 1`
  const live = rows[0]
  if (live === undefined || !subscriptionAllowsTasks(live.status)) {
    return {
      tier: 'none',
      limits: windowLimitsOf(null),
    }
  }
  return {
    tier: workspaceTierOfPlan(live.slug),
    limits: windowLimitsOf({
      creditsPer5h: live.creditsPer5h,
      creditsPerWeek: live.creditsPerWeek,
    }),
  }
}

/**
 * The advisory lock of the windows of a workspace, held to the end of the transaction. Only the
 * admission of a call takes it, and before the lock of its key (docs/spec.md §9): no transaction
 * that holds rows of `billing_accounts` waits for it, so it closes no cycle with `lockWorkspace`.
 */
export async function lockUsageWindows(db: Db, workspaceId: string): Promise<void> {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage-window:${workspaceId}`}, 0))::text`
}

interface WindowRow {
  kind: UsageWindowKind
  startedAt: Date
  endsAt: Date
  used: string
}

/**
 * The windows of the workspace at `now` with what its work took in each (Л1, Л7): Σ
 * `cost_rub / rub_per_credit` by the credit rate in force at each `occurred_at`, over the
 * billable rows of its tasks in the open window. A window not open — '0', no reset: it starts with
 * the first call. A row without a rate in force counts nothing: no task is taken without one.
 */
export async function workspaceWindowUsage(
  db: Db,
  input: { workspaceId: string; now: Date; limits: Record<UsageWindowKind, number | null> },
): Promise<UsageWindowState[]> {
  const rows = await db.$queryRaw<WindowRow[]>`
    SELECT w.kind, w.started_at AS "startedAt", w.ends_at AS "endsAt",
      COALESCE((
        SELECT SUM(u.cost_rub / r.rub_per_credit)
        FROM token_usage u
        JOIN tasks t ON t.id = u.task_id
        CROSS JOIN LATERAL (
          SELECT c.rub_per_credit FROM credit_rates c
          WHERE c.effective_from <= u.occurred_at ORDER BY c.effective_from DESC LIMIT 1
        ) r
        WHERE t.workspace_id = w.workspace_id AND u.billable AND t.billable
          AND u.occurred_at >= w.started_at AND u.occurred_at < w.ends_at
          AND ${PLAN_CALL}
      ), 0)::numeric(14,4)::text AS used
    FROM workspace_usage_windows w
    WHERE w.workspace_id = ${input.workspaceId}::uuid
      AND w.started_at <= ${input.now} AND w.ends_at > ${input.now}`
  return usageWindowKinds.map((kind) => {
    const open = rows.find((row) => row.kind === kind)
    return {
      kind,
      limit: input.limits[kind],
      used: open === undefined ? '0' : windowCreditsSchema.parse(open.used),
      resetsAt: open?.endsAt ?? null,
    }
  })
}

/**
 * What the open calls of the workspace have set aside, in credits at the rate in force at `now`
 * (Л19): a call is counted against the window from its admission, not only once it closed.
 */
export async function openReservedWindowCredits(
  db: Db,
  input: { workspaceId: string; now: Date },
): Promise<string> {
  const [row] = await db.$queryRaw<{ credits: string }[]>`
    SELECT COALESCE(SUM(c.reserved_rub) / NULLIF((
      SELECT r.rub_per_credit FROM credit_rates r
      WHERE r.effective_from <= ${input.now} ORDER BY r.effective_from DESC LIMIT 1
    ), 0), 0)::numeric(14,4)::text AS credits
    FROM llm_calls c
    JOIN llm_keys k ON k.id = c.key_id
    JOIN tasks t ON t.id = k.task_id
    WHERE t.workspace_id = ${input.workspaceId}::uuid AND c.state = 'open' AND t.billable
      AND EXISTS (SELECT 1 FROM subscription_accounts a
        JOIN llm_plan_rates r ON r.provider_id = a.provider_id
        WHERE a.id = c.subscription_account_id)`
  return windowCreditsSchema.parse(row?.credits ?? '0')
}

/**
 * Opens the windows of the workspace that are not open at `now`, from `now` for their length
 * (Л3). Under `lockUsageWindows`: a window of a kind opens only after the last one ended, so two
 * first calls at once open one window. Returns the kinds it opened.
 */
export async function openUsageWindows(
  db: Db,
  input: { workspaceId: string; now: Date },
): Promise<UsageWindowKind[]> {
  const open = await db.$queryRaw<{ kind: UsageWindowKind }[]>`
    SELECT kind FROM workspace_usage_windows
    WHERE workspace_id = ${input.workspaceId}::uuid AND ends_at > ${input.now}`
  const opened: UsageWindowKind[] = []
  for (const kind of usageWindowKinds) {
    if (open.some((row) => row.kind === kind)) continue
    const endsAt = new Date(input.now.getTime() + usageWindowLengthMs[kind])
    await db.$executeRaw`
      INSERT INTO workspace_usage_windows (id, workspace_id, kind, started_at, ends_at)
      VALUES (${uuidv7()}::uuid, ${input.workspaceId}::uuid, ${kind}, ${input.now}, ${endsAt})`
    opened.push(kind)
  }
  return opened
}
