'use client'

import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Popover from '@mui/material/Popover'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { formatCount } from '@/lib/count'
import { formatMoscowDay } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { plural } from '@/lib/plural'
import { useTRPC } from '@/trpc/client'

import type { BillingUsage } from './billing-types'
import { canBuyPack } from './pack-dialog'
import { noGiftToSpeakOf } from './plan-format'
import {
  NEW_TASK_CLOSED,
  noticeText,
  PLAN_CHANGE_STARTS_LATER,
  taskNotice,
  type NoticeAction,
  type TaskNotice,
} from './task-notice'
import { unpaidWhileTasksTaken, usageWithoutTariff } from './usage-format'

const USAGE_PATH = '/settings/usage'
const PLANS_PATH = '/settings/plans'
/**
 * The credits change while tasks run: the ring reads them again now and then. What the client
 * does here — a new dialog, a payment — reads them at once (`billing.usage` is invalidated).
 */
const REFRESH_MS = 5 * 60_000

const left = (count: number) => plural(count, 'остался', 'осталось', 'осталось')

export const creditRingText = Object.freeze({
  /** The ring as it is read aloud: the account it is full of, and what is left of it. */
  onTariff: (count: number, of: number) =>
    `Кредиты по тарифу: ${left(count)} ${formatCount(count)} из ${formatCount(of)}`,
  onGift: (count: number, of: number) =>
    `Подарочные кредиты: ${left(count)} ${formatCount(count)} из ${formatCount(of)}`,
  periodOver: 'Кредиты по тарифу: период закончился',
  tariff: (name: string, end: Date) => `Тариф «${name}» до ${formatMoscowDay(end)}`,
  unpaid: (name: string) => `Тариф «${name}» не оплачен`,
  noTariff: 'Без тарифа',
  today: 'Сегодня',
  onTariffRow: 'По тарифу',
  pack: 'Пакет',
  gift: 'Подарок',
  leftOf: (count: number, of: number) =>
    `${left(count)} ${formatCount(count)} из ${formatCount(of)}`,
  over: 'период закончился',
  manage: 'Управлять использованием',
})

/** The way out a notice names first, as a button of the window: where it leads and its words. */
const actionLink: Readonly<Record<NoticeAction, { label: string; href: string }>> = {
  // The window of the pack opens on «Использование»: the button leads there.
  buy_pack: { label: 'К покупке пакета', href: USAGE_PATH },
  choose_plan: { label: 'Выбрать тариф', href: PLANS_PATH },
  pay: { label: 'К тарифам', href: PLANS_PATH },
  resume_renewal: { label: 'Включить автопродление', href: PLANS_PATH },
  change_plan: { label: 'Сменить тариф', href: PLANS_PATH },
}

const pastDue = (usage: BillingUsage) => usage.subscription?.status === 'past_due'

/**
 * What stands in the way of a new task, by the server's answer — the notice «Тарифы» and
 * «Использование» show (`taskNotice`); null while one would be taken. No condition of its own.
 */
export function usageNotice(usage: BillingUsage): TaskNotice | null {
  const subscription = usage.subscription
  return taskNotice({
    task: usage,
    giftLeft: usage.gift.left,
    packLeft: usage.pack.left,
    tariff:
      subscription === null
        ? null
        : {
            status: subscription.status,
            name: subscription.plan.name,
            periodEnd: subscription.period.end,
            autoRenewal: subscription.autoRenewal,
            nextPlan: subscription.nextPlan ?? subscription.plan,
          },
    pack: canBuyPack(usage) ? usage.packOnSale : null,
    canResume: usage.autoRenewalAvailable,
  })
}

/**
 * What the window says of new tasks, in the words of «Использование»: the notice of a refusal; a
 * tariff that is not paid for while tasks are still taken on the gift; without a tariff, its own
 * line — «Кредиты входят в тариф…» when there is no gift to speak of. null — nothing to say.
 */
export function creditWords(
  usage: BillingUsage,
): { text: string; action: NoticeAction | null } | null {
  const notice = usageNotice(usage)
  if (usage.subscription === null) {
    if (usage.newTask.allowed) return null
    const gift = { available: usage.gift.left, held: usage.gift.held, granted: usage.gift.granted }
    const text = usageWithoutTariff(gift, usage, usage.pack.left)
    if (text === '') return null
    const action = noGiftToSpeakOf(gift, usage) ? 'choose_plan' : (notice?.actions[0] ?? null)
    return { text, action }
  }
  if (notice !== null) {
    return { text: noticeText(notice, usage.paymentsEnabled), action: notice.actions[0] ?? null }
  }
  return pastDue(usage) ? { text: unpaidWhileTasksTaken(), action: 'pay' } : null
}

/**
 * What the ring is full of: the credits of the tariff's period, or, without a tariff, the gift
 * of the registration. A tariff that is not paid for has its period over: nothing of it is left
 * to spend. `closed` — a new task would not be taken now (the server's `newTask`), or the tariff
 * waits for its payment.
 */
export function creditRing(usage: BillingUsage): {
  label: string
  share: number
  closed: boolean
} {
  const closed = !usage.newTask.allowed || pastDue(usage)
  const said = (label: string) => (usage.newTask.allowed ? label : `${label}. ${NEW_TASK_CLOSED}`)
  if (usage.tariff !== null && !pastDue(usage)) {
    const { left: count, granted } = usage.tariff.credits
    return {
      label: said(creditRingText.onTariff(count, granted)),
      share: granted > 0 ? count / granted : 0,
      closed,
    }
  }
  if (usage.tariff !== null) return { label: said(creditRingText.periodOver), share: 0, closed }
  const of = Math.max(usage.gift.left, signupGiftCredits)
  return {
    label: said(creditRingText.onGift(usage.gift.left, of)),
    share: usage.gift.left / of,
    closed,
  }
}

/** The lines of the window: the day of the tariff, its period, the pack and the gift. */
export function creditRows(usage: BillingUsage): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const today = usage.today
  if (today !== null && today.limit !== null) {
    rows.push({
      label: creditRingText.today,
      value: creditRingText.leftOf(today.left, today.limit),
    })
  }
  if (usage.tariff !== null) {
    const { left: count, granted } = usage.tariff.credits
    rows.push({
      label: creditRingText.onTariffRow,
      value: pastDue(usage) ? creditRingText.over : creditRingText.leftOf(count, granted),
    })
  }
  if (usage.pack.left > 0) {
    rows.push({ label: creditRingText.pack, value: formatCount(usage.pack.left) })
  }
  // A gift that was never granted is not an account with nothing on it.
  const gift = { available: usage.gift.left, held: usage.gift.held, granted: usage.gift.granted }
  if (usage.tariff === null && !noGiftToSpeakOf(gift, usage)) {
    const of = Math.max(usage.gift.left, signupGiftCredits)
    rows.push({ label: creditRingText.gift, value: creditRingText.leftOf(usage.gift.left, of) })
  } else if (usage.tariff !== null && usage.gift.left > 0) {
    rows.push({ label: creditRingText.gift, value: formatCount(usage.gift.left) })
  }
  return rows
}

const RADIUS = 11
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** The ring itself: the track, and the arc of what is left from the top, clockwise. */
function Ring({ share, closed }: { share: number; closed: boolean }) {
  const arc = Math.max(0, Math.min(1, share)) * CIRCUMFERENCE
  return (
    <Box
      component="span"
      sx={{
        position: 'relative',
        display: 'flex',
        color: closed ? 'warning.main' : 'primary.main',
      }}
    >
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
        <circle
          cx="14"
          cy="14"
          r={RADIUS}
          fill="none"
          stroke="var(--mui-palette-divider)"
          strokeWidth="3"
        />
        {arc > 0 ? (
          <circle
            cx="14"
            cy="14"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${arc} ${CIRCUMFERENCE}`}
            transform="rotate(-90 14 14)"
          />
        ) : null}
      </svg>
      {/* The dot, not the colour alone, says that a new task would not be taken now. */}
      {closed ? (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 9,
            height: 9,
            borderRadius: '50%',
            bgcolor: 'warning.main',
            boxShadow: '0 0 0 2px var(--mui-palette-background-default)',
          }}
        />
      ) : null}
    </Box>
  )
}

/**
 * The credits over the account menu (owner's request of 29.10.2026, in place of the block under
 * the list of dialogs): a ring of what is left, and by a press a window with the day, the period,
 * the pack and the gift — the server's numbers, never ones counted here — with what stands in the
 * way of a new task in the words of the billing pages. A failure to read them hides the ring.
 */
export function CreditRing({ placement }: { placement: 'sidebar' | 'toolbar' }) {
  const trpc = useTRPC()
  const usage = useQuery({ ...trpc.billing.usage.queryOptions(), refetchInterval: REFRESH_MS })
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const windowId = useId()
  const titleId = useId()
  const data = usage.data
  if (!data) return null
  const ring = creditRing(data)
  const words = creditWords(data)
  const action = words?.action ?? null
  const open = anchor !== null
  const subscription = data.subscription
  const sidebar = placement === 'sidebar'
  // The pressing area of 44px in the window too (DESIGN.md).
  const row = { minHeight: 44, px: 1.5, borderRadius: '10px' } as const
  return (
    <>
      <ButtonBase
        aria-label={ring.label}
        title={ring.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? windowId : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          width: 44,
          height: 44,
          borderRadius: '12px',
          bgcolor: open ? 'action.selected' : 'transparent',
          '&:hover': { bgcolor: 'action.hover' },
          '&.Mui-focusVisible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <Ring share={ring.share} closed={ring.closed} />
      </ButtonBase>
      <Popover
        id={windowId}
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        // In the rail the window stands to the right of the ring, its bottom at the ring's; in the
        // bar of a phone it hangs under the ring.
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={
          sidebar
            ? { vertical: 'bottom', horizontal: 'left' }
            : { vertical: 'top', horizontal: 'right' }
        }
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-labelledby': titleId,
            sx: {
              width: 300,
              maxWidth: 'calc(100vw - 24px)',
              borderRadius: '16px',
              p: 0.75,
              ml: sidebar ? 1 : 0,
            },
          },
        }}
      >
        <Typography
          id={titleId}
          component="h2"
          color="text.secondary"
          sx={{ px: 1.5, pt: 1, pb: 1, fontSize: 13 }}
        >
          {nbsp(
            subscription === null
              ? creditRingText.noTariff
              : subscription.status === 'past_due'
                ? creditRingText.unpaid(subscription.plan.name)
                : creditRingText.tariff(subscription.plan.name, subscription.period.end),
          )}
        </Typography>
        <Box
          component="dl"
          sx={{
            m: 0,
            px: 1.5,
            py: 1.25,
            display: 'grid',
            gridTemplateColumns: 'auto auto',
            justifyContent: 'space-between',
            gap: '8px 16px',
            borderTop: 1,
            borderColor: 'divider',
            fontSize: 14,
          }}
        >
          {creditRows(data).map((line) => (
            <Box key={line.label} sx={{ display: 'contents' }}>
              <Box component="dt">{line.label}</Box>
              <Box component="dd" sx={{ m: 0, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {line.value}
              </Box>
            </Box>
          ))}
        </Box>
        {words ? (
          <Box sx={{ px: 1.5, py: 1.25, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
              {nbsp(words.text)}
            </Typography>
            {action !== null && data.paymentsEnabled ? (
              <>
                <Button
                  component={Link}
                  href={actionLink[action].href}
                  variant="contained"
                  onClick={() => setAnchor(null)}
                  sx={{ mt: 1.25, minHeight: 44 }}
                >
                  {actionLink[action].label}
                </Button>
                {action === 'change_plan' ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {nbsp(PLAN_CHANGE_STARTS_LATER)}
                  </Typography>
                ) : null}
              </>
            ) : null}
          </Box>
        ) : null}
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 0.5, mt: 0.25 }}>
          <Box
            component={Link}
            href={USAGE_PATH}
            onClick={() => setAnchor(null)}
            sx={{
              ...row,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: 'text.primary',
              textDecoration: 'none',
              fontSize: 14,
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            {creditRingText.manage}
            <AppIcon name="chevron" size={16} />
          </Box>
        </Box>
      </Popover>
    </>
  )
}
