'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'

import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'
import { useTRPC } from '@/trpc/client'

import { DetailRow, DetailRows } from './billing-surface'
import type { Subscription } from './billing-types'
import { domainCodeOf, type BillingCallError } from './error-text'
import {
  PaymentDialog,
  paymentStartFailure,
  usePaymentStart,
  type PaymentCheck,
} from './payment-dialog'
import { pastDuePaymentTerms, planLimits } from './plan-format'

function failureText(error: BillingCallError): string {
  // Paid a moment ago — by the page of an earlier try, or in another tab.
  if (domainCodeOf(error) === 'BILLING_NOTHING_TO_CHANGE') {
    return 'Тариф уже оплачен. Обновите страницу, чтобы увидеть его.'
  }
  return paymentStartFailure(error)
}

/**
 * The last step before the payment page of a tariff whose renewal charge failed: what is paid
 * for and how much, that the month is counted from today, and whether the payment method is
 * saved — by the consent to auto-renewal as it stands. Confirming starts the payment and takes
 * the browser to the ЮKassa page.
 *
 * The payment is started for what the database holds, and the request names neither a tariff
 * nor an amount. So the dialog reads the tariff anew every time it opens — a change of tariff
 * scheduled or taken back in another tab, auto-renewal switched off there, a new price — and
 * the payment cannot be started before that answer is in: what the customer confirms is what
 * they are charged. `subscription` is what the page showed when the dialog was opened; the fresh
 * one takes its place while it still waits for a payment. The tariff paid for is the scheduled
 * one when a change is scheduled. Whether the payment saves its method is read the same way:
 * `savesMethod` is what the page knew, the fresh answer says what the shop does now.
 */
export function PastDueDialog({
  subscription,
  savesMethod,
  open,
  onClose,
}: {
  subscription: Subscription
  /** The shop saved payment methods when the dialog was opened (`autoRenewalAvailable`). */
  savesMethod: boolean
  open: boolean
  onClose: () => void
}) {
  const trpc = useTRPC()
  // The query of the page: the answer refreshes the page behind the dialog as well. Every
  // opening is a dialog of its own, so «on mount» is «when the dialog opens».
  const overview = useQuery({
    ...trpc.billing.overview.queryOptions(),
    refetchOnMount: 'always',
  })
  const pending = overview.isFetching || !overview.isFetchedAfterMount
  const fresh = overview.isFetchedAfterMount && overview.isSuccess
  const check: PaymentCheck = {
    pending,
    failure:
      !pending && !fresh
        ? 'Не удалось проверить тариф и сумму. Проверьте соединение и попробуйте ещё раз.'
        : null,
    retry: () => void overview.refetch(),
  }
  const read = fresh ? overview.data.subscription : null
  // A tariff that is paid for or over by now is not the dialog's to describe: it keeps the
  // words it was opened with, and the refusal of the payment says what happened.
  const paid = read?.status === 'past_due' ? read : subscription
  const plan = paid.nextPlan ?? paid.plan
  const saves = fresh ? overview.data.autoRenewalAvailable : savesMethod
  const payment = usePaymentStart((handlers) =>
    trpc.billing.startPastDuePayment.mutationOptions(handlers),
  )

  return (
    <PaymentDialog
      open={open}
      onClose={onClose}
      title={`Тариф «${plan.name}»`}
      description={planLimits(plan)}
      payment={payment}
      check={check}
      failureText={failureText}
      // Reachable only once the fresh answer is in: until then the button is not enabled.
      onConfirm={() => payment.start({})}
    >
      <DetailRows mt={2.5}>
        {/* The period is counted from the moment of the payment, which is not known yet. */}
        <DetailRow label="Период">С&nbsp;сегодняшнего дня на&nbsp;месяц</DetailRow>
        <DetailRow label="К оплате сегодня">
          <Box component="span" sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
            {formatRubles(plan.price)}&nbsp;₽
          </Box>
        </DetailRow>
      </DetailRows>
      <Typography
        variant="body2"
        color="textSecondary"
        sx={{ py: 2, borderTop: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        {nbsp(pastDuePaymentTerms(paid.autoRenewal, plan.price, saves))}
      </Typography>
    </PaymentDialog>
  )
}
