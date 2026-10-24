'use client'

import {
  chatCommandIds,
  chatCommandRefusalText,
  chatCommands,
  matchChatCommands,
  type ChatCommandId,
} from '@repo/domain/release/chat-commands'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { KeyboardEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { paletteText } from './chat-texts'
import type { CommandVerdict } from './chat-types'

// The window of commands (docs/plan/53-chat-preview-release.md, Р34): `/` at the start of an
// empty field opens a list of the chat's commands with their Russian names. Which of them can be
// run is the server's verdict (`task.commands`); one that cannot is shown with the reason, and
// choosing it runs nothing. The words of a command never go to the agent.

export interface PaletteOption {
  id: ChatCommandId
  available: boolean
  /** Why the command cannot be run now, in the server's words; null when it can. */
  reason: string | null
}

/**
 * The commands for what is typed: every command when the list was opened by its button,
 * otherwise those whose name starts with the letters after `/`. A command the server gave no
 * verdict on is shown as one that cannot be run.
 */
export function paletteOptions(
  typed: string | null,
  verdicts: readonly CommandVerdict[],
  /** The commands this dialog has at all; absent — every command of the chat. */
  listed?: readonly ChatCommandId[],
): PaletteOption[] {
  const ids = (typed === null ? [...chatCommandIds] : matchChatCommands(typed)).filter(
    (id) => listed === undefined || listed.includes(id),
  )
  return ids.flatMap((id) => {
    // «Отменить выпуск» and «Попробовать ещё» are listed only with the server's verdict on them:
    // a dialog that installed nothing, or has no failure to retry, does not list them
    // (dialog-view.tsx). Any other command without a verdict is listed as one that cannot be run.
    if ((id === 'undo' || id === 'retry') && !verdicts.some((item) => item.id === id)) return []
    const verdict = verdicts.find((item) => item.id === id)
    const available = verdict?.available === true
    const refusal = verdict?.refusal ?? null
    return [
      {
        id,
        available,
        reason: available ? null : refusal === null ? null : chatCommandRefusalText[refusal],
      },
    ]
  })
}

/** The option the arrows lead to; the list wraps around at both ends. */
export function movedIndex(index: number, key: string, count: number): number {
  if (count === 0) return 0
  if (key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return index
}

/** The id of an option in the document: what `aria-activedescendant` names. */
export const optionId = (listId: string, id: ChatCommandId) => `${listId}-${id}`

/**
 * The keys of the list, wherever the focus stands — in the field, or on the list itself when its
 * button opened it. Returns true when the key was the list's.
 */
export function paletteKey(
  event: KeyboardEvent,
  state: { options: readonly PaletteOption[]; active: number },
  act: {
    move: (index: number) => void
    choose: (option: PaletteOption) => void
    close: () => void
  },
): boolean {
  const { options, active } = state
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'Home':
    case 'End':
      event.preventDefault()
      act.move(movedIndex(active, event.key, options.length))
      return true
    case 'Enter': {
      event.preventDefault()
      const option = options[active]
      if (option) act.choose(option)
      return true
    }
    case 'Escape':
      event.preventDefault()
      act.close()
      return true
    case 'Tab':
      act.close()
      return false
    default:
      return false
  }
}

/** The list itself: options with their names, what they do or why they cannot be run. */
export function CommandList({
  listId,
  options,
  active,
  focusable,
  onChoose,
  onHover,
  onKeyDown,
}: {
  listId: string
  options: readonly PaletteOption[]
  active: number
  /** The list takes the focus itself: it was opened by its button, not by typing. */
  focusable: boolean
  onChoose: (option: PaletteOption) => void
  onHover: (index: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}) {
  const current = options[active]
  return (
    <Box
      id={listId}
      role="listbox"
      aria-label={paletteText.label}
      tabIndex={focusable ? 0 : -1}
      aria-activedescendant={
        focusable && current !== undefined ? optionId(listId, current.id) : undefined
      }
      onKeyDown={onKeyDown}
      sx={{
        m: 0,
        p: 0.75,
        maxHeight: 340,
        overflowY: 'auto',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'var(--raditi-rule-strong)',
        borderRadius: '14px',
        boxShadow: 4,
        outline: 'none',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {options.map((option, index) => {
        const command = chatCommands[option.id]
        const selected = index === active
        return (
          <Box
            key={option.id}
            id={optionId(listId, option.id)}
            role="option"
            aria-selected={selected}
            aria-disabled={option.available ? undefined : true}
            // The field keeps the focus: a press must not take it away before the choice.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(option)}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              columnGap: 1.25,
              alignItems: 'start',
              minHeight: 44,
              px: 1.25,
              py: 1,
              borderRadius: '10px',
              cursor: option.available ? 'pointer' : 'not-allowed',
              bgcolor: selected ? 'action.selected' : 'transparent',
              color: option.available ? 'text.primary' : 'text.secondary',
            }}
          >
            <Box component="span" sx={{ display: 'flex', pt: '2px' }}>
              <AppIcon name={option.available ? 'slash' : 'lock'} size={18} />
            </Box>
            <Box component="span" sx={{ minWidth: 0 }}>
              <Box
                component="span"
                sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 8px' }}
              >
                <Typography component="span" sx={{ fontSize: 15, fontWeight: 600 }}>
                  {command.label}
                </Typography>
                <Typography
                  component="span"
                  aria-hidden="true"
                  sx={{ fontSize: 13, color: 'text.secondary' }}
                >
                  {command.slash}
                </Typography>
                {option.available ? null : (
                  <Typography component="span" variant="caption" sx={{ fontWeight: 600 }}>
                    {paletteText.unavailable}
                  </Typography>
                )}
              </Box>
              <Typography
                component="span"
                variant="body2"
                sx={{ display: 'block', color: 'text.secondary', lineHeight: 1.45 }}
              >
                {option.available ? command.description : (option.reason ?? command.description)}
              </Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
