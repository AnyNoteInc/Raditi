import 'server-only'

import { prisma } from '@repo/db'
import { withTimeout } from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import type { LandingPlan, LandingPricingData } from '@/components/landing/pricing-calculator'

const reportFailure = throttledLogger((line) => console.error(line))

/** How long one answer of the database serves every render of the public landing. */
export const LANDING_PLANS_TTL_MS = 60_000
/** The pause before a failed lookup is repeated; meanwhile the landing shows no prices. */
export const LANDING_PLANS_RETRY_MS = 5_000

let cached: { data: LandingPricingData; until: number } | undefined
let loading: Promise<LandingPricingData> | undefined
// The timeout answers the render, it does not cancel the query: no second one beside it.
let querying = false

/**
 * Only published database terms reach the landing; no fallback price list can go stale. The
 * page is public, so its traffic must not become the same traffic of queries: an answer is kept
 * in memory for a minute, simultaneous renders share one lookup.
 */
export function getLandingPlans(): Promise<LandingPricingData> {
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.data)
  loading ??= loadLandingPlans().finally(() => {
    loading = undefined
  })
  return loading
}

async function loadLandingPlans(): Promise<LandingPricingData> {
  let data: LandingPricingData = { plans: [], pack: null }
  let ttl = LANDING_PLANS_RETRY_MS
  try {
    data = await readLandingPlans()
    ttl = LANDING_PLANS_TTL_MS
  } catch (error) {
    reportFailure('landing plans unavailable', error)
  }
  cached = { data, until: Date.now() + ttl }
  return data
}

async function readLandingPlans(): Promise<LandingPricingData> {
  if (querying) throw new Error('The previous landing plans lookup is still running')
  querying = true
  // An async wrapper: a synchronous failure of the client releases the flag as well.
  const query = (async () =>
    prisma.plan.findMany({
      where: { isActive: true, kind: { in: ['quota', 'pack'] } },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
      select: {
        slug: true,
        name: true,
        kind: true,
        price: true,
        creditsPerMonth: true,
        creditsPerDay: true,
        maxSites: true,
        packCredits: true,
      },
    }))().finally(() => {
    querying = false
  })
  const rows = await withTimeout(query, 3_000, 'Landing plans lookup timed out')

  const plans: LandingPlan[] = []
  for (const row of rows) {
    if (
      row.kind !== 'quota' ||
      row.creditsPerMonth === null ||
      row.creditsPerMonth <= 0 ||
      row.creditsPerDay === null ||
      row.creditsPerDay <= 0 ||
      row.maxSites === null ||
      row.maxSites <= 0 ||
      row.price.isNegative()
    ) {
      continue
    }
    plans.push({
      slug: row.slug,
      name: row.name,
      price: row.price.toFixed(2),
      creditsPerMonth: row.creditsPerMonth,
      creditsPerDay: row.creditsPerDay,
      maxSites: row.maxSites,
    })
  }
  const pack = rows.find(
    (row) =>
      row.kind === 'pack' &&
      row.packCredits !== null &&
      row.packCredits > 0 &&
      !row.price.isNegative(),
  )
  return {
    plans,
    pack: pack?.packCredits ? { price: pack.price.toFixed(2), credits: pack.packCredits } : null,
  }
}
