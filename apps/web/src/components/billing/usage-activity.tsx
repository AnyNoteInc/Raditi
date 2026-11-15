'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import type { Theme } from '@mui/material/styles'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { paletteOf, sectionHeading, sectionPadding } from './billing-surface'
import type { UsageActivityDay } from './billing-types'
import {
  ACTIVITY_SPANS,
  actionsSummary,
  actionsWord,
  dayTicks,
  dayCredits,
  longDayLabel,
  scaleTicks,
  spanLabel,
  CREDIT_PARTS,
  creditPartLabel,
  creditsCount,
  creditsSummary,
  totalActions,
  totalCredits,
  type ActivitySpan,
  type CreditPart,
} from './usage-activity-format'

/** The height of the plot, without the labels of the days. */
const PLOT_HEIGHT = 168

/** Read by assistive technology, not drawn. */
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

/**
 * One hue in three steps, darkest at the bottom: the accounts of a day's credits are one spending, and
 * the legend and the hint name each of them.
 */
function creditFill(theme: Theme, part: CreditPart): string {
  const { primary, background } = paletteOf(theme)
  switch (part) {
    case 'tariff':
      return primary.main
    case 'gift':
      return `color-mix(in srgb, ${primary.main} 64%, ${background.paper})`
    case 'pack':
      return `color-mix(in srgb, ${primary.main} 36%, ${background.paper})`
  }
}

interface Segment {
  key: string
  value: number
  fill: (theme: Theme) => string
}

/**
 * Columns of one day each over a scale of up to four lines; a column of several segments
 * stacks them bottom up with a gap of the surface between them. The hint of a column names the
 * day and its numbers. The drawing is hidden from assistive technology: the section has a table.
 */
function Columns({
  days,
  segmentsOf,
  hint,
  formatTick,
}: {
  days: readonly UsageActivityDay[]
  segmentsOf: (day: UsageActivityDay) => Segment[]
  hint: (day: UsageActivityDay) => ReactNode
  formatTick: (value: number) => string
}) {
  const totals = days.map((day) => segmentsOf(day).reduce((sum, { value }) => sum + value, 0))
  const ticks = scaleTicks(Math.max(0, ...totals))
  const top = ticks.at(-1) ?? 1
  const labels = dayTicks(days.map(({ date }) => date))
  return (
    <Box aria-hidden="true" sx={{ display: 'flex', gap: 1.5, mt: 2.5 }}>
      {/* The scale: its numbers stand at their lines. */}
      <Box sx={{ position: 'relative', height: PLOT_HEIGHT, flexShrink: 0, minWidth: 28 }}>
        {ticks.map((tick) => (
          <Typography
            key={tick}
            component="span"
            variant="caption"
            color="textSecondary"
            sx={{
              position: 'absolute',
              right: 0,
              bottom: `${(tick / top) * 100}%`,
              transform: 'translateY(50%)',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {nbsp(formatTick(tick))}
          </Typography>
        ))}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ position: 'relative', height: PLOT_HEIGHT }}>
          {ticks.map((tick) => (
            <Box
              key={tick}
              sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${(tick / top) * 100}%`,
                borderTop: 1,
                borderColor: 'divider',
                borderTopStyle: tick === 0 ? 'solid' : 'dashed',
              }}
            />
          ))}
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex' }}>
            {days.map((day, index) => {
              const segments = segmentsOf(day).filter(({ value }) => value > 0)
              return (
                <Tooltip key={day.date} title={hint(day)} placement="top" arrow disableInteractive>
                  <Box
                    data-day={day.date}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      height: '100%',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'flex-end',
                      cursor: 'default',
                      '&:hover > div': { opacity: 0.85 },
                    }}
                  >
                    <Box
                      sx={{
                        width: '56%',
                        maxWidth: 32,
                        height: `${((totals[index] ?? 0) / top) * 100}%`,
                        // A day of a little is still seen, not a hairline.
                        minHeight: segments.length > 0 ? 3 : 0,
                        display: 'flex',
                        flexDirection: 'column-reverse',
                        gap: '2px',
                        borderRadius: '4px 4px 0 0', // impeccable-disable-line design-system-radius: the end of a chart bar
                        overflow: 'hidden',
                      }}
                    >
                      {segments.map(({ key, value, fill }) => (
                        <Box
                          key={key}
                          data-part={key}
                          sx={(theme) => ({
                            flex: `${value} 1 0`,
                            minHeight: 2,
                            bgcolor: fill(theme),
                          })}
                        />
                      ))}
                    </Box>
                  </Box>
                </Tooltip>
              )
            })}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', mt: 1 }}>
          {days.map((day, index) => (
            <Typography
              key={day.date}
              component="span"
              variant="caption"
              color="textSecondary"
              sx={{ flex: 1, minWidth: 0, textAlign: 'center', whiteSpace: 'nowrap' }}
            >
              {nbsp(labels[index] ?? '')}
            </Typography>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

function ChartHeading({ title, total, note }: { title: string; total: string; note: string }) {
  return (
    <div>
      <Typography component="h3" sx={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4 }}>
        {title}
      </Typography>
      <Typography
        sx={{ mt: 0.5, fontSize: 24, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' }}
      >
        {nbsp(total)}
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp(note)}
      </Typography>
    </div>
  )
}

function HintLines({ title, lines }: { title: string; lines: readonly string[] }) {
  return (
    <Box sx={{ py: 0.25 }}>
      <Box sx={{ fontWeight: 600 }}>{nbsp(title)}</Box>
      {lines.map((line) => (
        <Box key={line}>{nbsp(line)}</Box>
      ))}
    </Box>
  )
}

function ActionsChart({ days }: { days: readonly UsageActivityDay[] }) {
  const total = totalActions(days)
  return (
    <Box component="figure" aria-label={actionsSummary(days)} sx={{ m: 0, minWidth: 0 }}>
      <ChartHeading
        title="Действия"
        total={`${formatCount(total)} ${actionsWord(total)}`}
        note="Сообщения, ответы и команды в чатах."
      />
      <Columns
        days={days}
        formatTick={formatCount}
        segmentsOf={(day) => [
          { key: 'actions', value: day.actions, fill: (theme) => paletteOf(theme).primary.main },
        ]}
        hint={(day) => (
          <HintLines
            title={longDayLabel(day.date)}
            lines={[`${formatCount(day.actions)} ${actionsWord(day.actions)}`]}
          />
        )}
      />
    </Box>
  )
}

function CreditsChart({ days }: { days: readonly UsageActivityDay[] }) {
  return (
    <Box component="figure" aria-label={creditsSummary(days)} sx={{ m: 0, minWidth: 0 }}>
      <ChartHeading
        title="Расход кредитов"
        total={creditsCount(totalCredits(days))}
        note="Кредиты, списанные за работу агента."
      />
      <Columns
        days={days}
        formatTick={formatCount}
        segmentsOf={(day) =>
          CREDIT_PARTS.map((part) => ({
            key: part,
            value: day.credits[part],
            fill: (theme: Theme) => creditFill(theme, part),
          }))
        }
        hint={(day) => (
          <HintLines
            title={`${longDayLabel(day.date)} — ${creditsCount(dayCredits(day))}`}
            // Top down, as the column is read.
            lines={[...CREDIT_PARTS]
              .reverse()
              .map((part) => `${creditPartLabel[part]} — ${formatCount(day.credits[part])}`)}
          />
        )}
      />
      <Box
        component="ul"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 20px',
          m: 0,
          mt: 1.5,
          p: 0,
          listStyle: 'none',
          fontSize: 14,
          lineHeight: 1.45,
        }}
      >
        {[...CREDIT_PARTS].reverse().map((part) => (
          <Box component="li" key={part} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              component="span"
              aria-hidden="true"
              sx={(theme) => ({
                width: 10,
                height: 10,
                flexShrink: 0,
                borderRadius: '2px', // impeccable-disable-line design-system-radius: the square of a legend entry
                bgcolor: creditFill(theme, part),
              })}
            />
            {nbsp(creditPartLabel[part])}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** The numbers of both charts as a table, for assistive technology. */
function ActivityTable({ days }: { days: readonly UsageActivityDay[] }) {
  return (
    <Box component="table" sx={hidden}>
      <caption>Действия и расход кредитов по дням</caption>
      <thead>
        <tr>
          <th scope="col">День</th>
          <th scope="col">Действия</th>
          {CREDIT_PARTS.map((part) => (
            <th scope="col" key={part}>
              {creditPartLabel[part]}, кредитов
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.date}>
            <th scope="row">{longDayLabel(day.date)}</th>
            <td>{day.actions}</td>
            {CREDIT_PARTS.map((part) => (
              <td key={part}>{day.credits[part]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </Box>
  )
}

/**
 * «Активность»: day by day over a week or a month in Moscow, what the customer did in the chats
 * and how many credits were charged for the work, by account.
 */
export function UsageActivity() {
  const trpc = useTRPC()
  const [days, setDays] = useState<ActivitySpan>(7)
  const activity = useQuery({
    ...trpc.billing.usageActivity.queryOptions({ days }),
    refetchOnMount: 'always',
    // The other span stays on the screen while this one is read.
    placeholderData: keepPreviousData,
  })
  const data = activity.data

  return (
    <Box component="section" aria-labelledby="activity-title" sx={{ p: sectionPadding }}>
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
          <Typography component="h2" id="activity-title" sx={sectionHeading}>
            Активность
          </Typography>
          <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
            {nbsp('По дням, по московскому времени.')}
          </Typography>
        </Box>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={days}
          aria-label="Период"
          onChange={(_, value: ActivitySpan | null) => {
            if (value !== null) setDays(value)
          }}
        >
          {ACTIVITY_SPANS.map((span) => (
            <ToggleButton
              key={span}
              value={span}
              sx={{ px: 1.5, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              {spanLabel(span)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {activity.isError && !data ? (
        <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="error">
            {nbsp('Не удалось загрузить активность.')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            loading={activity.isFetching}
            onClick={() => void activity.refetch()}
          >
            Повторить
          </Button>
        </Box>
      ) : !data ? (
        <Box role="status" aria-label="Загрузка активности">
          <Skeleton variant="rounded" height={260} sx={{ mt: 3, borderRadius: '12px' }} />
        </Box>
      ) : (
        <Box
          sx={{
            mt: 3,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
            gap: '32px 40px',
            opacity: activity.isPlaceholderData ? 0.6 : 1,
            transition: 'opacity 120ms',
          }}
        >
          <ActionsChart days={data.days} />
          <CreditsChart days={data.days} />
          <ActivityTable days={data.days} />
        </Box>
      )}
    </Box>
  )
}
