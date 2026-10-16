'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'

import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { PaymentTile, sectionHeading, sectionPadding } from './billing-surface'
import type { BillingOverview, RenewalCharge, Subscription } from './billing-types'
import { billingErrorText, domainCodeOf, type BillingCallError } from './error-text'
import { usePaymentStart } from './payment-dialog'
import { methodNote, noMethodNote, unlinkedText, unlinkWarning } from './payment-format'
import { giftTakesTasks } from './plan-format'

const subHeading = { fontSize: 15, fontWeight: 500, lineHeight: 1.4 } as const

/** Why a binding could not be started, for the customer. */
function bindingFailure(error: BillingCallError): string {
  // The page is out of date: the shop takes one-time payments only now. The server's text for
  // this refusal is written about the checkout of a tariff.
  if (domainCodeOf(error) === 'BILLING_AUTO_RENEWAL_UNAVAILABLE') {
    return 'Привязать или заменить карту пока нельзя: автопродление недоступно.'
  }
  return billingErrorText(
    error,
    'Не удалось начать привязку карты. Проверьте соединение и попробуйте ещё раз.',
  )
}

/** The saved method the customer is about to unlink, kept with the dialog while it closes. */
interface Unlinking {
  subscription: Subscription
  /** The renewal charge the page knew to be under way when the dialog was opened. */
  renewalCharge: RenewalCharge
  /** The shop took one-time payments only then: a card cannot be bound again. */
  oneTimeOnly: boolean
  /** The gift credits of the customer could start a task then. */
  tasksOnGift: boolean
  label: string
  open: boolean
}

/**
 * The confirmation before the saved method is unlinked: what happens to auto-renewal and how
 * long the tariff works — and, at a shop that takes one-time payments only, that a card cannot
 * be bound again. Nothing closes the dialog while the request is on its way.
 */
function UnlinkDialog({
  unlinking,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  unlinking: Unlinking
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <Dialog
      open={unlinking.open}
      onClose={busy ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 480,
            m: 2,
            p: 3,
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}
      >
        Отвязать способ оплаты?
      </Typography>
      <Box id={descriptionId}>
        <Typography variant="body2" sx={{ mt: 1, fontWeight: 500, overflowWrap: 'anywhere' }}>
          {unlinking.label}
        </Typography>
        <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
          {nbsp(
            unlinkWarning(
              unlinking.subscription,
              unlinking.renewalCharge,
              unlinking.oneTimeOnly,
              unlinking.tasksOnGift,
            ),
          )}
        </Typography>
      </Box>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
        {nbsp(
          'Данные карты хранит ЮKassa. Мы удалим у себя идентификатор сохранённого способа оплаты и больше не сможем списывать с него деньги.',
        )}
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button onClick={onClose} disabled={busy}>
          Не отвязывать
        </Button>
        <Button variant="outlined" color="error" onClick={onConfirm} loading={busy}>
          Отвязать
        </Button>
      </Box>
    </Dialog>
  )
}

/**
 * «Способ оплаты»: the method the tariff is renewed with — when it is charged next, the way to
 * replace it and the way to unlink it — or, when none is saved, why and how one gets saved.
 * Replacing and binding leave for a ЮKassa page where nothing is charged; unlinking is done
 * here, after a confirmation, and switches auto-renewal off. A renewal charge that was started
 * before is not stopped by any of it: while one is under way the section says so instead of
 * naming a charge to come, and the notice of an unlink tells what the unlink itself found.
 *
 * While the shop takes one-time payments only (`autoRenewalAvailable` is false with payments
 * on) no card is bound or replaced: the section offers neither and says why nothing is saved.
 * A method saved before stays, with the way to unlink it.
 */
export function PaymentMethodSection({ overview }: { overview: BillingOverview }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { subscription, paymentsEnabled, autoRenewalAvailable, renewalCharge } = overview
  const method = subscription?.paymentMethod ?? null
  const [unlinking, setUnlinking] = useState<Unlinking | null>(null)
  /** The renewal charge the unlink found under way; null: nothing was unlinked here. */
  const [unlinked, setUnlinked] = useState<RenewalCharge | null>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  // The button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)

  const binding = usePaymentStart((handlers) =>
    trpc.billing.startPaymentMethodChange.mutationOptions(handlers),
  )
  const unlink = useMutation(
    trpc.billing.unlinkPaymentMethod.mutationOptions({
      onSuccess: (answer) => {
        // What unlinking does is known: the page shows it at once, whatever becomes of the
        // reading that follows.
        queryClient.setQueryData(trpc.billing.overview.queryKey(), (shown) =>
          shown?.subscription
            ? {
                ...shown,
                // A binding under way is forgotten with the method.
                bindingPending: false,
                renewalCharge: answer.renewalCharge,
                subscription: { ...shown.subscription, autoRenewal: false, paymentMethod: null },
              }
            : shown,
        )
        setUnlinked(answer.renewalCharge)
        setUnlinking((current) => current && { ...current, open: false })
      },
      onSettled: () => {
        // After a refusal as well: it may be about what the page shows — a tariff that has
        // just ended, a method that is unlinked already.
        void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      },
    }),
  )

  // Taken back when a method is there again: the words are about the method that is gone.
  const said = unlinked !== null && method === null ? unlinkedText(unlinked) : null
  const done = said !== null
  useEffect(() => {
    // The button that opened the dialog is gone with the method: the focus goes to the words
    // that say what happened instead of being lost.
    if (done && unlinking?.open === false) notice.current?.focus()
  }, [done, unlinking?.open])

  function confirmUnlink() {
    if (sent.current) return
    sent.current = true
    unlink.mutate(
      {},
      {
        // A refused request can be tried again, and a method bound later unlinked again.
        onSettled: () => {
          sent.current = false
        },
      },
    )
  }

  // A card is bound to a tariff: without one there is nothing to renew. And only at a shop
  // that saves payment methods — which is never the case while payments are off.
  const canBind = autoRenewalAvailable && subscription !== null
  /** Payments are on, and the shop takes one-time payments only. */
  const oneTimeOnly = paymentsEnabled && !autoRenewalAvailable

  return (
    <Box component="section" aria-labelledby="method-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="method-title" sx={sectionHeading}>
        Способ оплаты
      </Typography>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px 24px',
          mt: 2,
        }}
      >
        <Box sx={{ display: 'flex', flex: '1 1 320px', alignItems: 'center', gap: 2, minWidth: 0 }}>
          <PaymentTile />
          <Box sx={{ minWidth: 0 }}>
            {subscription && method ? (
              <>
                <Typography sx={{ ...subHeading, overflowWrap: 'anywhere' }}>
                  {method.label}
                </Typography>
                <Typography variant="body2" color="textSecondary" sx={{ mt: '2px' }}>
                  {nbsp(methodNote(subscription, renewalCharge))}
                </Typography>
              </>
            ) : (
              <>
                <Typography sx={subHeading}>
                  {nbsp(
                    subscription
                      ? 'Способ оплаты не сохранён: автопродление выключено.'
                      : 'Способ оплаты не сохранён.',
                  )}
                </Typography>
                <Typography variant="body2" color="textSecondary" sx={{ mt: '2px' }}>
                  {nbsp(noMethodNote(subscription, canBind, renewalCharge, oneTimeOnly))}
                </Typography>
              </>
            )}
          </Box>
        </Box>
        {subscription && method ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {autoRenewalAvailable ? (
              <Button variant="outlined" loading={binding.busy} onClick={() => binding.start({})}>
                Заменить
              </Button>
            ) : null}
            <Button
              disabled={binding.busy}
              onClick={() => {
                unlink.reset()
                setUnlinking({
                  subscription,
                  renewalCharge,
                  oneTimeOnly,
                  tasksOnGift: giftTakesTasks(overview.credits.gift.available),
                  label: method.label,
                  open: true,
                })
              }}
            >
              Отвязать
            </Button>
          </Box>
        ) : canBind ? (
          <Button variant="outlined" loading={binding.busy} onClick={() => binding.start({})}>
            Привязать карту
          </Button>
        ) : null}
      </Box>

      {binding.error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {bindingFailure(binding.error)}
        </Alert>
      ) : null}
      {said !== null ? (
        <Typography
          ref={notice}
          role="status"
          tabIndex={-1}
          variant="body2"
          sx={{ maxWidth: '72ch', mt: 2, '&:focus-visible': { outline: 'none' } }}
        >
          {nbsp(said)}
        </Typography>
      ) : null}
      {subscription ? (
        <Typography variant="body2" color="textSecondary" sx={{ maxWidth: '72ch', mt: 2 }}>
          {nbsp(
            'Данные карты хранит ЮKassa. У нас — только идентификатор сохранённого способа оплаты и последние четыре цифры карты.',
          )}
        </Typography>
      ) : null}

      {unlinking ? (
        <UnlinkDialog
          unlinking={unlinking}
          busy={unlink.isPending}
          error={
            unlink.error
              ? billingErrorText(
                  unlink.error,
                  'Не удалось отвязать способ оплаты. Проверьте соединение и попробуйте ещё раз.',
                )
              : null
          }
          onClose={() => setUnlinking((current) => current && { ...current, open: false })}
          onConfirm={confirmUnlink}
        />
      ) : null}
    </Box>
  )
}
