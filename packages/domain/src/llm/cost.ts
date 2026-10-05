import type { CallUsage } from '../ports/llm-backend.ts'
import { asCostRub, Money, requirePrices, requireUsage, type LlmModelPrices } from './money.ts'

export type { LlmModelPrices } from './money.ts'

/** Charge each input partition once; reasoning is already included in output. */
export function llmCallCostRub(
  usage: CallUsage,
  prices: LlmModelPrices | null | undefined,
): string {
  const tokens = requireUsage(usage)
  const rates = requirePrices(prices)
  const input = new Money(rates.inputPer1m)
  const cost = new Money(tokens.input - tokens.cacheRead - tokens.cacheWrite)
    .mul(input)
    .plus(new Money(tokens.cacheRead).mul(rates.cacheReadPer1m ?? input))
    .plus(new Money(tokens.cacheWrite).mul(rates.cacheWritePer1m ?? input))
    .plus(new Money(tokens.output).mul(rates.outputPer1m))
    .div(1_000_000)
  return asCostRub(cost)
}
