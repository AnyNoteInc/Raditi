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
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { paletteOf, sectionHeading, sectionPadding } from './billing-surface'
import type { UsageActivityDay } from './billing-types'
import {
  ACTIONS_YEAR,
  ACTIVITY_SPANS,
  actionsSummary,
  actionsWord,
  dayTicks,
  dayCredits,
  heatLevel,
  longDayLabel,
  monthTicks,
  scaleTicks,
  spanLabel,
  CREDIT_PARTS,
  creditPartLabel,
  creditsCount,
  creditsSummary,
  totalActions,
  totalCredits,
  weeksOf,
  WEEKDAY_LABELS,
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
              sx={{
                flex: 1,
                minWidth: 0,
                textAlign: 'center',
                whiteSpace: 'nowrap',
                // On a phone the number and its month stand one under the other, both centred on
                // the column even when a month is a little wider than it.
                display: { xs: 'flex', sm: 'block' },
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <DayTick label={labels[index] ?? ''} />
            </Typography>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

/**
 * A label under a column: «13», or «13 нояб.» where the month starts. On a phone a week's column
 * is narrower than «13 нояб.», which then lay over «14»: there the month goes under the number.
 */
function DayTick({ label }: { label: string }) {
  // Any space: an engine may put a no-break one between the day and its month.
  const space = label.search(/\s/)
  if (space === -1) return label
  return (
    <>
      <span>{label.slice(0, space)}</span>
      <Box component="span" sx={{ display: { xs: 'block', sm: 'inline' } }}>
        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
          &nbsp;
        </Box>
        {label.slice(space + 1)}
      </Box>
    </>
  )
}

const chartTitle = { fontSize: 15, fontWeight: 500, lineHeight: 1.4 } as const

/** The title of a chart, its total and a line of what it counts; the title may stand above. */
function ChartHeading({ title, total, note }: { title?: string; total: string; note: string }) {
  return (
    <div>
      {title === undefined ? null : (
        <Typography component="h3" sx={chartTitle}>
          {title}
        </Typography>
      )}
      <Typography
        sx={{
          mt: title === undefined ? 0 : 0.5,
          fontSize: 24,
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: '-0.02em',
        }}
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

/** A cell of the grid: its side and the gap after it, in pixels. */
const CELL = 12
const CELL_GAP = 3
const STEP = CELL + CELL_GAP

/** The fill of a level of the grid: the empty day is a faint square, the busiest the full hue. */
function heatFill(theme: Theme, level: 0 | 1 | 2 | 3 | 4): string {
  const { primary, text, background } = paletteOf(theme)
  if (level === 0) return `color-mix(in srgb, ${text.primary} 7%, ${background.paper})`
  const share = [0, 30, 55, 78, 100][level]
  return `color-mix(in srgb, ${primary.main} ${share}%, ${background.paper})`
}

/**
 * «Действия»: a year of days in weeks — a column a week, Monday on top —, each day coloured by
 * how many actions it had against the busiest one; the months stand under their first week. A
 * grid wider than its place scrolls inside its own frame and opens at today. The hint of a day
 * names it and its actions; for assistive technology the figure is named by its numbers.
 */
function ActionsYear({ days }: { days: readonly UsageActivityDay[] }) {
  const total = totalActions(days)
  const max = Math.max(0, ...days.map(({ actions }) => actions))
  const weeks = weeksOf(days)
  const months = monthTicks(weeks)
  const frame = useRef<HTMLDivElement>(null)
  // The latest weeks are in sight when the grid opens and whenever its frame changes width.
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const toToday = () => {
      element.scrollLeft = element.scrollWidth
    }
    toToday()
    if (typeof ResizeObserver === 'undefined') return
    const watcher = new ResizeObserver(toToday)
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [days])
  return (
    <Box component="figure" aria-label={actionsSummary(days)} sx={{ m: 0, minWidth: 0 }}>
      <ChartHeading
        title="Действия"
        total={`${formatCount(total)} ${actionsWord(total)} за год`}
        note="Сообщения, ответы и команды в чатах."
      />
      <Box sx={{ display: 'flex', gap: 1, mt: 2.5 }}>
        <Box
          aria-hidden="true"
          sx={{ display: 'grid', gridAutoRows: `${CELL}px`, rowGap: `${CELL_GAP}px` }}
        >
          {WEEKDAY_LABELS.map((label, index) => (
            <Typography
              key={index}
              component="span"
              variant="caption"
              color="textSecondary"
              sx={{ fontSize: 11, lineHeight: `${CELL}px` }}
            >
              {label}
            </Typography>
          ))}
        </Box>
        <Box ref={frame} sx={{ overflowX: 'auto', minWidth: 0, pb: 0.5 }}>
          <Box aria-hidden="true" sx={{ width: weeks.length * STEP }}>
            <Box sx={{ display: 'flex', gap: `${CELL_GAP}px` }}>
              {weeks.map((week, column) => (
                <Box
                  key={column}
                  sx={{ display: 'grid', gridAutoRows: `${CELL}px`, rowGap: `${CELL_GAP}px` }}
                >
                  {week.map((day, row) =>
                    day === null ? (
                      <Box key={row} sx={{ width: CELL }} />
                    ) : (
                      <Tooltip
                        key={day.date}
                        title={`${longDayLabel(day.date)} — ${formatCount(day.actions)} ${actionsWord(day.actions)}`}
                        placement="top"
                        arrow
                        disableInteractive
                      >
                        <Box
                          data-day={day.date}
                          data-level={heatLevel(day.actions, max)}
                          sx={(theme) => ({
                            width: CELL,
                            height: CELL,
                            borderRadius: '3px', // impeccable-disable-line design-system-radius: a cell of the grid
                            bgcolor: heatFill(theme, heatLevel(day.actions, max)),
                          })}
                        />
                      </Tooltip>
                    ),
                  )}
                </Box>
              ))}
            </Box>
            <Box sx={{ position: 'relative', height: 18, mt: 1 }}>
              {months.map(({ week, label }) => (
                <Typography
                  key={week}
                  component="span"
                  variant="caption"
                  color="textSecondary"
                  sx={{
                    position: 'absolute',
                    left: week * STEP,
                    whiteSpace: 'nowrap',
                    lineHeight: '18px',
                  }}
                >
                  {label}
                </Typography>
              ))}
            </Box>
          </Box>
        </Box>
      </Box>
      <Box
        aria-hidden="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '4px',
          mt: 1,
        }}
      >
        <Typography component="span" variant="caption" color="textSecondary" sx={{ mr: 0.5 }}>
          Меньше
        </Typography>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <Box
            key={level}
            sx={(theme) => ({
              width: CELL,
              height: CELL,
              borderRadius: '3px', // impeccable-disable-line design-system-radius: a cell of the grid
              bgcolor: heatFill(theme, level),
            })}
          />
        ))}
        <Typography component="span" variant="caption" color="textSecondary" sx={{ ml: 0.5 }}>
          Больше
        </Typography>
      </Box>
    </Box>
  )
}

function CreditsChart({ days }: { days: readonly UsageActivityDay[] }) {
  return (
    <Box component="figure" aria-label={creditsSummary(days)} sx={{ m: 0, minWidth: 0 }}>
      {/* The title stands above, beside the choice of the span. */}
      <ChartHeading
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

/**
 * The numbers of the chart of credits as a table, for assistive technology. The box that hides it
 * is a `div`: a table is never narrower than its cells, so `width: 1px` on the table itself left
 * it as wide as its text, and the page scrolled sideways.
 */
function ActivityTable({ days }: { days: readonly UsageActivityDay[] }) {
  return (
    <Box sx={hidden}>
      <table>
        <caption>Расход кредитов по дням</caption>
        <thead>
          <tr>
            <th scope="col">День</th>
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
              {CREDIT_PARTS.map((part) => (
                <td key={part}>{day.credits[part]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  )
}

/** What a block shows while its numbers are read, or when they did not come. */
function Loading({
  query,
  height,
  children,
}: {
  query: { isError: boolean; isFetching: boolean; refetch: () => unknown }
  height: number
  children: ReactNode
}) {
  if (children) return children
  return query.isError ? (
    <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="body2" color="error">
        {nbsp('Не удалось загрузить активность.')}
      </Typography>
      <Button
        size="small"
        variant="outlined"
        loading={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Повторить
      </Button>
    </Box>
  ) : (
    <Box role="status" aria-label="Загрузка активности">
      <Skeleton variant="rounded" height={height} sx={{ mt: 3, borderRadius: '12px' }} />
    </Box>
  )
}

/**
 * «Активность»: the actions of the customer in the chats over a year, day by day, and the credits
 * charged over a week or a month — days of Moscow both.
 */
export function UsageActivity() {
  const trpc = useTRPC()
  const [days, setDays] = useState<ActivitySpan>(7)
  const year = useQuery({
    ...trpc.billing.usageActivity.queryOptions({ days: ACTIONS_YEAR }),
    refetchOnMount: 'always',
  })
  const credits = useQuery({
    ...trpc.billing.usageActivity.queryOptions({ days }),
    refetchOnMount: 'always',
    // The other span stays on the screen while this one is read.
    placeholderData: keepPreviousData,
  })

  return (
    <Box component="section" aria-labelledby="activity-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="activity-title" sx={sectionHeading}>
        Активность
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp('По дням, по московскому времени.')}
      </Typography>

      <Box sx={{ mt: 3 }}>
        <Loading query={year} height={170}>
          {year.data ? <ActionsYear days={year.data.days} /> : null}
        </Loading>
      </Box>

      <Box sx={{ mt: 4 }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            mb: 0.5,
          }}
        >
          <Typography component="h3" sx={chartTitle}>
            Расход кредитов
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={days}
            aria-label="Период расхода"
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
        <Loading query={credits} height={260}>
          {credits.data ? (
            <Box
              sx={{
                opacity: credits.isPlaceholderData ? 0.6 : 1,
                transition: 'opacity 120ms',
              }}
            >
              <CreditsChart days={credits.data.days} />
              <ActivityTable days={credits.data.days} />
            </Box>
          ) : null}
        </Loading>
      </Box>
    </Box>
  )
}
