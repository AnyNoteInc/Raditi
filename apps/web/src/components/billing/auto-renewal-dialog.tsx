'use client'

import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'

import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type {
  AutoRenewalCancel,
  CreditBalances,
  RenewalCharge,
  Subscription,
} from './billing-types'
import { ConfirmDialog } from './confirm-dialog'
import { billingErrorText } from './error-text'
import { cancelRenewalWarning } from './plan-format'

/** What the customer is about to switch off, kept with the dialog while it closes. */
export interface RenewalCancelling {
  subscription: Subscription
  credits: CreditBalances
  /** The renewal charge the page knew to be under way when the dialog was opened. */
  renewalCharge: RenewalCharge
  /** The shop took one-time payments only then: auto-renewal cannot be switched back on. */
  oneTimeOnly: boolean
}

/**
 * The confirmation before auto-renewal is switched off: until when the tariff works, which
 * credits can still be used, whether tasks are taken after it — they are while the gift credits
 * last — and what stays. The numbers are the customer's own. A
 * renewal charge that has already left is not stopped: the dialog says so when the page knows
 * of one, and the answer tells what the switch itself found. At a shop that takes one-time
 * payments only the dialog also says that auto-renewal cannot be switched back on.
 */
export function CancelRenewalDialog({
  cancelling,
  open,
  onClose,
  onCancelled,
}: {
  cancelling: RenewalCancelling
  open: boolean
  onClose: () => void
  onCancelled: (answer: AutoRenewalCancel) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)
  const { subscription, credits, renewalCharge, oneTimeOnly } = cancelling

  const cancel = useMutation(
    trpc.billing.cancelAutoRenew.mutationOptions({
      onSuccess: (answer) => {
        // What the switch does is known: the page shows it at once, whatever becomes of the
        // reading that follows.
        queryClient.setQueryData(trpc.billing.overview.queryKey(), (shown) =>
          shown?.subscription
            ? {
                ...shown,
                renewalCharge: answer.renewalCharge,
                subscription: { ...shown.subscription, autoRenewal: false },
              }
            : shown,
        )
        onCancelled(answer)
      },
      onSettled: () => {
        // After a refusal as well: it may be about what the page shows — a tariff that has
        // just ended, auto-renewal that is off already.
        void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      },
    }),
  )

  function confirm() {
    if (sent.current) return
    sent.current = true
    cancel.mutate(
      {},
      {
        onSettled: () => {
          sent.current = false
        },
      },
    )
  }

  const warning = cancelRenewalWarning({
    planName: subscription.plan.name,
    periodEnd: subscription.period.end,
    left: {
      tariff: credits.tariff.available,
      gift: credits.gift.available,
      pack: credits.pack.available,
    },
    pastDue: subscription.status === 'past_due',
    nextPlanName: subscription.nextPlan?.name ?? null,
    charge: renewalCharge,
    oneTimeOnly,
  })

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Отключить автопродление?"
      busy={cancel.isPending}
      error={
        cancel.error
          ? billingErrorText(
              cancel.error,
              'Не удалось отключить автопродление. Проверьте соединение и попробуйте ещё раз.',
            )
          : null
      }
      keepLabel="Оставить включённым"
      confirmLabel="Отключить"
      danger
      onConfirm={confirm}
    >
      {warning.map((sentence, index) => (
        <Typography
          key={sentence}
          variant="body2"
          color="textSecondary"
          sx={{ mt: index === 0 ? 1 : 1.5 }}
        >
          {nbsp(sentence)}
        </Typography>
      ))}
    </ConfirmDialog>
  )
}
