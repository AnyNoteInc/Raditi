import { describe, expect, it } from 'vitest'
import {
  assertOrderTransition,
  canOrderTransition,
  nextOrderStatuses,
  orderKinds,
  orderKindSchema,
  orderStatuses,
  orderStatusForPayment,
  orderStatusSchema,
  orderTransitionForPayment,
  yookassaPaymentStatuses,
  yookassaPaymentStatusSchema,
  type OrderStatus,
  type YookassaPaymentStatus,
} from './order.ts'

const allowed: readonly (readonly [OrderStatus, OrderStatus])[] = [
  ['pending', 'paid'],
  ['pending', 'failed'],
  ['pending', 'cancelled'],
  ['paid', 'refunded'],
]
const forbidden = orderStatuses.flatMap((from) =>
  orderStatuses
    .filter((to) => !allowed.some(([a, b]) => a === from && b === to))
    .map((to) => [from, to] as const),
)
const conflict = expect.objectContaining({ name: 'DomainError', code: 'CONFLICT', httpStatus: 409 })

describe('order kinds and statuses', () => {
  it('lists exactly the values of the database enums', () => {
    expect(orderKinds).toEqual(['subscription', 'pack', 'topup'])
    expect(orderStatuses).toEqual(['pending', 'paid', 'failed', 'refunded', 'cancelled'])
    for (const kind of orderKinds) expect(orderKindSchema.parse(kind)).toBe(kind)
    for (const status of orderStatuses) expect(orderStatusSchema.parse(status)).toBe(status)
  })

  it.each(['canceled', 'succeeded', 'PAID', '', null])('rejects %j as an order status', (value) => {
    expect(orderStatusSchema.safeParse(value).success).toBe(false)
  })

  it.each(['renewal', 'top_up', '', null])('rejects %j as an order kind', (value) => {
    expect(orderKindSchema.safeParse(value).success).toBe(false)
  })
})

describe('order status machine', () => {
  it.each(allowed)('allows %s → %s', (from, to) => {
    expect(canOrderTransition(from, to)).toBe(true)
    expect(() => assertOrderTransition(from, to)).not.toThrow()
  })

  it('covers every pair of statuses with the two tables', () => {
    expect(allowed.length + forbidden.length).toBe(orderStatuses.length ** 2)
    expect(forbidden).toHaveLength(21)
  })

  it.each(forbidden)('refuses %s → %s', (from, to) => {
    expect(canOrderTransition(from, to)).toBe(false)
    expect(() => assertOrderTransition(from, to)).toThrow(conflict)
  })

  it.each([
    ['pending', ['paid', 'failed', 'cancelled']],
    ['paid', ['refunded']],
    ['failed', []],
    ['refunded', []],
    ['cancelled', []],
  ] as const)('lists what follows %s', (from, next) => {
    expect(nextOrderStatuses(from)).toEqual(next)
  })

  it('names both statuses in the error', () => {
    expect(() => assertOrderTransition('failed', 'paid')).toThrowError(
      'Order cannot move from failed to paid',
    )
  })

  it('refuses a status it does not know', () => {
    expect(canOrderTransition('toString' as OrderStatus, 'paid')).toBe(false)
    expect(canOrderTransition('pending', 'succeeded' as OrderStatus)).toBe(false)
    expect(() => assertOrderTransition('constructor' as OrderStatus, 'paid')).toThrow(conflict)
  })
})

describe('orderStatusForPayment', () => {
  it('knows the four payment statuses of ЮKassa', () => {
    expect(yookassaPaymentStatuses).toEqual([
      'pending',
      'waiting_for_capture',
      'succeeded',
      'canceled',
    ])
    expect(yookassaPaymentStatusSchema.safeParse('cancelled').success).toBe(false)
  })

  it.each([
    ['pending', null],
    ['waiting_for_capture', null],
    ['succeeded', 'paid'],
    ['canceled', 'failed'],
  ] as const)('maps a %s payment to %s', (payment, status) => {
    expect(orderStatusForPayment(payment)).toBe(status)
  })

  it('leads only to statuses a pending order may take', () => {
    for (const payment of yookassaPaymentStatuses) {
      const status = orderStatusForPayment(payment)
      if (status !== null) expect(canOrderTransition('pending', status)).toBe(true)
    }
  })

  it('has no outcome for a status it does not know', () => {
    expect(orderStatusForPayment('refunded' as YookassaPaymentStatus)).toBeNull()
    expect(orderStatusForPayment('toString' as YookassaPaymentStatus)).toBeNull()
  })
})

describe('orderTransitionForPayment', () => {
  // Every order status against every payment status: the new status, null or a conflict.
  const table: readonly (readonly [OrderStatus, YookassaPaymentStatus, OrderStatus | null])[] = [
    ['pending', 'pending', null],
    ['pending', 'waiting_for_capture', null],
    ['pending', 'succeeded', 'paid'],
    ['pending', 'canceled', 'failed'],
    // the outcome is already applied: a repeated webhook or a poll after it
    ['paid', 'pending', null],
    ['paid', 'waiting_for_capture', null],
    ['paid', 'succeeded', null],
    ['failed', 'pending', null],
    ['failed', 'waiting_for_capture', null],
    ['failed', 'canceled', null],
    // refunded after it was paid
    ['refunded', 'pending', null],
    ['refunded', 'waiting_for_capture', null],
    ['refunded', 'succeeded', null],
    // closed by us, and the payment was never made
    ['cancelled', 'pending', null],
    ['cancelled', 'waiting_for_capture', null],
    ['cancelled', 'canceled', null],
  ]
  const contradictions: readonly (readonly [OrderStatus, YookassaPaymentStatus])[] = [
    ['paid', 'canceled'],
    ['refunded', 'canceled'],
    // money arrived for an order that was closed without it
    ['failed', 'succeeded'],
    ['cancelled', 'succeeded'],
  ]

  it('covers every pair of order and payment status with the two tables', () => {
    const pairs = new Set([...table, ...contradictions].map(([order, pay]) => `${order}:${pay}`))
    expect(pairs.size).toBe(orderStatuses.length * yookassaPaymentStatuses.length)
  })

  it.each(table)('order %s, payment %s → %s', (order, payment, next) => {
    expect(orderTransitionForPayment(order, payment)).toBe(next)
  })

  it.each(contradictions)('order %s contradicts a %s payment', (order, payment) => {
    expect(() => orderTransitionForPayment(order, payment)).toThrow(conflict)
    expect(() => orderTransitionForPayment(order, payment)).toThrowError(
      `Order in status ${order} contradicts a ${payment} payment`,
    )
  })

  it('returns only transitions the status machine allows', () => {
    const contradicts = (order: OrderStatus, payment: YookassaPaymentStatus) =>
      contradictions.some(([a, b]) => a === order && b === payment)
    for (const order of orderStatuses) {
      for (const payment of yookassaPaymentStatuses) {
        if (contradicts(order, payment)) continue
        const next = orderTransitionForPayment(order, payment)
        if (next !== null) expect(canOrderTransition(order, next)).toBe(true)
      }
    }
  })

  it('applies one outcome once, however many times it is reported', () => {
    let status: OrderStatus = 'pending'
    const applied: OrderStatus[] = []
    for (const payment of ['pending', 'succeeded', 'succeeded', 'succeeded'] as const) {
      const next = orderTransitionForPayment(status, payment)
      if (next !== null) {
        applied.push(next)
        status = next
      }
    }
    expect(applied).toEqual(['paid'])
  })
})
