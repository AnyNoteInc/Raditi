import type { Prisma } from '@repo/db'
import { creditAccountUnits } from '@repo/domain'
import { z } from 'zod'

// The read model of the charts of «Настройки → Использование»: day by day, what the customer
// did in the chats of a workspace and how many credits were charged for the work. Nothing is
// written here.
//
// - An action is a `feed.request` row: a message, an answer, a command, «Продолжить»,
//   «Попробовать ещё» — whatever the customer wrote or pressed in a chat of the workspace.
// - The credits are the `charge` entries of the credit accounts of the workspace, by the moment
//   they were written, in three parts — the accounts they came from: the tariff, the gift and
//   the pack, in the order credits are spent. A reserve still in work is not charged yet.
// Days are those of Moscow, as the day of the tariff.

export const ACTIVITY_TIME_ZONE = 'Europe/Moscow'

/** The spans the page reads: a week and a month of credits, a year of actions. */
export const usageActivitySpans = [7, 30, 365] as const

export const usageActivityQuerySchema = z.strictObject({
  days: z.union([
    z.literal(usageActivitySpans[0]),
    z.literal(usageActivitySpans[1]),
    z.literal(usageActivitySpans[2]),
  ]),
})
export type UsageActivityQuery = z.infer<typeof usageActivityQuerySchema>

const count = z.number().int().nonnegative()

export const usageActivityDaySchema = z.strictObject({
  /** The day in Moscow, `YYYY-MM-DD`. */
  date: z.iso.date(),
  actions: count,
  credits: z.strictObject({ tariff: count, gift: count, pack: count }),
})
export type UsageActivityDayDto = z.infer<typeof usageActivityDaySchema>

/** The days of the span, oldest first, today last; a day without anything is zeros. */
export const usageActivitySchema = z.strictObject({ days: z.array(usageActivityDaySchema) })
export type UsageActivityDto = z.infer<typeof usageActivitySchema>

const inputSchema = z.strictObject({
  workspaceId: z.uuid(),
  days: usageActivityQuerySchema.shape.days,
  now: z.date(),
})
export type UsageActivityInput = z.infer<typeof inputSchema>

interface ActivityRow {
  date: string
  actions: number
  tariff: number
  gift: number
  pack: number
}

const { tariff, gift, pack } = creditAccountUnits

export async function getUsageActivity(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: UsageActivityInput,
): Promise<UsageActivityDto> {
  const { workspaceId, days, now } = inputSchema.parse(input)
  const rows = await db.$queryRaw<ActivityRow[]>`
    WITH today AS (
      SELECT (${now}::timestamptz AT TIME ZONE ${ACTIVITY_TIME_ZONE})::date AS day
    ),
    span AS (
      SELECT (today.day - g.n) AS day
      FROM today, generate_series(0, ${days}::int - 1) AS g(n)
    ),
    since AS (
      SELECT (min(day)::timestamp AT TIME ZONE ${ACTIVITY_TIME_ZONE}) AS at FROM span
    ),
    actions AS (
      SELECT (e.created_at AT TIME ZONE ${ACTIVITY_TIME_ZONE})::date AS day, count(*)::int AS n
      FROM task_events e
      JOIN tasks t ON t.id = e.task_id
      WHERE t.workspace_id = ${workspaceId}::uuid
        AND e.client_visible AND e.type = 'feed.request'
        AND e.created_at >= (SELECT at FROM since)
      GROUP BY 1
    ),
    credits AS (
      SELECT (l.created_at AT TIME ZONE ${ACTIVITY_TIME_ZONE})::date AS day,
        -sum(l.amount) FILTER (WHERE a.unit = ${tariff}::"BillingUnit") AS tariff,
        -sum(l.amount) FILTER (WHERE a.unit = ${gift}::"BillingUnit") AS gift,
        -sum(l.amount) FILTER (WHERE a.unit = ${pack}::"BillingUnit") AS pack
      FROM credit_ledger l
      JOIN billing_accounts a ON a.id = l.account_id
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND l.kind = 'charge'
        AND l.created_at >= (SELECT at FROM since)
      GROUP BY 1
    )
    SELECT to_char(s.day, 'YYYY-MM-DD') AS date,
      coalesce(a.n, 0) AS actions,
      coalesce(k.tariff, 0)::int AS tariff,
      coalesce(k.gift, 0)::int AS gift,
      coalesce(k.pack, 0)::int AS pack
    FROM span s
    LEFT JOIN actions a ON a.day = s.day
    LEFT JOIN credits k ON k.day = s.day
    ORDER BY s.day
  `
  return usageActivitySchema.parse({
    days: rows.map((row) => ({
      date: row.date,
      actions: row.actions,
      credits: { tariff: row.tariff, gift: row.gift, pack: row.pack },
    })),
  })
}
