import type { Decimal } from 'decimal.js'
import { z } from 'zod'
import { badRequest, llmPriceMissing } from '../errors.ts'
import { decimalStringSchema, Money } from '../money.ts'
import { callUsageSchema, type CallUsage } from '../ports/llm-backend.ts'

// The generic part lives in ../money.ts; the llm modules keep importing it from here.
export { decimalStringSchema, Money }

/** The precision of token_usage.cost_rub and llm_calls.reserved_rub. */
export const costRubSchema = decimalStringSchema(8, 10)
const rateSchema = decimalStringSchema(8, 6)
const pricesSchema = z.strictObject({
  inputPer1m: rateSchema,
  cacheReadPer1m: rateSchema.nullable(),
  cacheWritePer1m: rateSchema.nullable(),
  outputPer1m: rateSchema,
})

/** Published RUB rates per million tokens, including VAT. Null cache rates use the input rate. */
export type LlmModelPrices = z.infer<typeof pricesSchema>

export function requirePrices(prices: LlmModelPrices | null | undefined): LlmModelPrices {
  if (prices === null || prices === undefined) throw llmPriceMissing()
  const result = pricesSchema.safeParse(prices)
  if (!result.success) throw badRequest('Invalid LLM model prices')
  return result.data
}

export function requireUsage(usage: CallUsage): CallUsage {
  const result = callUsageSchema.safeParse(usage)
  if (!result.success) throw badRequest('Invalid LLM call usage')
  return result.data
}

export function asCostRub(amount: Decimal): string {
  const rounded = amount.toDecimalPlaces(10, Money.ROUND_HALF_UP)
  if (!rounded.isFinite() || rounded.isNegative() || rounded.gte('100000000')) {
    throw badRequest('LLM cost exceeds its supported range')
  }
  return rounded.toFixed(10)
}
