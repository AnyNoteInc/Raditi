'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'

import type { AutoRenewalCancel } from '@/components/billing/billing-types'
import { billingErrorText } from '@/components/billing/error-text'
import { consentRenewalNotice, consentRenewalOff } from '@/components/billing/plan-format'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

/**
 * The coming charge of auto-renewal, on the page that asks for the consent to a new edition of
 * the documents. A user who has not accepted it is sent here from every page of the cabinet,
 * «Тарифы» included, and is charged all the same (default «н» of docs/plan/37-billing-plan.md):
 * so the charge is told here, with the way to stop it that needs no consent.
 *
 * Shown only to a user whose tariff is paid for and renews by itself; nothing is drawn for
 * anybody else, while the answer is on its way, or when it does not come — the form above works
 * without it. Once switched off, the block says so and until when the tariff works.
 *
 * The button switches auto-renewal off in one press, with no confirmation. At a shop that takes
 * one-time payments only it cannot be switched back on: the words above the button say so
 * (`oneTimeOnly` of the answer).
 */
export function AutoRenewalNotice() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const titleId = useId()
  const coming = useQuery({ ...trpc.billing.autoRenewal.queryOptions(), retry: false })
  /** The tariff whose auto-renewal was switched off here, with what the switch answered. */
  const [off, setOff] = useState<{ planName: string; answer: AutoRenewalCancel } | null>(null)
  const result = useRef<HTMLParagraphElement>(null)
  // The button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)

  const cancel = useMutation(
    trpc.billing.cancelAutoRenew.mutationOptions({
      onSettled: () => {
        // After a refusal as well: auto-renewal may be off already, or the tariff over.
        void queryClient.invalidateQueries({ queryKey: trpc.billing.autoRenewal.queryKey() })
      },
    }),
  )

  const done = off !== null
  useEffect(() => {
    // The button is gone with what it switched off: the focus goes to the words that say so.
    if (done) result.current?.focus()
  }, [done])

  const renewal = coming.data?.renewal ?? null
  if (off === null && renewal === null) return null

  function switchOff(planName: string) {
    if (sent.current) return
    sent.current = true
    cancel.mutate(
      {},
      {
        onSuccess: (answer) => setOff({ planName, answer }),
        onSettled: () => {
          sent.current = false
        },
      },
    )
  }

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}
      >
        Автопродление тарифа
      </Typography>
      {off ? (
        <Typography
          ref={result}
          role="status"
          tabIndex={-1}
          variant="body2"
          sx={{ mt: 0.5, overflowWrap: 'anywhere', '&:focus-visible': { outline: 'none' } }}
        >
          {nbsp(consentRenewalOff(off.planName, off.answer.periodEnd, off.answer.renewalCharge))}
        </Typography>
      ) : renewal ? (
        <>
          <Typography
            variant="body2"
            color="textSecondary"
            sx={{ mt: 0.5, overflowWrap: 'anywhere' }}
          >
            {nbsp(consentRenewalNotice(renewal))}
          </Typography>
          {cancel.error ? (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {billingErrorText(
                cancel.error,
                'Не удалось отключить автопродление. Проверьте соединение и попробуйте ещё раз.',
              )}
            </Alert>
          ) : null}
          <Button
            variant="outlined"
            loading={cancel.isPending}
            onClick={() => switchOff(renewal.planName)}
            sx={{ mt: 1.5 }}
          >
            Отключить автопродление
          </Button>
        </>
      ) : null}
    </Box>
  )
}
