import { describe, expect, it, vi } from 'vitest'

import {
  isRenewalOrder,
  renewalChargeUnderWay,
  renewalKey,
  renewedPeriodEnd,
} from './renewal-order.ts'

const SUBSCRIPTION = '0199a000-0000-7000-8000-0000000000c1'
const PERIOD_END = new Date('2026-10-18T09:30:00.000Z')

const order = (
  fields: Partial<Parameters<typeof renewedPeriodEnd>[0]> = {},
): Parameters<typeof renewedPeriodEnd>[0] => ({
  kind: 'subscription',
  subscriptionId: SUBSCRIPTION,
  idempotenceKey: renewalKey(SUBSCRIPTION, PERIOD_END),
  ...fields,
})

describe('renewalKey', () => {
  it('names the subscription and the end of the period in milliseconds', () => {
    expect(renewalKey(SUBSCRIPTION, PERIOD_END)).toBe(`renew.${SUBSCRIPTION}.1792315800000`)
  })

  it('fits an Idempotence-Key and the column, in the characters ЮKassa keys are kept to', () => {
    const key = renewalKey(SUBSCRIPTION, PERIOD_END)
    expect(key).toHaveLength(56)
    expect(key).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    // Thirteen digits until the year 2286.
    expect(renewalKey(SUBSCRIPTION, new Date('2286-01-01T00:00:00Z')).length).toBeLessThanOrEqual(
      64,
    )
  })

  it('differs for every period and every subscription', () => {
    const next = new Date(PERIOD_END.getTime() + 1)
    expect(renewalKey(SUBSCRIPTION, next)).not.toBe(renewalKey(SUBSCRIPTION, PERIOD_END))
    expect(renewalKey('0199a000-0000-7000-8000-0000000000c2', PERIOD_END)).not.toBe(
      renewalKey(SUBSCRIPTION, PERIOD_END),
    )
  })
})

describe('renewedPeriodEnd', () => {
  it('reads the period back from the key of a renewal order', () => {
    expect(renewedPeriodEnd(order())).toEqual(PERIOD_END)
    expect(isRenewalOrder(order())).toBe(true)
  })

  it.each([
    ['a first payment, which has no subscription yet', { subscriptionId: null }],
    ['a pack', { kind: 'pack' as const }],
    ['a top-up', { kind: 'topup' as const }],
    [
      'a payment the customer makes by hand for an overdue tariff',
      { idempotenceKey: '0199a000-0000-7000-8000-0000000000d1' },
    ],
    [
      'a key of another subscription',
      { idempotenceKey: renewalKey('0199a000-0000-7000-8000-0000000000c2', PERIOD_END) },
    ],
    ['a key without the period', { idempotenceKey: `renew.${SUBSCRIPTION}.` }],
    ['a key with something after the period', { idempotenceKey: `renew.${SUBSCRIPTION}.1.2` }],
    ['a key that only starts like one', { idempotenceKey: 'renew.me.1792315800000' }],
  ])('knows no period for %s', (_case, fields) => {
    expect(renewedPeriodEnd(order(fields))).toBeNull()
    expect(isRenewalOrder(order(fields))).toBe(false)
  })
})

describe('renewalChargeUnderWay', () => {
  type Reader = Parameters<typeof renewalChargeUnderWay>[0]
  const subscription = { id: SUBSCRIPTION, currentPeriodEnd: PERIOD_END }
  const reading = (row: { status: string; yookassaPaymentId: string | null } | null) => {
    const findUnique = vi.fn().mockResolvedValue(row)
    return { findUnique, db: { order: { findUnique } } as unknown as Reader }
  }

  it('asks for the one order that renews the period the subscription stands in', async () => {
    const { db, findUnique } = reading(null)

    expect(await renewalChargeUnderWay(db, subscription)).toBe('none')

    expect(findUnique).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { idempotenceKey: renewalKey(SUBSCRIPTION, PERIOD_END) },
      }),
    )
  })

  it.each([
    ['at the bank: the pending order holds a payment', 'pending', 'pm-1', 'at_bank'],
    ['without an answer: the pending order holds no payment', 'pending', null, 'unanswered'],
    ['over once the order is paid', 'paid', 'pm-1', 'none'],
    ['over once the order has failed', 'failed', 'pm-1', 'none'],
    ['over when the order failed without a payment', 'failed', null, 'none'],
    ['over once the order is cancelled', 'cancelled', null, 'none'],
    ['over once the money went back', 'refunded', 'pm-1', 'none'],
  ] as const)('tells that the charge is %s', async (_case, status, yookassaPaymentId, state) => {
    expect(
      await renewalChargeUnderWay(reading({ status, yookassaPaymentId }).db, subscription),
    ).toBe(state)
  })
})
