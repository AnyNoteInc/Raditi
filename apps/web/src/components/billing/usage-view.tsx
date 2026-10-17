'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { pageHeading, sectionHeading, sectionPadding, surface } from './billing-surface'
import type { BillingUsage, PackOffer, Subscription, TariffDay, TariffUsage } from './billing-types'
import { canBuyPack, PackDialog } from './pack-dialog'
import { creditsWord } from './plan-format'
import {
  dayLimitTomorrow,
  giftCarriesTasks,
  noticeText,
  PLAN_CHANGE_STARTS_LATER,
  taskNotice,
  type NoticeAction,
} from './task-notice'
import {
  buyPackLabel,
  creditsLeftWords,
  giftNote,
  heldEarlierNote,
  heldNote,
  ofDailyLimit,
  ofSiteLimit,
  packCredits,
  packNote,
  sitesMeterLabel,
  sitesNote,
  tariffMeterLabel,
  tariffNote,
  tariffRestEntry,
  todayMeterLabel,
  todayNote,
  todaySpent,
  unpaidWhileTasksTaken,
  usagePeriod,
  usageWithoutTariff,
  type TariffState,
} from './usage-format'
import { UsageHistory } from './usage-history'
import { Bar, Meter, Swatch, type MeterPart, type MeterTone } from './usage-meter'

const PLANS_PATH = '/settings/plans'

const subHeading = { fontSize: 15, fontWeight: 500, lineHeight: 1.4 } as const

/** Read by assistive technology, not drawn: the unit of a number that stands alone. */
const hidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

const tariffState = ({
  status,
  period,
  autoRenewal,
  plan,
  nextPlan,
}: Subscription): TariffState => ({
  status,
  periodEnd: period.end,
  autoRenewal,
  nextPlan: nextPlan ?? plan,
  changes: nextPlan !== null,
})

/** A notice inside a section: what stands in the way of new tasks, in words and with a sign. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <Alert
      // The state of the page, not news: it is read in its turn.
      role="status"
      severity="error"
      variant="outlined"
      icon={<AppIcon name="warning" />}
      sx={{ mt: 3, borderRadius: '12px' }}
    >
      <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
        {children}
      </Typography>
    </Alert>
  )
}

/**
 * The ways out a notice names, as the buttons this page has for them. The payment of an
 * overdue tariff, the tariffs on sale and the switch of auto-renewal are on «Тарифы»: the
 * buttons lead there.
 */
function NoticeActions({
  actions,
  onBuyPack,
}: {
  actions: readonly NoticeAction[]
  /** Opens the dialog of the pack the notice offers. */
  onBuyPack: () => void
}) {
  if (actions.length === 0) return null
  const has = (action: NoticeAction) => actions.includes(action)
  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2.5 }}>
        {has('buy_pack') ? (
          <Button variant="contained" onClick={onBuyPack} sx={{ whiteSpace: 'nowrap' }}>
            Купить пакет
          </Button>
        ) : null}
        {has('pay') ? (
          <Button variant="outlined" href={PLANS_PATH}>
            К тарифам
          </Button>
        ) : null}
        {has('choose_plan') ? (
          <Button variant="contained" href={PLANS_PATH}>
            Выбрать тариф
          </Button>
        ) : null}
        {has('resume_renewal') ? (
          <Button variant="outlined" href={PLANS_PATH}>
            Включить автопродление
          </Button>
        ) : null}
        {has('change_plan') ? (
          <Button variant="outlined" href={PLANS_PATH}>
            Сменить тариф
          </Button>
        ) : null}
      </Box>
      {has('change_plan') ? (
        <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
          {nbsp(PLAN_CHANGE_STARTS_LATER)}
        </Typography>
      ) : null}
    </>
  )
}

function Legend({ entries }: { entries: readonly { tone: MeterTone; text: string }[] }) {
  return (
    <Box
      component="ul"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 24px',
        m: 0,
        mt: 1.5,
        p: 0,
        listStyle: 'none',
        fontSize: 14,
        lineHeight: 1.45,
      }}
    >
      {entries.map(({ tone, text }) => (
        <Box component="li" key={tone} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Swatch tone={tone} />
          {nbsp(text)}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The credits left and, above the meter, what stands in the way of a new task; what the quota
 * of the period went to, the gift credits — while any are left or set aside — and the purchased
 * ones.
 */
function Credits({
  usage,
  subscription,
  tariff,
  offer,
  onBuyPack,
}: {
  usage: BillingUsage
  subscription: Subscription
  tariff: TariffUsage
  /** The pack the customer may buy now; null when there is none or it cannot be bought. */
  offer: PackOffer | null
  onBuyPack: (pack: PackOffer) => void
}) {
  const { credits } = tariff
  const pastDue = subscription.status === 'past_due'
  const state = tariffState(subscription)
  // The period of a tariff that is not paid for is over: what it did not use is not carried
  // over, so the customer has the gift and the purchased credits left and nothing of the tariff.
  const left = pastDue ? usage.gift.left + usage.pack.left : usage.totalLeft
  // A gift that is used up is not shown as an account with nothing on it.
  const hasGift = usage.gift.left + usage.gift.held > 0
  const notice = taskNotice({
    task: usage,
    giftLeft: usage.gift.left,
    packLeft: usage.pack.left,
    tariff: { ...state, name: subscription.plan.name },
    pack: offer,
    canResume: usage.autoRenewalAvailable,
  })
  // The credits ran out: what was spent is drawn as the end of them. A quota that is used up
  // while a task can still start on other credits is drawn as usual.
  const out = usage.newTask.reason === 'empty' || usage.newTask.reason === 'below_start'
  const spent: MeterTone = out ? 'out' : 'spent'
  const offersPack = notice?.actions.includes('buy_pack') === true
  const setAside = credits.held + credits.heldEarlier + usage.gift.held + usage.pack.held > 0

  return (
    <Box component="section" aria-labelledby="credits-title" sx={{ p: sectionPadding }}>
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
          <Typography component="h2" id="credits-title" sx={sectionHeading}>
            Кредиты
          </Typography>
          <Typography
            variant="body2"
            color="textSecondary"
            sx={{ mt: 0.5, overflowWrap: 'anywhere' }}
          >
            {nbsp(usagePeriod(subscription.plan.name, subscription.period))}
          </Typography>
        </Box>
        {/* When the notice offers the pack, the same offer stands there, as the way out. */}
        {offer && !offersPack ? (
          <Button variant="outlined" onClick={() => onBuyPack(offer)} sx={{ whiteSpace: 'nowrap' }}>
            {buyPackLabel(offer.credits, offer.price, true)}
          </Button>
        ) : null}
      </Box>

      {notice ? (
        <>
          <Notice>{nbsp(noticeText(notice, usage.paymentsEnabled))}</Notice>
          <NoticeActions
            actions={usage.paymentsEnabled ? notice.actions : []}
            onBuyPack={() => {
              if (offer) onBuyPack(offer)
            }}
          />
        </>
      ) : pastDue ? (
        // New tasks are still taken, on gift credits: the tariff itself is what is said.
        <>
          <Notice>{nbsp(unpaidWhileTasksTaken())}</Notice>
          <NoticeActions actions={['pay']} onBuyPack={() => undefined} />
        </>
      ) : null}

      <Typography
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px 12px', mt: 3 }}
      >
        <Box
          component="span"
          sx={{
            fontSize: 56,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: '-0.03em',
            // One figure on its own: its digits keep their natural widths.
            fontVariantNumeric: 'proportional-nums',
          }}
        >
          {nbsp(formatCount(left))}
        </Box>
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {creditsLeftWords(left)}
        </Box>
      </Typography>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '24px 40px', mt: 3.5 }}>
        <Box sx={{ flex: '2 1 360px', minWidth: 0 }}>
          <Typography component="h3" sx={subHeading}>
            {pastDue ? (
              <>По тарифу&nbsp;— период закончился</>
            ) : (
              <>
                По тарифу&nbsp;— {nbsp(formatCount(credits.left))} из&nbsp;
                {nbsp(formatCount(credits.granted))}
              </>
            )}
          </Typography>
          <Box sx={{ mt: 1.5 }}>
            <Meter
              label={tariffMeterLabel(credits, pastDue)}
              height={12}
              parts={[
                { tone: spent, value: credits.charged },
                { tone: 'expired', value: credits.expired },
                { tone: 'held', value: credits.held },
                { tone: 'left', value: credits.left },
              ]}
            />
          </Box>
          <Legend
            entries={[
              { tone: spent, text: `Списано — ${formatCount(credits.charged)}` },
              // Said only when something of this period is gone without a charge.
              ...(credits.expired > 0
                ? [{ tone: 'expired' as const, text: `Сгорело — ${formatCount(credits.expired)}` }]
                : []),
              { tone: 'held', text: `Отложено — ${formatCount(credits.held)}` },
              { tone: 'left', text: tariffRestEntry(credits.left, pastDue) },
            ]}
          />
          {setAside ? (
            <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
              {nbsp(heldNote())}
            </Typography>
          ) : null}
          {credits.heldEarlier > 0 ? (
            <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
              {nbsp(heldEarlierNote(credits.heldEarlier))}
            </Typography>
          ) : null}
          <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
            {nbsp(tariffNote(state))}
          </Typography>
        </Box>
        {/* The accounts stand in the order their credits are spent in. */}
        {hasGift ? (
          <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
            <Typography component="h3" sx={subHeading}>
              Подарочные&nbsp;— {nbsp(formatCount(usage.gift.left))}
            </Typography>
            <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
              {nbsp(giftNote(usage.gift))}
            </Typography>
          </Box>
        ) : null}
        <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
          <Typography component="h3" sx={subHeading}>
            Из пакета&nbsp;— {nbsp(formatCount(usage.pack.left))}
          </Typography>
          <Typography variant="body2" color="textSecondary" sx={{ mt: 1.5 }}>
            {nbsp(packNote(usage.pack, { tariff: credits.left, gift: usage.gift.left }, !pastDue))}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * One limit of the tariff: how much of it is taken, a small meter, what the taken part is made
 * of and a line about the rest.
 */
function Tile({
  title,
  figure,
  meter,
  detail = null,
  note,
}: {
  title: string
  /** null: nothing is counted against this limit now. */
  figure: { value: number; unit: string } | null
  /** null: the tariff sets no such limit, there is nothing to measure against. */
  meter: { label: string; parts: readonly MeterPart[]; total?: number } | null
  /** What the taken part is made of; null when there is nothing to tell. */
  detail?: string | null
  note: string
}) {
  return (
    <div>
      <Typography component="h2" variant="body2" color="textSecondary">
        {title}
      </Typography>
      {figure ? (
        <Typography
          sx={{
            mt: 0.75,
            fontSize: 28,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
          }}
        >
          {nbsp(formatCount(figure.value))}{' '}
          <Box
            component="span"
            sx={{ color: 'text.secondary', fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
          >
            {nbsp(figure.unit)}
          </Box>
        </Typography>
      ) : null}
      {meter ? (
        <Box sx={{ mt: 1.75 }}>
          <Meter label={meter.label} height={8} parts={meter.parts} total={meter.total} />
        </Box>
      ) : null}
      {detail ? (
        <Typography variant="body2" color="textSecondary" sx={{ mt: 1.25 }}>
          {nbsp(detail)}
        </Typography>
      ) : null}
      <Typography variant="body2" color="textSecondary" sx={{ mt: 1.25 }}>
        {nbsp(note)}
      </Typography>
    </div>
  )
}

/** A meter of «taken out of a limit»; what is taken beyond the limit fills the track. */
const taken = (count: number, limit: number): MeterPart[] => [
  { tone: 'spent', value: Math.min(count, limit) },
  { tone: 'left', value: Math.max(limit - count, 0) },
]

/**
 * The meter of the day, like that of the tariff: charged, set aside, left — what the tariff can
 * still give today (`left`), less than the room of the day when the month has less; the rest of
 * the track stays empty. A day that took more than the limit of now — after a renewal onto a
 * smaller plan — fills the track.
 */
const dayParts = ({ charged, held, left }: TariffDay): MeterPart[] => [
  { tone: 'spent', value: charged },
  { tone: 'held', value: held },
  { tone: 'left', value: left },
]

function Limits({
  usage,
  subscription,
  tariff,
}: {
  usage: BillingUsage
  subscription: Subscription
  tariff: TariffUsage
}) {
  const { today, sites } = tariff
  return (
    <Box component="section" aria-label="Лимиты тарифа" sx={{ p: sectionPadding }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
          gap: 4,
        }}
      >
        <Tile
          title="Сегодня"
          figure={
            today === null
              ? null
              : {
                  value: today.used,
                  unit: today.limit === null ? creditsWord(today.used) : ofDailyLimit(today.limit),
                }
          }
          meter={
            today === null || today.limit === null
              ? null
              : {
                  label: todayMeterLabel({ ...today, limit: today.limit }),
                  parts: dayParts(today),
                  total: today.limit,
                }
          }
          detail={today === null ? null : todaySpent(today)}
          note={todayNote({
            today,
            paid: subscription.status === 'active',
            tasksTaken: giftCarriesTasks(usage),
            tomorrow:
              today?.limit == null
                ? null
                : dayLimitTomorrow(
                    tariffState(subscription),
                    today.limit,
                    tariff.credits.left === 0,
                  ),
          })}
        />
        <Tile
          title="Сайты"
          figure={{ value: sites.count, unit: ofSiteLimit(sites.max) }}
          meter={{
            label: sitesMeterLabel(sites.count, sites.max),
            parts: taken(sites.count, sites.max),
          }}
          note={sitesNote(sites.count, sites.max)}
        />
      </Box>
    </Box>
  )
}

/** The credits charged in the period, site by site; one line while nothing is charged. */
function BySite({ sites }: { sites: TariffUsage['bySite'] }) {
  const most = Math.max(...sites.map(({ credits }) => credits), 1)
  return (
    <Box component="section" aria-labelledby="sites-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="sites-title" sx={sectionHeading}>
        По сайтам
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp(
          sites.length > 0
            ? 'Кредиты, списанные за текущий период.'
            : 'В этом периоде кредиты ещё не списывались.',
        )}
      </Typography>
      {sites.length > 0 ? (
        <Box
          component="ul"
          aria-labelledby="sites-title"
          sx={{ display: 'grid', gap: 2, m: 0, mt: 2.5, p: 0, listStyle: 'none' }}
        >
          {sites.map(({ siteId, name, credits }) => (
            <Box
              component="li"
              key={siteId}
              sx={{
                display: 'grid',
                // A count of four digits keeps its width: the column grows with it.
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(40px, max-content)',
                alignItems: 'center',
                gap: 2,
                fontSize: 14,
                lineHeight: 1.45,
              }}
            >
              <Box component="span" sx={{ overflowWrap: 'anywhere' }}>
                {name}
              </Box>
              <Bar share={credits / most} />
              <Box component="span" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {nbsp(formatCount(credits))}
                <Box component="span" sx={hidden}>
                  {' '}
                  {creditsWord(credits)}
                </Box>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * A customer without a tariff: the gift credits of the registration they can spend, or what
 * stands in the way of a new task, and the way on — to choose a tariff. Nothing is measured;
 * the history is shown below.
 */
function NoTariff({ usage }: { usage: BillingUsage }) {
  const { gift, pack } = usage
  // «Тариф закончился. У вас 40 кредитов из пакета…» has said it already.
  const namesPack = usage.newTask.reason === 'ended'
  return (
    <Box component="section" aria-labelledby="no-plan-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="no-plan-title" sx={sectionHeading}>
        Тариф не выбран
      </Typography>
      <Typography variant="body2" sx={{ maxWidth: '62ch', mt: 1, lineHeight: 1.5 }}>
        {nbsp(
          usageWithoutTariff(
            { available: gift.left, held: gift.held, granted: gift.granted },
            usage,
            pack.left,
          ),
        )}
      </Typography>
      {pack.left > 0 && !namesPack ? (
        <Typography variant="body2" sx={{ maxWidth: '62ch', mt: 1, lineHeight: 1.5 }}>
          {nbsp(packCredits(pack.left))}
        </Typography>
      ) : null}
      <Box sx={{ mt: 2.5 }}>
        <Button variant="contained" href={PLANS_PATH}>
          Выбрать тариф
        </Button>
      </Box>
    </Box>
  )
}

/**
 * «Настройки → Использование»: how many credits a customer on a tariff has left, what stands
 * in the way of a new task, what the current period went to, the limits of the tariff and the
 * history of the period. A customer without a tariff reads of the gift credits of the
 * registration, and their whole history.
 */
export function UsageView() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // Read anew every time the page is opened, whatever the cache holds: a payment on another
  // page and a task that has just finished both change these numbers. What the cache holds
  // is shown meanwhile.
  const usage = useQuery({ ...trpc.billing.usage.queryOptions(), refetchOnMount: 'always' })
  // The pack is kept with its dialog: a refusal reads the page anew, and the offer may be gone.
  // `round` gives every opening a dialog of its own, as on «Тарифы».
  const [packPurchase, setPackPurchase] = useState<{
    pack: PackOffer
    open: boolean
    round: number
  } | null>(null)

  const data = usage.data
  const offer = data && canBuyPack(data) ? data.packOnSale : null

  return (
    <Box>
      <Typography component="h1" sx={pageHeading}>
        Использование
      </Typography>
      <Typography color="textSecondary" sx={{ mt: 1 }}>
        {nbsp('Сколько кредитов осталось и на какие задачи они ушли.')}
      </Typography>

      {
        // Numbers that are on the screen stay there when a refresh in the background fails.
        usage.isError && !data ? (
          <Alert
            severity="error"
            sx={{ mt: 4 }}
            action={
              <Button
                color="inherit"
                size="small"
                loading={usage.isFetching}
                onClick={() => void usage.refetch()}
              >
                Повторить
              </Button>
            }
          >
            Не удалось загрузить данные об использовании. Попробуйте ещё раз.
          </Alert>
        ) : !data ? (
          <Box role="status" aria-label="Загрузка использования">
            <Skeleton variant="rounded" height={520} sx={{ mt: 4, borderRadius: '14px' }} />
          </Box>
        ) : data.subscription === null || data.tariff === null ? (
          <Stack divider={<Divider />} sx={{ ...surface, mt: 4 }}>
            <NoTariff usage={data} />
            {/* No tariff, no period: the history is whole, and its dates name their year. */}
            <UsageHistory first={data.history} readAt={usage.dataUpdatedAt} whole />
          </Stack>
        ) : (
          <Stack divider={<Divider />} sx={{ ...surface, mt: 4 }}>
            <Credits
              usage={data}
              subscription={data.subscription}
              tariff={data.tariff}
              offer={offer}
              onBuyPack={(pack) =>
                setPackPurchase((previous) => ({
                  pack,
                  open: true,
                  round: (previous?.round ?? 0) + 1,
                }))
              }
            />
            <Limits usage={data} subscription={data.subscription} tariff={data.tariff} />
            <BySite sites={data.tariff.bySite} />
            <UsageHistory first={data.history} readAt={usage.dataUpdatedAt} />
          </Stack>
        )
      }

      {packPurchase ? (
        <PackDialog
          key={packPurchase.round}
          pack={packPurchase.pack}
          open={packPurchase.open}
          onClose={() => {
            setPackPurchase((current) => current && { ...current, open: false })
            // A refusal of the dialog may be about what this page shows: the tariff has just
            // ended, the pack is no longer sold.
            void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
          }}
        />
      ) : null}
    </Box>
  )
}
