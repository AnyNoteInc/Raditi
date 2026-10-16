import {
  badRequest,
  billingCreditRateMissing,
  creditAccountUnits,
  creditRateCoversPrice,
  creditRateVerdict,
  creditsFromCost,
  Money,
  toCredits,
  type CostAtRate,
  type CreditRateVerdict,
  type Credits,
} from '@repo/domain'
import type { Decimal } from 'decimal.js'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'

// The credit rate K and what it turns into credits (spec §17, «Учётные ставки»): the row of
// `credit_rates` in force at a moment, whether credits can be reserved by it, the recorded model
// calls of a task in credits and the work of a workspace in credits. Read only: the rows of
// `credit_rates` and of `llm_model_prices` are written by the operator's `approveCreditRate`.
// Every function joins the transaction of its caller.

/**
 * The most one turn key may hold, RUB (`llm_keys_budget_check`, `attemptBudgetRub` of
 * @repo/domain). A step of an attempt above it is spent through several keys in a row.
 */
export const TURN_KEY_LIMIT_RUB = 750

/** A row of `credit_rates`. */
export interface StoredCreditRate {
  id: string
  /** Whole milliseconds (CHECK of the table): a Date holds it exactly. */
  effectiveFrom: Date
  /** K as the column prints it, "6.000000": RUB of accounting cost in one credit. */
  rubPerCredit: string
  basis: string
}

const instantSchema = z.date().refine((value) => Number.isFinite(value.getTime()))

function requireInstant(value: Date, what: string): Date {
  if (!instantSchema.safeParse(value).success) throw badRequest(`Invalid ${what}`)
  return value
}

/**
 * The credit rate in force at `at`: the row with the greatest `effective_from` that is not
 * later than it, or null when no rate had started by then. A model call is turned into credits
 * at the rate of its own start, so `at` is `token_usage.occurred_at` for a call and the clock
 * for a reserve.
 */
export async function creditRateAt(
  tx: Pick<BillingTx, 'creditRate'>,
  at: Date,
): Promise<StoredCreditRate | null> {
  const row = await tx.creditRate.findFirst({
    where: { effectiveFrom: { lte: requireInstant(at, 'moment of a credit rate') } },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true, effectiveFrom: true, rubPerCredit: true, basis: true },
  })
  return row === null ? null : { ...row, rubPerCredit: row.rubPerCredit.toFixed(6) }
}

/** Whether credits can be reserved, and the rate the answer is about. */
export interface CreditRateStatus {
  /**
   * `usable`; `missing` — no rate is in force; `stale` — one is, and a price in force of an
   * enabled model started after it, so the calls of that model could not be converted.
   */
  verdict: CreditRateVerdict
  /** The rate in force at the moment asked about; null when the verdict is `missing`. */
  rate: StoredCreditRate | null
}

/**
 * Whether a reserve may be placed at `now` (`creditRateVerdict` of @repo/domain): a rate is in
 * force and it is not older than the newest price in force of an enabled model — a model with
 * `llm_models.enabled`, whatever the switch of its provider says. Without enabled models, or
 * while none of them has a price in force, a rate in force is usable.
 */
export async function creditRateStatus(
  tx: Pick<BillingTx, 'creditRate' | 'llmModelPrice'>,
  now: Date,
): Promise<CreditRateStatus> {
  const rate = await creditRateAt(tx, now)
  // The newest price in force among the enabled models: the one the rate must cover.
  const newest =
    rate === null
      ? null
      : await tx.llmModelPrice.findFirst({
          where: { effectiveFrom: { lte: now }, model: { enabled: true } },
          orderBy: { effectiveFrom: 'desc' },
          select: { effectiveFrom: true },
        })
  const verdict = creditRateVerdict({
    now,
    rate: rate === null ? null : { effectiveFrom: rate.effectiveFrom },
    prices: newest === null ? [] : [newest],
  })
  return { verdict, rate }
}

/**
 * The rate a reserve is placed by at `now`; BILLING_CREDIT_RATE_MISSING when no rate is in
 * force or the one in force is older than a price of an enabled model.
 */
export async function requireUsableCreditRate(
  tx: Pick<BillingTx, 'creditRate' | 'llmModelPrice'>,
  now: Date,
): Promise<StoredCreditRate> {
  const { verdict, rate } = await creditRateStatus(tx, now)
  if (verdict !== 'usable' || rate === null) throw billingCreditRateMissing()
  return rate
}

const attemptsSchema = z
  .array(z.number().int().min(1).max(2_147_483_647))
  .min(1)
  .max(100)
  .refine((attempts) => new Set(attempts).size === attempts.length)
const taskWorkSchema = z.strictObject({ taskId: z.uuid(), attempts: attemptsSchema })

export interface TaskWorkQuery {
  taskId: string
  /**
   * The attempts whose calls are summed: for a charge, the attempts of the chain — those that
   * have an active reserve row. The caller knows them; a failed attempt is simply not named.
   */
  attempts: readonly number[]
}

/** The counted calls of one attempt. */
export interface AttemptRawCredits {
  attempt: number
  /** Σ `token_usage.cost_rub` of the counted calls, ten decimals. */
  costRub: string
  /** The same work in credits, not rounded. */
  credits: Decimal
}

/**
 * The counted model calls of a task in credits, before any rounding — or the word that they
 * cannot be converted yet, never a number that silently leaves a call out.
 */
export type TaskRawCredits =
  | {
      convertible: true
      /** Σ over the attempts, not rounded: what `taskCharge` rounds once. */
      credits: Decimal
      /** Σ `token_usage.cost_rub` of the counted calls, ten decimals. */
      costRub: string
      /** One entry per attempt asked for, in the order asked; zeros for one without calls. */
      attempts: AttemptRawCredits[]
    }
  | {
      convertible: false
      /** Counted calls that started while no credit rate was in force. */
      callsWithoutRate: number
      /** Counted calls whose price row is newer than the credit rate in force at their start. */
      callsWithStaleRate: number
    }

interface TaskWorkRow {
  attempt: number
  rubPerCredit: string | null
  rateFrom: Date | null
  priceFrom: Date
  costRub: string
  calls: number
}

const sumCostRub = (rows: readonly { costRub: string }[]): string =>
  rows.reduce((sum, row) => sum.plus(row.costRub), new Money(0)).toFixed(10)

/**
 * What the model calls of a task come to in credits (design §1.2): the `token_usage` rows of
 * the named attempts that are billable, except the rows of a key whose turn (`task_turns` by
 * task and `llm_keys.turn_no`) ended `lost`; each call divided by the credit rate in force at
 * its own start (`occurred_at`), so an attempt that crosses a change of the rate needs no
 * special case. A key without a turn row counts: the queue writes turn rows from P12 on.
 *
 * A call is convertible only when a rate was in force at its start and that rate is not older
 * than the price row the call was costed with (`creditRateCoversPrice`). While one counted call
 * is not, the answer is `convertible: false` with the two counts, and the task is not charged.
 * Nothing is rounded here: SQL sums the cost per attempt, rate row and price row, and
 * `creditsFromCost` divides.
 */
export async function taskRawCredits(
  tx: Pick<BillingTx, '$queryRaw'>,
  query: TaskWorkQuery,
): Promise<TaskRawCredits> {
  const parsed = taskWorkSchema.safeParse(query)
  if (!parsed.success) throw badRequest('Invalid task work query')
  const { taskId, attempts } = parsed.data
  const rows = await tx.$queryRaw<TaskWorkRow[]>`
    SELECT u.task_attempt AS attempt,
      r.rub_per_credit::text AS "rubPerCredit",
      r.effective_from AS "rateFrom",
      p.effective_from AS "priceFrom",
      SUM(u.cost_rub)::text AS "costRub",
      COUNT(*)::int AS calls
    FROM token_usage u
    JOIN llm_keys k ON k.id = u.key_id
    JOIN llm_model_prices p ON p.id = u.price_id
    LEFT JOIN task_turns t ON t.task_id = k.task_id AND t.turn_no = k.turn_no
    LEFT JOIN LATERAL (
      SELECT c.rub_per_credit, c.effective_from FROM credit_rates c
      WHERE c.effective_from <= u.occurred_at
      ORDER BY c.effective_from DESC LIMIT 1
    ) r ON true
    WHERE u.task_id = ${taskId}::uuid
      AND u.task_attempt = ANY(${attempts}::int[])
      AND u.billable
      AND t.status IS DISTINCT FROM 'lost'::"TurnStatus"
    GROUP BY u.task_attempt, r.rub_per_credit, r.effective_from, p.effective_from
    ORDER BY u.task_attempt, r.effective_from, p.effective_from
  `

  let callsWithoutRate = 0
  let callsWithStaleRate = 0
  const converted = new Map<number, CostAtRate[]>()
  for (const row of rows) {
    if (row.rubPerCredit === null || row.rateFrom === null) callsWithoutRate += row.calls
    else if (!creditRateCoversPrice(row.rateFrom, row.priceFrom)) callsWithStaleRate += row.calls
    else {
      const sums = converted.get(row.attempt) ?? []
      sums.push({ costRub: row.costRub, rubPerCredit: row.rubPerCredit })
      converted.set(row.attempt, sums)
    }
  }
  if (callsWithoutRate > 0 || callsWithStaleRate > 0) {
    return { convertible: false, callsWithoutRate, callsWithStaleRate }
  }
  const all = [...converted.values()].flat()
  return {
    convertible: true,
    // Over every sum at once, not over the attempts' own results: how the cost was split does
    // not change the charge.
    credits: creditsFromCost(all),
    costRub: sumCostRub(all),
    attempts: attempts.map((attempt) => {
      const sums = converted.get(attempt) ?? []
      return { attempt, costRub: sumCostRub(sums), credits: creditsFromCost(sums) }
    }),
  }
}

const workspaceWorkSchema = z.strictObject({ workspaceId: z.uuid(), since: instantSchema })

export interface WorkspaceWorkQuery {
  workspaceId: string
  /**
   * The moment the bound on unpaid work is counted from: the start of the current period of a
   * paid tariff; without one, the end of the last tariff or the creation of the workspace.
   */
  since: Date
}

/** What a workspace got and what it was charged since a moment: the input of `unpaidWork`. */
export interface WorkspaceWork {
  /**
   * Every model call of the billable tasks of the workspace that started at `since` or later,
   * in credits, not rounded — billable calls or not: a lost call spent the pool too. Work in
   * progress is in it until it is charged.
   */
  work: Decimal
  /**
   * The credits charged to the three credit accounts of the workspace since the same moment:
   * by the moment each task was charged, whatever period its ledger rows are stamped into.
   */
  charged: Credits
  /**
   * Calls that started while no credit rate was in force: they have no credits and are not in
   * `work`. No reserve is placed without a usable rate, so a task of the queue has none.
   */
  unrated: { calls: number; costRub: string }
}

interface WorkspaceWorkRow {
  rubPerCredit: string | null
  costRub: string
  calls: number
}

/**
 * The work of a workspace in credits and what was charged for it, since `since` (design §3.8):
 * `unpaidWork({ work, charged })` of @repo/domain is what new tasks and retries are bounded by.
 * `work` is Σ cost ÷ K over all `token_usage` rows of the billable tasks (`tasks.billable`) of
 * the workspace with `occurred_at >= since`, each call at the rate in force at its own start;
 * `charged` is the `charge` rows of `credit_ledger` on the three credit accounts of the tasks
 * charged at `since` or later.
 *
 * When a task was charged is told by its reserve — `credit_holds.settled_at` of the rows the
 * charge captured —, not by the stamp of the ledger row alone: the charge of the tariff account
 * is stamped inside the period whose credits it takes (`tariffHoldCreatedAt`), so a task done
 * after a period ended and before its renewal is settled leaves a row stamped with the last
 * millisecond of that period, while its model calls started after it. Counted by the stamp, that
 * work would be unpaid for the whole next period. A `charge` row whose own stamp is not before
 * `since` counts as before, with or without a reserve.
 */
export async function workspaceWorkCredits(
  tx: Pick<BillingTx, '$queryRaw' | 'creditLedger'>,
  query: WorkspaceWorkQuery,
): Promise<WorkspaceWork> {
  const parsed = workspaceWorkSchema.safeParse(query)
  if (!parsed.success) throw badRequest('Invalid workspace work query')
  const { workspaceId, since } = parsed.data
  const rows = await tx.$queryRaw<WorkspaceWorkRow[]>`
    SELECT r.rub_per_credit::text AS "rubPerCredit",
      SUM(u.cost_rub)::text AS "costRub",
      COUNT(*)::int AS calls
    FROM tasks t
    JOIN token_usage u ON u.task_id = t.id
    LEFT JOIN LATERAL (
      SELECT c.rub_per_credit, c.effective_from FROM credit_rates c
      WHERE c.effective_from <= u.occurred_at
      ORDER BY c.effective_from DESC LIMIT 1
    ) r ON true
    WHERE t.workspace_id = ${workspaceId}::uuid
      AND t.billable
      AND u.occurred_at >= ${since}::timestamptz
    GROUP BY r.rub_per_credit, r.effective_from
    ORDER BY r.effective_from
  `
  const rated: CostAtRate[] = []
  const unrated: { costRub: string }[] = []
  let unratedCalls = 0
  for (const row of rows) {
    if (row.rubPerCredit === null) {
      unrated.push(row)
      unratedCalls += row.calls
    } else rated.push({ costRub: row.costRub, rubPerCredit: row.rubPerCredit })
  }
  const { _sum: sum } = await tx.creditLedger.aggregate({
    where: {
      kind: 'charge',
      account: { workspaceId, unit: { in: Object.values(creditAccountUnits) } },
      OR: [
        { createdAt: { gte: since } },
        // Stamped into a period that ended, charged after it: the rows of a task are captured
        // together, at the moment of its charge.
        { task: { creditHolds: { some: { status: 'captured', settledAt: { gte: since } } } } },
      ],
    },
    _sum: { amount: true },
  })
  return {
    work: creditsFromCost(rated),
    // A charge is a negative amount of the journal.
    charged: toCredits(new Money(0).minus(sum.amount ?? 0)),
    unrated: { calls: unratedCalls, costRub: sumCostRub(unrated) },
  }
}
