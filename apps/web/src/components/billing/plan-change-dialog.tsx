'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'

import { formatMoscowDay } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { DetailRow, DetailRows } from './billing-surface'
import type { PlanOffer, Subscription } from './billing-types'
import { ConfirmDialog } from './confirm-dialog'
import { billingErrorText, domainCodeOf, type BillingCallError } from './error-text'
import { planChangeCharge, planChangeTerms, planLimits } from './plan-format'

/** Why the change was not scheduled, for the customer. */
function failureText(error: BillingCallError): string {
  // The server's text for this refusal is written about a payment the customer makes.
  if (domainCodeOf(error) === 'BILLING_PAYMENT_IN_PROGRESS') {
    return 'Списание за следующий период уже отправлено в банк. Сменить тариф можно будет, когда оно завершится: обновите страницу через пару минут.'
  }
  return billingErrorText(
    error,
    'Не удалось сменить тариф. Проверьте соединение и попробуйте ещё раз.',
  )
}

/**
 * The confirmation of a change of tariff: it starts with the next period on the named day,
 * nothing is charged or recalculated today, and the dialog names what is charged then and how —
 * or says that with auto-renewal off the tariff changes only if it is renewed.
 *
 * The subscription is the one the dialog was opened for: a refusal refreshes the page behind
 * it, and the words of the dialog must not change under the customer's eyes.
 */
export function PlanChangeDialog({
  plan,
  subscription,
  open,
  onClose,
  onScheduled,
}: {
  plan: PlanOffer
  subscription: Subscription
  open: boolean
  onClose: () => void
  /** The change is recorded: the subscription as the page shows it now. */
  onScheduled: (subscription: Subscription) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)
  const { period, autoRenewal, paymentMethod, nextPlan } = subscription
  const day = formatMoscowDay(period.end)

  const schedule = useMutation(
    trpc.billing.schedulePlanChange.mutationOptions({
      onSuccess: (scheduled) => {
        // What the change does is known: the page shows it at once.
        queryClient.setQueryData(trpc.billing.overview.queryKey(), (shown) =>
          shown ? { ...shown, subscription: scheduled } : shown,
        )
        onScheduled(scheduled)
      },
      onSettled: () => {
        // After a refusal as well: it may be about what the page shows — a tariff that has
        // just ended or is no longer sold, one more site, a charge that has just left.
        void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.billing.plans.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      },
    }),
  )

  function confirm() {
    if (sent.current) return
    sent.current = true
    schedule.mutate(
      { planSlug: plan.slug },
      {
        onSettled: () => {
          sent.current = false
        },
      },
    )
  }

  const charge = planChangeCharge({
    periodEnd: period.end,
    price: plan.price,
    autoRenewal,
    methodLabel: paymentMethod?.label ?? null,
  })

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Перейти на тариф «${plan.name}»?`}
      busy={schedule.isPending}
      error={schedule.error ? failureText(schedule.error) : null}
      keepLabel="Не менять"
      // The name of a button keeps its plain spaces: it is looked up by that name.
      confirmLabel={`Перейти с ${day}`}
      onConfirm={confirm}
    >
      <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
        {nbsp(
          planChangeTerms({
            currentName: subscription.plan.name,
            periodEnd: period.end,
            replacedName: nextPlan && nextPlan.id !== plan.id ? nextPlan.name : null,
          }),
        )}
      </Typography>
      {/* The rows are closed by a line of their own: nothing with a border follows them. */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <DetailRows mt={2.5}>
          <DetailRow label={nbsp(`С ${day}`)}>{nbsp(planLimits(plan))}</DetailRow>
          <DetailRow label={nbsp(charge.label)}>{nbsp(charge.value)}</DetailRow>
        </DetailRows>
      </Box>
    </ConfirmDialog>
  )
}
