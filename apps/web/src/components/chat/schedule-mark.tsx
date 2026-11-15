import Box from '@mui/material/Box'
import Link from 'next/link'

import { AppIcon } from '@/components/application/app-icon'

import { scheduledTaskHref } from './chat-address'
import { scheduleChatText } from './chat-texts'
import type { ChatScheduleLabel } from './chat-types'
import { offScreen } from './composer'

/** «По расписанию · Заявки за сутки» of a chat of a run (docs/plan/82-scheduled-tasks.md, Зп43). */
export const scheduleLabelText = (schedule: ChatScheduleLabel): string =>
  `${scheduleChatText.trigger[schedule.trigger]} · ${schedule.name}`

/**
 * The line under the name of a chat of a run (Зп43): how the run began and the name of its task,
 * a link to the task while it is there; a deleted task leaves its name without one (Зп23). One
 * quiet line of 13 px: under the name it keeps the head within its 44 px.
 */
export function ScheduleMark({ schedule }: { schedule: ChatScheduleLabel }) {
  const text = scheduleLabelText(schedule)
  const common = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.75,
    maxWidth: '100%',
    minWidth: 0,
    fontSize: 13,
    lineHeight: 1.4,
    color: 'text.secondary',
  } as const
  const words = (
    <>
      <AppIcon name="timer" size={14} />
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {text}
      </Box>
    </>
  )
  if (schedule.id === null)
    return (
      <Box component="span" data-schedule-mark="" sx={{ ...common, whiteSpace: 'nowrap' }}>
        {words}
      </Box>
    )
  return (
    <Box
      component={Link}
      href={scheduledTaskHref(schedule.id)}
      data-schedule-mark=""
      sx={{
        ...common,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        borderRadius: '6px',
        '&:hover': { color: 'text.primary', textDecoration: 'underline' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {words}
    </Box>
  )
}

/**
 * The stopwatch of a row of the list of chats (Зп43): the chat is a run of a scheduled task. A
 * screen reader hears how it began.
 */
export function ScheduleSign({ schedule }: { schedule: ChatScheduleLabel }) {
  return (
    <Box
      component="span"
      data-schedule-sign=""
      sx={{ display: 'inline-flex', alignSelf: 'center', flex: 'none', color: 'text.secondary' }}
    >
      <AppIcon name="timer" size={14} />
      <Box component="span" sx={offScreen}>
        {scheduleChatText.listSign[schedule.trigger]}
      </Box>
    </Box>
  )
}
