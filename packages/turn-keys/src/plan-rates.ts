import type { Prisma } from '@repo/db'
import {
  planCreditsOfCall,
  planRatesSchema,
  type PlanCallTokens,
  type PlanRates,
} from '@repo/domain'

// The rates of a provider's subscription plan a call is counted in (docs/plan/71-usage-limits.md,
// §2.1): the gateway estimates an open call with them, the ledger counts a closed one.

type Db = Pick<Prisma.TransactionClient, 'llmPlanRate'>

/**
 * The plan rates of a model of a provider in force at `at`; null — none: the provider has no plan
 * rates (a backend without windows), and the call has no plan credits.
 */
export async function planRatesAt(
  db: Db,
  input: { providerId: string; model: string | null; at: Date },
): Promise<PlanRates | null> {
  if (input.model === null) return null
  const row = await db.llmPlanRate.findFirst({
    where: { providerId: input.providerId, model: input.model, effectiveFrom: { lte: input.at } },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (row === null) return null
  return planRatesSchema.parse({
    inputUncachedPer10k: row.inputUncachedPer10k.toFixed(),
    cacheReadPer10k: row.cacheReadPer10k.toFixed(),
    outputPer10k: row.outputPer10k.toFixed(),
    offPeakShare: row.offPeakShare.toFixed(),
    peak: row.peak,
  })
}

/** The plan credits of a call by the rates in force at its start; null without rates. */
export async function callPlanCredits(
  db: Db,
  input: { providerId: string; model: string | null; at: Date; tokens: PlanCallTokens },
): Promise<string | null> {
  const rates = await planRatesAt(db, input)
  return rates === null ? null : planCreditsOfCall(input.tokens, rates, input.at)
}
