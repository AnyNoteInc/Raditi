import Box from '@mui/material/Box'
import Link from 'next/link'

import { AppIcon } from '@/components/application/app-icon'

import { scheduledTaskHref } from './chat-address'
import { scheduleChatText } from './chat-texts'
import type { ChatScheduleLabel } from './chat-types'
import { offScreen } from './composer'

/** «По расписанию · Сводка курсов» of a chat of a run (docs/plan/82-scheduled-tasks.md, Зп43). */
export const scheduleLabelText = (schedule: ChatScheduleLabel): string =>
  `${scheduleChatText.trigger[schedule.trigger]} · ${schedule.name}`

/**
 * What the line under the name of a chat shows: «По расписанию» alone when the chat is named as
 * its task — the name stands right above it —, the name of the task too when the chat was renamed.
 */
export function scheduleMarkShown(schedule: ChatScheduleLabel, chatTitle?: string): string {
  return chatTitle !== undefined && chatTitle.trim() === schedule.name.trim()
    ? scheduleChatText.trigger[schedule.trigger]
    : scheduleLabelText(schedule)
}

/**
 * The line under the name of a chat of a run (Зп43): how the run began and the name of its task,
 * a link to the task while it is there; a deleted task leaves its name without one (Зп23). The
 * name of the task is not said twice: under a chat named as its task the line is «По расписанию»
 * or «Запуск вручную» alone, and the link keeps the whole label for a screen reader. One quiet
 * line of 13 px: under the name it keeps the head within its 44 px.
 */
export function ScheduleMark({
  schedule,
  chatTitle,
}: {
  schedule: ChatScheduleLabel
  /** The name of the chat above the line. */
  chatTitle?: string
}) {
  const text = scheduleMarkShown(schedule, chatTitle)
  const whole = scheduleLabelText(schedule)
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
      // The words shown start the name (WCAG 2.5.3); the task is named even when not shown.
      {...(text === whole ? {} : { 'aria-label': whole })}
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
