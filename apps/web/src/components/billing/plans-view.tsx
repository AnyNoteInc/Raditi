'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { hardNavigate } from '@/lib/hard-navigate'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { CancelRenewalDialog, type RenewalCancelling } from './auto-renewal-dialog'
import { pageHeading, sectionHeading, sectionPadding, surface } from './billing-surface'
import type { PackOffer, PlanOffer, Subscription } from './billing-types'
import { CheckoutDialog } from './checkout-dialog'
import { CreditsExplainer } from './credits-explainer'
import {
  AutoRenewal,
  CurrentPlan,
  EndedPlan,
  PLANS_SECTION_ID,
  type Action,
  type Said,
} from './current-plan'
import { billingErrorText, domainCodeOf, type BillingCallError } from './error-text'
import { canBuyPack, PackDialog } from './pack-dialog'
import { PackRow } from './pack-row'
import { PastDueDialog } from './past-due-dialog'
import { LEAVING_WAIT_MS, OFFER_PATH } from './payment-dialog'
import { PlanChangeDialog } from './plan-change-dialog'
import {
  changeCancelledText,
  changeScheduledText,
  renewalOffWhileOverdue,
  resumedText,
  taskCostRule,
} from './plan-format'
import { PlanGrid } from './plan-grid'
import { plansWithoutTariff } from './task-notice'
import { useBindingSync } from './use-binding-sync'

/**
 * What a dialog was opened for, kept while it closes; `round` gives each opening its own. The
 * dialogs of the page are siblings and every `round` starts at 1: the key of a dialog names its
 * kind as well, or two dialogs that were each opened once would share one key — and the second
 * of them could not be closed.
 */
type Opened<What> = (What & { open: boolean; round: number }) | null

function opened<What>(what: What) {
  return (previous: Opened<What>): Opened<What> => ({
    ...what,
    open: true,
    round: (previous?.round ?? 0) + 1,
  })
}

function closed<What>(current: Opened<What>): Opened<What> {
  return current && { ...current, open: false }
}

/** Why auto-renewal could not be switched on, for the customer. */
function resumeFailure(error: BillingCallError): string {
  // The page is out of date: the shop takes one-time payments only now. The server's text for
  // this refusal is written about the checkout of a tariff.
  if (domainCodeOf(error) === 'BILLING_AUTO_RENEWAL_UNAVAILABLE') {
    return 'Автопродление пока недоступно: включить его сейчас нельзя.'
  }
  return billingErrorText(
    error,
    'Не удалось включить автопродление. Проверьте соединение и попробуйте ещё раз.',
  )
}

/**
 * «Настройки → Тарифы»: the tariff the customer has and the tariffs on sale. A customer
 * without a tariff reads what the gift credits of the registration are enough for — or what
 * stands in the way of a new task —, chooses a tariff here and confirms the payment in a
 * dialog. A customer with one manages it: switches auto-renewal off and on, chooses another
 * tariff for the next period and takes that choice back, pays for a tariff whose renewal
 * charge failed, and may buy a pack of credits on top of a tariff that takes tasks. Under the
 * tariffs, collapsed: how credits are counted.
 */
export function PlansView({ email }: { email: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const overview = useQuery(trpc.billing.overview.queryOptions())
  const offers = useQuery(trpc.billing.plans.queryOptions())
  // «Включить автопродление» without a saved method leaves for a page that binds a card. A
  // customer who confirmed it and came back before the return page had an answer lands here:
  // the page settles that binding, and auto-renewal comes on with it.
  useBindingSync(overview.data)
  // `round` gives every opening a dialog of its own: the consent starts unticked each time.
  // Whether there is a consent to give is kept with the dialog, like its tariff.
  const [checkout, setCheckout] =
    useState<Opened<{ plan: PlanOffer; autoRenewalAvailable: boolean }>>(null)
  // The pack is kept with its dialog: a refusal refreshes the page, and the row may be gone.
  const [packPurchase, setPackPurchase] = useState<Opened<{ pack: PackOffer }>>(null)
  // So is what the other dialogs were opened for: their words must not change while they close.
  const [planChange, setPlanChange] =
    useState<Opened<{ plan: PlanOffer; subscription: Subscription }>>(null)
  const [renewalCancel, setRenewalCancel] = useState<Opened<RenewalCancelling>>(null)
  const [overduePayment, setOverduePayment] =
    useState<Opened<{ subscription: Subscription; savesMethod: boolean }>>(null)
  const [said, setSaid] = useState<Said | null>(null)
  // A button is disabled only after a render: a second click of a double click comes sooner.
  const sent = useRef(false)
  // The browser is leaving for the page that binds a card.
  const [leaving, setLeaving] = useState(false)

  const say = (text: string | null) =>
    setSaid((previous) => ({ text, at: (previous?.at ?? 0) + 1 }))
  const refresh = () => {
    // After a refusal as well: it may be about what the page shows — a tariff that has just
    // ended, a change somebody made in another tab.
    void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.billing.plans.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
  }

  const resume = useMutation(
    trpc.billing.resumeAutoRenew.mutationOptions({
      onSuccess: (answer) => {
        if (answer.needsPaymentMethod) {
          // Nothing is switched on yet: the card comes first.
          setLeaving(true)
          hardNavigate(answer.confirmationUrl)
          return
        }
        // What the switch does is known: the page shows it at once.
        queryClient.setQueryData(trpc.billing.overview.queryKey(), (shown) =>
          shown?.subscription
            ? {
                ...shown,
                renewalCharge: answer.renewalCharge,
                subscription: { ...shown.subscription, autoRenewal: true },
              }
            : shown,
        )
        say(resumedText(answer.renewalCharge))
      },
      onSettled: (answer) => {
        if (answer?.needsPaymentMethod !== true) refresh()
      },
    }),
  )
  const cancelChange = useMutation(
    trpc.billing.cancelPlanChange.mutationOptions({
      onSuccess: (subscription) => {
        queryClient.setQueryData(trpc.billing.overview.queryKey(), (shown) =>
          shown ? { ...shown, subscription } : shown,
        )
        say(changeCancelledText(subscription.plan.name))
      },
      onSettled: refresh,
    }),
  )

  const resetResume = resume.reset
  useEffect(() => {
    // «Back» from the page of the card may bring this page out of the browser's cache exactly
    // as it was left: it has to be ready for another try.
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      setLeaving(false)
      resetResume()
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [resetResume])
  useEffect(() => {
    // The browser may never leave: the button must not stay locked for good.
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), LEAVING_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  /** One request per press of a button of the block: `send` gets what frees the next press. */
  function once(send: (settled: { onSettled: () => void }) => void) {
    if (sent.current) return
    sent.current = true
    send({
      onSettled: () => {
        sent.current = false
      },
    })
  }

  // Data that is on the screen stays there when a refresh in the background fails.
  const failed = (overview.isError && !overview.data) || (offers.isError && !offers.data)
  const subscription = overview.data?.subscription ?? null
  const ended = subscription === null ? (overview.data?.ended ?? null) : null
  const paymentsEnabled = overview.data?.paymentsEnabled === true
  // false while the shop takes one-time payments only: no consent to auto-renewal is asked
  // for, and it is not switched on.
  const autoRenewalAvailable = overview.data?.autoRenewalAvailable === true
  // Payments are on, and the shop takes one-time payments only. Not the same as «no
  // auto-renewal»: without a shop there is none either, and the page then says nothing of a
  // shop that is not there.
  const oneTimeOnly = paymentsEnabled && !autoRenewalAvailable
  // Nothing can be paid for while the shop is not set up, and a customer with a tariff
  // changes it in another way than buying it again.
  const canChoose = paymentsEnabled && subscription === null
  // The next period of a tariff that is paid for, while its charge has not left yet: a charge
  // that was sent for one tariff is not applied as another. An overdue tariff is paid first.
  // And only a tariff that has a next period: one that does not renew, where auto-renewal
  // cannot be switched on either, ends before any change could start.
  const canChange =
    paymentsEnabled &&
    subscription?.status === 'active' &&
    overview.data?.renewalCharge === 'none' &&
    (subscription.autoRenewal || autoRenewalAvailable)
  const pack = overview.data && canBuyPack(overview.data) ? (offers.data?.pack ?? null) : null
  /** The overview the page shows, for what is read when a button is pressed. */
  const shown = overview.data ?? null

  function retry() {
    if (overview.isError) void overview.refetch()
    if (offers.isError) void offers.refetch()
  }

  const resumeAction: Action = {
    busy: resume.isPending || leaving,
    error: resume.error ? resumeFailure(resume.error) : null,
    run: () => once((settled) => resume.mutate({}, settled)),
  }
  const cancelChangeAction: Action = {
    busy: cancelChange.isPending,
    error: cancelChange.error
      ? billingErrorText(
          cancelChange.error,
          'Не удалось отменить переход. Проверьте соединение и попробуйте ещё раз.',
        )
      : null,
    run: () => once((settled) => cancelChange.mutate({}, settled)),
  }

  return (
    // The tariff cards fold by the width of this column, not of the window: the sidebar
    // beside it has two widths.
    <Box sx={{ containerType: 'inline-size' }}>
      <Typography component="h1" sx={pageHeading}>
        Тарифы
      </Typography>

      {failed ? (
        <Alert
          severity="error"
          sx={{ mt: 4 }}
          action={
            <Button
              color="inherit"
              size="small"
              loading={overview.isFetching || offers.isFetching}
              onClick={retry}
            >
              Повторить
            </Button>
          }
        >
          Не удалось загрузить тарифы. Попробуйте ещё раз.
        </Alert>
      ) : !overview.data || !offers.data ? (
        <Box role="status" aria-label="Загрузка тарифов">
          <Skeleton variant="text" width={320} sx={{ maxWidth: '100%', mt: 1, fontSize: 16 }} />
          <Skeleton variant="rounded" height={420} sx={{ mt: 4, borderRadius: '14px' }} />
        </Box>
      ) : (
        <>
          {/* Without a tariff the line tells of the gift credits; it may take three sentences. */}
          <Typography color="textSecondary" sx={{ maxWidth: '62ch', mt: 1 }}>
            {nbsp(
              subscription
                ? 'Ваш тариф и автопродление.'
                : plansWithoutTariff({
                    gift: overview.data.credits.gift,
                    task: overview.data.credits,
                    packLeft: overview.data.credits.pack.available,
                    hadTariff: ended !== null,
                    canChoose,
                  }),
            )}
          </Typography>
          <Stack divider={<Divider />} sx={{ ...surface, mt: 4 }}>
            {subscription ? (
              <CurrentPlan
                overview={overview.data}
                subscription={subscription}
                said={said}
                onPay={() =>
                  setOverduePayment(opened({ subscription, savesMethod: autoRenewalAvailable }))
                }
                resume={resumeAction}
                cancelChange={cancelChangeAction}
                pack={pack}
              />
            ) : ended ? (
              <EndedPlan
                ended={ended}
                packCredits={overview.data.credits.pack.available}
                tasksTaken={overview.data.credits.newTask.allowed}
                canChoose={canChoose}
              />
            ) : null}
            <Box
              component="section"
              id={PLANS_SECTION_ID}
              aria-labelledby="plans-title"
              sx={{ p: sectionPadding, scrollMarginTop: 16 }}
            >
              <Typography component="h2" id="plans-title" sx={sectionHeading}>
                {canChoose ? 'Выберите тариф' : 'Все тарифы'}
              </Typography>
              <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
                {nbsp(taskCostRule())}
              </Typography>
              <CreditsExplainer conversion={offers.data.creditConversion} />
              {offers.data.plans.length > 0 ? (
                <PlanGrid
                  plans={offers.data.plans}
                  siteCount={offers.data.siteCount}
                  subscription={subscription}
                  canChoose={canChoose}
                  onChoose={(plan) => setCheckout(opened({ plan, autoRenewalAvailable }))}
                  canChange={canChange}
                  onChange={(plan) => {
                    if (subscription) setPlanChange(opened({ plan, subscription }))
                  }}
                />
              ) : (
                <Typography variant="body2" sx={{ mt: 3 }}>
                  {nbsp('Сейчас тарифы не продаются. Загляните позже.')}
                </Typography>
              )}
              {pack ? (
                <PackRow pack={pack} onBuy={() => setPackPurchase(opened({ pack }))} />
              ) : null}
            </Box>
            {/* A tariff that is paid for and does not renew is told of in its own block. */}
            {subscription && (subscription.status === 'past_due' || subscription.autoRenewal) ? (
              <AutoRenewal
                subscription={subscription}
                renewalCharge={overview.data.renewalCharge}
                savesMethod={!oneTimeOnly}
                email={email}
                onCancel={() => {
                  if (shown === null) return
                  const { credits, renewalCharge } = shown
                  setRenewalCancel(opened({ subscription, credits, renewalCharge, oneTimeOnly }))
                }}
              />
            ) : null}
          </Stack>
          <Typography variant="body2" color="textSecondary" sx={{ mt: 2 }}>
            {nbsp(
              'Цены в рублях. Оплата проходит на странице ЮKassa: картой, через СБП или SberPay. Оплата принимается только с личной карты; счета и закрывающие документы для организаций не выдаём.',
            )}{' '}
            <Link href={OFFER_PATH}>Публичная оферта</Link>
          </Typography>
        </>
      )}

      {checkout ? (
        <CheckoutDialog
          key={`checkout-${checkout.round}`}
          plan={checkout.plan}
          autoRenewalAvailable={checkout.autoRenewalAvailable}
          open={checkout.open}
          onClose={() => setCheckout(closed)}
        />
      ) : null}
      {packPurchase ? (
        <PackDialog
          key={`pack-${packPurchase.round}`}
          pack={packPurchase.pack}
          open={packPurchase.open}
          onClose={() => setPackPurchase(closed)}
        />
      ) : null}
      {planChange ? (
        <PlanChangeDialog
          key={`change-${planChange.round}`}
          plan={planChange.plan}
          subscription={planChange.subscription}
          open={planChange.open}
          onClose={() => setPlanChange(closed)}
          onScheduled={(scheduled) => {
            setPlanChange(closed)
            say(
              changeScheduledText(
                scheduled.nextPlan?.name ?? planChange.plan.name,
                scheduled.period.end,
                scheduled.autoRenewal,
              ),
            )
          }}
        />
      ) : null}
      {renewalCancel ? (
        <CancelRenewalDialog
          key={`renewal-${renewalCancel.round}`}
          cancelling={renewalCancel}
          open={renewalCancel.open}
          onClose={() => setRenewalCancel(closed)}
          onCancelled={() => {
            setRenewalCancel(closed)
            // The block of a tariff that is paid for says it itself: «Автопродление
            // отключено…». One that waits for its payment has no such block.
            say(renewalCancel.subscription.status === 'past_due' ? renewalOffWhileOverdue() : null)
          }}
        />
      ) : null}
      {overduePayment ? (
        <PastDueDialog
          key={`overdue-${overduePayment.round}`}
          subscription={overduePayment.subscription}
          savesMethod={overduePayment.savesMethod}
          open={overduePayment.open}
          onClose={() => setOverduePayment(closed)}
        />
      ) : null}
    </Box>
  )
}
