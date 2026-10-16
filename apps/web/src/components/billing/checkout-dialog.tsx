'use client'

import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import Typography from '@mui/material/Typography'
import { useId, useState } from 'react'

import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'
import { useTRPC } from '@/trpc/client'

import { DetailRow, DetailRows } from './billing-surface'
import type { PlanOffer } from './billing-types'
import { PaymentDialog, usePaymentStart } from './payment-dialog'
import { checkoutWithoutRenewal, planLimits } from './plan-format'

/**
 * The last step before the payment page: what is bought, for how much, and the consent to
 * auto-renewal, which is off until the customer ticks it. Confirming starts the checkout and
 * takes the browser to the ЮKassa page.
 *
 * While the shop takes one-time payments only (`autoRenewalAvailable` is false) there is no
 * consent to give: the dialog says so in its place, and the checkout is started without it.
 */
export function CheckoutDialog({
  plan,
  autoRenewalAvailable,
  open,
  onClose,
}: {
  plan: PlanOffer
  /** The shop saves payment methods: the customer may agree to auto-renewal. */
  autoRenewalAvailable: boolean
  open: boolean
  onClose: () => void
}) {
  const trpc = useTRPC()
  const [autoRenew, setAutoRenew] = useState(false)
  const renewTitleId = useId()
  const renewTextId = useId()
  const price = formatRubles(plan.price)
  const payment = usePaymentStart((handlers) =>
    trpc.billing.startCheckout.mutationOptions(handlers),
  )
  const { busy } = payment

  return (
    <PaymentDialog
      open={open}
      onClose={onClose}
      title={`Тариф «${plan.name}»`}
      description={planLimits(plan)}
      payment={payment}
      // A tick is never sent from a dialog that shows none.
      onConfirm={() =>
        payment.start({ planSlug: plan.slug, autoRenew: autoRenewalAvailable && autoRenew })
      }
    >
      <DetailRows mt={2.5}>
        {/* The period is counted from the moment of the payment, which is not known yet. */}
        <DetailRow label="Период">С&nbsp;сегодняшнего дня на&nbsp;месяц</DetailRow>
        <DetailRow label="К оплате сегодня">
          <Box component="span" sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
            {price}&nbsp;₽
          </Box>
        </DetailRow>
      </DetailRows>

      {autoRenewalAvailable ? (
        <Box
          component="label"
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 1.5,
            py: 2,
            borderTop: 1,
            borderBottom: 1,
            borderColor: 'divider',
            cursor: busy ? 'default' : 'pointer',
            '&:has(.Mui-focusVisible)': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 3,
            },
          }}
        >
          <Checkbox
            checked={autoRenew}
            onChange={(_event, checked) => setAutoRenew(checked)}
            disabled={busy}
            size="small"
            slotProps={{
              input: { 'aria-labelledby': renewTitleId, 'aria-describedby': renewTextId },
            }}
            sx={{ flexShrink: 0, p: 0, mt: '1px' }}
          />
          <Box sx={{ minWidth: 0, fontSize: 14, lineHeight: 1.45 }}>
            <Box component="span" id={renewTitleId} sx={{ display: 'block', fontWeight: 500 }}>
              Продлевать автоматически
            </Box>
            <Box
              component="span"
              id={renewTextId}
              sx={{ display: 'block', mt: '2px', color: 'text.secondary' }}
            >
              {nbsp(
                `Сохраним способ оплаты, которым вы заплатите сейчас, и каждый месяц будем списывать ${price} ₽ тем же способом. Перед списанием пришлём письмо. Отключить можно в настройках в любой день.`,
              )}
            </Box>
          </Box>
        </Box>
      ) : (
        <Typography
          variant="body2"
          color="textSecondary"
          sx={{ py: 2, borderTop: 1, borderBottom: 1, borderColor: 'divider' }}
        >
          {nbsp(checkoutWithoutRenewal())}
        </Typography>
      )}
    </PaymentDialog>
  )
}
