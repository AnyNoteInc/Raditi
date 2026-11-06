'use client'

import {
  chatCommandGroupLabel,
  chatCommandIds,
  chatCommandRefusalText,
  chatCommands,
  matchChatCommands,
  type ChatCommandGroup,
  type ChatCommandId,
} from '@repo/domain/release/chat-commands'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useEffect, useId, useRef, type KeyboardEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { paletteText } from './chat-texts'
import type { CommandVerdict } from './chat-types'

// The window of commands (docs/plan/53-chat-preview-release.md, Р34; docs/plan/61-chats-first.md,
// §5.14): `/` at the start of an empty field opens a list of the chat's commands, by groups, with
// their Russian names. Which of the server's can be run is its verdict (`task.commands`); one that
// cannot is shown with the reason, and choosing it runs nothing. The commands of the page itself
// need no verdict. The words of a command never go to the agent.

export interface PaletteOption {
  id: ChatCommandId
  available: boolean
  /** Why the command cannot be run now, in the server's words; null when it can. */
  reason: string | null
}

/** What only a chat that has something to undo or to retry can offer: no row on a new chat. */
const AFTER_WORK: readonly ChatCommandId[] = ['undo', 'retry']

/**
 * The commands for what is typed: every command when the list was opened by its button, otherwise
 * those whose name or other word starts with the letters after `/`. A command of the server stands
 * here by its verdict, and a chat lists the verdicts `DialogView` hands over and no others
 * (docs/plan/61-chats-first.md, К27). A command of the page needs none. A place with `closedReason`
 * has no chat yet: it lists the server's commands with that reason, and those of the page that take
 * a chat; `plain` — the chat that starts there has no repository, so what it will not have is not
 * listed, for the reason would not be true of it.
 */
export function paletteOptions(
  typed: string | null,
  verdicts: readonly CommandVerdict[],
  /** Why a command cannot be run here, where no chat has given a verdict on it. */
  closedReason?: string,
  plain = false,
): PaletteOption[] {
  const ids = typed === null ? [...chatCommandIds] : matchChatCommands(typed)
  return ids.flatMap((id) => {
    const command = chatCommands[id]
    if (command.scope === 'client') {
      const closed = closedReason !== undefined && command.needs === 'session'
      return [{ id, available: !closed, reason: closed ? closedReason : null }]
    }
    const verdict = verdicts.find((item) => item.id === id)
    const unknownHere =
      closedReason === undefined ||
      AFTER_WORK.includes(id) ||
      (plain && command.needs === 'repository')
    if (verdict === undefined && unknownHere) return []
    const available = verdict?.available === true
    const refusal = verdict?.refusal ?? null
    return [
      {
        id,
        available,
        reason: available
          ? null
          : refusal !== null
            ? chatCommandRefusalText[refusal]
            : (closedReason ?? null),
      },
    ]
  })
}

/** What the composer measures: the room above the field, which the list must not leave. */
export const PALETTE_ROOM = '--raditi-palette-room'

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

/** The options of the list under the heads of their groups, the order kept. */
function groupsOf(options: readonly PaletteOption[]) {
  const groups: { group: ChatCommandGroup; items: { option: PaletteOption; index: number }[] }[] =
    []
  options.forEach((option, index) => {
    const { group } = chatCommands[option.id]
    const last = groups.at(-1)
    if (last?.group === group) last.items.push({ option, index })
    else groups.push({ group, items: [{ option, index }] })
  })
  return groups
}

/** The list itself: groups of options with their names, what they do or why they cannot be run. */
export function CommandList({
  listId,
  options,
  active,
  focusable,
  plain = false,
  onChoose,
  onHover,
  onKeyDown,
}: {
  listId: string
  options: readonly PaletteOption[]
  active: number
  /** The list takes the focus itself: it was opened by its button, not by typing. */
  focusable: boolean
  /** A chat without the repository: the commands that have other words for it use them. */
  plain?: boolean
  onChoose: (option: PaletteOption) => void
  onHover: (index: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}) {
  const current = options[active]
  const headId = useId()
  // The list is longer than its window: the option the arrows reach comes into sight.
  const activeRow = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // In braces: Chromium answers with a promise, which an effect must not return.
    activeRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
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
        // A field in the middle of the screen has less above it than the window has: what stays
        // out of sight above the window no scrolling brings back.
        maxHeight: `min(560px, 55dvh, var(${PALETTE_ROOM}, 560px))`,
        overflowY: 'auto',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        // A list over the dialog: one soft shadow lifts it, no more.
        boxShadow: '0 8px 24px -12px rgba(0, 0, 0, 0.18)',
        outline: 'none',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {groupsOf(options).map(({ group, items }) => (
        <Box key={group} role="group" aria-labelledby={`${headId}-${group}`}>
          <Typography
            id={`${headId}-${group}`}
            role="presentation"
            component="div"
            sx={{
              px: 1.25,
              pt: 1,
              pb: 0.25,
              fontSize: 12,
              fontWeight: 500,
              color: 'text.secondary',
            }}
          >
            {chatCommandGroupLabel[group]}
          </Typography>
          {items.map(({ option, index }) => {
            const command = chatCommands[option.id]
            const selected = index === active
            const description =
              plain && command.descriptionPlain !== undefined
                ? command.descriptionPlain
                : command.description
            return (
              <Box
                key={option.id}
                ref={selected ? activeRow : undefined}
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
                  gridTemplateColumns: '104px minmax(0, 1fr)',
                  columnGap: 1.5,
                  alignItems: 'baseline',
                  minHeight: 44,
                  px: 1.25,
                  py: 0.75,
                  // A row of a fractional height: the scroll stops on a whole pixel, and without
                  // this margin a part of a pixel of the last row stays outside the list.
                  scrollMarginBlock: '2px',
                  borderRadius: '10px',
                  cursor: option.available ? 'pointer' : 'not-allowed',
                  bgcolor: selected ? 'action.selected' : 'transparent',
                  color: option.available ? 'text.primary' : 'text.secondary',
                }}
              >
                <Typography
                  component="span"
                  aria-hidden="true"
                  sx={{ fontSize: 14, fontWeight: 500, display: 'flex', gap: 0.5 }}
                >
                  {command.slash}
                  {option.available ? null : (
                    <Box component="span" sx={{ alignSelf: 'center', display: 'flex' }}>
                      <AppIcon name="lock" size={13} />
                    </Box>
                  )}
                </Typography>
                <Box component="span" sx={{ minWidth: 0 }}>
                  <Box
                    component="span"
                    sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 8px' }}
                  >
                    <Typography component="span" sx={{ fontSize: 14 }}>
                      {command.label}
                    </Typography>
                    {option.available ? null : (
                      <Typography component="span" variant="caption" sx={{ fontWeight: 600 }}>
                        {paletteText.unavailable}
                      </Typography>
                    )}
                  </Box>
                  <Typography
                    component="span"
                    sx={{
                      display: 'block',
                      fontSize: 13,
                      color: 'text.secondary',
                      lineHeight: 1.4,
                    }}
                  >
                    {option.available ? description : (option.reason ?? description)}
                  </Typography>
                </Box>
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}
