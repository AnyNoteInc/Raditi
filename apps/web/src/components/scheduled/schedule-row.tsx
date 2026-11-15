'use client'

import { scheduledRunStateText, type ScheduledRunState } from '@repo/domain/schedule'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import NextLink from 'next/link'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'

import { ScheduleMoreMenu, ScheduleSwitch, type ScheduleActions } from './schedule-actions'
import { lastRunText, scheduleStateText, scheduleWords, type ScheduleItem } from './schedule-model'
import { scheduledTexts, scheduleRowTexts } from './schedule-texts'

type Tone = 'text.secondary' | 'text.primary' | 'error.main' | 'primary.main'

const runSign: Readonly<Record<ScheduledRunState['kind'], { icon: AppIconName; tone: Tone }>> =
  Object.freeze({
    pending: { icon: 'clock', tone: 'text.secondary' },
    running: { icon: 'clock', tone: 'text.secondary' },
    done: { icon: 'check', tone: 'text.primary' },
    waiting: { icon: 'chat', tone: 'primary.main' },
    ready: { icon: 'eye', tone: 'primary.main' },
    failed: { icon: 'warning', tone: 'error.main' },
    stopped: { icon: 'warning', tone: 'error.main' },
    chat_deleted: { icon: 'trash', tone: 'text.secondary' },
    refused: { icon: 'warning', tone: 'error.main' },
    skipped: { icon: 'forward', tone: 'text.secondary' },
  })

/** What came of a run: a sign and its words — the word is never the colour alone. */
export function RunStateMark({ state, text }: { state: ScheduledRunState; text?: string }) {
  const sign = runSign[state.kind]
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        color: sign.tone,
        minWidth: 0,
      }}
    >
      <Box component="span" aria-hidden sx={{ display: 'flex', flexShrink: 0 }}>
        <AppIcon name={sign.icon} size={15} />
      </Box>
      <Box component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {text ?? scheduledRunStateText(state)}
      </Box>
    </Box>
  )
}

/**
 * A task of «Ваши» (Зп5): its name — the link to its page —, its schedules in words and its
 * project; under them its state and its latest run; the switch and «⋯» on the right.
 */
export function ScheduleRow({
  item,
  now,
  actions,
  onEdit,
}: {
  item: ScheduleItem
  now: Date
  actions: ScheduleActions
  onEdit: (item: ScheduleItem, opener: HTMLElement | null) => void
}) {
  const lastRun = item.lastRun
  const lastText = lastRunText(item, now)
  const on = item.enabled
  return (
    <Box
      component="li"
      sx={{
        // The name and the controls on one line; what is said of the task under them, the whole
        // width on a phone, beside the icon from `sm`.
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', sm: '40px minmax(0, 1fr) auto' },
        columnGap: { xs: 1, sm: 2 },
        rowGap: 0.25,
        alignItems: 'start',
        px: { xs: 1.75, sm: 2.5 },
        py: 2,
        '& + &': { borderTop: 1, borderColor: 'divider' },
      }}
    >
      <Box
        aria-hidden
        sx={{
          display: { xs: 'none', sm: 'grid' },
          gridRow: '1 / span 2',
          placeItems: 'center',
          width: 40,
          height: 40,
          borderRadius: '12px',
          bgcolor: 'action.hover',
          color: on ? 'primary.main' : 'text.secondary',
        }}
      >
        <AppIcon name="timer" size={20} />
      </Box>
      <Typography
        component="h3"
        sx={{
          gridColumn: { xs: 1, sm: 2 },
          alignSelf: 'center',
          fontSize: 16,
          fontWeight: 600,
          lineHeight: 1.35,
          minWidth: 0,
        }}
      >
        <Link
          component={NextLink}
          href={`/scheduled/${item.id}`}
          color="inherit"
          underline="hover"
          sx={{ overflowWrap: 'anywhere' }}
        >
          {item.name}
        </Link>
      </Typography>
      <Box
        sx={{
          gridColumn: { xs: 2, sm: 3 },
          gridRow: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          my: -0.75,
          mr: -1,
        }}
      >
        <ScheduleSwitch task={item} actions={actions} />
        <ScheduleMoreMenu task={item} actions={actions} onEdit={(opener) => onEdit(item, opener)} />
      </Box>
      <Box sx={{ gridColumn: { xs: '1 / -1', sm: '2 / -1' }, minWidth: 0 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {nbsp(scheduleWords(item))}
          <Box component="span" aria-hidden sx={{ mx: 0.75 }}>
            ·
          </Box>
          {item.project?.name ?? scheduledTexts.noProject}
        </Typography>
        <Box
          sx={{
            mt: 1,
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: 2,
            rowGap: 0.5,
            fontSize: 14,
            lineHeight: 1.45,
          }}
        >
          <Box
            component="span"
            sx={{ color: on ? 'text.primary' : 'text.secondary', fontWeight: on ? 500 : 400 }}
          >
            {scheduleStateText(item, now)}
          </Box>
          {lastRun !== null && lastText !== null ? (
            <Box component="span" sx={{ display: 'inline-flex', minWidth: 0 }}>
              <Box component="span" sx={visuallyHiddenSx}>
                {`${scheduleRowTexts.lastRun}: `}
              </Box>
              <RunStateMark state={lastRun.state} text={lastText} />
            </Box>
          ) : (
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {scheduleRowTexts.noRuns}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

const visuallyHiddenSx = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
} as const
