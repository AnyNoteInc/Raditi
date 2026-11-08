'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

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
 * The versions or the runs of a site as a list across the full width
 * (docs/plan/64-cabinet-navigation.md, Н6): each row leads to the item's own page. The runs are
 * told apart by the tabs «Все», «Идут» and «С ошибкой» (Н5).
 */
export function HistoryList({
  label,
  root,
  items,
  emptyText,
  filters = false,
}: {
  /** The accessible name of the list. */
  label: string
  root: string
  items: readonly HistoryItem[]
  emptyText: string
  filters?: boolean
}) {
  const [filter, setFilter] = useState<RunFilter>('all')
  const shown =
    filter === 'all' ? items : items.filter((item) => item.filters?.includes(filter) ?? false)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {filters ? (
        <Box
          role="group"
          aria-label="Какие запуски показать"
          sx={{ display: 'flex', gap: 0.5, borderBottom: 1, borderColor: 'divider', mt: -1 }}
        >
          {(Object.keys(runFilterText) as RunFilter[]).map((key) => {
            const on = filter === key
            return (
              <Box
                key={key}
                component="button"
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(key)}
                sx={{
                  position: 'relative',
                  minHeight: 44,
                  px: 1.75,
                  border: 0,
                  borderRadius: '8px 8px 0 0',
                  bgcolor: 'transparent',
                  font: 'inherit',
                  fontSize: 14,
                  fontWeight: on ? 600 : 500,
                  color: on ? 'text.primary' : 'text.secondary',
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    left: 10,
                    right: 10,
                    bottom: -1,
                    height: 2,
                    borderRadius: 2,
                    bgcolor: on ? 'primary.main' : 'transparent',
                  },
                }}
              >
                {runFilterText[key]}
              </Box>
            )
          })}
        </Box>
      ) : null}
      {shown.length === 0 ? (
        <Typography color="text.secondary">
          {items.length === 0 ? emptyText : 'Таких запусков нет.'}
        </Typography>
      ) : (
        <Box
          component="ul"
          aria-label={label}
          sx={{
            m: 0,
            p: 0,
            listStyle: 'none',
            border: 1,
            borderColor: 'divider',
            borderRadius: '16px',
            overflow: 'hidden',
          }}
        >
          {shown.map((item) => (
            <Box
              component="li"
              key={item.segment}
              sx={{ '& + &': { borderTop: 1, borderColor: 'divider' } }}
            >
              <Box
                component={Link}
                href={`${root}/${item.segment}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
                  alignItems: 'center',
                  gap: '2px 14px',
                  minHeight: 60,
                  px: { xs: 2, md: 2.5 },
                  py: 1.25,
                  textDecoration: 'none',
                  color: 'text.primary',
                  '&:hover': { bgcolor: 'action.hover' },
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: -2,
                  },
                }}
              >
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: toneColor[item.tone] }}
                />
                <Box
                  component="span"
                  sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}
                >
                  <Typography
                    component="span"
                    sx={{
                      fontSize: 15,
                      fontWeight: 500,
                      lineHeight: 1.35,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {item.title}
                  </Typography>
                  <Typography component="span" variant="caption" color="text.secondary">
                    {item.note}
                  </Typography>
                </Box>
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
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{ display: 'flex', color: 'text.secondary' }}
                >
                  <AppIcon name="chevron" size={18} />
                </Box>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
