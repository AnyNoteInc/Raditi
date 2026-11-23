import { recordOriFact, type Order } from '@repo/db'
import { Money } from '@repo/domain'
import type { Payment } from '@repo/yookassa'

import type { BillingTx } from './accounts.ts'

/**
 * What the journal of facts keeps of a paid service (149-FZ, art. 10.1; Government Decree № 1526,
 * p. 3 «д»; docs/plan/88-artifacts.md, slice 88.16а-1): the time, the payment organisation, the
 * currency, the amount, the number of the transaction and the payment system with its identifiers.
 * Never a card number: the type of the card names the system, and ЮKassa's id of the method
 * identifies it. The amount is a string of Decimal (rule 8).
 */
export function paymentFactDetail(
  order: Pick<Order, 'id' | 'kind'>,
  payment: Payment,
): Record<string, string> {
  const method = payment.payment_method
  return {
    organisation: 'ЮKassa',
    transaction: payment.id,
    currency: payment.amount.currency,
    amount: new Money(payment.amount.value).toFixed(2),
    order: order.id,
    service: order.kind,
    ...(method ? { system: method.type, methodId: method.id } : {}),
    ...(method?.card?.card_type ? { card: method.card.card_type } : {}),
  }
}

/** The fact of a payment, in the transaction that applies it. */
export async function recordPaymentFact(
  tx: Pick<BillingTx, '$executeRaw'>,
  order: Pick<Order, 'id' | 'kind' | 'userId'>,
  payment: Payment,
  paidAt: Date,
): Promise<void> {
  await recordOriFact(tx, {
    kind: 'payment',
    userId: order.userId,
    detail: paymentFactDetail(order, payment),
    now: paidAt,
  })
}
