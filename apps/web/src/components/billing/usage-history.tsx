'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery } from '@tanstack/react-query'

import { AppIcon } from '@/components/application/app-icon'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPCClient } from '@/trpc/client'

import { sectionHeading, sectionPadding } from './billing-surface'
import type { BillingUsage, UsageEntry } from './billing-types'
import { outcomeText, taskNote } from './usage-format'

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
      <Box component="td" sx={{ ...cell, overflowWrap: 'anywhere' }}>
        {entry.site.name}
      </Box>
      <Box component="td" sx={{ ...cell, ...lastCell }}>
        <Outcome entry={entry} />
      </Box>
    </tr>
  )
}

/**
 * «История списаний»: the tasks of the current period — of a customer without a tariff, all of
 * them — and how many credits each one took. The summary of the page brings the first lines;
 * «Показать ещё» asks for the next ones, a page at a time. `readAt` is when the summary was
 * read (`dataUpdatedAt` of its query).
 *
 * `whole`: the history has no period — the customer has no tariff — and goes back as far as
 * their first task, so a date is printed with its year («5 октября 2026»). The lines of a
 * period, a month long and named above them with its year, keep the short form («5 октября»).
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
  // The pages after the first one. They hang on the reading of the summary that brought the
  // first page: when the summary is read anew, the continuation starts anew as well. A line
  // that has changed since — a task in work that is done now — is not left on the screen as it
  // was, and nothing is skipped or repeated when the first page ends elsewhere. Nothing is
  // asked until the customer asks.
  const more = useInfiniteQuery({
    queryKey: ['billing-usage-history', readAt, first.nextCursor],
    queryFn: ({ pageParam }) => client.billing.usageHistory.query({ cursor: pageParam }),
    initialPageParam: first.nextCursor ?? '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: false,
    retry: false,
    staleTime: Infinity,
  })
  const entries = [...first.items, ...(more.data?.pages.flatMap(({ items }) => items) ?? [])]
  const hasMore = more.data ? more.hasNextPage : first.nextCursor !== null

  return (
    <Box component="section" aria-labelledby="history-title" sx={{ p: sectionPadding }}>
      <Typography component="h2" id="history-title" sx={sectionHeading}>
        История списаний
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {nbsp(
          'Сколько кредитов ушло на каждую задачу. Списываем только за выполненные задачи; уточнения и «Изменить» считаются вместе с задачей. «Отменить» — бесплатно.',
        )}
      </Typography>
      {entries.length === 0 ? (
        <Typography variant="body2" sx={{ mt: 2.5 }}>
          {nbsp('Списаний пока нет. Здесь появятся задачи и сколько кредитов ушло на каждую.')}
        </Typography>
      ) : (
        // A table wider than a phone scrolls inside its own frame, which the keyboard reaches.
        <Box
          role="group"
          aria-labelledby="history-title"
          tabIndex={0}
          sx={{
            mt: 2.5,
            overflowX: 'auto',
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
                <th scope="col">Сайт</th>
                <th scope="col">Списано</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} withYear={whole} />
              ))}
            </tbody>
          </Box>
        </Box>
      )}
      {more.isError ? (
        <Typography role="alert" variant="body2" color="error" sx={{ mt: 2.5 }}>
          {nbsp('Не удалось загрузить продолжение истории. Попробуйте ещё раз.')}
        </Typography>
      ) : null}
      {hasMore ? (
        <Box sx={{ mt: 2.5 }}>
          <Button
            variant="outlined"
            loading={more.isFetching}
            onClick={() => void more.fetchNextPage()}
          >
            Показать ещё
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
