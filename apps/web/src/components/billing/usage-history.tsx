'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPCClient } from '@/trpc/client'

import { sectionHeading, sectionPadding } from './billing-surface'
import type { BillingUsage, UsageEntry } from './billing-types'
import { historyRange, outcomeText, taskNote } from './usage-format'

const cell = { py: 1.75, pr: 2, borderBottom: 1, borderColor: 'divider', verticalAlign: 'top' }
const lastCell = { '&:last-child': { pr: 0 } }
const noteLine = { display: 'block', color: 'text.secondary' }

function Outcome({ entry }: { entry: UsageEntry }) {
  const { text, note } = outcomeText(entry)
  return (
    <>
      {entry.outcome === 'held' ? (
        // In work is told by the words and the clock, not by the colour.
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          icon={<AppIcon name="clock" size={14} />}
          label={text}
          sx={{
            height: 'auto',
            minHeight: 26,
            fontSize: 12,
            borderColor: 'currentColor',
            '& .MuiChip-icon': { ml: 1, color: 'inherit' },
          }}
        />
      ) : (
        nbsp(text)
      )}
      {note ? (
        <Box component="span" sx={{ ...noteLine, mt: entry.outcome === 'held' ? 0.5 : 0 }}>
          {nbsp(note)}
        </Box>
      ) : null}
    </>
  )
}

function HistoryRow({ entry, withYear }: { entry: UsageEntry; withYear: boolean }) {
  const note = taskNote(entry.outcome, entry.task.status)
  return (
    <tr>
      <Box component="td" sx={{ ...cell, whiteSpace: 'nowrap' }}>
        {withYear ? formatMoscowDate(entry.at) : formatMoscowDay(entry.at)}
      </Box>
      <Box component="td" sx={{ ...cell, overflowWrap: 'anywhere' }}>
        {entry.task.title ?? 'Задача без описания'}
        {note ? (
          <Box component="span" sx={noteLine}>
            {note}
          </Box>
        ) : null}
      </Box>
      <Box component="td" sx={{ ...cell, ...lastCell }}>
        <Outcome entry={entry} />
      </Box>
    </tr>
  )
}

/** Lines on a page of the history. */
export const HISTORY_PAGE = 20

/**
 * «История списаний»: newest first, twenty lines a page, with «Назад» and «Вперёд» and how many
 * lines there are. Without dates — the tasks of the current period, of a customer without a
 * tariff all of them; the summary of the page brings that first page. «С» and «По» bound the
 * lines by days of Moscow instead of the period, so older charges can be found. `readAt` is when
 * the summary was read (`dataUpdatedAt` of its query): the pages after it are read anew with it.
 *
 * `whole`: the history has no period — the customer has no tariff — so a date is printed with
 * its year («5 октября 2026»); so it is when dates are chosen. The lines of a period keep the
 * short form («5 октября»).
 */
export function UsageHistory({
  first,
  readAt,
  whole = false,
}: {
  first: BillingUsage['history']
  readAt: number
  whole?: boolean
}) {
  const client = useTRPCClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // The cursor of every page opened so far: the first page has none.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const page = cursors.length - 1
  const cursor = cursors[page]
  const backwards = from !== '' && to !== '' && from > to
  const bounded = from !== '' || to !== ''
  const query = {
    ...(cursor === undefined ? {} : { cursor }),
    ...(from === '' ? {} : { from }),
    ...(to === '' ? {} : { to }),
  }
  const isFirst = !bounded && cursor === undefined
  const lines = useQuery({
    queryKey: ['billing-usage-history', readAt, query],
    queryFn: () => client.billing.usageHistory.query(query),
    // The first page without dates is the one the summary brought.
    ...(isFirst ? { initialData: first, initialDataUpdatedAt: readAt } : {}),
    enabled: !backwards,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: Infinity,
  })
  const shown = lines.data ?? (isFirst ? first : null)
  const entries = shown?.items ?? []
  const total = shown?.total ?? 0
  const start = page * HISTORY_PAGE

  const setBound = (set: (value: string) => void) => (value: string) => {
    set(value)
    setCursors([undefined])
  }

  return (
    <Box component="section" aria-labelledby="history-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="history-title" sx={sectionHeading}>
        История списаний
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp(
          'Сколько кредитов ушло на каждую задачу. Списываем за проделанную работу, даже если её прервал сбой; уточнения и «Изменить» считаются вместе с задачей. «Отменить» — бесплатно.',
        )}
      </Typography>
      <Box
        role="group"
        aria-label="Даты"
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5, mt: 2.5 }}
      >
        <TextField
          type="date"
          size="small"
          label="С"
          value={from}
          onChange={(event) => setBound(setFrom)(event.target.value)}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: to || undefined } }}
          sx={{ width: 170 }}
        />
        <TextField
          type="date"
          size="small"
          label="По"
          value={to}
          onChange={(event) => setBound(setTo)(event.target.value)}
          error={backwards}
          helperText={backwards ? nbsp('Раньше даты «С»') : undefined}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: from || undefined } }}
          sx={{ width: 170 }}
        />
        {bounded ? (
          <Button
            onClick={() => {
              setFrom('')
              setTo('')
              setCursors([undefined])
            }}
            sx={{ mt: 0.25 }}
          >
            Сбросить
          </Button>
        ) : null}
      </Box>
      {lines.isError ? (
        <Typography role="alert" variant="body2" color="error" sx={{ mt: 2.5 }}>
          {nbsp('Не удалось загрузить историю. Попробуйте ещё раз.')}
        </Typography>
      ) : backwards ? null : shown === null ? (
        <Box role="status" aria-label="Загрузка истории">
          <Skeleton variant="rounded" height={120} sx={{ mt: 2.5, borderRadius: '12px' }} />
        </Box>
      ) : entries.length === 0 ? (
        <Typography variant="body2" sx={{ mt: 2.5 }}>
          {nbsp(
            bounded
              ? 'За эти дни списаний нет.'
              : 'Списаний пока нет. Здесь появятся задачи и сколько кредитов ушло на каждую.',
          )}
        </Typography>
      ) : (
        <>
          {/* A table wider than a phone scrolls inside its own frame, which the keyboard reaches. */}
          <Box
            role="group"
            aria-labelledby="history-title"
            tabIndex={0}
            sx={{
              mt: 2.5,
              overflowX: 'auto',
              opacity: lines.isPlaceholderData ? 0.6 : 1,
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 3,
              },
            }}
          >
            <Box
              component="table"
              aria-labelledby="history-title"
              sx={{
                width: '100%',
                minWidth: 600,
                borderCollapse: 'collapse',
                fontSize: 14,
                lineHeight: 1.45,
                '& th': {
                  py: 1.25,
                  pr: 2,
                  borderBottom: 1,
                  borderColor: 'divider',
                  color: 'text.secondary',
                  fontWeight: 500,
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  ...lastCell,
                },
              }}
            >
              <thead>
                <tr>
                  <th scope="col">Дата</th>
                  <th scope="col">Задача</th>
                  <th scope="col">Списано</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} withYear={whole || bounded} />
                ))}
              </tbody>
            </Box>
          </Box>
          <Box
            component="nav"
            aria-label="Страницы истории"
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1.5,
              mt: 2,
            }}
          >
            <Typography variant="body2" color="textSecondary" aria-live="polite">
              {nbsp(historyRange(start, entries.length, total))}
            </Typography>
            {page > 0 || shown?.nextCursor ? (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={page === 0}
                  onClick={() => setCursors((opened) => opened.slice(0, -1))}
                >
                  Назад
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={!shown?.nextCursor || lines.isFetching}
                  onClick={() => {
                    const next = shown?.nextCursor
                    if (next) setCursors((opened) => [...opened, next])
                  }}
                >
                  Вперёд
                </Button>
              </Box>
            ) : null}
          </Box>
        </>
      )}
    </Box>
  )
}
