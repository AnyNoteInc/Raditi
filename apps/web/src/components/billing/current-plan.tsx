'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'

import { DetailRow, DetailRows, sectionHeading, sectionPadding } from './billing-surface'
import type {
  BillingOverview,
  CreditBalances,
  EndedSubscription,
  PackOffer,
  RenewalCharge,
  Subscription,
} from './billing-types'
import {
  chargeUnderWayValue,
  creditsLeft,
  creditsWhileOverdue,
  endedText,
  endsUnlessCharged,
  endsWithPeriod,
  nextCharge,
  pastDueText,
  planLimits,
  renewalUnavailable,
  renewalWhileOverdue,
  renewsWithChargeUnderWay,
  renewsWithPeriod,
  resumeTerms,
  scheduledChange,
  type CreditsLeft,
} from './plan-format'
import { giftCarriesTasks, noticeText, PLAN_CHANGE_STARTS_LATER, taskNotice } from './task-notice'

const USAGE_PATH = '/settings/usage'
const BILLING_PATH = '/settings/billing'
/** The section of the tariffs on sale: where «Выбрать тариф» leads. */
export const PLANS_SECTION_ID = 'plans'

/** A value of a row with a link beside it that takes no more of the row than its text. */
const valueWithLink = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '4px 16px',
} as const
/** The link is as tall as a finger needs without making its row taller. */
const rowLink = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  my: '-12px',
} as const
/** A sentence that is given the focus when it says what the customer has just done. */
const spoken = { '&:focus-visible': { outline: 'none' } } as const
const buttons = { display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2.5 } as const

interface Status {
  label: string
  icon: AppIconName
  /** The chip is never told apart by colour alone: every status has its words and its icon. */
  color: 'success' | 'error' | 'default'
}

function statusOf({ status, autoRenewal, period }: Subscription): Status {
  if (status === 'past_due') return { label: 'Оплата не прошла', icon: 'warning', color: 'error' }
  if (!autoRenewal) {
    return { label: `До ${formatMoscowDay(period.end)}`, icon: 'clock', color: 'default' }
  }
  return { label: 'Активен', icon: 'check', color: 'success' }
}

function StatusChip({ status }: { status: Status }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={status.color}
      icon={<AppIcon name={status.icon} size={14} />}
      label={nbsp(status.label)}
      sx={{
        height: 'auto',
        minHeight: 26,
        fontSize: 12,
        borderColor: 'currentColor',
        ...(status.color === 'default' ? { color: 'text.secondary' } : {}),
        '& .MuiChip-icon': { ml: 1, color: 'inherit' },
      }}
    />
  )
}

/** The tariff of the next period: a scheduled change, else the tariff that renews. */
const renewalPlan = ({ plan, nextPlan }: Subscription) => nextPlan ?? plan

const availableCredits = (credits: CreditBalances): CreditsLeft => ({
  tariff: credits.tariff.available,
  gift: credits.gift.available,
  pack: credits.pack.available,
})

/**
 * What the page has just done at the customer's word. `text`: the sentence to show and to give
 * the focus to — the button that was pressed is gone with the state it changed. null: the
 * sentence of the new state itself says it («Автопродление отключено…»), and gets the focus.
 * `at` tells one saying from the next.
 */
export interface Said {
  text: string | null
  at: number
}

/** What one of the buttons of the block is doing, and why its last try was refused. */
export interface Action {
  busy: boolean
  error: string | null
  run: () => void
}

/**
 * The tariff the customer has: its state, the next charge or the last day, and the credits left
 * on the three accounts — and what can be done about it from here. A tariff whose charge failed
 * is paid for, a tariff that does not renew gets auto-renewal back, a scheduled change is taken
 * back. When a new task would not be taken — the credits ran out or are set aside, the limit of
 * the day is reached —, the block says why and names the way out (`taskNotice`); the pack and
 * the other tariffs it names are offered by the page below.
 *
 * While the shop takes one-time payments only (`autoRenewalAvailable` is false with payments
 * on) auto-renewal is not offered: no «Включить автопродление» and no terms of a charge to
 * come, no way to replace the card — a sentence says that it is unavailable for now. A tariff
 * without a saved method gets no «Изменить» beside «Способ оплаты» either: «Оплата» has nothing
 * to offer it.
 */
export function CurrentPlan({
  overview,
  subscription,
  said,
  onPay,
  resume,
  cancelChange,
  pack,
}: {
  overview: Pick<
    BillingOverview,
    'credits' | 'renewalCharge' | 'pastDueEndsAt' | 'paymentsEnabled' | 'autoRenewalAvailable'
  >
  subscription: Subscription
  said: Said | null
  /** Opens the last step before the payment page of an overdue tariff. */
  onPay: () => void
  /** «Включить автопродление». */
  resume: Action
  /** «Отменить переход». */
  cancelChange: Action
  /**
   * The pack the customer may buy now, as the row under the tariffs offers it; null when none is
   * on sale or it cannot be bought.
   */
  pack: PackOffer | null
}) {
  const { credits, renewalCharge, pastDueEndsAt, paymentsEnabled, autoRenewalAvailable } = overview
  const { plan, period, autoRenewal, paymentMethod, nextPlan } = subscription
  const pastDue = subscription.status === 'past_due'
  const left = availableCredits(credits)
  // What stands in the way of a new task. That the tariff is not paid is said by the block of
  // the failed charge itself.
  const refusal = taskNotice({
    task: credits,
    giftLeft: left.gift,
    packLeft: left.pack,
    tariff: {
      status: subscription.status,
      name: plan.name,
      periodEnd: period.end,
      autoRenewal,
      nextPlan: renewalPlan(subscription),
    },
    pack,
    canResume: autoRenewalAvailable,
  })
  const blocked = credits.newTask.reason === 'past_due' ? null : refusal
  // «Изменить» leads to «Оплата» while that page has something to do for this tariff. A shop
  // that takes one-time payments only binds and replaces no card: there is a saved method to
  // unlink there, or nothing at all. While payments are off the link is as it always was.
  const canChangeMethod = paymentMethod !== null || autoRenewalAvailable || !paymentsEnabled
  const notice = useRef<HTMLParagraphElement>(null)
  const state = useRef<HTMLParagraphElement>(null)

  const saidAt = said?.at
  const saidByState = said?.text === null
  useEffect(() => {
    // The button that was pressed is gone with the state it changed: the focus goes to the
    // words that say what happened instead of being lost.
    if (saidAt === undefined) return
    ;(saidByState ? state : notice).current?.focus()
  }, [saidAt, saidByState])

  const change = nextPlan
    ? scheduledChange({
        next: nextPlan,
        periodEnd: period.end,
        autoRenewal,
        pastDue,
        charge: renewalCharge,
        canResume: autoRenewalAvailable,
      })
    : null

  return (
    <Box component="section" aria-labelledby="plan-title" sx={{ p: sectionPadding }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px 24px',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' }}>
            <Typography
              component="h2"
              id="plan-title"
              sx={{ ...sectionHeading, overflowWrap: 'anywhere' }}
            >
              Тариф «{plan.name}»
            </Typography>
            <StatusChip status={statusOf(subscription)} />
          </Box>
          <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
            {nbsp(planLimits(plan))}
          </Typography>
        </Box>
        <Typography
          sx={{
            fontSize: 28,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: '-0.03em',
            whiteSpace: 'nowrap',
          }}
        >
          {formatRubles(plan.price)}&nbsp;₽{' '}
          <Box
            component="span"
            sx={{ color: 'text.secondary', fontSize: 14, fontWeight: 400, letterSpacing: 0 }}
          >
            в&nbsp;месяц
          </Box>
        </Typography>
      </Box>

      {said?.text ? (
        <Typography
          ref={notice}
          role="status"
          tabIndex={-1}
          variant="body2"
          sx={{ maxWidth: '62ch', mt: 3, lineHeight: 1.5, ...spoken }}
        >
          {nbsp(said.text)}
        </Typography>
      ) : null}

      {pastDue ? (
        <>
          <Alert
            severity="error"
            variant="outlined"
            icon={<AppIcon name="warning" />}
            sx={{ mt: 3, borderRadius: '12px' }}
          >
            <Typography sx={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4 }}>
              Не получилось списать {formatRubles(renewalPlan(subscription).price)}&nbsp;₽
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {nbsp(
                pastDueText({
                  canPay: paymentsEnabled,
                  autoRenewal,
                  endsAt: pastDueEndsAt,
                  canReplaceCard: autoRenewalAvailable,
                  tasksTaken: giftCarriesTasks(credits),
                }),
              )}
            </Typography>
          </Alert>
          {paymentsEnabled ? (
            <Box sx={buttons}>
              <Button variant="contained" onClick={onPay}>
                Оплатить сейчас
              </Button>
              {paymentMethod && autoRenewalAvailable ? (
                // Replacing the card is done on «Оплата» and pays for nothing: the tariff is paid
                // for here, by hand.
                <Button variant="outlined" href={BILLING_PATH}>
                  Заменить карту
                </Button>
              ) : null}
            </Box>
          ) : null}
        </>
      ) : autoRenewal ? null : (
        <>
          <Typography
            ref={state}
            // The words of the state are an announcement only when they are news.
            {...(saidByState ? { role: 'status' } : {})}
            tabIndex={-1}
            variant="body2"
            sx={{ maxWidth: '62ch', mt: 3, lineHeight: 1.5, ...spoken }}
          >
            {nbsp(
              renewalCharge === 'none'
                ? endsWithPeriod(period.end, left)
                : endsUnlessCharged(renewalCharge),
            )}
          </Typography>
          {autoRenewalAvailable ? (
            <>
              <Box sx={buttons}>
                <Button variant="contained" loading={resume.busy} onClick={resume.run}>
                  Включить автопродление
                </Button>
              </Box>
              <Typography
                variant="body2"
                color="textSecondary"
                sx={{ maxWidth: '62ch', mt: 1.5, overflowWrap: 'anywhere' }}
              >
                {nbsp(
                  resumeTerms({
                    periodEnd: period.end,
                    plan: renewalPlan(subscription),
                    changes: nextPlan !== null,
                    methodLabel: paymentMethod?.label ?? null,
                    charge: renewalCharge,
                  }),
                )}
              </Typography>
            </>
          ) : paymentsEnabled ? (
            // Payments are on and the shop takes one-time payments only: nothing to switch on.
            <Typography
              variant="body2"
              color="textSecondary"
              sx={{ maxWidth: '62ch', mt: 1.5, overflowWrap: 'anywhere' }}
            >
              {nbsp(renewalUnavailable())}
            </Typography>
          ) : null}
          {resume.error ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {resume.error}
            </Alert>
          ) : null}
        </>
      )}

      {blocked ? (
        <>
          <Alert
            // The state of the tariff, not news: it is read in its turn.
            role="status"
            severity="error"
            variant="outlined"
            icon={<AppIcon name="warning" />}
            sx={{ mt: 3, borderRadius: '12px' }}
          >
            <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
              {nbsp(noticeText(blocked, paymentsEnabled))}
            </Typography>
          </Alert>
          {/* The ways out are on this page already — the pack and the other tariffs stand
              below —, so the notice adds no second button for them: only what another tariff
              does not do today. */}
          {paymentsEnabled && blocked.actions.includes('change_plan') ? (
            <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
              {nbsp(PLAN_CHANGE_STARTS_LATER)}
            </Typography>
          ) : null}
        </>
      ) : null}

      {change ? (
        <ScheduledChange
          title={change.title}
          text={change.text}
          // A charge that has left was sent for the scheduled tariff: it cannot be taken back.
          action={
            renewalCharge === 'none' ? (
              <Button variant="outlined" loading={cancelChange.busy} onClick={cancelChange.run}>
                Отменить переход
              </Button>
            ) : null
          }
          error={cancelChange.error}
        />
      ) : null}

      <DetailRows>
        {pastDue ? null : autoRenewal ? (
          <DetailRow label="Следующее списание">
            {nbsp(
              renewalCharge === 'none'
                ? nextCharge(period.end, renewalPlan(subscription).price)
                : chargeUnderWayValue(renewalCharge),
            )}
          </DetailRow>
        ) : (
          <DetailRow label="Действует до">{formatMoscowDate(period.end)}</DetailRow>
        )}
        <DetailRow label="Способ оплаты">
          <Box component="span" sx={valueWithLink}>
            <span>{paymentMethod?.label ?? 'Не сохранён'}</span>
            {/* Replacing, binding and unlinking the method: «Оплата». */}
            {canChangeMethod ? (
              <Link href={BILLING_PATH} aria-label="Изменить способ оплаты" sx={rowLink}>
                Изменить
              </Link>
            ) : null}
          </Box>
        </DetailRow>
        <DetailRow label="Кредиты">
          <Box component="span" sx={valueWithLink}>
            {/* Nothing of an overdue tariff is «left» to the customer; gift credits are — the
                free ones, or those the task in work has set aside. */}
            <span>
              {nbsp(
                pastDue ? creditsWhileOverdue(left, credits.gift.held) : creditsLeft(left, credits),
              )}
            </span>
            {/* Where the credits went: «Использование». */}
            <Link href={USAGE_PATH} aria-label="Подробнее о кредитах" sx={rowLink}>
              Подробнее
            </Link>
          </Box>
        </DetailRow>
      </DetailRows>
    </Box>
  )
}

/** The tariff chosen for the next period, with the way to take the choice back. */
function ScheduledChange({
  title,
  text,
  action,
  error,
}: {
  title: string
  text: string
  action: ReactNode
  error: string | null
}) {
  return (
    <Box
      role="group"
      aria-labelledby="plan-change-title"
      sx={{
        mt: 3,
        p: 2,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px 24px',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flex: '1 1 320px',
            alignItems: 'flex-start',
            gap: 1.5,
            minWidth: 0,
          }}
        >
          <Box
            aria-hidden="true"
            sx={{ display: 'inline-flex', flexShrink: 0, mt: '1px', color: 'text.secondary' }}
          >
            <AppIcon name="clock" size={20} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              id="plan-change-title"
              sx={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4, overflowWrap: 'anywhere' }}
            >
              {nbsp(title)}
            </Typography>
            <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
              {nbsp(text)}
            </Typography>
          </Box>
        </Box>
        {action}
      </Box>
      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}
    </Box>
  )
}

/**
 * «Автопродление»: what happens at the end of the period while it is on, with the way to switch
 * it off — and, for a tariff that waits for a payment made by hand, what the consent means for
 * that payment. A tariff that is paid for and does not renew is told of in the block of the
 * tariff itself.
 */
export function AutoRenewal({
  subscription,
  renewalCharge,
  savesMethod,
  email,
  onCancel,
}: {
  subscription: Subscription
  renewalCharge: RenewalCharge
  /**
   * A payment made by hand saves the method it is made with. false only at a shop that takes
   * one-time payments only: while payments are off nothing is said of what a shop does not do.
   */
  savesMethod: boolean
  email: string
  /** Opens the confirmation of «Отключить автопродление». */
  onCancel: () => void
}) {
  const pastDue = subscription.status === 'past_due'
  const text = pastDue
    ? renewalWhileOverdue(subscription.autoRenewal, savesMethod)
    : renewalCharge === 'none'
      ? renewsWithPeriod({
          periodEnd: subscription.period.end,
          plan: renewalPlan(subscription),
          changes: subscription.nextPlan !== null,
          email,
        })
      : renewsWithChargeUnderWay(renewalCharge, email)

  return (
    <Box component="section" aria-labelledby="renew-title" sx={{ p: sectionPadding }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px 24px',
        }}
      >
        <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
          <Typography component="h2" id="renew-title" sx={sectionHeading}>
            Автопродление
          </Typography>
          <Typography
            variant="body2"
            color="textSecondary"
            sx={{ maxWidth: '62ch', mt: 0.5, overflowWrap: 'anywhere' }}
          >
            {nbsp(text)}
          </Typography>
        </Box>
        {subscription.autoRenewal ? (
          <Button variant="outlined" onClick={onCancel}>
            Отключить автопродление
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * The tariff the customer had last, once none is live: when and why it ended, what is kept, and
 * the way to a new one.
 */
export function EndedPlan({
  ended,
  packCredits,
  tasksTaken,
  canChoose,
}: {
  ended: EndedSubscription
  /** Purchased credits that wait for a new tariff. */
  packCredits: number
  /** A new task is taken without a tariff: on gift credits, by the answer of the server. */
  tasksTaken: boolean
  /** Payments are on: a tariff can be chosen below. */
  canChoose: boolean
}) {
  return (
    <Box component="section" aria-labelledby="plan-title" sx={{ p: sectionPadding }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' }}>
        <Typography
          component="h2"
          id="plan-title"
          sx={{ ...sectionHeading, overflowWrap: 'anywhere' }}
        >
          Тариф «{ended.planName}»
        </Typography>
        <StatusChip
          status={{
            label: `Закончился ${formatMoscowDay(ended.endedAt)}`,
            icon: 'clock',
            color: 'default',
          }}
        />
      </Box>
      <Typography variant="body2" sx={{ maxWidth: '62ch', mt: 2, lineHeight: 1.5 }}>
        {nbsp(endedText({ reason: ended.reason, packCredits, tasksTaken }))}
      </Typography>
      {canChoose ? (
        <Box sx={buttons}>
          <Button variant="contained" href={`#${PLANS_SECTION_ID}`}>
            Выбрать тариф
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
