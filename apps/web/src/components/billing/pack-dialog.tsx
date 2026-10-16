'use client'

import Box from '@mui/material/Box'

import { formatRubles } from '@/lib/rubles'
import { useTRPC } from '@/trpc/client'

import { DetailRow, DetailRows } from './billing-surface'
import type { BillingOverview, PackOffer } from './billing-types'
import { domainCodeOf, type BillingCallError } from './error-text'
import { PaymentDialog, paymentStartFailure, usePaymentStart } from './payment-dialog'
import { packPromise } from './plan-format'

/**
 * Whether the customer may buy a pack now: payments are on and their tariff takes tasks. The
 * server refuses a pack checkout by the same rule (`startPackCheckout` of @repo/billing).
 */
export function canBuyPack({
  paymentsEnabled,
  subscription,
}: Pick<BillingOverview, 'paymentsEnabled' | 'subscription'>): boolean {
  return paymentsEnabled && subscription?.status === 'active'
}

function failureText(error: BillingCallError): string {
  // The server's text for «not on sale» is written about a tariff and offers to choose another.
  if (domainCodeOf(error) === 'BILLING_PLAN_NOT_FOUND') {
    return 'Пакет сейчас не продаётся. Обновите страницу.'
  }
  return paymentStartFailure(error)
}

/**
 * The last step before the payment page of a pack: what is bought and for how much. Nothing is
 * chosen here: a pack saves no payment method and renews nothing. Confirming starts the
 * checkout and takes the browser to the ЮKassa page.
 */
export function PackDialog({
  pack,
  open,
  onClose,
}: {
  pack: PackOffer
  open: boolean
  onClose: () => void
}) {
  const trpc = useTRPC()
  const payment = usePaymentStart((handlers) =>
    trpc.billing.startPackCheckout.mutationOptions(handlers),
  )

  return (
    <PaymentDialog
      open={open}
      onClose={onClose}
      title={pack.name}
      description={packPromise(pack.credits)}
      payment={payment}
      failureText={failureText}
      onConfirm={() => payment.start({})}
    >
      {/* The rows are closed by a line of their own: nothing with a border follows them. */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <DetailRows mt={2.5}>
          <DetailRow label="К оплате сегодня">
            <Box component="span" sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
              {formatRubles(pack.price)}&nbsp;₽
            </Box>
          </DetailRow>
        </DetailRows>
      </Box>
    </PaymentDialog>
  )
}
