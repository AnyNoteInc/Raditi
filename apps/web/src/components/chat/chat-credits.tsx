'use client'

import Box from '@mui/material/Box'
import MuiLink from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

import type { BillingUsage } from '@/components/billing/billing-types'
import { canBuyPack } from '@/components/billing/pack-dialog'
import { creditsWord } from '@/components/billing/plan-format'
import { noticeText, taskNotice } from '@/components/billing/task-notice'
import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { plural } from '@/lib/plural'
import { useTRPC } from '@/trpc/client'

import { creditsText } from './chat-texts'

const USAGE_PATH = '/settings/usage'

/**
 * What stands in the way of a new task, by the server's answer — the same notice «Тарифы» and
 * «Использование» show (`taskNotice`); null while one would be taken. No condition of its own.
 */
export function creditsNotice(usage: BillingUsage): string | null {
  const subscription = usage.subscription
  const notice = taskNotice({
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
  return notice === null ? null : noticeText(notice, usage.paymentsEnabled)
}

/**
 * The credits under the list of dialogs: how many a new dialog can spend — the server's own
 * number (`spendable`), never one counted here — and, when a new task would not be taken, why,
 * in the words of the billing pages. A failure to read them hides the block: the dialogs
 * themselves do not depend on it.
 */
export function ChatCredits() {
  const trpc = useTRPC()
  const usage = useQuery(trpc.billing.usage.queryOptions())
  const data = usage.data
  if (!data) return null
  const left = data.spendable
  const notice = creditsNotice(data)
  return (
    <Box
      component="section"
      aria-labelledby="chat-credits-title"
      sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography
        id="chat-credits-title"
        component="h2"
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600 }}
      >
        {creditsText.title}
      </Typography>
      <Typography sx={{ mt: 0.5, fontSize: 15, fontWeight: 600 }}>
        {nbsp(
          `${plural(left, 'Остался', 'Осталось', 'Осталось')} ${formatCount(left)} ${creditsWord(left)}`,
        )}
      </Typography>
      {notice ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, lineHeight: 1.5 }}>
          {nbsp(notice)}
        </Typography>
      ) : null}
      <MuiLink
        component={Link}
        href={USAGE_PATH}
        variant="body2"
        sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
      >
        {creditsText.details}
      </MuiLink>
    </Box>
  )
}
