import { z } from 'zod'
import { badRequest } from '../errors.ts'
import { callUsageSchema, type CallUsage } from '../ports/llm-backend.ts'
import { modelClasses, quotaAttemptCeilingsRub } from './model-class.ts'
import {
  asCostRub,
  costRubSchema,
  decimalStringSchema,
  Money,
  requirePrices,
  type LlmModelPrices,
} from './money.ts'

const attemptSpend = {
  spentRub: costRubSchema,
  openReservedRub: costRubSchema,
}
const attemptBudgetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('quota'), modelClass: z.enum(modelClasses), ...attemptSpend }),
  z.strictObject({
    kind: z.literal('payg'),
    holdRub: decimalStringSchema(12, 2),
    feeRub: decimalStringSchema(10, 2),
    markup: decimalStringSchema(4, 4),
    ...attemptSpend,
  }),
])

/** Spent costs and open-call reserves must include every key of this attempt. */
export type AttemptBudgetInput = z.infer<typeof attemptBudgetSchema>

/** Remaining cost budget of a turn key, capped at 750 RUB and rounded down to kopecks. */
export function attemptBudgetRub(input: AttemptBudgetInput): string {
  const result = attemptBudgetSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid LLM attempt budget')
  const value = result.data
  if (value.kind === 'payg' && new Money(value.markup).lte(0)) {
    throw badRequest('Invalid LLM attempt budget')
  }
  const ceiling =
    value.kind === 'quota'
      ? new Money(quotaAttemptCeilingsRub[value.modelClass])
      : new Money(value.holdRub).minus(value.feeRub).div(value.markup)
  const remaining = ceiling.minus(value.spentRub).minus(value.openReservedRub)
  return Money.max(0, Money.min(750, remaining)).toFixed(2, Money.ROUND_DOWN)
}

const callReserveSchema = z.strictObject({
  estimatedInputTokens: z.number().int().nonnegative(),
  // Matches llm_models_reserve_output_tokens_check from the B3 migration.
  reserveOutputTokens: z.number().int().min(1024).max(131_072),
  lastCompletedUsage: callUsageSchema.nullable(),
})

export type CallReserveInput = z.infer<typeof callReserveSchema>

/** One formula for reserves and estimates: the cache-read share of a call's input, at most 0.9. */
function cacheShare(lastCompletedUsage: CallUsage | null) {
  return lastCompletedUsage === null || lastCompletedUsage.input === 0
    ? new Money(0)
    : Money.min('0.9', new Money(lastCompletedUsage.cacheRead).div(lastCompletedUsage.input))
}

/**
 * The share of the next call's input expected to be cache reads: that of the last completed
 * call of this attempt (across turn keys), 0 for the first call, never above 0.9.
 */
export function callCacheShare(lastCompletedUsage: CallUsage | null): string {
  const result = callReserveSchema.shape.lastCompletedUsage.safeParse(lastCompletedUsage)
  if (!result.success) throw badRequest('Invalid LLM call reserve')
  return cacheShare(result.data).toString()
}

const estimatedCacheSchema = callReserveSchema.pick({
  estimatedInputTokens: true,
  lastCompletedUsage: true,
})

/**
 * The cache-read part of an estimated input (a call with no provider usage), split by the same
 * share as its reserve. Whole tokens are rounded towards the cheaper rate, so the input of an
 * estimate never costs more than the input of the reserve that admitted the call.
 */
export function estimatedCacheReadTokens(
  input: z.infer<typeof estimatedCacheSchema>,
  prices: LlmModelPrices | null | undefined,
): number {
  const result = estimatedCacheSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid LLM call reserve')
  const { estimatedInputTokens, lastCompletedUsage } = result.data
  const rates = requirePrices(prices)
  const cacheIsCheaper = new Money(rates.cacheReadPer1m ?? rates.inputPer1m).lte(rates.inputPer1m)
  return Math.min(
    estimatedInputTokens,
    cacheShare(lastCompletedUsage)
      .mul(estimatedInputTokens)
      .toDecimalPlaces(0, cacheIsCheaper ? Money.ROUND_CEIL : Money.ROUND_FLOOR)
      .toNumber(),
  )
}

/**
 * The caller supplies the last completed usage of this attempt, across turn keys.
 * Body normalization estimates input separately, excluding encrypted content and image bytes.
 */
export function callReserveRub(
  input: CallReserveInput,
  prices: LlmModelPrices | null | undefined,
): string {
  const result = callReserveSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid LLM call reserve')
  const { estimatedInputTokens, reserveOutputTokens, lastCompletedUsage } = result.data
  const rates = requirePrices(prices)
  const cacheRatio = cacheShare(lastCompletedUsage)
  const inputRate = new Money(rates.inputPer1m)
  const weightedInputRate = cacheRatio
    .mul(rates.cacheReadPer1m ?? inputRate)
    .plus(new Money(1).minus(cacheRatio).mul(inputRate))
  return asCostRub(
    new Money(estimatedInputTokens)
      .mul(weightedInputRate)
      .plus(new Money(reserveOutputTokens).mul(rates.outputPer1m))
      .div(1_000_000),
  )
}

/** Key issuance requires enough budget for 40,000 uncached input tokens plus model output reserve. */
export function firstCallReserveRub(
  reserveOutputTokens: number,
  prices: LlmModelPrices | null | undefined,
): string {
  return callReserveRub(
    { estimatedInputTokens: 40_000, reserveOutputTokens, lastCompletedUsage: null },
    prices,
  )
}

const callBudgetSchema = z.strictObject({
  budgetRub: costRubSchema,
  ...attemptSpend,
  reserveRub: costRubSchema,
})

/** Spent and reserved amounts are for this key; reserveRub is the new call only. */
export type CallBudgetInput = z.infer<typeof callBudgetSchema>

/** A pure admission check; persisting the reservation must share the gateway's budget lock. */
export function callFitsBudget(input: CallBudgetInput): boolean {
  const result = callBudgetSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid LLM call budget')
  const { budgetRub, spentRub, openReservedRub, reserveRub } = result.data
  if (new Money(budgetRub).gt(750)) throw badRequest('Invalid LLM call budget')
  if (new Money(budgetRub).isZero()) return false
  return new Money(spentRub).plus(openReservedRub).plus(reserveRub).lte(budgetRub)
}

const turnKeyBudgetSchema = z.strictObject({
  budgetRub: costRubSchema,
  attempt: attemptBudgetSchema,
  reserveOutputTokens: callReserveSchema.shape.reserveOutputTokens,
})

/** Zero attempt spend, while the caller cannot supply it, bounds the key by the whole ceiling. */
export type TurnKeyBudgetInput = z.infer<typeof turnKeyBudgetSchema>
export type TurnKeyBudgetVerdict = 'ok' | 'above_ceiling' | 'below_first_call'

/**
 * The key issuer's budget check (spec §17). `above_ceiling`: the key would admit more than
 * attemptBudgetRub leaves to its attempt — the class ceiling on a quota plan, the hold on payg.
 * `below_first_call`: the first request would get a final budget refusal, so no key is issued
 * and the task goes to awaiting_user before a container starts.
 */
export function turnKeyBudgetVerdict(
  input: TurnKeyBudgetInput,
  prices: LlmModelPrices | null | undefined,
): TurnKeyBudgetVerdict {
  const result = turnKeyBudgetSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid turn key budget')
  const { budgetRub, attempt, reserveOutputTokens } = result.data
  // Without an approved rate there is no key, whatever its budget.
  const reserveRub = firstCallReserveRub(reserveOutputTokens, prices)
  if (new Money(budgetRub).gt(attemptBudgetRub(attempt))) return 'above_ceiling'
  return callFitsBudget({ budgetRub, spentRub: '0', openReservedRub: '0', reserveRub })
    ? 'ok'
    : 'below_first_call'
}
