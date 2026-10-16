'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { useEffect, useId, useRef, type ReactNode } from 'react'

import { hardNavigate } from '@/lib/hard-navigate'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { billingErrorText, domainCodeOf, type BillingCallError } from './error-text'

// What the dialogs that end on the ЮKassa page share: how a payment is started and how the
// dialog behaves while the browser is leaving, and the frame around what is bought.

export const OFFER_PATH = '/terms/public-offer'
/** How long the dialog stays locked for a payment page the browser has not opened yet. */
export const LEAVING_WAIT_MS = 15_000

/**
 * What a start answers with: the ЮKassa page to open. A checkout of a tariff or a pack, and
 * the binding of a payment method, where nothing is paid.
 */
interface Started {
  confirmationUrl: string
}

/** What every start does with its answer; the caller passes them to its mutation. */
interface PaymentHandlers {
  onSuccess: (started: Started) => void
  onError: () => void
}

/**
 * A dialog that reads what is paid for anew before the payment can be started. `pending`: the
 * answer is on its way and the confirmation waits for it. `failure`: it did not come — the
 * sentence that says so; nothing is confirmed until `retry` brings one.
 */
export interface PaymentCheck {
  pending: boolean
  failure: string | null
  retry: () => void
}

export interface PaymentStart<Input> {
  /** The request runs, or its answer is already taking the browser to the payment page. */
  busy: boolean
  /** Why the last try was refused; null before a try and after a new one starts. */
  error: BillingCallError | null
  /** Starts the payment; a second call while one is on its way does nothing. */
  start: (input: Input) => void
}

/**
 * Why a payment could not be started, for the customer. The server's words for a refusal; its
 * plain conflict gets a sentence of its own, and a request that never arrived another.
 */
export function paymentStartFailure(error: BillingCallError): string {
  // A plain conflict: another request of the same customer changed or closed the order while
  // this one was starting its payment. The general text of a conflict would not say that
  // trying again helps.
  if (domainCodeOf(error) === 'CONFLICT') {
    return 'Не удалось начать оплату: заказ только что изменился. Попробуйте ещё раз.'
  }
  return billingErrorText(
    error,
    'Не удалось начать оплату. Проверьте соединение и попробуйте ещё раз.',
  )
}

/**
 * The start of a payment, or of the binding of a payment method: one request per confirmation,
 * and its answer takes the browser to the ЮKassa page. `mutationOptions` builds the options of
 * the router's mutation around the handlers it is given.
 */
export function usePaymentStart<Input, CallError extends BillingCallError, Answer extends Started>(
  mutationOptions: (handlers: PaymentHandlers) => UseMutationOptions<Answer, CallError, Input>,
): PaymentStart<Input> {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)

  const checkout = useMutation(
    mutationOptions({
      onSuccess: ({ confirmationUrl }) => hardNavigate(confirmationUrl),
      onError: () => {
        // The refusal may be about what the page behind the dialog shows: a tariff that is on
        // already or has just ended, a tariff or a pack that is no longer sold, one more site.
        void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.billing.plans.queryKey() })
      },
    }),
  )
  const busy = checkout.isPending || checkout.isSuccess
  const { reset, mutate } = checkout

  useEffect(() => {
    // «Back» from the payment page may bring this page out of the browser's cache exactly as
    // it was left: it has to be ready for another try, not waiting for a page that is gone.
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      sent.current = false
      reset()
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [reset])

  const leaving = checkout.isSuccess
  useEffect(() => {
    // The browser may never leave: the customer stopped the load, or it broke off. A dialog
    // that nothing closes would then stay for good. Pressing again is safe: a tariff checkout
    // finds the order it left unfinished and gives the same payment page, and a pack order
    // nobody paid costs nothing.
    if (!leaving) return
    const timer = window.setTimeout(() => {
      sent.current = false
      reset()
    }, LEAVING_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [leaving, reset])

  function start(input: Input) {
    if (sent.current) return
    sent.current = true
    mutate(input, {
      // A refused payment can be tried again; a started one is leaving the page.
      onError: () => {
        sent.current = false
      },
    })
  }

  return { busy, error: checkout.error, start }
}

/**
 * The frame of the last step before the payment page: what is bought (`title`, `description`
 * and the rows a dialog puts inside), who can pay and on which terms, and the two buttons.
 * Confirming takes the browser to the ЮKassa page; until then nothing closes the dialog.
 */
export function PaymentDialog({
  open,
  onClose,
  title,
  description,
  payment,
  check,
  failureText = paymentStartFailure,
  onConfirm,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** One line under the title; it is the accessible description of the dialog. */
  description: string
  payment: Pick<PaymentStart<never>, 'busy' | 'error'>
  /** For a dialog whose tariff and amount may have changed since the page read them. */
  check?: PaymentCheck
  /** The sentence for a refused start, when a dialog has more to say than the common one. */
  failureText?: (error: BillingCallError) => string
  onConfirm: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const { busy, error } = payment

  return (
    <Dialog
      open={open}
      // Nothing closes the dialog while it is leaving for the payment page.
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
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}
      >
        {title}
      </Typography>
      <Typography id={descriptionId} variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp(description)}
      </Typography>

      {children}

      <Typography variant="body2" color="textSecondary" sx={{ mt: 2 }}>
        {nbsp(
          'Оплата проходит на странице ЮKassa: картой, через СБП или SberPay. Оплата принимается только с личной карты; счета и закрывающие документы для организаций не выдаём.',
        )}{' '}
        Оплачивая, вы&nbsp;принимаете условия{' '}
        <Link href={OFFER_PATH} target="_blank" rel="noopener noreferrer">
          публичной оферты
        </Link>
        .
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {failureText(error)}
        </Alert>
      ) : null}
      {check?.failure ? (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            <Button color="inherit" size="small" onClick={check.retry}>
              Повторить
            </Button>
          }
        >
          {check.failure}
        </Alert>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          loading={busy || check?.pending === true}
          disabled={Boolean(check?.failure)}
        >
          Перейти к оплате
        </Button>
      </Box>
    </Dialog>
  )
}
