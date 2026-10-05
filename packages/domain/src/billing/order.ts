import { z } from 'zod'
import { conflict } from '../errors.ts'

/** What an order pays for — the database enum OrderKind. */
export const orderKinds = ['subscription', 'pack', 'topup'] as const
export const orderKindSchema = z.enum(orderKinds)
export type OrderKind = z.infer<typeof orderKindSchema>

/**
 * Statuses of an order — the database enum OrderStatus. `failed`: ЮKassa cancelled the
 * payment (the bank declined it, or the customer never paid). `cancelled`: we closed the
 * order ourselves without a payment outcome.
 */
export const orderStatuses = ['pending', 'paid', 'failed', 'refunded', 'cancelled'] as const
export const orderStatusSchema = z.enum(orderStatuses)
export type OrderStatus = z.infer<typeof orderStatusSchema>

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'failed', 'cancelled'],
  paid: ['refunded'],
  failed: [],
  refunded: [],
  cancelled: [],
}

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return Object.hasOwn(transitions, from) && transitions[from].includes(to)
}

export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return transitions[from]
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canOrderTransition(from, to)) throw conflict(`Order cannot move from ${from} to ${to}`)
}

/** Payment statuses of the ЮKassa API; the spelling `canceled` is theirs. */
export const yookassaPaymentStatuses = [
  'pending',
  'waiting_for_capture',
  'succeeded',
  'canceled',
] as const
export const yookassaPaymentStatusSchema = z.enum(yookassaPaymentStatuses)
export type YookassaPaymentStatus = z.infer<typeof yookassaPaymentStatusSchema>

const orderStatusByPayment: Record<YookassaPaymentStatus, 'paid' | 'failed' | null> = {
  pending: null,
  // payments are created with capture: true, so this state is only passed through
  waiting_for_capture: null,
  succeeded: 'paid',
  canceled: 'failed',
}

/** The order status a payment status leads to; null while the payment has no outcome yet. */
export function orderStatusForPayment(payment: YookassaPaymentStatus): 'paid' | 'failed' | null {
  return Object.hasOwn(orderStatusByPayment, payment) ? orderStatusByPayment[payment] : null
}

/**
 * The transition a payment status causes for an order, safe to call for every webhook, poll
 * and repeat. Returns the new status, or null when nothing changes: the payment has no outcome
 * yet, the outcome is already applied (a refunded order was paid), or the payment was not made
 * and the order is closed anyway. Throws a conflict when the payment contradicts the order —
 * money arrived for an order closed as `failed` or `cancelled`, or a paid one is reported
 * cancelled — so the caller cannot drop it unnoticed.
 */
export function orderTransitionForPayment(
  current: OrderStatus,
  payment: YookassaPaymentStatus,
): OrderStatus | null {
  const target = orderStatusForPayment(payment)
  if (target === null || target === current) return null
  if (canOrderTransition(current, target)) return target
  const alreadyApplied = target === 'paid' && current === 'refunded'
  const closedUnpaid = target === 'failed' && current === 'cancelled'
  if (alreadyApplied || closedUnpaid) return null
  throw conflict(`Order in status ${current} contradicts a ${payment} payment`)
}
