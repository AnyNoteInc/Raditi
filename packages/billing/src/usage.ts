import type { Prisma } from '@repo/db'
import {
  creditAccountKinds,
  creditAccountUnits,
  liveSubscriptionStatuses,
  tasksPerDayWithoutTariff,
  toCredits,
  type CreditAccountKind,
} from '@repo/domain'
import { z } from 'zod'

import {
  usageHistoryPageSchema,
  usageHistoryQuerySchema,
  usageSummarySchema,
  type CreditsOverviewDto,
  type TariffUsageDto,
  type UsageHistoryPageDto,
  type UsageHistoryQuery,
  type UsageSummaryDto,
} from './dto.ts'
import { countLaunchesToday } from './holds.ts'
import { getCreditsOverview, getPlanOverview } from './read-models.ts'

// The read model of «Настройки → Использование»: how many credits are left and what they went
// to. Nothing is written here; everything is read from the accounts, the reserves and the
// ledger.
//
// Credits of the tariff belong to a period, and a row says its period by a stamp, never by the
// clock it was written at (docs/research/2026-10-credits/credits-design.md, §4.3):
// - a reserve row by `credit_holds.created_at`, which `placeCreditHold` sets inside the period
//   the credits are taken from;
// - a charge of the tariff account from its credits of now (`task:<taskId>:charge:<accountId>`)
//   by its own `created_at`, which `settleTaskCharge` sets the same way;
// - what a reserve of an ended period paid or lost (`hold:<holdId>:charge`,
//   `hold:<holdId>:expire`) by the stamp of that reserve row;
// - the quota by the order it was paid with: `orders.period_start` is the start of its period;
// - the remainder that expired when a period ended (`sub:<subscriptionId>:<periodEndMs>:expire`)
//   belongs to the period in its key, the one that ended — although the renewal writes it in
//   the transaction that grants the next quota.
// So a task that was queued before a renewal and finished after it is counted in the period
// that ended, and the numbers of a period add up to what it was granted.
//
// Before the task queue of P12 nothing places a reserve: a workspace then has its quota, its
// gift and purchased credits and its sites, and no line of history.

type Reader = Prisma.TransactionClient
type HistoryReader = Pick<Reader, '$queryRaw'>

const summaryInputSchema = z.strictObject({ workspaceId: z.uuid(), now: z.date() })
export type UsageSummaryInput = z.infer<typeof summaryInputSchema>

const CREDIT_UNITS = Object.values(creditAccountUnits)
const LIVE_STATUSES = [...liveSubscriptionStatuses]

interface MeterRow {
  granted: string
  charged: string
  expired: string
  held: string
  heldEarlier: string
  left: string
}

/**
 * The meter of the current period of the live subscription, on the tariff account — every part
 * read from the ledger and the reserves by the stamp that says its period:
 * - `granted`: the quota of the order that paid for this period, and what an operator added to
 *   the account since it started;
 * - `charged`: charges from credits of this period — rows of the account stamped in it, and
 *   what reserve rows stamped in it paid once the tariff no longer took tasks;
 * - `held`: active reserve rows stamped in this period;
 * - `expired`: what reserve rows stamped in this period lost, and what an operator took off the
 *   account since it started;
 * - `left`: `balance − held` of the account;
 * - `heldEarlier`, beside the meter: active reserve rows stamped before this period.
 *
 * One statement, so the parts are of one instant and add up: what is left of earlier periods on
 * the account is exactly `heldEarlier`, and everything else on it came with this period.
 * null without a live subscription; zeros while the workspace has no tariff account.
 */
async function tariffMeter(
  db: HistoryReader,
  workspaceId: string,
): Promise<TariffUsageDto['credits'] | null> {
  const [row] = await db.$queryRaw<MeterRow[]>`
    WITH live AS (
      SELECT s.current_period_start AS since
      FROM subscriptions s
      WHERE s.workspace_id = ${workspaceId}::uuid
        AND s.status = ANY(${LIVE_STATUSES}::"SubscriptionStatus"[])
    ), account AS (
      SELECT a.id, a.balance, a.held
      FROM billing_accounts a
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND a.unit = ${creditAccountUnits.tariff}::"BillingUnit"
    ), entries AS (
      SELECT l.kind, l.amount,
        CASE l.kind
          WHEN 'grant' THEN o.period_start = live.since
          WHEN 'charge' THEN COALESCE(h.created_at, l.created_at) >= live.since
          WHEN 'expire' THEN h.created_at >= live.since
          WHEN 'adjust' THEN l.created_at >= live.since
          ELSE false
        END AS current
      FROM account
      CROSS JOIN live
      JOIN credit_ledger l ON l.account_id = account.id
      LEFT JOIN orders o ON o.id = l.order_id
      LEFT JOIN credit_holds h ON h.task_id = l.task_id
        AND l.idempotency_key IN ('hold:' || h.id::text || ':charge', 'hold:' || h.id::text || ':expire')
    ), reserves AS (
      SELECT h.amount, h.created_at >= live.since AS current
      FROM account
      CROSS JOIN live
      JOIN credit_holds h ON h.account_id = account.id AND h.status = 'active'
    )
    SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM entries
        WHERE current AND (kind = 'grant' OR (kind = 'adjust' AND amount > 0)))::text AS granted,
      (SELECT COALESCE(-SUM(amount), 0) FROM entries
        WHERE current AND kind = 'charge')::text AS charged,
      (SELECT COALESCE(-SUM(amount), 0) FROM entries
        WHERE current AND (kind = 'expire' OR (kind = 'adjust' AND amount < 0)))::text AS expired,
      (SELECT COALESCE(SUM(amount), 0) FROM reserves WHERE current)::text AS held,
      (SELECT COALESCE(SUM(amount), 0) FROM reserves WHERE NOT current)::text AS "heldEarlier",
      COALESCE((SELECT balance - held FROM account), 0)::text AS left
    FROM live
  `
  if (row === undefined) return null
  return {
    granted: toCredits(row.granted),
    charged: toCredits(row.charged),
    held: toCredits(row.held),
    expired: toCredits(row.expired),
    left: toCredits(row.left),
    heldEarlier: toCredits(row.heldEarlier),
  }
}

interface SiteUsageRow {
  siteId: string
  name: string
  credits: number
}

/**
 * Credits charged per site in the period that started at `since`, on every credit account: the
 * `charge` rows of the ledger, each found by the task it is linked to (`credit_ledger.task_id`)
 * and counted in the period its stamp says. A row a reserve of an ended period paid —
 * `hold:<holdId>:charge` — takes the stamp of that reserve row, every other row its own. So a
 * task continued across a renewal may stand here in two periods, each with what it took of it.
 */
function chargedBySite(
  db: HistoryReader,
  workspaceId: string,
  since: Date,
): Promise<SiteUsageRow[]> {
  return db.$queryRaw<SiteUsageRow[]>`
    SELECT s.id AS "siteId", s.name, (-SUM(l.amount))::int AS credits
    FROM credit_ledger l
    JOIN billing_accounts a ON a.id = l.account_id
    JOIN tasks t ON t.id = l.task_id
    JOIN sites s ON s.id = t.site_id
    LEFT JOIN credit_holds h ON h.task_id = l.task_id
      AND l.idempotency_key = 'hold:' || h.id::text || ':charge'
    WHERE a.workspace_id = ${workspaceId}::uuid
      AND a.unit = ANY(${CREDIT_UNITS}::"BillingUnit"[])
      AND l.kind = 'charge'
      AND COALESCE(h.created_at, l.created_at) >= ${since}::timestamptz
    GROUP BY s.id, s.name
    HAVING SUM(l.amount) < 0
    ORDER BY credits DESC, s.name ASC, s.id ASC
  `
}

type ByAccount<Prefix extends string> = Record<`${Prefix}${Capitalize<CreditAccountKind>}`, number>

interface HistoryRow extends ByAccount<'held'>, ByAccount<'paid'> {
  id: string
  at: Date
  outcome: 'held' | 'charged' | 'unpaid' | 'free'
  taskId: string
  title: string | null
  status: string
  siteId: string
  siteName: string
}

const byAccount = (row: HistoryRow, prefix: 'held' | 'paid') => ({
  tariff: row[`${prefix}Tariff`],
  gift: row[`${prefix}Gift`],
  pack: row[`${prefix}Pack`],
})

/** What a line of the history took: the charge of a done task, the reserve of one in work. */
function entryCredits(row: HistoryRow) {
  if (row.outcome !== 'charged' && row.outcome !== 'held') return { credits: null, from: null }
  const from = byAccount(row, row.outcome === 'charged' ? 'paid' : 'held')
  return { credits: creditAccountKinds.reduce((sum, kind) => sum + from[kind], 0), from }
}

/**
 * One page of the history, newest first: one line per task that set credits aside — whatever
 * attempts it took and on whichever accounts —, and every undo, which takes no credit and so
 * has no reserve.
 *
 * `since` is the start of the period the page is of. A task belongs to the period of its first
 * reserve: the earliest stamp of its reserve rows (`credit_holds.created_at`) is not before
 * `since`. null — a workspace without a live subscription has no period — puts no lower bound
 * on the history: every task of the workspace is in it.
 *
 * The line of a task stands at the moment its first reserve was placed (`placed_at`) and says
 * what the task cost as a whole: `held` while a reserve row is active, with what its active
 * rows set aside; `charged` once its reserve was captured, with every credit the task was
 * charged — on each account and, for a task continued across a renewal, in both periods, while
 * the meter counts each ledger row in its own; `unpaid` when its reserve came back without a
 * charge — it failed, was cancelled or was rolled back. Whether tariff credits of that reserve
 * returned or expired with their period is not a line of the history: they were never the
 * customer's loss.
 *
 * The order is `(at, id)`, the id of a line being its task; the cursor is the id of the last
 * line of the previous page, and the database compares the next page with that line itself, so
 * the microseconds a Date would lose do not skip or repeat a line. A cursor that is not a line
 * of this period gives an empty page.
 */
async function historyPage(
  db: HistoryReader,
  workspaceId: string,
  since: Date | null,
  query: UsageHistoryQuery,
): Promise<UsageHistoryPageDto> {
  const { cursor = null, limit } = usageHistoryQuerySchema.parse(query)
  const { tariff, gift, pack } = creditAccountUnits
  const rows = await db.$queryRaw<HistoryRow[]>`
    WITH entries AS (
      SELECT h.task_id AS id, MIN(h.placed_at) AS at, h.task_id,
        CASE
          WHEN bool_or(h.status = 'active') THEN 'held'
          WHEN bool_or(h.status = 'captured') THEN 'charged'
          ELSE 'unpaid'
        END AS outcome,
        COALESCE(SUM(h.amount) FILTER (
          WHERE h.status = 'active' AND a.unit = ${tariff}::"BillingUnit"), 0)::int AS "heldTariff",
        COALESCE(SUM(h.amount) FILTER (
          WHERE h.status = 'active' AND a.unit = ${gift}::"BillingUnit"), 0)::int AS "heldGift",
        COALESCE(SUM(h.amount) FILTER (
          WHERE h.status = 'active' AND a.unit = ${pack}::"BillingUnit"), 0)::int AS "heldPack"
      FROM credit_holds h
      JOIN billing_accounts a ON a.id = h.account_id
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND a.unit = ANY(${CREDIT_UNITS}::"BillingUnit"[])
      GROUP BY h.task_id
      HAVING ${since}::timestamptz IS NULL OR MIN(h.created_at) >= ${since}::timestamptz
      UNION ALL
      SELECT undo.id, undo.created_at, undo.id, 'free', 0, 0, 0
      FROM tasks undo
      WHERE undo.workspace_id = ${workspaceId}::uuid
        AND undo.reverts_task_id IS NOT NULL
        AND (${since}::timestamptz IS NULL OR undo.created_at >= ${since}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM credit_holds taken WHERE taken.task_id = undo.id)
    )
    SELECT e.id, e.at, e.outcome, e."heldTariff", e."heldGift", e."heldPack",
      paid."paidTariff", paid."paidGift", paid."paidPack", t.id AS "taskId",
      NULLIF(btrim(t.summary), '') AS title, t.status::text AS status,
      s.id AS "siteId", s.name AS "siteName"
    FROM entries e
    JOIN tasks t ON t.id = e.task_id
    JOIN sites s ON s.id = t.site_id
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(-SUM(l.amount) FILTER (WHERE l.unit = ${tariff}::"BillingUnit"), 0)::int
          AS "paidTariff",
        COALESCE(-SUM(l.amount) FILTER (WHERE l.unit = ${gift}::"BillingUnit"), 0)::int
          AS "paidGift",
        COALESCE(-SUM(l.amount) FILTER (WHERE l.unit = ${pack}::"BillingUnit"), 0)::int
          AS "paidPack"
      FROM credit_ledger l
      WHERE l.task_id = e.task_id AND l.kind = 'charge'
    ) paid
    WHERE ${cursor}::uuid IS NULL OR (e.at, e.id) < (
      SELECT last.at, last.id FROM entries last WHERE last.id = ${cursor}::uuid
    )
    ORDER BY e.at DESC, e.id DESC
    LIMIT ${limit + 1}::int
  `
  const items = rows.slice(0, limit)
  return usageHistoryPageSchema.parse({
    items: items.map((row) => ({
      id: row.id,
      at: row.at,
      outcome: row.outcome,
      ...entryCredits(row),
      task: { id: row.taskId, title: row.title, status: row.status },
      site: { id: row.siteId, name: row.siteName },
    })),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  })
}

/**
 * A page of the usage history of the workspace, newest first (`historyPage`): the lines of the
 * current period of its live subscription, or, without a live subscription, every line it has —
 * there is no period then, and the history has no lower bound.
 */
export async function listUsageHistory(
  db: Pick<Reader, 'subscription' | '$queryRaw'>,
  workspaceId: string,
  query: UsageHistoryQuery = {},
): Promise<UsageHistoryPageDto> {
  // Checked before anything is read, as the page itself would.
  const checked = usageHistoryQuerySchema.parse(query)
  // Not findUnique: the unique index on workspace_id covers live rows only.
  const live = await db.subscription.findFirst({
    where: { workspaceId, status: { in: LIVE_STATUSES } },
    select: { currentPeriodStart: true },
  })
  return historyPage(db, workspaceId, live?.currentPeriodStart ?? null, checked)
}

/** What a credits overview tells of a new task, beside the accounts. */
const taskCreditsOf = (overview: CreditsOverviewDto) => ({
  spendable: overview.spendable,
  setAside: overview.setAside,
  minToStart: overview.minToStart,
  today: overview.today,
  newTask: overview.newTask,
})

/**
 * «Настройки → Использование» of a workspace at `now`: the live subscription, the meter of its
 * current period (`tariffMeter`), the launches of today against the daily limit of the plan,
 * the sites against its site limit, the credits charged per site, the gift credits and the
 * purchased ones, the first page of the history, and whether a new task would be taken
 * (`getCreditsOverview`). A workspace without a live subscription has «no tariff»: its gift
 * and purchased credits, the launches of today against what a day takes without a tariff, and
 * its whole history.
 *
 * The meter is one statement and adds up by itself. The other parts are read one after another
 * under READ COMMITTED and may be a moment apart; pass a snapshot transaction to read them as
 * of one instant.
 */
export async function getUsageSummary(
  db: Reader,
  input: UsageSummaryInput,
): Promise<UsageSummaryDto> {
  const { workspaceId, now } = summaryInputSchema.parse(input)
  const [{ subscription }, overview, usedToday] = await Promise.all([
    getPlanOverview(db, workspaceId),
    getCreditsOverview(db, { workspaceId, now }),
    countLaunchesToday(db, { workspaceId, now }),
  ])
  const gift = {
    left: overview.gift.available,
    held: overview.gift.held,
    granted: overview.gift.granted,
  }
  const pack = { left: overview.pack.available, held: overview.pack.held }
  const credits = subscription === null ? null : await tariffMeter(db, workspaceId)
  if (subscription === null || credits === null) {
    // What is left on the tariff account of an ended tariff is not the customer's to spend.
    return usageSummarySchema.parse({
      subscription: null,
      tariff: null,
      trial: { today: usedToday, perDay: tasksPerDayWithoutTariff },
      gift,
      pack,
      totalLeft: gift.left + pack.left,
      history: await historyPage(db, workspaceId, null, {}),
      ...taskCreditsOf(overview),
    })
  }

  const since = subscription.period.start
  const [siteCount, bySite, history] = await Promise.all([
    // Every site of the workspace, whatever its status: the count project.create and a
    // checkout compare with the plan.
    db.site.count({ where: { workspaceId } }),
    chargedBySite(db, workspaceId, since),
    historyPage(db, workspaceId, since, {}),
  ])
  return usageSummarySchema.parse({
    subscription,
    tariff: {
      credits,
      today: { used: usedToday, limit: subscription.plan.tasksPerDay },
      sites: { count: siteCount, max: subscription.plan.maxSites },
      bySite,
    },
    trial: null,
    gift,
    pack,
    totalLeft: credits.left + gift.left + pack.left,
    history,
    ...taskCreditsOf(overview),
  })
}

/**
 * «Настройки → Использование» of a user who has no personal workspace: no tariff, nothing
 * purchased, no history, and the gift of the registration with the answer about the first task
 * as `promised` tells them (`getPromisedCreditsOverview`) — promised until the workspace is
 * made, unless the user was granted it elsewhere.
 */
export function promisedUsage(promised: CreditsOverviewDto): UsageSummaryDto {
  const { gift, pack, totalAvailable } = promised
  return usageSummarySchema.parse({
    subscription: null,
    tariff: null,
    trial: { today: 0, perDay: tasksPerDayWithoutTariff },
    gift: { left: gift.available, held: gift.held, granted: gift.granted },
    pack: { left: pack.available, held: pack.held },
    totalLeft: totalAvailable,
    history: { items: [], nextCursor: null },
    ...taskCreditsOf(promised),
  })
}
