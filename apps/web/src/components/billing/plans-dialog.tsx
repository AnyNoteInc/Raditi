'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type { PlanOffer } from './billing-types'
import { creditsWord } from './plan-format'
import { PlanGrid } from './plan-grid'

export const PLANS_PAGE = '/settings/plans'

/**
 * What the dialog says above the cards: the customer's tariff and the bigger one they may move
 * to, or that there is no tariff yet. Bigger means more credits a month.
 */
export function plansDialogLead(plans: PlanOffer[]): string {
  const current = plans.find((plan) => plan.current)
  if (!current) return 'Тарифа пока нет. Выберите подходящий — кредиты начисляются каждый месяц.'
  const bigger = plans
    .filter((plan) => plan.creditsPerMonth > current.creditsPerMonth)
    .sort((a, b) => a.creditsPerMonth - b.creditsPerMonth)[0]
  if (!bigger)
    return `Ваш тариф — «${current.name}». Это самый большой тариф: больше кредитов в месяц нет ни в одном.`
  return `Ваш тариф — «${current.name}». Его можно поднять до «${bigger.name}»: ${formatCount(bigger.creditsPerMonth)} ${creditsWord(bigger.creditsPerMonth)} в месяц вместо ${formatCount(current.creditsPerMonth)}.`
}

/**
 * «Посмотреть тарифы» of the account menu: the tariffs on sale with the customer's own marked,
 * and what it can be raised to. Nothing is bought here — the button leads to «Тарифы», where
 * the checkout and the change of a tariff live.
 */
export function PlansDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trpc = useTRPC()
  const overview = useQuery({ ...trpc.billing.overview.queryOptions(), enabled: open })
  const offers = useQuery({ ...trpc.billing.plans.queryOptions(), enabled: open })
  const failed = (overview.isError && !overview.data) || (offers.isError && !offers.data)
  const subscription = overview.data?.subscription ?? null
  const hasPlan = offers.data?.plans.some((plan) => plan.current) ?? false

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="plans-dialog-title"
    >
      <DialogTitle id="plans-dialog-title">Тарифы</DialogTitle>
      <DialogContent>
        {failed ? (
          <Alert severity="error">Не удалось загрузить тарифы. Попробуйте ещё раз.</Alert>
        ) : !overview.data || !offers.data ? (
          <Box role="status" aria-label="Загрузка тарифов">
            <Skeleton variant="text" width={360} sx={{ maxWidth: '100%', fontSize: 16 }} />
            <Skeleton variant="rounded" height={360} sx={{ mt: 3, borderRadius: '12px' }} />
          </Box>
        ) : (
          // The cards fold by the width of the dialog, as on «Тарифы» by its column.
          <Box sx={{ containerType: 'inline-size' }}>
            <Typography color="textSecondary">
              {nbsp(plansDialogLead(offers.data.plans))}
            </Typography>
            {offers.data.plans.length > 0 ? (
              <PlanGrid
                plans={offers.data.plans}
                subscription={subscription}
                canChoose={false}
                onChoose={() => undefined}
                canChange={false}
                onChange={() => undefined}
              />
            ) : (
              <Typography variant="body2" sx={{ mt: 3 }}>
                {nbsp('Сейчас тарифы не продаются. Загляните позже.')}
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Закрыть</Button>
        <Button variant="contained" component={Link} href={PLANS_PAGE} onClick={onClose}>
          {hasPlan ? 'Сменить тариф' : 'Выбрать тариф'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
