'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { formatMoscowDate } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { pageHeading, sectionPadding, surface } from './billing-surface'
import type { OrderState } from './billing-types'
import { billingErrorText, domainCodeOf } from './error-text'
import { packAdded } from './plan-format'
import { Outcome, RETURN_POLL_MS, RETURN_WAIT_MS, useReturnCheck } from './return-check'

/** The pause between two looks at an order that has no outcome yet. */
export const ORDER_POLL_MS = RETURN_POLL_MS
/** How long the page keeps looking by itself; after that the customer asks. */
export const ORDER_WAIT_MS = RETURN_WAIT_MS

const PLANS_PATH = '/settings/plans'

type View =
  'not-found' | 'checking' | 'slow' | 'error' | 'paid' | 'failed' | 'unapplied' | 'refunded'

function viewOf(input: {
  order: OrderState | undefined
  notFound: boolean
  failed: boolean
  waitedOut: boolean
}): View {
  const { order, notFound, failed, waitedOut } = input
  if (notFound) return 'not-found'
  if (order && order.status !== 'pending') {
    // The money came and was not applied: neither «paid» nor «try again» would be true.
    if (order.refundNeeded) return 'unapplied'
    if (order.status === 'paid') return 'paid'
    if (order.status === 'refunded') return 'refunded'
    // `cancelled` is an order we closed ourselves: nothing was paid for it either.
    return 'failed'
  }
  if (failed) return 'error'
  return order && waitedOut ? 'slow' : 'checking'
}

/** What the order paid for, as the start of a sentence. */
function bought({ kind, planName }: OrderState): string {
  if (planName === null) return 'Заказ'
  return kind === 'subscription' ? `Тариф «${planName}»` : planName
}

/**
 * Why money that came was not applied, when the order carries no sentence of its own. A tariff
 * order that stays paid found nothing to pay for: the tariff was on already — paid by another
 * order — or was over by then, as when a payment by hand arrives after the overdue tariff has
 * ended. Any other order — one closed before its money came; a pack is turned away by nothing
 * else — says that.
 */
function unappliedText(order: OrderState | undefined): string {
  return order?.kind === 'subscription' && order.status === 'paid'
    ? 'Деньги поступили, но зачислить их не получилось: тариф к этому времени уже был оплачен или закончился. Мы вернём этот платёж.'
    : 'Деньги поступили, но зачислить их не получилось: заказ был закрыт. Мы вернём этот платёж.'
}

const toPlans = (
  <Button variant="outlined" href={PLANS_PATH}>
    К тарифам
  </Button>
)

/**
 * Where ЮKassa sends the customer back, whatever the outcome of the payment. The page asks for
 * the order at once and keeps asking while the payment has no outcome (`useReturnCheck`).
 *
 * `orderId` is null when the link names no order: «not found» without a request.
 */
export function OrderReturn({ orderId }: { orderId: string | null }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const { check, waitedOut, failed } = useReturnCheck<OrderState>({
    queryKey: ['billing-order-return', orderId],
    ask: orderId === null ? null : () => client.billing.syncOrder.mutate({ orderId }),
    unsettled: (order) => order.status === 'pending',
  })

  const order = check.data
  const settled = order !== undefined && order.status !== 'pending'
  useEffect(() => {
    // The outcome changes what «Тарифы» shows, and the link from here to it is a transition
    // inside the application: an answer it kept from before the payment must not pass as fresh.
    if (!settled) return
    void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.billing.plans.queryKey() })
  }, [settled, queryClient, trpc])

  const view = viewOf({
    order,
    notFound: orderId === null || domainCodeOf(check.error) === 'BILLING_ORDER_NOT_FOUND',
    failed,
    waitedOut,
  })
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
              'Не удалось проверить оплату. Проверьте соединение и попробуйте ещё раз.',
            )}
          </Alert>
        ) : (
          // One live region: a screen reader hears the outcome when the waiting ends.
          <Box role="status">
            {view === 'paid' && order ? (
              <Outcome
                icon="check"
                tone="success.main"
                title="Оплата прошла"
                actions={
                  <Button variant="contained" href={PLANS_PATH}>
                    К тарифам
                  </Button>
                }
              >
                <Typography>
                  {bought(order)}&nbsp;— {formatRubles(order.amount)}&nbsp;₽.
                </Typography>
                {order.kind === 'subscription' && order.subscription ? (
                  <Typography>
                    {nbsp(`Тариф действует до ${formatMoscowDate(order.subscription.period.end)}.`)}
                  </Typography>
                ) : null}
                {order.kind === 'pack' ? (
                  <Typography>{nbsp(packAdded(order.packCredits))}</Typography>
                ) : null}
              </Outcome>
            ) : view === 'failed' ? (
              <Outcome
                icon="warning"
                tone="error.main"
                title="Оплата не прошла"
                actions={
                  <Button variant="contained" href={PLANS_PATH}>
                    Попробовать ещё раз
                  </Button>
                }
              >
                <Typography>
                  {nbsp(
                    order?.failureText ??
                      'Этот заказ закрыт, оплата по нему не прошла. Оформите оплату заново.',
                  )}
                </Typography>
              </Outcome>
            ) : view === 'unapplied' ? (
              <Outcome
                icon="warning"
                tone="error.main"
                title="Платёж не зачислен"
                actions={toPlans}
              >
                <Typography>{nbsp(order?.failureText ?? unappliedText(order))}</Typography>
              </Outcome>
            ) : view === 'refunded' ? (
              <Outcome icon="back" title="Платёж возвращён" actions={toPlans}>
                <Typography>{nbsp('Деньги за этот заказ возвращены.')}</Typography>
              </Outcome>
            ) : view === 'not-found' ? (
              <Outcome icon="search" title="Заказ не найден" actions={toPlans}>
                <Typography>
                  {nbsp('Проверьте ссылку или откройте «Тарифы» в настройках.')}
                </Typography>
              </Outcome>
            ) : view === 'slow' ? (
              <Outcome
                icon="clock"
                title="Оплата ещё не подтверждена"
                actions={
                  <>
                    {checkAgain}
                    <Button href={PLANS_PATH}>К тарифам</Button>
                  </>
                }
              >
                <Typography>
                  {nbsp(
                    order?.kind === 'pack'
                      ? 'Платёж ещё обрабатывается. Можно закрыть страницу: кредиты добавятся, когда оплата пройдёт.'
                      : 'Платёж ещё обрабатывается. Можно закрыть страницу: тариф включится, когда оплата пройдёт.',
                  )}
                </Typography>
              </Outcome>
            ) : (
              <Outcome icon="progress" title="Проверяем оплату">
                <Typography>{nbsp('Обычно это занимает несколько секунд.')}</Typography>
              </Outcome>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}
