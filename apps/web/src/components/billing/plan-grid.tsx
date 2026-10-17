'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { planDescription } from '@/lib/plan-description'
import { formatRubles } from '@/lib/rubles'

import { paletteOf } from './billing-surface'
import type { PlanOffer, Subscription } from './billing-types'
import {
  creditsWord,
  currentPlanNote,
  planAverageTasks,
  planDailyLimit,
  planSites,
  planTooSmall,
  scheduledPlanNote,
} from './plan-format'

/**
 * The width of the page's column at which three cards no longer fit side by side: the mockup
 * folds them when the column beside the sidebar is 760px, which leaves this much for the page.
 */
const ONE_COLUMN_BELOW = 696

/**
 * The tariffs on sale as cards. A customer without a tariff chooses one here; a customer with
 * a tariff sees which one is theirs and which one comes next, and may choose another for the
 * next period.
 */
export function PlanGrid({
  plans,
  siteCount,
  subscription,
  canChoose,
  onChoose,
  canChange,
  onChange,
}: {
  plans: PlanOffer[]
  siteCount: number
  subscription: Subscription | null
  /** Payments are on and no tariff is live: every tariff that fits the sites has its button. */
  canChoose: boolean
  onChoose: (plan: PlanOffer) => void
  /**
   * The customer's tariff is paid for and its next period can still be changed: every other
   * tariff that fits the sites has «Перейти на …».
   */
  canChange: boolean
  onChange: (plan: PlanOffer) => void
}) {
  // The cheapest tariff that holds the customer's sites; with a tariff of their own nothing
  // else is suggested.
  const suggested = subscription ? undefined : plans.find((plan) => plan.fitsSites)

  return (
    <Box
      component="ul"
      aria-label="Тарифы"
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(plans.length, 3)}, minmax(0, 1fr))`,
        // The gaps are the lines between the cards: every card outlines itself into them, and
        // the list cuts the outline off at its own border. A row that is not full stays empty.
        gap: '1px',
        m: 0,
        mt: 3,
        p: 0,
        listStyle: 'none',
        overflow: 'hidden',
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.paper',
        [`@container (max-width: ${ONE_COLUMN_BELOW}px)`]: {
          gridTemplateColumns: 'minmax(0, 1fr)',
        },
      }}
    >
      {plans.map((plan) => {
        const current = subscription !== null && plan.current
        // The tariff chosen for the next period.
        const scheduled = subscription !== null && subscription.nextPlan?.id === plan.id
        const overdue = subscription?.status === 'past_due'
        const marked = current || plan === suggested
        const averageTasks = planAverageTasks(plan.creditsPerMonth)
        const dailyLimit = planDailyLimit(plan.creditsPerDay)
        const note = current
          ? overdue
            ? null
            : // A scheduled change renews into another tariff: this one only lasts until then.
              currentPlanNote(
                subscription.period.end,
                subscription.autoRenewal && subscription.nextPlan === null,
              )
          : scheduled
            ? // What an overdue tariff changes to is told by the block of the tariff itself.
              overdue
              ? null
              : scheduledPlanNote(subscription.period.end, subscription.autoRenewal)
            : plan.fitsSites
              ? null
              : planTooSmall(siteCount, plan.maxSites)
        // A card has a note or a button, never both: where buttons are shown at all, a tariff
        // without a note is one that fits the sites.
        const offered = !current && !scheduled

        return (
          <Box
            component="li"
            key={plan.id}
            sx={(theme) => ({
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              px: 2.5,
              py: 3,
              boxShadow: `0 0 0 1px ${paletteOf(theme).divider}`,
              bgcolor: marked
                ? `color-mix(in srgb, var(--raditi-accent) 16%, ${paletteOf(theme).background.paper})`
                : 'background.paper',
            })}
          >
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Typography
                component="h3"
                sx={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}
              >
                {plan.name}
              </Typography>
              {marked ? (
                <Box
                  component="span"
                  sx={{
                    px: '9px',
                    py: '5px',
                    borderRadius: '3px', // impeccable-disable-line design-system-radius: the amber label of the landing's tariff
                    bgcolor: 'var(--raditi-marker)',
                    color: 'var(--raditi-ink)',
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: 1.2,
                  }}
                >
                  {current ? 'Ваш тариф' : 'Подходит вам'}
                </Box>
              ) : null}
            </Box>
            <Typography variant="body2" color="textSecondary" sx={{ mt: 0.75 }}>
              {nbsp(planDescription(plan.slug))}
            </Typography>
            <Typography
              sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 1, mt: 2.5 }}
            >
              <Box
                component="span"
                sx={{
                  fontSize: 26,
                  fontWeight: 500,
                  lineHeight: 1.2,
                  letterSpacing: '-0.04em',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatRubles(plan.price)}&nbsp;₽
              </Box>
              <Box component="span" sx={{ color: 'text.secondary', fontSize: 13 }}>
                / месяц
              </Box>
            </Typography>
            <Box
              component="ul"
              sx={(theme) => ({
                display: 'grid',
                gap: 1.25,
                m: 0,
                mt: 2.5,
                p: 0,
                pt: 2.5,
                listStyle: 'none',
                borderTop: 1,
                borderColor: marked
                  ? `color-mix(in srgb, ${paletteOf(theme).primary.main} 50%, transparent)`
                  : 'divider',
                fontSize: 14,
                lineHeight: 1.45,
              })}
            >
              <li>
                <Box component="strong" sx={{ fontWeight: 600 }}>
                  {nbsp(formatCount(plan.creditsPerMonth))}
                </Box>
                &nbsp;{creditsWord(plan.creditsPerMonth)} в&nbsp;месяц
              </li>
              {averageTasks ? <li>{nbsp(averageTasks)}</li> : null}
              {dailyLimit ? <li>{nbsp(dailyLimit)}</li> : null}
              <li>{nbsp(planSites(plan.maxSites))}</li>
            </Box>
            {note ? (
              <Typography variant="body2" color="textSecondary" sx={{ mt: 'auto', pt: 3 }}>
                {nbsp(note)}
              </Typography>
            ) : canChoose ? (
              <Box sx={{ mt: 'auto', pt: 3 }}>
                <Button
                  variant={plan === suggested ? 'contained' : 'outlined'}
                  fullWidth
                  onClick={() => onChoose(plan)}
                >
                  Выбрать «{plan.name}»
                </Button>
              </Box>
            ) : canChange && offered ? (
              <Box sx={{ mt: 'auto', pt: 3 }}>
                {/* One word, so that the buttons of a row stay one line tall whatever the tariffs
                    are called; the card says which tariff, and so does the name of the button. */}
                <Button
                  variant="outlined"
                  fullWidth
                  aria-label={`Перейти на тариф «${plan.name}»`}
                  onClick={() => onChange(plan)}
                >
                  Перейти
                </Button>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
