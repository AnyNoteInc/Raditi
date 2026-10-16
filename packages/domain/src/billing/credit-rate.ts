import { z } from 'zod'
import { badRequest } from '../errors.ts'
import { decimalStringSchema } from '../money.ts'

// The credit rate K: how many roubles of accounting cost one credit stands for. The rows of
// `credit_rates` are only added, never changed, and nothing is pinned on a task or on a hold:
// every model call is turned into credits at the rate in force when the call started — the same
// moment its price row was chosen by. The rate is approved together with the accounting rates
// of the models, so a rate is never older than a price it converts.

/**
 * K as `credit_rates.rub_per_credit` prints it: RUB of accounting cost in one credit,
 * Decimal(14,6), above zero. A string, like every rate of the platform.
 */
export const rubPerCreditSchema = decimalStringSchema(8, 6).refine(
  // Above zero: a decimal of digits and a point has a digit that is not zero. Asked of the text
  // itself, because a refinement also runs on a string the format has already refused.
  (value) => /[1-9]/.test(value),
)

const instantSchema = z.date().refine((value) => Number.isFinite(value.getTime()))

export const creditRateSchema = z.strictObject({
  /** The instant the rate starts — the same one as the price rows it is approved with. */
  effectiveFrom: instantSchema,
  rubPerCredit: rubPerCreditSchema,
  /** How the row was derived: basket, model, rates, date, who approved. varchar(1024). */
  basis: z
    .string()
    .max(1024)
    .refine((value) => value.trim() !== ''),
})

/** A row of `credit_rates` as the rules read it. */
export type CreditRate = z.infer<typeof creditRateSchema>

/**
 * Whether a credit rate may convert a cost counted by a price row: only a rate that is not
 * older than the price. A call whose price is newer than the rate in force at its start is not
 * convertible, and its task is not charged until it is. Both are compared as instants.
 */
export function creditRateCoversPrice(rateEffectiveFrom: Date, priceEffectiveFrom: Date): boolean {
  if (!instantSchema.safeParse(rateEffectiveFrom).success) {
    throw badRequest('Invalid start of a credit rate')
  }
  if (!instantSchema.safeParse(priceEffectiveFrom).success) {
    throw badRequest('Invalid start of a model price')
  }
  return rateEffectiveFrom.getTime() >= priceEffectiveFrom.getTime()
}

const usableRateSchema = z.strictObject({
  now: instantSchema,
  rate: z.strictObject({ effectiveFrom: instantSchema }).nullable(),
  prices: z.array(z.strictObject({ effectiveFrom: instantSchema })),
})

export interface UsableCreditRateInput {
  now: Date
  /**
   * The credit rate in force at `now` — the row with the greatest `effective_from` that is not
   * later than `now` — or null when no row has started yet.
   */
  rate: Pick<CreditRate, 'effectiveFrom'> | null
  /**
   * The price rows of the enabled models. Only rows in force count: one that starts after `now`
   * is passed over, so the caller may give every row of every enabled model as well.
   */
  prices: readonly { effectiveFrom: Date }[]
}

/**
 * `missing`: no rate is in force. `stale`: one is, and a price in force of an enabled model
 * started after it — the calls of that model could not be converted.
 */
export type CreditRateVerdict = 'usable' | 'missing' | 'stale'

/**
 * Whether credits can be reserved now (BILLING_CREDIT_RATE_MISSING otherwise): a credit rate is
 * in force, and it is not older than the newest price in force of an enabled model. A rate that
 * starts after `now` is not in force yet.
 */
export function creditRateVerdict(input: UsableCreditRateInput): CreditRateVerdict {
  const result = usableRateSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid credit rate check')
  const { now, rate, prices } = result.data
  if (rate === null || rate.effectiveFrom.getTime() > now.getTime()) return 'missing'
  const covered = prices
    .filter((price) => price.effectiveFrom.getTime() <= now.getTime())
    .every((price) => creditRateCoversPrice(rate.effectiveFrom, price.effectiveFrom))
  return covered ? 'usable' : 'stale'
}
