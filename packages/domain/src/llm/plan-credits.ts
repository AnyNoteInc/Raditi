import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { decimalStringSchema, Money } from '../money.ts'
import type { LimitWindow } from '../ports/llm-backend.ts'

// The credits of a subscription plan of a model provider (GLM Coding Plan on Z.ai): what a call
// takes from the windows of the account it went through (docs/plan/69-usage-limits.md, §2.1).
// They are the provider's unit, not the customer's credit (CLAUDE.md, «Слова»: «кредиты плана»).
// The multipliers and the peak are data — rows of `llm_plan_rates` an operator approves —, never
// code: the provider changes them, and a row is added with its moment.

/** The precision of token_usage.plan_credits and llm_calls.reserved_plan_credits. */
export const planCreditsSchema = decimalStringSchema(10, 4)

const multiplierSchema = decimalStringSchema(6, 6)
const hourSchema = z.number().int().min(0).max(24)

/**
 * When the provider's peak is: the days of the week (1 — Monday … 7 — Sunday) and the hours
 * `[fromHour, toHour)` in its own time zone. Outside it a call takes `offPeakShare` of its credits.
 */
export const planPeakSchema = z
  .strictObject({
    timeZone: z.string().min(1).max(64),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    fromHour: hourSchema,
    toHour: hourSchema,
  })
  .refine((peak) => peak.fromHour < peak.toHour, { message: 'The peak ends after it starts' })
  .refine((peak) => new Set(peak.days).size === peak.days.length, {
    message: 'Days of the peak are unique',
  })
  .refine(
    (peak) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: peak.timeZone })
        return true
      } catch {
        return false
      }
    },
    { message: 'Unknown time zone of the peak' },
  )
export type PlanPeak = z.infer<typeof planPeakSchema>

/**
 * The plan credits of one model per 10 000 tokens (`(uncached × 6.9 + cache × 1.7 + output × 24)
 * / 10 000` for GLM-5.3 at the peak), and the share a call outside the peak takes.
 */
export const planRatesSchema = z.strictObject({
  inputUncachedPer10k: multiplierSchema,
  cacheReadPer10k: multiplierSchema,
  outputPer10k: multiplierSchema,
  offPeakShare: decimalStringSchema(1, 4).refine(
    (share) => new Money(share).gt(0) && new Money(share).lte(1),
    { message: 'The off-peak share lies in (0, 1]' },
  ),
  peak: planPeakSchema,
})
export type PlanRates = z.infer<typeof planRatesSchema>

const weekdays: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
})

/** Whether `at` falls in the provider's peak, by the calendar of its own time zone. */
export function isPlanPeak(at: Date, peak: PlanPeak): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: peak.timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at)
  const day = weekdays[parts.find((part) => part.type === 'weekday')?.value ?? '']
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  if (day === undefined || !Number.isInteger(hour)) throw badRequest('Invalid moment of a call')
  return peak.days.includes(day) && hour >= peak.fromHour && hour < peak.toHour
}

const tokensSchema = z.strictObject({
  inputUncachedTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})
export type PlanCallTokens = z.infer<typeof tokensSchema>

/**
 * The plan credits a call takes, rounded half up to four places. Cache writes are counted as
 * uncached input: the provider names no rate of their own, and the larger count is the safe one.
 * A count from the formula is an estimate (П31: the measured credits per generation varied
 * fourfold); the probe of the quota is the truth, and replaces the forecast built on it.
 */
export function planCreditsOfCall(tokens: PlanCallTokens, rates: PlanRates, at: Date): string {
  const usage = tokensSchema.safeParse(tokens)
  const parsedRates = planRatesSchema.safeParse(rates)
  if (!usage.success || !parsedRates.success) throw badRequest('Invalid plan credits of a call')
  const value = usage.data
  const rate = parsedRates.data
  const share = isPlanPeak(at, rate.peak) ? new Money(1) : new Money(rate.offPeakShare)
  const credits = new Money(value.inputUncachedTokens + value.cacheWriteTokens)
    .times(rate.inputUncachedPer10k)
    .plus(new Money(value.cacheReadTokens).times(rate.cacheReadPer10k))
    .plus(new Money(value.outputTokens).times(rate.outputPer10k))
    .div(10_000)
    .times(share)
  return planCreditsSchema.parse(credits.toDecimalPlaces(4, Money.ROUND_HALF_UP).toFixed(4))
}

/** The plans of an account (`subscription_accounts.plan`) whose windows the domain knows. */
export const knownAccountPlans = ['lite', 'pro', 'max'] as const
export type KnownAccountPlan = (typeof knownAccountPlans)[number]

/**
 * The published sizes of the windows of GLM Coding Plan, in plan credits (docs.z.ai/devpack/
 * overview, checked 11.11.2026). A fallback and a check: a probe that names another size is
 * believed, and its difference is logged.
 */
export const planWindowCredits: Readonly<
  Record<KnownAccountPlan, Readonly<Record<'5h' | 'week', number>>>
> = Object.freeze({
  lite: Object.freeze({ '5h': 2_000, week: 10_000 }),
  pro: Object.freeze({ '5h': 12_000, week: 60_000 }),
  max: Object.freeze({ '5h': 28_000, week: 140_000 }),
})

/** The nominal size of a window of an account's plan; null for a plan or window it does not know. */
export function nominalWindowCredits(plan: string, window: LimitWindow['name']): number | null {
  if (window === 'month' || !(knownAccountPlans as readonly string[]).includes(plan)) return null
  return planWindowCredits[plan as KnownAccountPlan][window]
}

/**
 * A window of the probe with its absolute numbers: the probe's own size, else the nominal size of
 * the plan with the used share of the probe. null — neither is known: the pool keeps percents.
 */
export function absoluteWindow(
  window: LimitWindow,
  plan: string,
): { limitCredits: number; usedCredits: number } | null {
  if (window.limitCredits !== undefined && window.limitCredits > 0) {
    return {
      limitCredits: window.limitCredits,
      usedCredits:
        window.usedCredits ??
        Math.min(window.limitCredits, (window.usedPct * window.limitCredits) / 100),
    }
  }
  const nominal = nominalWindowCredits(plan, window.name)
  if (nominal === null) return null
  return { limitCredits: nominal, usedCredits: (window.usedPct * nominal) / 100 }
}

/**
 * The used credits of a window between probes: what the last probe saw, plus what the calls of
 * the account that closed after it took (Σ `token_usage.plan_credits` after `limits_seen_at`),
 * plus the estimates of its open calls (Σ `llm_calls.reserved_plan_credits`). Never beyond the
 * size of the window by more than what the calls added; the next probe replaces it.
 */
export function accountWindowForecast(input: {
  probedUsedCredits: number
  closedSinceProbe: string
  openReserved: string
}): number {
  const closed = planCreditsSchema.safeParse(input.closedSinceProbe)
  const open = planCreditsSchema.safeParse(input.openReserved)
  if (
    !closed.success ||
    !open.success ||
    !Number.isFinite(input.probedUsedCredits) ||
    input.probedUsedCredits < 0
  )
    throw badRequest('Invalid forecast of a window')
  return new Money(input.probedUsedCredits).plus(closed.data).plus(open.data).toNumber()
}

/**
 * How far a forecast missed the probe that replaced it: (forecast − probe) / size of the window.
 * Positive — the forecast was above the provider's count.
 */
export function forecastErrorRatio(forecast: number, probed: number, limitCredits: number): number {
  if (!(limitCredits > 0)) return 0
  return (forecast - probed) / limitCredits
}
