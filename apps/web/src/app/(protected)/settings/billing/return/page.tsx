import type { Metadata } from 'next'

import { MethodReturn } from '@/components/billing/method-return'
import { orderIdFromQuery } from '@/components/billing/order-id'
import { OrderReturn } from '@/components/billing/order-return'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Оплата' }

/**
 * Where ЮKassa sends the customer after its page: `?order=<id of the order>` after a payment,
 * `?method=1` after the binding of a card.
 */
export default async function BillingReturnPage({
  searchParams,
}: PageProps<'/settings/billing/return'>) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const query = await searchParams
  // A link that names an order is about that order, whatever else it carries.
  const orderId = orderIdFromQuery(query.order)
  if (orderId === null && query.method === '1') return <MethodReturn />
  // A link that cannot name an order is «not found» at once: nothing is asked for it.
  // Keyed by the order: another order in the same tab starts its own waiting.
  return <OrderReturn key={orderId} orderId={orderId} />
}
