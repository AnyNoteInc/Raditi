'use client'

import { parseChatCommand, type ChatCommandId } from '@repo/domain/release/chat-commands'
import { feedInputText, feedTooLongText } from '@repo/domain/tasks/client-feed-labels'
import { FEED_REQUEST_TEXT_LIMIT, hasVisibleText } from '@repo/domain/tasks/client-feed-text'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { plural } from '@/lib/plural'

import { composerText, paletteText } from './chat-texts'
import type { CommandVerdict } from './chat-types'
import {
  CommandList,
  optionId,
  paletteKey,
  paletteOptions,
  type PaletteOption,
} from './command-palette'

/** A native control that stays in the accessibility tree and off the screen. */
export const offScreen = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  border: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const

export interface ComposerCommands {
  verdicts: readonly CommandVerdict[]
  /** A command was chosen: the server has said it can be run. */
  onRun: (id: ChatCommandId) => void
  /** The list was opened: the verdicts are read again. */
  onOpen?: () => void
}

/**
 * The field a client writes in, with its send button and, in a dialog, the window of commands:
 * `/` at the start of the empty field — or the button beside it — opens it. Enter in the field is
 * a new line; Ctrl+Enter or ⌘+Enter sends. A text that is a command alone runs the command and
 * is never sent. The text stays in the field until the server has taken it.
 */
export function Composer({
  label = composerText.label,
  placeholder,
  sendLabel = composerText.send,
  disabledReason = null,
  error = null,
  busy = false,
  onSend,
  commands,
  modes,
  fieldRef,
}: {
  label?: string
  placeholder: string
  sendLabel?: string
  /** Set while nothing can be written: the field and the button say why. */
  disabledReason?: string | null
  /** Why the server refused the last try, as a sentence. */
  error?: string | null
  busy?: boolean
  /** Sends the text; resolves true when the server took it and the field is cleared. */
  onSend: (text: string) => Promise<boolean>
  commands?: ComposerCommands
  /** The switch of the mode, on a new dialog. */
  modes?: ReactNode
  fieldRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const fieldId = useId()
  const reasonId = useId()
  const errorId = useId()
  const limitId = useId()
  const listId = useId()
  const [text, setText] = useState('')
  // The list closed by Escape stays closed until the field starts anew.
  const [dismissed, setDismissed] = useState(false)
  // Opened by its button: every command, the focus on the list.
  const [forced, setForced] = useState(false)
  const [active, setActive] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  // What the field itself says of the last try: a command where commands do not work, or one
  // the server does not allow now. Gone with the next change of the text.
  const [notice, setNotice] = useState<string | null>(null)
  const shownError = notice ?? error
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const ownField = useRef<HTMLTextAreaElement>(null)
  const field = fieldRef ?? ownField

  const disabled = disabledReason !== null
  const tooLong = text.trim().length > FEED_REQUEST_TEXT_LIMIT
  const typed = commands !== undefined && !dismissed && !forced && text.startsWith('/')
  const options: PaletteOption[] =
    commands === undefined
      ? []
      : forced
        ? paletteOptions(null, commands.verdicts)
        : typed && !disabled
          ? paletteOptions(text, commands.verdicts)
          : []
  const open = options.length > 0
  const activeIndex = Math.min(active, Math.max(0, options.length - 1))

  function announceOpened(count: number) {
    setAnnouncement(paletteText.opened(count, plural(count, 'команда', 'команды', 'команд')))
    commands?.onOpen?.()
  }

  function close(returnFocus: boolean) {
    const wasForced = forced
    setForced(false)
    setDismissed(true)
    setActive(0)
    if (returnFocus) (wasForced ? buttonRef.current : field.current)?.focus()
  }

  function choose(option: PaletteOption) {
    if (!option.available) {
      setAnnouncement(option.reason ?? paletteText.unavailable)
      return
    }
    // Opened by its button, the list hands the focus back before it goes — to the field, or to
    // the button while nothing can be written — so a window the command opens returns it there.
    if (forced) (disabled ? buttonRef.current : field.current)?.focus()
    // The words of a command go; a draft the button opened the list over stays.
    if (!forced || text.startsWith('/')) setText('')
    setNotice(null)
    setDismissed(false)
    setForced(false)
    setActive(0)
    commands?.onRun(option.id)
  }

  function changeText(next: string) {
    const wasClosed = !open
    setNotice(null)
    setText(next)
    if (!next.startsWith('/')) setDismissed(false)
    setActive(0)
    if (commands && wasClosed && !disabled && next.startsWith('/') && !dismissed) {
      const count = paletteOptions(next, commands.verdicts).length
      if (count > 0) announceOpened(count)
    }
  }

  async function send() {
    if (busy || disabled || tooLong || !hasVisibleText(text)) return
    // The words of a command are never sent: not to the agent, not as a message.
    const command = parseChatCommand(text)
    if (command !== null) {
      if (commands === undefined) {
        setNotice(composerText.commandsInDialog)
        return
      }
      const option = paletteOptions(null, commands.verdicts).find((item) => item.id === command)
      if (option?.available) choose(option)
      else setNotice(option?.reason ?? composerText.commandUnavailable)
      return
    }
    if (await onSend(text)) setText('')
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      open &&
      paletteKey(
        event,
        { options, active: activeIndex },
        {
          move: setActive,
          choose,
          close: () => close(true),
        },
      )
    )
      return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    }
  }

  function openByButton() {
    if (!commands) return
    if (forced) {
      close(true)
      return
    }
    setForced(true)
    setActive(0)
    announceOpened(paletteOptions(null, commands.verdicts).length)
    // The list is in the document after this render: then it takes the focus.
    window.setTimeout(
      () => listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus(),
      0,
    )
  }

  const describedBy = [
    disabled ? reasonId : null,
    shownError ? errorId : null,
    tooLong ? limitId : null,
  ]
    .filter((id) => id !== null)
    .join(' ')
  const canSend = !busy && !disabled && !tooLong && hasVisibleText(text)
  const current = options[activeIndex]

  return (
    <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {open ? (
        <Box
          ref={listRef}
          sx={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', zIndex: 3 }}
          onBlur={(event) => {
            // Opened by its button, the list closes when the focus leaves it.
            if (forced && !event.currentTarget.contains(event.relatedTarget as Node | null))
              close(false)
          }}
        >
          <CommandList
            listId={listId}
            options={options}
            active={activeIndex}
            focusable={forced}
            onChoose={choose}
            onHover={setActive}
            onKeyDown={forced ? keyDown : undefined}
          />
        </Box>
      ) : null}

      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          p: 1,
          border: 1,
          // The edge of the field: the divider is too faint to mark a control.
          borderColor: 'var(--raditi-rule-strong)',
          borderRadius: '22px',
          bgcolor: 'background.default',
          '&:has(textarea:focus-visible)': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <Box component="label" htmlFor={fieldId} sx={offScreen}>
          {label}
        </Box>
        <Box
          component="textarea"
          ref={field}
          id={fieldId}
          rows={2}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={describedBy || undefined}
          aria-invalid={tooLong || shownError !== null ? true : undefined}
          aria-autocomplete={commands ? 'list' : undefined}
          aria-controls={open && !forced ? listId : undefined}
          aria-activedescendant={
            open && !forced && current !== undefined ? optionId(listId, current.id) : undefined
          }
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={keyDown}
          sx={{
            display: 'block',
            width: '100%',
            minHeight: 44,
            maxHeight: '40dvh',
            px: 1.5,
            py: 1.25,
            border: 0,
            borderRadius: '14px',
            resize: 'none',
            bgcolor: 'transparent',
            color: 'text.primary',
            font: 'inherit',
            outline: 'none',
            '&::placeholder': { color: 'text.secondary', opacity: 1 },
            '&:disabled': { cursor: 'not-allowed' },
          }}
        />
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {modes}
            {commands ? (
              <IconButton
                ref={buttonRef}
                aria-label={paletteText.open}
                aria-haspopup="listbox"
                aria-expanded={forced}
                aria-controls={forced ? listId : undefined}
                onClick={openByButton}
                sx={{ width: 44, height: 44, flex: 'none', border: 1, borderColor: 'divider' }}
              >
                <AppIcon name="slash" />
              </IconButton>
            ) : null}
          </Box>
          <IconButton
            aria-label={sendLabel}
            aria-describedby={describedBy || undefined}
            disabled={!canSend}
            onClick={() => void send()}
            sx={{
              width: 44,
              height: 44,
              flex: 'none',
              border: 1,
              borderColor: canSend ? 'transparent' : 'divider',
              bgcolor: canSend ? 'var(--raditi-accent)' : 'transparent',
              color: canSend ? 'var(--raditi-on-accent)' : undefined,
              '&:hover': { bgcolor: canSend ? 'var(--raditi-accent-hover)' : undefined },
            }}
          >
            <AppIcon name="send" />
          </IconButton>
        </Box>
      </Box>

      {disabled ? (
        <Typography
          id={reasonId}
          variant="body2"
          color="text.secondary"
          sx={{ textAlign: 'center' }}
        >
          {disabledReason}
        </Typography>
      ) : null}
      {tooLong ? (
        <Typography id={limitId} role="alert" variant="body2" color="error.main">
          {feedTooLongText(FEED_REQUEST_TEXT_LIMIT)}
        </Typography>
      ) : null}
      {shownError ? (
        <Typography id={errorId} role="alert" variant="body2" color="error.main">
          {shownError}
        </Typography>
      ) : null}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {announcement}
      </Box>
      <Box sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center', lineHeight: 1.5 }}>
        <Box component="p" sx={{ m: 0 }}>
          {feedInputText.mistakes}
        </Box>
        <Box component="p" sx={{ m: 0 }}>
          {feedInputText.noSecrets}.
        </Box>
      </Box>
    </Box>
  )
}
