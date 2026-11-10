import {
  badRequest,
  billingCreditRateMissing,
  creditRateCoversPrice,
  creditRateVerdict,
  creditsFromCost,
  Money,
  turnKeyLimitRub,
  type CostAtRate,
  type CreditRateVerdict,
} from '@repo/domain'
import type { Decimal } from 'decimal.js'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'

// The credit rate K and what it turns into credits (spec §17, «Учётные ставки»): the row of
// `credit_rates` in force at a moment, whether credits can be reserved by it, the recorded model
// calls of a task in credits and the work of a workspace in credits. Read only: the rows of
// `credit_rates` and of `llm_model_prices` are written by the operator's `approveCreditRate`.
// Every function joins the transaction of its caller.

/** The most a turn key can be written with, RUB: `turnKeyLimitRub` of @repo/domain. */
export const TURN_KEY_LIMIT_RUB = turnKeyLimitRub

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
   * have an active reserve row — and those of the chains «Попробовать ещё» gave back before it
   * (`workAttemptsOf` in holds.ts). The calls of a pass that failed are left out by its turn.
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
 * task and `llm_keys.turn_no`) ended `lost` or was rejected — its pass ended in a `feed.failure`
 * (`task_turns.rejected_at`; docs/plan/53, «Попробовать ещё (18.10)»): a failure the client did
 * not cause is not the client's to pay, even when the dialog kept its candidate and is released
 * later. Each call divided by the credit rate in force at its own start (`occurred_at`), so an
 * attempt that crosses a change of the rate needs no special case. A key without a turn row
 * counts: the queue writes turn rows from P12 on.
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
      AND t.rejected_at IS NULL
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
