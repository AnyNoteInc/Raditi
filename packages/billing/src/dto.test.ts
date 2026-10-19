import { liveSubscriptionStatuses, orderKinds, orderStatuses } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  checkoutRequestSchema,
  checkoutSchema,
  creditBalancesSchema,
  MAX_PAYMENTS_PAGE,
  orderSyncSchema,
  packSchema,
  paymentMethodSyncSchema,
  paymentMethodUnlinkSchema,
  paymentSchema,
  paymentsPageSchema,
  paymentsQuerySchema,
  planListSchema,
  planOverviewSchema,
  planSchema,
  renewalChargeStates,
  subscriptionOverviewSchema,
  subscriptionWaitsSchema,
} from './dto.ts'

const ID = '0199a000-0000-7000-8000-0000000000a1'
const plan = {
  id: ID,
  slug: 'business',
  name: 'Бизнес',
  price: '12900.00',
  creditsPerMonth: 80,
  creditsPerDay: 10,
  maxSites: 3,
}
const pack = {
  id: ID,
  slug: 'pack',
  name: 'Пакет из 100 кредитов',
  price: '1990.00',
  credits: 100,
}
const period = { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') }
const subscription = {
  id: ID,
  status: 'active',
  plan,
  period,
  autoRenewal: true,
  nextPlan: null,
  paymentMethod: { label: 'Карта «Мир» ••\u00a04444' },
  pastDueSince: null,
}
const payment = {
  id: ID,
  kind: 'subscription',
  planName: 'Бизнес',
  period,
  amount: '12900.00',
  status: 'paid',
  failureReason: null,
  failureText: null,
  refundedAmount: null,
  refundedAt: null,
  paidAt: new Date('2026-09-18T09:00:05Z'),
  createdAt: new Date('2026-09-18T09:00:00Z'),
}

/** Money in a DTO is the string toFixed(2) prints, never a number. */
const notMoney = [12900, '12900', '12900.0', '12900.000', '-1.00', '012900.00', '12 900.00', '']

describe('plan DTOs', () => {
  it('accept a tariff and a pack with string prices', () => {
    expect(planSchema.parse(plan)).toEqual(plan)
    expect(planSchema.parse({ ...plan, creditsPerDay: null })).toMatchObject({
      creditsPerDay: null,
    })
    expect(packSchema.parse(pack)).toEqual(pack)
    expect(planListSchema.parse({ plans: [plan], pack })).toEqual({ plans: [plan], pack })
    expect(planListSchema.parse({ plans: [], pack: null })).toEqual({ plans: [], pack: null })
  })

  it.each(notMoney)('refuse the price %o', (price) => {
    expect(planSchema.safeParse({ ...plan, price }).success).toBe(false)
    expect(packSchema.safeParse({ ...pack, price }).success).toBe(false)
  })

  it.each([
    { creditsPerMonth: 0 },
    { creditsPerMonth: null },
    { creditsPerMonth: 80.5 },
    { creditsPerDay: 0 },
    { maxSites: 0 },
    { maxSites: null },
    { id: 'business' },
    { name: '' },
    { slug: '' },
  ])('refuse the tariff field %o', (change) => {
    expect(planSchema.safeParse({ ...plan, ...change }).success).toBe(false)
  })

  it('refuse a pack without credits', () => {
    expect(packSchema.safeParse({ ...pack, credits: 0 }).success).toBe(false)
    expect(packSchema.safeParse({ ...pack, credits: null }).success).toBe(false)
  })

  it('drop what the page must not see', () => {
    expect(planSchema.parse({ ...plan, isActive: true, sortOrder: 20 })).toEqual(plan)
  })
})

describe('plan overview DTO', () => {
  it('accepts «no subscription» and a live subscription', () => {
    expect(planOverviewSchema.parse({ subscription: null })).toEqual({ subscription: null })
    expect(planOverviewSchema.parse({ subscription })).toEqual({ subscription })
    expect(
      subscriptionOverviewSchema.parse({
        ...subscription,
        status: 'past_due',
        autoRenewal: false,
        nextPlan: { ...plan, slug: 'agency' },
        paymentMethod: null,
        pastDueSince: period.end,
      }),
    ).toMatchObject({ status: 'past_due', nextPlan: { slug: 'agency' }, paymentMethod: null })
  })

  it('knows exactly the live statuses', () => {
    expect(subscriptionOverviewSchema.shape.status.options).toEqual([...liveSubscriptionStatuses])
    for (const status of ['cancelled', 'expired', 'paused']) {
      expect(subscriptionOverviewSchema.safeParse({ ...subscription, status }).success).toBe(false)
    }
  })

  it.each([
    { period: { start: '2026-09-18', end: period.end } },
    { period: { start: period.start } },
    { autoRenewal: 'on' },
    { paymentMethod: { label: '' } },
    { plan: { ...plan, price: 12900 } },
    { nextPlan: undefined },
  ])('refuses the subscription field %o', (change) => {
    expect(subscriptionOverviewSchema.safeParse({ ...subscription, ...change }).success).toBe(false)
  })
})

describe('credit balances DTO', () => {
  const noGift = { balance: 0, held: 0, available: 0, granted: false }
  const balances = {
    tariff: { balance: 47, held: 2, available: 45 },
    gift: noGift,
    pack: { balance: 10, held: 0, available: 10 },
    totalAvailable: 55,
  }

  it('accepts whole credits that add up', () => {
    expect(creditBalancesSchema.parse(balances)).toEqual(balances)
    const empty = { balance: 0, held: 0, available: 0 }
    expect(
      creditBalancesSchema.parse({ tariff: empty, gift: noGift, pack: empty, totalAvailable: 0 }),
    ).toMatchObject({ totalAvailable: 0 })
  })

  it('counts the gift in what is left, granted and partly reserved', () => {
    const withGift = {
      ...balances,
      gift: { balance: 35, held: 5, available: 30, granted: true },
      totalAvailable: 85,
    }
    expect(creditBalancesSchema.parse(withGift)).toEqual(withGift)
    // A gift that is spent stays granted.
    const spent = { ...balances, gift: { ...noGift, granted: true } }
    expect(creditBalancesSchema.parse(spent)).toEqual(spent)
  })

  it('accepts the gift a user without a workspace is promised: its numbers, not granted', () => {
    const empty = { balance: 0, held: 0, available: 0 }
    const promised = {
      tariff: empty,
      gift: { balance: 35, held: 0, available: 35, granted: false },
      pack: empty,
      totalAvailable: 35,
    }
    expect(creditBalancesSchema.parse(promised)).toEqual(promised)
    // A promise obeys the rule of every account: what is available is the balance less the held.
    expect(
      creditBalancesSchema.safeParse({
        ...promised,
        gift: { balance: 0, held: 0, available: 35, granted: false },
      }).success,
    ).toBe(false)
  })

  it.each([
    // An account whose `available` is not balance − held, under a total that agrees with it:
    // only the rule of the account itself can refuse these three.
    { tariff: { balance: 47, held: 2, available: 47 }, totalAvailable: 57 },
    { pack: { balance: 10, held: 0, available: 9 }, totalAvailable: 54 },
    { gift: { balance: 35, held: 5, available: 35, granted: true }, totalAvailable: 90 },
    { totalAvailable: 57 },
    { tariff: { balance: 47.5, held: 2, available: 45.5 } },
    { tariff: { balance: 1, held: 2, available: -1 } },
    { tariff: { balance: '47.00', held: '2.00', available: '45.00' } },
    // The total counts the gift: accounts that add up to 90 under a total of 55.
    { gift: { balance: 35, held: 0, available: 35, granted: true } },
    { gift: { balance: 35.5, held: 0, available: 35.5, granted: true }, totalAvailable: 90.5 },
    { gift: { balance: 0, held: 0, available: 0 } },
    { gift: { balance: 0, held: 0, available: 0, granted: 'no' } },
    { gift: undefined },
  ])('refuses %o', (change) => {
    expect(creditBalancesSchema.safeParse({ ...balances, ...change }).success).toBe(false)
  })
})

describe('payment history DTOs', () => {
  it('accept every kind and status of an order', () => {
    for (const kind of orderKinds) {
      for (const status of orderStatuses) {
        expect(paymentSchema.parse({ ...payment, kind, status })).toMatchObject({ kind, status })
      }
    }
    expect(paymentSchema.safeParse({ ...payment, kind: 'gift' }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...payment, status: 'succeeded' }).success).toBe(false)
  })

  it('accept a failed, a refunded and a pack order', () => {
    expect(
      paymentSchema.parse({
        ...payment,
        status: 'failed',
        failureReason: 'card_declined',
        failureText: 'Банк отклонил платёж.',
        paidAt: null,
        period: null,
      }),
    ).toMatchObject({
      failureReason: 'card_declined',
      failureText: 'Банк отклонил платёж.',
      period: null,
    })
    // The sentence is a sentence: a failed order is never shown with an empty reason.
    expect(paymentSchema.safeParse({ ...payment, failureText: '' }).success).toBe(false)
    const { failureText: _omitted, ...withoutText } = payment
    expect(paymentSchema.safeParse(withoutText).success).toBe(false)
    expect(
      paymentSchema.parse({
        ...payment,
        kind: 'pack',
        planName: 'Пакет из 100 кредитов',
        period: null,
        amount: '1990.00',
        status: 'refunded',
        refundedAmount: '1990.00',
        refundedAt: new Date('2026-08-05T10:00:00Z'),
      }),
    ).toMatchObject({ refundedAmount: '1990.00' })
    expect(paymentSchema.parse({ ...payment, kind: 'topup', planName: null })).toMatchObject({
      planName: null,
    })
  })

  it.each(notMoney)('refuse the amount %o', (amount) => {
    expect(paymentSchema.safeParse({ ...payment, amount }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...payment, refundedAmount: amount }).success).toBe(false)
  })

  it('page by the id of the last order', () => {
    expect(paymentsPageSchema.parse({ items: [payment], nextCursor: ID })).toEqual({
      items: [payment],
      nextCursor: ID,
    })
    expect(paymentsPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(paymentsPageSchema.safeParse({ items: [], nextCursor: '2' }).success).toBe(false)
  })

  it('ask for twenty orders by default and a hundred at most', () => {
    expect(paymentsQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(paymentsQuerySchema.parse({ cursor: ID, limit: MAX_PAYMENTS_PAGE })).toEqual({
      cursor: ID,
      limit: 100,
    })
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { limit: '20' },
      { cursor: 'last' },
      { cursor: null },
      { workspaceId: ID },
    ]) {
      expect(paymentsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
    }
  })
})

describe('checkout DTOs', () => {
  it('take the plan and the consent to auto-renewal, and nothing else', () => {
    const request = { planSlug: 'business', autoRenew: false }
    expect(checkoutRequestSchema.parse(request)).toEqual(request)
    expect(checkoutRequestSchema.parse({ ...request, autoRenew: true }).autoRenew).toBe(true)
    // The consent is the customer's own choice: it has no default and no other spelling.
    expect(checkoutRequestSchema.safeParse({ planSlug: 'business' }).success).toBe(false)
    for (const autoRenew of ['true', 1, null]) {
      expect(checkoutRequestSchema.safeParse({ ...request, autoRenew }).success).toBe(false)
    }
    for (const planSlug of ['', 's'.repeat(51), 7]) {
      expect(checkoutRequestSchema.safeParse({ ...request, planSlug }).success).toBe(false)
    }
    // The amount is the price of the plan, never what the browser sends.
    expect(checkoutRequestSchema.safeParse({ ...request, amount: '1.00' }).success).toBe(false)
    expect(checkoutRequestSchema.safeParse({ ...request, userId: ID }).success).toBe(false)
  })

  it('send the customer only to an http(s) page', () => {
    const checkout = { orderId: ID, confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2' }
    expect(checkoutSchema.parse(checkout)).toEqual(checkout)
    for (const confirmationUrl of ['javascript:alert(1)', 'data:text/html,x', '/pay', '']) {
      expect(checkoutSchema.safeParse({ ...checkout, confirmationUrl }).success).toBe(false)
    }
    expect(checkoutSchema.safeParse({ ...checkout, orderId: 'order' }).success).toBe(false)
  })
})

describe('order sync DTO', () => {
  const order = {
    orderId: ID,
    status: 'pending',
    kind: 'subscription',
    planName: 'Бизнес',
    packCredits: null,
    amount: '12900.00',
    failureText: null,
    refundNeeded: false,
    subscription: null,
  }

  it('accepts a pending, a paid and a failed order', () => {
    expect(orderSyncSchema.parse(order)).toEqual(order)
    const paid = { ...order, status: 'paid', subscription }
    expect(orderSyncSchema.parse(paid)).toEqual(paid)
    const failed = { ...order, status: 'failed', failureText: 'Банк отклонил платёж.' }
    expect(orderSyncSchema.parse(failed)).toEqual(failed)
    for (const status of orderStatuses) {
      expect(orderSyncSchema.safeParse({ ...order, status }).success).toBe(true)
    }
  })

  it('accepts a pack order with the size of its pack', () => {
    const packOrder = {
      ...order,
      kind: 'pack',
      planName: 'Пакет из 100 кредитов',
      packCredits: 100,
      amount: '1990.00',
    }
    expect(orderSyncSchema.parse(packOrder)).toEqual(packOrder)
    for (const packCredits of [0, -1, 2.5, '100', undefined]) {
      expect(orderSyncSchema.safeParse({ ...packOrder, packCredits }).success).toBe(false)
    }
  })

  it('carries money as a string and a reason as a sentence', () => {
    for (const amount of notMoney) {
      expect(orderSyncSchema.safeParse({ ...order, amount }).success).toBe(false)
    }
    expect(orderSyncSchema.safeParse({ ...order, failureText: '' }).success).toBe(false)
    expect(orderSyncSchema.safeParse({ ...order, refundNeeded: undefined }).success).toBe(false)
    expect(orderSyncSchema.safeParse({ ...order, status: 'unknown' }).success).toBe(false)
  })

  it('drops what the page must not see', () => {
    const parsed = orderSyncSchema.parse({ ...order, failureReason: 'general_decline' })
    expect(parsed).not.toHaveProperty('failureReason')
  })
})

describe('payment method DTOs', () => {
  it('tell where a renewal charge under way stands, in one of three words', () => {
    expect(renewalChargeStates).toEqual(['none', 'at_bank', 'unanswered'])
    for (const renewalCharge of renewalChargeStates) {
      const binding = { state: 'active', renewalCharge, subscription }
      expect(paymentMethodSyncSchema.parse(binding)).toEqual(binding)
      expect(paymentMethodUnlinkSchema.parse({ renewalCharge })).toEqual({ renewalCharge })
      const waits = { bindingPending: true, renewalCharge }
      expect(subscriptionWaitsSchema.parse(waits)).toEqual(waits)
    }
  })

  it('never leave the charge out or name it otherwise', () => {
    for (const renewalCharge of [undefined, null, true, 'pending', '']) {
      expect(
        paymentMethodSyncSchema.safeParse({ state: 'active', renewalCharge, subscription: null })
          .success,
      ).toBe(false)
      expect(paymentMethodUnlinkSchema.safeParse({ renewalCharge }).success).toBe(false)
      expect(
        subscriptionWaitsSchema.safeParse({ bindingPending: false, renewalCharge }).success,
      ).toBe(false)
    }
  })

  it('tell that a binding waits as a yes or a no, and drop the id of its method', () => {
    const parsed = subscriptionWaitsSchema.parse({
      bindingPending: true,
      renewalCharge: 'none',
      pendingPaymentMethodId: 'pm-waiting',
    })
    expect(parsed).toEqual({ bindingPending: true, renewalCharge: 'none' })
    for (const bindingPending of [undefined, null, 'pm-waiting', 1]) {
      expect(
        subscriptionWaitsSchema.safeParse({ bindingPending, renewalCharge: 'none' }).success,
      ).toBe(false)
    }
  })
})
