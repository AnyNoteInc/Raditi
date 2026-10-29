'use client'

import { taskModeLabel } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Link from 'next/link'
import { useId } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { composerText } from './chat-texts'
import { offScreen } from './composer'

/** The mode of a dialog: «Чат» — without the files, in the cloud browser; «Работа» — on them. */
export type DialogMode = 'chat' | 'work'

const modes: readonly DialogMode[] = ['chat', 'work']

/**
 * «Чат | Работа» over the dialog, as ChatGPT has it (owner's request of 29.10.2026): one look on
 * «Новый диалог», where the mode is chosen, and in a dialog that goes on, where it is only shown.
 * A segment is pressed over 44px of height (DESIGN.md); the track and the marked segment are
 * drawn smaller inside: 38px and 32px.
 */
const track = {
  position: 'relative',
  isolation: 'isolate',
  display: 'inline-flex',
  gap: '2px',
  px: '3px',
  '&::before': {
    content: '""',
    position: 'absolute',
    zIndex: -1,
    inset: '3px 0',
    borderRadius: '999px',
    bgcolor: 'action.selected',
  },
} as const

function segment(current: boolean) {
  return {
    position: 'relative',
    isolation: 'isolate',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.75,
    minWidth: 92,
    height: 44,
    px: 2,
    borderRadius: '999px',
    fontSize: 14,
    fontWeight: current ? 500 : 400,
    color: current ? 'text.primary' : 'text.secondary',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    transition: 'color var(--raditi-motion-fast) var(--raditi-ease-out)',
    '&::before': {
      content: '""',
      position: 'absolute',
      zIndex: -1,
      inset: '6px 0',
      borderRadius: '999px',
      bgcolor: current ? 'background.paper' : 'transparent',
      boxShadow: current ? '0 1px 3px rgba(var(--mui-palette-text-primaryChannel) / 0.14)' : 'none',
      transition: 'background-color var(--raditi-motion-base) var(--raditi-ease-out)',
    },
  } as const
}

/**
 * The choice of the mode on «Новый диалог»: a group of radio buttons. A mode the site does not
 * offer cannot be chosen; the clock, not the colour, says so, and `describedBy` reads why.
 */
export function ModeChoice({
  value,
  onChange,
  closed = {},
  describedBy,
}: {
  value: DialogMode
  onChange: (mode: DialogMode) => void
  /** A mode that cannot be chosen: the id of the phrase that says why. */
  closed?: Partial<Record<DialogMode, string>>
  describedBy?: string
}) {
  const name = useId()
  return (
    <Box
      role="radiogroup"
      aria-label={composerText.modes}
      aria-describedby={describedBy}
      sx={track}
    >
      {modes.map((mode) => {
        const checked = mode === value
        const off = closed[mode] !== undefined
        return (
          <Box
            key={mode}
            component="label"
            sx={{
              ...segment(checked),
              opacity: off ? 0.6 : 1,
              cursor: off ? 'not-allowed' : 'pointer',
              '&:hover': off || checked ? undefined : { color: 'text.primary' },
              // The ring stands around what is drawn, not around the pressing area.
              '&:has(input:focus-visible)::before': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: '2px',
              },
            }}
          >
            <Box
              component="input"
              type="radio"
              name={name}
              value={mode}
              checked={checked}
              disabled={off}
              aria-describedby={closed[mode]}
              onChange={() => onChange(mode)}
              sx={offScreen}
            />
            {off ? <AppIcon name="clock" size={16} /> : null}
            {taskModeLabel[mode]}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The mode of a dialog that goes on, in the same switch: its own mode is marked, the other one
 * leads to «Новый диалог» in that mode — a started dialog keeps the mode it began in. A mode the
 * site does not offer is not a link: the clock says so, and why is read aloud.
 */
export function ModeLinks({
  value,
  newDialogHref,
  closed = {},
}: {
  value: DialogMode
  /** «Новый диалог» of the site, which the other mode opens. */
  newDialogHref: string
  /** A mode the site does not offer now: why, as a sentence. */
  closed?: Partial<Record<DialogMode, string>>
}) {
  const noteId = useId()
  const other = modes.find((mode) => mode !== value) ?? value
  const otherClosed = closed[other]
  return (
    <Box component="nav" aria-label={composerText.modes} sx={track}>
      {modes.map((mode) =>
        mode === value ? (
          <Box key={mode} component="span" aria-current="true" sx={segment(true)}>
            {taskModeLabel[mode]}
          </Box>
        ) : otherClosed !== undefined ? (
          <Box
            key={mode}
            component="span"
            aria-disabled="true"
            aria-describedby={noteId}
            sx={{ ...segment(false), opacity: 0.6, cursor: 'not-allowed' }}
          >
            <AppIcon name="clock" size={16} />
            {taskModeLabel[mode]}
          </Box>
        ) : (
          <Box
            key={mode}
            component={Link}
            href={`${newDialogHref}?mode=${mode}`}
            aria-describedby={noteId}
            sx={{
              ...segment(false),
              '&:hover': { color: 'text.primary' },
              '&&:focus-visible': { outline: 'none' },
              '&:focus-visible::before': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: '2px',
              },
            }}
          >
            {taskModeLabel[mode]}
          </Box>
        ),
      )}
      <Box id={noteId} sx={offScreen}>
        {otherClosed ?? composerText.otherMode(taskModeLabel[other])}
      </Box>
    </Box>
  )
}

/** The mode a «Новый диалог» was opened for by the switch of a dialog (`?mode=`); null — none. */
export function askedMode(value: string | null): DialogMode | null {
  return value === 'chat' || value === 'work' ? value : null
}
