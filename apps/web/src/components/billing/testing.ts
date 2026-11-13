import {
  newTaskVerdict,
  toCredits,
  usageWindowRoom,
  type UsageWindowState,
  type WorkspaceTier,
} from '@repo/domain'

import type {
  BillingOverview,
  BillingUsage,
  CreditBalances,
  CreditConversion,
  PlanOffer,
  Subscription,
  TaskCredits,
} from './billing-types'

// Answers of the billing router for the component tests: the three tariffs of the seeds — the
// terms of 06.11.2026, without a daily limit — and a subscription to «Бизнес» for the month that
// ends on 18 October 2026. A test of the daily limit, which stays in the code for a plan that
// sets one, gives a tariff its day itself (`withDay`).

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
  price: '1990.00',
  creditsPerMonth: 150,
  creditsPerDay: null,
  creditsPer5h: 20,
  creditsPerWeek: 55,
  maxSites: 1,
})

export const business = offer({
  id: '018f0000-0000-7000-8000-000000000002',
  slug: 'business',
  name: 'Бизнес',
  price: '6990.00',
  creditsPerMonth: 600,
  creditsPerDay: null,
  creditsPer5h: 70,
  creditsPerWeek: 210,
  maxSites: 3,
})

export const agency = offer({
  id: '018f0000-0000-7000-8000-000000000003',
  slug: 'agency',
  name: 'Агентство',
  price: '19990.00',
  creditsPerMonth: 2000,
  creditsPerDay: null,
  creditsPer5h: 200,
  creditsPerWeek: 700,
  maxSites: 15,
})

/**
 * A tariff with a daily limit of `creditsPerDay` tariff credits: none on sale has one since
 * 06.11.2026, the code of the day stays for a plan that sets one.
 */
export const withDay = (plan: PlanOffer, creditsPerDay: number): PlanOffer => ({
  ...plan,
  creditsPerDay,
})

const planOf = ({
  id,
  slug,
  name,
  price,
  creditsPerMonth,
  creditsPerDay,
  creditsPer5h,
  creditsPerWeek,
  maxSites,
}: PlanOffer) => ({
  id,
  slug,
  name,
  price,
  creditsPerMonth,
  creditsPerDay,
  creditsPer5h,
  creditsPerWeek,
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
      price: '1490.00',
      withoutTariff: false,
      credits: 100,
    },
    siteCount,
    autoRenewalAvailable: true,
    creditConversion,
  }
}

/** The meter of the current period of a tariff, as `billing.usage` sends it. */
export type TariffMeter = NonNullable<BillingUsage['tariff']>['credits']

/**
 * A meter that adds up, as the server reads it: what was carried into the period and granted for
 * it is what was charged, set aside, expired and left — `granted` is counted from the parts
 * unless told —, and the next renewal would carry what is left up to `carryLimit` (the quota of
 * the period: what was granted, unless told) and let the rest expire. Nothing carried unless told.
 */
export function tariffMeter(patch: Partial<TariffMeter> = {}): TariffMeter {
  const parts = { carried: 0, charged: 0, held: 0, expired: 0, left: 0, heldEarlier: 0, ...patch }
  const granted =
    patch.granted ?? parts.charged + parts.held + parts.expired + parts.left - parts.carried
  const carryLimit = patch.carryLimit ?? granted
  const carryNext = Math.min(parts.left, carryLimit)
  return { ...parts, granted, carryLimit, carryNext, burnNext: parts.left - carryNext }
}

/** What the day and the platform add to the answer about a new task, beside the accounts. */
export interface TaskFacts {
  /** The tariff credits of today, charged and set aside; nothing unless told. */
  today?: { charged?: number; held?: number }
  /** A credit rate is in force; true unless told. */
  rateUsable?: boolean
  /** The windows of 5 hours and of the week (plan 70); none unless told. */
  windows?: UsageWindowState[]
  /** The tier of the workspace; `none` unless told. */
  tier?: WorkspaceTier
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
  { today = {}, rateUsable = true, windows = [], tier = 'none' }: TaskFacts = {},
): TaskCredits {
  const terms =
    subscription === null
      ? null
      : {
          status: subscription.status,
          creditsPerMonth: subscription.plan.creditsPerMonth,
          creditsPerDay: subscription.plan.creditsPerDay,
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
    tariffCreditsToday: {
      charged: toCredits(today.charged ?? 0),
      held: toCredits(today.held ?? 0),
    },
    rateUsable,
    windows,
    tier,
  })
  return {
    spendable: verdict.spendable,
    spendableNow: verdict.spendableNow,
    setAside: verdict.held,
    minToStart: verdict.needed,
    today: verdict.today,
    // As `usageWindowsDto` of @repo/billing sends them.
    windows: verdict.windows.map((window) => ({
      kind: window.kind,
      limit: window.limit,
      used: Math.ceil(Number(window.used)),
      left: usageWindowRoom(window),
      resetsAt: window.resetsAt,
    })),
    tier: verdict.tier,
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
 * as the server counts it; `facts` add the tariff credits of the day, the unpaid work and the
 * credit rate.
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
