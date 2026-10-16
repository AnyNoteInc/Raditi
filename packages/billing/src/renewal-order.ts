import type { Order } from '@repo/db'

import type { BillingTx } from './accounts.ts'
import type { RenewalChargeState } from './dto.ts'

// A renewal order is the order of one automatic charge: a subscription order that belongs to
// a subscription and whose Idempotence-Key names the period it renews. The key is all that
// tells it from the order of a payment the customer makes by hand, so it is built and read
// only here.

const RENEWAL_KEY = /^renew\.([0-9a-f-]{36})\.(\d{1,15})$/

/**
 * The Idempotence-Key of the charge that renews the period ending at `periodEnd`:
 * `renew.<subscriptionId>.<period end, ms>`, 56 characters of the set ЮKassa keys are kept to
 * (docs/plan/37-billing-plan.md, «Ключи идемпотентности»). One key per period, and
 * orders.idempotence_key is unique: a period has at most one renewal order and one charge.
 */
export function renewalKey(subscriptionId: string, periodEnd: Date): string {
  return `renew.${subscriptionId}.${periodEnd.getTime()}`
}

type RenewalFields = Pick<Order, 'kind' | 'subscriptionId' | 'idempotenceKey'>

/**
 * The end of the period a renewal order was made to renew, read from its key; null for every
 * other order — a first payment, a pack, a payment made by hand while the tariff is overdue.
 */
export function renewedPeriodEnd(order: RenewalFields): Date | null {
  if (order.kind !== 'subscription' || order.subscriptionId === null) return null
  const match = RENEWAL_KEY.exec(order.idempotenceKey)
  if (match === null || match[1] !== order.subscriptionId) return null
  return new Date(Number(match[2]))
}

export function isRenewalOrder(order: RenewalFields): boolean {
  return renewedPeriodEnd(order) !== null
}

/**
 * Where the charge that renews the current period of the subscription stands while it has no
 * outcome: its order is pending, with a payment (`at_bank`) or without one (`unanswered`).
 * `none` when no charge was started for the period or its order is closed. The order of a
 * charge is made under the lock of the subscription row (`chargeRenewals`): whoever reads here
 * while holding that lock sees every charge that was started before.
 */
export async function renewalChargeUnderWay(
  db: Pick<BillingTx, 'order'>,
  subscription: { id: string; currentPeriodEnd: Date },
): Promise<RenewalChargeState> {
  const order = await db.order.findUnique({
    where: { idempotenceKey: renewalKey(subscription.id, subscription.currentPeriodEnd) },
    select: { status: true, yookassaPaymentId: true },
  })
  if (order?.status !== 'pending') return 'none'
  return order.yookassaPaymentId === null ? 'unanswered' : 'at_bank'
}
