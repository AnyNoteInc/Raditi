'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useState } from 'react'

import { runFilterText, type RunFilter } from './history-text'

/** One item of the list of «Изменения» or «Запуски». */
export interface HistoryItem {
  /** The segment of its page under the section. */
  segment: string
  title: string
  note: string
  /** A short mark beside the title: «на сайте», «идёт». */
  badge?: string
  tone: 'ok' | 'error' | 'running' | 'neutral'
  /** The filters it is shown under, besides «Все». */
  filters?: readonly RunFilter[]
}

const toneColor = {
  ok: 'success.main',
  error: 'error.main',
  running: 'warning.main',
  neutral: 'text.disabled',
} as const

/**
 * The list column of a history section: links to the items, the open one marked. At the root of
 * the section the item the root page shows (`rootSegment`) is the open one.
 */
export function HistoryList({
  root,
  items,
  rootSegment,
  emptyText,
  filters = false,
}: {
  root: string
  items: readonly HistoryItem[]
  rootSegment: string | null
  emptyText: string
  filters?: boolean
}) {
  const segment = useSelectedLayoutSegment() ?? rootSegment
  const [filter, setFilter] = useState<RunFilter>('all')
  const shown =
    filter === 'all' ? items : items.filter((item) => item.filters?.includes(filter) ?? false)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {filters ? (
        <Box
          role="group"
          aria-label="Какие запуски показать"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, pb: 0.5 }}
        >
          {(Object.keys(runFilterText) as RunFilter[]).map((key) => (
            <Box
              key={key}
              component="button"
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              sx={{
                minHeight: 36,
                px: 1.5,
                borderRadius: '999px',
                border: 1,
                borderColor: filter === key ? 'text.primary' : 'divider',
                bgcolor: filter === key ? 'text.primary' : 'transparent',
                color: filter === key ? 'background.paper' : 'text.primary',
                font: 'inherit',
                fontSize: 14,
                cursor: 'pointer',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              {runFilterText[key]}
            </Box>
          ))}
        </Box>
      ) : null}
      {shown.length === 0 ? (
        <Typography color="text.secondary" sx={{ px: 1.5, py: 1 }}>
          {items.length === 0 ? emptyText : 'Таких запусков нет.'}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.5 }}
        >
          {shown.map((item) => {
            const current = item.segment === segment
            return (
              <li key={item.segment}>
                <Box
                  component={Link}
                  href={`${root}/${item.segment}`}
                  aria-current={current ? 'page' : undefined}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    alignItems: 'baseline',
                    gap: '2px 10px',
                    minHeight: 44,
                    px: 1.5,
                    py: 1.25,
                    borderRadius: '12px',
                    textDecoration: 'none',
                    color: 'text.primary',
                    bgcolor: current ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: current ? 'action.selected' : 'action.hover' },
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Box
                    component="span"
                    aria-hidden="true"
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: toneColor[item.tone],
                      alignSelf: 'center',
                    }}
                  />
                  <Typography
                    component="span"
                    sx={{
                      minWidth: 0,
                      fontSize: 15,
                      fontWeight: current ? 600 : 500,
                      lineHeight: 1.35,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {item.title}
                  </Typography>
                  {item.badge ? (
                    <Typography
                      component="span"
                      variant="caption"
                      sx={{
                        px: 1,
                        borderRadius: '999px',
                        border: 1,
                        borderColor: 'divider',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.badge}
                    </Typography>
                  ) : (
                    <span />
                  )}
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                    sx={{ gridColumn: '2 / -1' }}
                  >
                    {item.note}
                  </Typography>
                </Box>
              </li>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
