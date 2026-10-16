import { dailyTaskLimit, Money, newTaskVerdict } from '@repo/domain'

import type {
  BillingOverview,
  CreditBalances,
  CreditConversion,
  PlanOffer,
  Subscription,
  TaskCredits,
} from './billing-types'

// Answers of the billing router for the component tests: the three tariffs of the seeds and a
// subscription to «Бизнес» for the month that ends on 18 October 2026.

/** The text as it reads: the pages set non-breaking spaces, the expectations use plain ones. */
export const plain = (text: string | null | undefined) =>
  (text ?? '').replaceAll(String.fromCharCode(0xa0), ' ')

/** A failure the way the tRPC client reports a refusal of the server. */
export function serverRefusal(message: string, domainCode: string | null = null): Error {
  return Object.assign(new Error(message), { data: { code: 'CONFLICT', domainCode } })
}

const offer = (plan: Omit<PlanOffer, 'fitsSites' | 'current'>): PlanOffer => ({
  ...plan,
  fitsSites: true,
  current: false,
})

export const start = offer({
  id: '018f0000-0000-7000-8000-000000000001',
  slug: 'start',
  name: 'Старт',
  price: '4900.00',
  creditsPerMonth: 300,
  tasksPerDay: 5,
  maxSites: 1,
})

export const business = offer({
  id: '018f0000-0000-7000-8000-000000000002',
  slug: 'business',
  name: 'Бизнес',
  price: '12900.00',
  creditsPerMonth: 800,
  tasksPerDay: 10,
  maxSites: 3,
})

export const agency = offer({
  id: '018f0000-0000-7000-8000-000000000003',
  slug: 'agency',
  name: 'Агентство',
  price: '39900.00',
  creditsPerMonth: 2500,
  tasksPerDay: 30,
  maxSites: 15,
})

const planOf = ({ id, slug, name, price, creditsPerMonth, tasksPerDay, maxSites }: PlanOffer) => ({
  id,
  slug,
  name,
  price,
  creditsPerMonth,
  tasksPerDay,
  maxSites,
})

/**
 * The tariffs on sale as `billing.plans` answers for a customer with `siteCount` sites. No
 * table of «Точный расчёт» unless told: no credit rate is in force.
 */
export function offers({
  siteCount = 0,
  current,
  creditConversion = null,
}: { siteCount?: number; current?: string; creditConversion?: CreditConversion | null } = {}) {
  return {
    plans: [start, business, agency].map((plan) => ({
      ...plan,
      fitsSites: siteCount <= plan.maxSites,
      current: plan.slug === current,
    })),
    pack: {
      id: '018f0000-0000-7000-8000-000000000004',
      slug: 'pack',
      name: 'Пакет из 100 кредитов',
      price: '1990.00',
      credits: 100,
    },
    siteCount,
    autoRenewalAvailable: true,
    creditConversion,
  }
}

/** What the day and the platform add to the answer about a new task, beside the accounts. */
export interface TaskFacts {
  /** Launches of today; none unless told. */
  launchesToday?: number
  /** Credits of work that ended without a charge; none unless told. */
  unpaidWork?: number
  /** A credit rate is in force; true unless told. */
  rateUsable?: boolean
}

type Account = { balance: number; held: number }

/**
 * What the server answers about a new task for these accounts and this tariff: the rule of the
 * queue itself (`newTaskVerdict` of @repo/domain), so a fixture never states an answer the
 * server could not give.
 */
export function taskCreditsFor(
  accounts: { tariff: Account; gift: Account; pack: Account },
  subscription: Pick<Subscription, 'status' | 'plan'> | null,
  { launchesToday = 0, unpaidWork = 0, rateUsable = true }: TaskFacts = {},
): TaskCredits {
  const terms =
    subscription === null
      ? null
      : {
          status: subscription.status,
          creditsPerMonth: subscription.plan.creditsPerMonth,
          tasksPerDay: subscription.plan.tasksPerDay,
        }
  const account = ({ balance, held }: Account) => ({ balance, held })
  const verdict = newTaskVerdict({
    placement: 'new',
    accounts: {
      tariff: account(accounts.tariff),
      gift: account(accounts.gift),
      pack: account(accounts.pack),
    } as Parameters<typeof newTaskVerdict>[0]['accounts'],
    subscription: terms,
    launchesToday,
    unpaidWork: new Money(unpaidWork),
    rateUsable,
  })
  return {
    spendable: verdict.spendable,
    setAside: verdict.held,
    minToStart: verdict.needed,
    today: { used: launchesToday, limit: dailyTaskLimit(terms) },
    newTask: { allowed: verdict.allowed, reason: verdict.reason },
  }
}

/**
 * Credits of the tariff, of a pack and of the gift of the registration, nothing set aside.
 * Without `gift` the gift was never granted to the workspace and none is promised: the pages
 * then speak of no gift. `granted` false with gift credits is the gift a user without a
 * workspace is promised; true with none is a gift that is used up.
 *
 * The answer about a new task is that of a customer without a tariff; `overviewOf` counts it
 * again for the tariff of its overview.
 */
export function creditBalances(
  tariff: number,
  pack: number,
  gift = 0,
  granted = gift > 0,
): CreditBalances {
  const accounts = {
    tariff: { balance: tariff, held: 0, available: tariff },
    gift: { balance: gift, held: 0, available: gift, granted },
    pack: { balance: pack, held: 0, available: pack },
  }
  return {
    ...accounts,
    totalAvailable: tariff + gift + pack,
    ...taskCreditsFor(accounts, null),
  }
}

/** «Бизнес», active, with auto-renewal from a saved card, unless told otherwise. */
export function subscriptionTo(patch: Partial<Subscription> = {}): Subscription {
  return {
    id: '018f0000-0000-7000-8000-00000000000a',
    status: 'active',
    plan: planOf(business),
    period: { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') },
    autoRenewal: true,
    nextPlan: null,
    paymentMethod: { label: `Карта «Мир» ••${String.fromCharCode(0xa0)}4444` },
    pastDueSince: null,
    ...patch,
  }
}

/** An overview as a test states it: the accounts are enough, the answer about a task is counted. */
type OverviewPatch = Partial<Omit<BillingOverview, 'credits'>> & {
  credits?: Pick<CreditBalances, 'tariff' | 'gift' | 'pack' | 'totalAvailable'>
}

/**
 * No tariff, with nothing waited for: no binding to settle and no renewal charge under way; no
 * tariff has ended either, and none is overdue. The shop saves payment methods, unless told
 * otherwise: `ONE_TIME_ONLY` is a shop that does not.
 *
 * Whether a new task would be taken is counted for the accounts and the tariff of the overview,
 * as the server counts it; `facts` add the day, the unpaid work and the credit rate.
 */
export function overviewOf(patch: OverviewPatch = {}, facts: TaskFacts = {}): BillingOverview {
  const overview = {
    paymentsEnabled: true,
    // As the server derives it: never on without a shop.
    autoRenewalAvailable: patch.paymentsEnabled !== false,
    subscription: null,
    credits: creditBalances(0, 0),
    bindingPending: false,
    renewalCharge: 'none' as const,
    pastDueEndsAt: null,
    ended: null,
    ...patch,
  }
  return {
    ...overview,
    credits: {
      ...overview.credits,
      ...taskCreditsFor(overview.credits, overview.subscription, facts),
    },
  }
}

export const agencyPlan = planOf(agency)

/** Payments are on and the shop takes one-time payments only: auto-renewal is not offered. */
export const ONE_TIME_ONLY = { paymentsEnabled: true, autoRenewalAvailable: false } as const
