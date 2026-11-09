'use client'

import { fontFamilies } from '@repo/ui/theme/tokens'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { commandText } from './chat-texts'

// A command of the agent as Claude shows it (owner's request of 09.11.2026: «IN: — команда
// выполняемая, OUT: — вывод команды, который можно детализировать и посмотреть во всплывающем
// окне»): the command, the first lines of what it printed, and the whole of it in a window.

const mono = {
  fontFamily: fontFamilies.mono,
  fontSize: 13,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

/** Lines of the output the feed shows before «ещё N строк». */
export const COMMAND_PREVIEW_LINES = 3

export interface CommandEvent {
  command: string
  exitCode: number | null
  output?: string
  outputCut?: boolean
}

/** The lines of an output without the empty end a command usually prints. */
export function outputLines(output: string | undefined): string[] {
  if (output === undefined) return []
  const trimmed = output.replace(/\s+$/u, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

function Tag({ children }: { children: string }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        fontFamily: fontFamilies.mono,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        lineHeight: '20px',
        color: 'text.secondary',
        userSelect: 'none',
      }}
    >
      {children}
    </Box>
  )
}

/** The whole command and its output, in a window. */
function CommandWindow({
  event,
  open,
  onClose,
}: {
  event: CommandEvent
  open: boolean
  onClose: () => void
}) {
  const titleId = useId()
  const status = commandText.exit(event.exitCode)
  const failed = event.exitCode !== null && event.exitCode !== 0
  const lines = outputLines(event.output)
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby={titleId}>
      <DialogTitle
        id={titleId}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6, fontSize: 18 }}
      >
        <AppIcon name="terminal" size={18} />
        {commandText.title}
        {status ? (
          <Typography
            component="span"
            sx={{ fontSize: 14, color: failed ? 'error.main' : 'text.secondary' }}
          >
            · {status}
          </Typography>
        ) : null}
        <IconButton
          aria-label={commandText.close}
          onClick={onClose}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <AppIcon name="close" size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <Box sx={{ display: 'grid', gap: 0.75 }}>
          <Typography component="h3" sx={{ fontSize: 13, color: 'text.secondary' }}>
            {commandText.input}
          </Typography>
          <Box
            component="pre"
            sx={{ ...mono, m: 0, px: 1.5, py: 1, borderRadius: '8px', bgcolor: 'action.hover' }}
          >
            {event.command}
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gap: 0.75 }}>
          <Typography component="h3" sx={{ fontSize: 13, color: 'text.secondary' }}>
            {commandText.output}
          </Typography>
          {lines.length === 0 ? (
            <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
              {event.output === undefined ? commandText.noOutputKnown : commandText.noOutput}
            </Typography>
          ) : (
            <Box
              component="pre"
              tabIndex={0}
              sx={{
                ...mono,
                m: 0,
                px: 1.5,
                py: 1,
                borderRadius: '8px',
                bgcolor: 'action.hover',
                maxHeight: '60vh',
                overflow: 'auto',
              }}
            >
              {lines.join('\n')}
            </Box>
          )}
          {event.outputCut ? (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              {commandText.cut}
            </Typography>
          ) : null}
        </Box>
      </DialogContent>
    </Dialog>
  )
}

/** A command in «Ход работы»: IN — the command, OUT — the first lines of what it printed. */
export function CommandBlock({ event }: { event: CommandEvent }) {
  const [open, setOpen] = useState(false)
  const status = commandText.exit(event.exitCode)
  const failed = event.exitCode !== null && event.exitCode !== 0
  const lines = outputLines(event.output)
  const shown = lines.slice(0, COMMAND_PREVIEW_LINES)
  const rest = lines.length - shown.length
  return (
    <>
      <ButtonBase
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={commandText.open(event.command)}
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 1.5,
          rowGap: 0.5,
          alignItems: 'start',
          justifyItems: 'start',
          width: '100%',
          textAlign: 'left',
          px: 1.25,
          py: 0.75,
          borderRadius: '8px',
          bgcolor: 'action.hover',
          color: 'text.primary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.selected' },
          '&.Mui-focusVisible': {
            outline: '2px solid',
            outlineColor: 'text.primary',
            outlineOffset: 2,
          },
        }}
      >
        <Tag>IN</Tag>
        <Box sx={{ ...mono, display: 'flex', flexWrap: 'wrap', gap: '0 8px', minWidth: 0 }}>
          <span>{event.command}</span>
          {status ? (
            <Box
              component="span"
              sx={{
                fontFamily: 'inherit',
                color: failed ? 'error.main' : 'text.secondary',
                fontSize: 12,
              }}
            >
              · {status}
            </Box>
          ) : null}
        </Box>
        {shown.length > 0 ? (
          <>
            <Tag>OUT</Tag>
            <Box sx={{ ...mono, color: 'text.secondary', minWidth: 0 }}>
              {shown.join('\n')}
              {rest > 0 || event.outputCut ? (
                <Box
                  component="span"
                  sx={{ display: 'block', fontFamily: 'inherit', fontSize: 12 }}
                >
                  {rest > 0 ? commandText.moreLines(rest) : commandText.cutShort}
                </Box>
              ) : null}
            </Box>
          </>
        ) : null}
      </ButtonBase>
      <CommandWindow event={event} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
