'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { nbsp } from '@/lib/nbsp'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { pageHeading, sectionPadding, surface } from './billing-surface'
import type { MethodBinding } from './billing-types'
import { billingErrorText } from './error-text'
import { boundText, notBoundText } from './payment-format'
import { Outcome, useReturnCheck } from './return-check'

const BILLING_PATH = '/settings/billing'

type View = 'checking' | 'slow' | 'error' | 'bound' | 'not-bound' | 'nothing'

function viewOf(input: {
  binding: MethodBinding | undefined
  failed: boolean
  waitedOut: boolean
}): View {
  const { binding, failed, waitedOut } = input
  if (binding && binding.state !== 'pending') {
    if (binding.state === 'active') return 'bound'
    return binding.state === 'inactive' ? 'not-bound' : 'nothing'
  }
  if (failed) return 'error'
  return binding && waitedOut ? 'slow' : 'checking'
}

const toBilling = (
  <Button variant="outlined" href={BILLING_PATH}>
    В раздел «Оплата»
  </Button>
)

/**
 * Where ЮKassa sends the customer back after the page that binds a card, whatever its outcome.
 * The page asks for the binding at once and keeps asking while it has no outcome
 * (`useReturnCheck`): asking is what stores the card when the notification is late or lost.
 * After the thirty seconds nothing asks for the customer but a page that shows the method:
 * «Оплата» settles a binding that still waits when it is opened (`useBindingSync`), which is
 * what the page promises.
 */
export function MethodReturn() {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const { check, waitedOut, failed } = useReturnCheck<MethodBinding>({
    queryKey: ['billing-method-return'],
    ask: () => client.billing.syncPaymentMethod.mutate({}),
    unsettled: (binding) => binding.state === 'pending',
  })

  const binding = check.data
  const settled = binding !== undefined && binding.state !== 'pending'
  useEffect(() => {
    // The outcome changes what «Оплата» and «Тарифы» show, and the link from here is a
    // transition inside the application: an answer kept from before must not pass as fresh.
    if (!settled) return
    void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
  }, [settled, queryClient, trpc])

  const view = viewOf({ binding, failed, waitedOut })
  const checkAgain = (
    <Button variant="outlined" loading={check.isFetching} onClick={() => void check.refetch()}>
      Проверить ещё раз
    </Button>
  )

  return (
    <Box>
      <Typography component="h1" sx={pageHeading}>
        Оплата
      </Typography>
      <Box sx={{ ...surface, mt: 4, p: sectionPadding }}>
        {view === 'error' && check.error ? (
          <Alert severity="error" action={checkAgain} sx={{ alignItems: 'center' }}>
            {billingErrorText(
              check.error,
              'Не удалось проверить привязку карты. Проверьте соединение и попробуйте ещё раз.',
            )}
          </Alert>
        ) : (
          // One live region: a screen reader hears the outcome when the waiting ends.
          <Box role="status">
            {view === 'bound' && binding ? (
              <Outcome
                icon="check"
                tone="success.main"
                title="Карта привязана"
                actions={
                  <Button variant="contained" href={BILLING_PATH}>
                    В раздел «Оплата»
                  </Button>
                }
              >
                {boundText(binding).map((sentence) => (
                  <Typography key={sentence}>{nbsp(sentence)}</Typography>
                ))}
              </Outcome>
            ) : view === 'not-bound' && binding ? (
              <Outcome
                icon="warning"
                tone="error.main"
                title="Не удалось привязать карту"
                // The neutral label on purpose: a shop that takes one-time payments only
                // (YOOKASSA_AUTOPAYMENTS=off) offers no second try on «Оплата».
                actions={
                  <Button variant="contained" href={BILLING_PATH}>
                    В раздел «Оплата»
                  </Button>
                }
              >
                {notBoundText(binding).map((sentence) => (
                  <Typography key={sentence}>{nbsp(sentence)}</Typography>
                ))}
              </Outcome>
            ) : view === 'nothing' ? (
              <Outcome icon="search" title="Привязка карты не найдена" actions={toBilling}>
                <Typography>
                  {nbsp(
                    'Сейчас ни одна карта не ждёт привязки. Сохранённый способ оплаты — в разделе «Оплата».',
                  )}
                </Typography>
              </Outcome>
            ) : view === 'slow' ? (
              <Outcome
                icon="clock"
                title="Привязка ещё не подтверждена"
                actions={
                  <>
                    {checkAgain}
                    <Button href={BILLING_PATH}>В раздел «Оплата»</Button>
                  </>
                }
              >
                <Typography>
                  {nbsp(
                    'ЮKassa ещё не подтвердила карту. Можно закрыть страницу: карта появится в разделе «Оплата», когда вы откроете его после завершения привязки.',
                  )}
                </Typography>
              </Outcome>
            ) : (
              <Outcome icon="progress" title="Проверяем привязку карты">
                <Typography>{nbsp('Обычно это занимает несколько секунд.')}</Typography>
              </Outcome>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}
