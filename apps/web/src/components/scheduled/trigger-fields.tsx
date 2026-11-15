'use client'

import {
  scheduleFrequencyHints,
  scheduleFrequencyLabels,
  scheduleWeekdays,
} from '@repo/domain/schedule'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import FormHelperText from '@mui/material/FormHelperText'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useId } from 'react'

import {
  onceDateFor,
  wallDateOf,
  type ScheduleFrequency,
  type TriggerDraft,
} from './schedule-model'
import { scheduleDialogTexts } from './schedule-texts'

const minutes = Array.from({ length: 60 }, (_, minute) => minute)
const monthDays = Array.from({ length: 31 }, (_, index) => index + 1)

const fieldSx = { flex: '1 1 140px', minWidth: 0 } as const

const visuallyHidden = {
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

/**
 * The seven days of «Еженедельно» (Зп8): buttons pressed or not, read by their full names; at
 * least one stays chosen — the window says so otherwise.
 */
function WeekdayButtons({
  days,
  onChange,
  describedBy,
}: {
  days: readonly number[]
  onChange: (days: number[]) => void
  describedBy?: string
}) {
  const labelId = useId()
  return (
    <Box sx={{ flex: '1 1 100%' }}>
      <Typography id={labelId} variant="body2" sx={{ mb: 0.75, color: 'text.secondary' }}>
        {scheduleDialogTexts.days}
      </Typography>
      <Box
        role="group"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        // Seven of 44 px in a row on a phone of 375 px.
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}
      >
        {scheduleWeekdays.map(({ day, name, short }) => {
          const pressed = days.includes(day)
          return (
            <ButtonBase
              key={day}
              aria-pressed={pressed}
              onClick={() =>
                onChange(
                  pressed
                    ? days.filter((each) => each !== day)
                    : [...days, day].sort((a, b) => a - b),
                )
              }
              sx={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                fontSize: 14,
                fontWeight: pressed ? 600 : 500,
                color: pressed ? 'primary.contrastText' : 'text.primary',
                bgcolor: pressed ? 'primary.main' : 'transparent',
                boxShadow: pressed ? 'none' : 'inset 0 0 0 1px var(--mui-palette-divider)',
                transition: 'background-color 150ms ease',
                '&:hover': { bgcolor: pressed ? 'primary.main' : 'action.hover' },
                '&.Mui-focusVisible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            >
              <span aria-hidden="true">{short}</span>
              <Box component="span" sx={visuallyHidden}>
                {name}
              </Box>
            </ButtonBase>
          )
        })}
      </Box>
    </Box>
  )
}

/**
 * One block of «Когда запускать» (Зп7, Зп8): the frequency and its fields — the time, the date of
 * «Один раз» from today, the minute of «Каждый час», the day of «Ежемесячно», the days of
 * «Еженедельно» —, a group of its own named «Время запуска N», with «Убрать» from the second.
 */
export function TriggerFields({
  draft,
  index,
  frequencies,
  timezone,
  now,
  error,
  removable,
  onChange,
  onRemove,
}: {
  draft: TriggerDraft
  /** From 1. */
  index: number
  frequencies: readonly ScheduleFrequency[]
  timezone: string
  now: Date
  /** What is wrong with this block; null — nothing. */
  error: string | null
  removable: boolean
  onChange: (draft: TriggerDraft) => void
  onRemove: () => void
}) {
  const errorId = useId()
  const hint = draft.frequency === 'manual' ? undefined : scheduleFrequencyHints[draft.frequency]
  const set = (change: Partial<TriggerDraft>) => onChange({ ...draft, ...change })
  const withTime = draft.frequency !== 'hourly' && draft.frequency !== 'manual'
  return (
    <Box
      role="group"
      aria-label={scheduleDialogTexts.schedule(index)}
      aria-describedby={error ? errorId : undefined}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5 }}>
        <TextField
          select
          size="small"
          label={scheduleDialogTexts.frequency}
          value={draft.frequency}
          onChange={(event) => {
            const frequency = event.target.value as ScheduleFrequency
            // «Один раз» starts on the next day the time comes, never in the past.
            set(
              frequency === 'once' && draft.frequency !== 'once'
                ? { frequency, date: onceDateFor(draft.time, timezone, now) }
                : { frequency },
            )
          }}
          helperText={hint}
          sx={{ flex: '1 1 200px', minWidth: 0 }}
        >
          {frequencies.map((frequency) => (
            <MenuItem key={frequency} value={frequency}>
              {scheduleFrequencyLabels[frequency]}
            </MenuItem>
          ))}
        </TextField>
        {draft.frequency === 'once' ? (
          <TextField
            type="date"
            size="small"
            label={scheduleDialogTexts.date}
            value={draft.date}
            onChange={(event) => set({ date: event.target.value })}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: wallDateOf(now, timezone) },
            }}
            sx={fieldSx}
          />
        ) : null}
        {draft.frequency === 'monthly' ? (
          <TextField
            select
            size="small"
            label={scheduleDialogTexts.dayOfMonth}
            value={draft.day}
            onChange={(event) => set({ day: Number(event.target.value) })}
            sx={fieldSx}
          >
            {monthDays.map((day) => (
              <MenuItem key={day} value={day}>
                {day}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        {draft.frequency === 'hourly' ? (
          <TextField
            select
            size="small"
            label={scheduleDialogTexts.minute}
            value={draft.minute}
            onChange={(event) => set({ minute: Number(event.target.value) })}
            slotProps={{
              select: { MenuProps: { slotProps: { paper: { sx: { maxHeight: 320 } } } } },
            }}
            sx={fieldSx}
          >
            {minutes.map((minute) => (
              <MenuItem key={minute} value={minute}>
                {scheduleDialogTexts.minuteOption(minute)}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        {withTime ? (
          <TextField
            type="time"
            size="small"
            label={scheduleDialogTexts.time}
            value={draft.time}
            onChange={(event) => {
              // A cleared field keeps the last time: a schedule always has one.
              if (event.target.value !== '') set({ time: event.target.value })
            }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 60 } }}
            sx={fieldSx}
          />
        ) : null}
        {removable ? (
          <Button
            onClick={onRemove}
            aria-label={scheduleDialogTexts.removeLabel(index)}
            sx={{ flex: 'none', minHeight: 40, color: 'text.secondary' }}
          >
            {scheduleDialogTexts.remove}
          </Button>
        ) : null}
      </Box>
      {draft.frequency === 'weekly' ? (
        <WeekdayButtons
          days={draft.days}
          onChange={(days) => set({ days })}
          describedBy={error ? errorId : undefined}
        />
      ) : null}
      {error ? (
        <FormHelperText id={errorId} error sx={{ mx: 0 }}>
          {error}
        </FormHelperText>
      ) : null}
    </Box>
  )
}
