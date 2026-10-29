'use client'

import { attachmentAcceptAttribute } from '@repo/domain/attachments/rules'
import { attachmentHintText } from '@repo/domain/attachments/labels'
import { parseChatCommand, type ChatCommandId } from '@repo/domain/release/chat-commands'
import { feedInputText, feedTooLongText } from '@repo/domain/tasks/client-feed-labels'
import { FEED_REQUEST_TEXT_LIMIT, hasVisibleText } from '@repo/domain/tasks/client-feed-text'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { plural } from '@/lib/plural'

import { AttachmentChips } from './attachment-chips'
import { attachmentText, composerText, paletteText } from './chat-texts'
import type { CommandVerdict } from './chat-types'
import {
  CommandList,
  optionId,
  paletteKey,
  paletteOptions,
  type PaletteOption,
} from './command-palette'
import type { AttachmentsControl } from './use-attachments'

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

/** How far the drawn control stands in from its pressing area: 36px drawn by a finger, 32px. */
const ROUND = { touch: '4px', fine: '6px' } as const
const PILL = { touch: '4px 0', fine: '6px 0' } as const

/**
 * A control of the field's row, smaller to the eye than the cabinet's own (owner's request of
 * 29.10.2026): what is pressed stays 44px tall (DESIGN.md, «область нажатия — не меньше 44px»),
 * what is drawn — its fill, the hover, the ripple, the ring of the focus — is 32px where a
 * pointer aims and 36px where a finger presses, inside it. `drawn` is the fill at rest.
 */
export function fieldControl(drawn = 'transparent', inset: { touch: string; fine: string } = PILL) {
  const shape = { inset: inset.touch, '@media (pointer: fine)': { inset: inset.fine } }
  return {
    position: 'relative',
    isolation: 'isolate',
    height: 44,
    flex: 'none',
    bgcolor: 'transparent',
    '&::before': {
      content: '""',
      position: 'absolute',
      zIndex: -1,
      ...shape,
      borderRadius: '999px',
      bgcolor: drawn,
      transition: 'background-color var(--raditi-motion-fast) var(--raditi-ease-out)',
    },
    '&:hover': { bgcolor: 'transparent' },
    '& .MuiTouchRipple-root': { ...shape, borderRadius: '999px' },
    // The ring stands around what is drawn, not around the pressing area.
    '&&:focus-visible': { outline: 'none' },
    '&.Mui-focusVisible::before': {
      outline: '2px solid',
      outlineColor: 'primary.main',
      outlineOffset: '2px',
    },
  } as const
}

/** A quiet round button of the field's own row: no fill until the pointer is on it. */
const toolButton = {
  ...fieldControl('transparent', ROUND),
  width: 44,
  p: 0,
  color: 'text.secondary',
  '&:hover': { bgcolor: 'transparent', color: 'text.primary' },
  '&:hover::before': { bgcolor: 'action.hover' },
} as const

/**
 * The files a paste carries when the client meant files: a screenshot, a picture copied from a
 * page, files copied in the file manager (owner's request of 29.10.2026: a pasted file goes as if
 * it were chosen). A copy from a document — its text together with its rich copy, as office
 * programs give, often with a picture of the cells — stays text.
 */
export function pastedFiles(data: Pick<DataTransfer, 'files' | 'types'> | null): File[] {
  if (data === null || data.files.length === 0) return []
  const types = Array.from(data.types)
  if (types.includes('text/plain') && types.includes('text/html')) return []
  return Array.from(data.files)
}

/** The keys that paste, as this computer names them. */
function pasteKeys(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Mac|iPhone|iPad/.test(agent) ? '⌘V' : 'Ctrl+V'
}

export interface ComposerCommands {
  verdicts: readonly CommandVerdict[]
  /** A command was chosen: the server has said it can be run. */
  onRun: (id: ChatCommandId) => void
  /** The list was opened: the verdicts are read again. */
  onOpen?: () => void
  /**
   * The commands this dialog has at all; absent — every command of the chat. A task in the
   * browser has only `/cancel` (docs/plan/57-browser-tasks.md): no preview, release or undo.
   */
  listed?: readonly ChatCommandId[]
  /** Why a command the server gave no verdict on cannot be run here: on «Новый диалог». */
  closedReason?: string
}

/**
 * The field a client writes in, the same on «Новый диалог» and in a dialog that goes on (owner's
 * request of 29.10.2026). Its row holds, in this order, the window of commands — `/` at the start
 * of the empty field or its button opens it —, «+» with «Загрузить файл», «Размышление», and the
 * send button. A file pasted into the field is attached as if it were chosen. Enter in the field
 * is a new line; Ctrl+Enter or ⌘+Enter sends. A text that is a command alone runs the command and
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
  effort,
  attachments,
  noSecrets = feedInputText.noSecrets,
  fieldRef,
  stop,
}: {
  label?: string
  placeholder: string
  sendLabel?: string
  /**
   * Set while nothing can be written: the field and the button say why — read aloud with them,
   * not shown (owner's request of 26.10.2026: no standing words under the field).
   */
  disabledReason?: string | null
  /** Why the server refused the last try, as a sentence. */
  error?: string | null
  busy?: boolean
  /**
   * Sends the text and the ids of the attached files that are ready; resolves true when the
   * server took them, and the field and the files are cleared.
   */
  onSend: (text: string, attachmentIds: readonly string[]) => Promise<boolean>
  commands?: ComposerCommands
  /** «Размышление»: the menu of how hard the model thinks, after «+». */
  effort?: ReactNode
  /** The files of the message (docs/plan/57-browser-tasks.md, Б26); absent — no files here. */
  attachments?: AttachmentsControl
  /** The reminder about passwords: read aloud with the field, not shown under it. */
  noSecrets?: string
  fieldRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * While the agent works: «Остановить» stands in place of «Отправить», as `/cancel` does it.
   * `available` false — the dialog cannot be stopped now (a release, a stop on its way).
   */
  stop?: { onStop: () => void; available: boolean }
}) {
  const fieldId = useId()
  const reasonId = useId()
  const errorId = useId()
  const limitId = useId()
  const listId = useId()
  const filesWaitId = useId()
  const filesHintId = useId()
  const noFilesId = useId()
  const secretsId = useId()
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
  const fileInput = useRef<HTMLInputElement>(null)
  // «+»: the menu of what can be added to the message — for now a file from the computer.
  const addMenuId = useId()
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null)
  const ownField = useRef<HTMLTextAreaElement>(null)
  const field = fieldRef ?? ownField

  // The field grows with its text, up to its own limit (`maxHeight`), then scrolls.
  useLayoutEffect(() => {
    const area = field.current
    if (!area) return
    area.style.height = 'auto'
    if (area.scrollHeight > 0) area.style.height = `${area.scrollHeight}px`
  }, [text, field])

  const disabled = disabledReason !== null
  const tooLong = text.trim().length > FEED_REQUEST_TEXT_LIMIT
  // The message waits for its files: one on its way, or one that failed and is not dealt with.
  const filesWait = attachments?.uploading
    ? attachmentText.wait
    : attachments?.failed
      ? attachmentText.fix
      : null
  const typed = commands !== undefined && !dismissed && !forced && text.startsWith('/')
  const options: PaletteOption[] =
    commands === undefined
      ? []
      : forced
        ? paletteOptions(null, commands.verdicts, commands.listed, commands.closedReason)
        : typed && !disabled
          ? paletteOptions(text, commands.verdicts, commands.listed, commands.closedReason)
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
      const count = paletteOptions(
        next,
        commands.verdicts,
        commands.listed,
        commands.closedReason,
      ).length
      if (count > 0) announceOpened(count)
    }
  }

  async function send() {
    if (busy || disabled || tooLong || filesWait !== null || !hasVisibleText(text)) return
    // The words of a command are never sent: not to the agent, not as a message.
    const command = parseChatCommand(text)
    if (command !== null) {
      if (commands === undefined) {
        setNotice(composerText.commandsInDialog)
        return
      }
      const option = paletteOptions(
        null,
        commands.verdicts,
        commands.listed,
        commands.closedReason,
      ).find((item) => item.id === command)
      if (option?.available) choose(option)
      else setNotice(option?.reason ?? composerText.commandUnavailable)
      return
    }
    if (await onSend(text, attachments?.readyIds ?? [])) {
      setText('')
      attachments?.clear()
    }
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
    announceOpened(
      paletteOptions(null, commands.verdicts, commands.listed, commands.closedReason).length,
    )
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
  // The field carries the reminder about passwords too; the button does not repeat it.
  const fieldDescribedBy = [describedBy, secretsId].filter((id) => id !== '').join(' ')
  const sendDescribedBy = [describedBy, filesWait !== null ? filesWaitId : null]
    .filter((id) => id !== null && id !== '')
    .join(' ')
  const canSend = !busy && !disabled && !tooLong && filesWait === null && hasVisibleText(text)
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
          p: 1.25,
          // A soft fill and no frame (owner's brief of 26.10.2026).
          borderRadius: '28px',
          bgcolor: 'var(--mui-palette-action-hover)',
          transition: 'box-shadow var(--raditi-motion-fast) var(--raditi-ease-out)',
          // One calm ring for the whole field while it is written in, none around the text.
          '&:has(textarea:focus-visible)': {
            boxShadow: 'inset 0 0 0 1px rgba(var(--mui-palette-text-primaryChannel) / 0.24)',
          },
        }}
      >
        {attachments ? (
          <AttachmentChips
            items={attachments.items}
            onRetry={attachments.retry}
            onRemove={attachments.remove}
          />
        ) : null}
        <Box component="label" htmlFor={fieldId} sx={offScreen}>
          {label}
        </Box>
        <Box
          component="textarea"
          ref={field}
          id={fieldId}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={fieldDescribedBy}
          aria-invalid={tooLong || shownError !== null ? true : undefined}
          aria-autocomplete={commands ? 'list' : undefined}
          aria-controls={open && !forced ? listId : undefined}
          aria-activedescendant={
            open && !forced && current !== undefined ? optionId(listId, current.id) : undefined
          }
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={keyDown}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            if (!attachments) return
            const files = pastedFiles(event.clipboardData)
            if (files.length === 0) return
            event.preventDefault()
            attachments.add(files)
          }}
          sx={{
            display: 'block',
            width: '100%',
            minHeight: 44,
            maxHeight: { xs: '30dvh', md: '40dvh' },
            overflowY: 'auto',
            px: 1.25,
            py: 1,
            border: 0,
            borderRadius: 0,
            resize: 'none',
            bgcolor: 'transparent',
            color: 'text.primary',
            font: 'inherit',
            fontSize: 16,
            lineHeight: 1.65,
            outline: 'none',
            // Stronger than the ring of the page: the field above draws the only one.
            '&&:focus-visible': { outline: 'none' },
            '&::placeholder': { color: 'text.secondary', opacity: 1 },
            '&:disabled': { cursor: 'not-allowed' },
          }}
        />
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
        >
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
            {commands ? (
              <IconButton
                ref={buttonRef}
                aria-label={paletteText.open}
                aria-haspopup="listbox"
                aria-expanded={forced}
                aria-controls={forced ? listId : undefined}
                onClick={openByButton}
                sx={toolButton}
              >
                <AppIcon name="slash" size={18} />
              </IconButton>
            ) : null}
            <IconButton
              aria-label={composerText.add}
              aria-haspopup="menu"
              aria-expanded={addAnchor !== null}
              aria-controls={addAnchor !== null ? addMenuId : undefined}
              aria-describedby={attachments ? filesHintId : noFilesId}
              disabled={disabled || !attachments}
              onClick={(event) => setAddAnchor(event.currentTarget)}
              sx={toolButton}
            >
              <AppIcon name="plus" />
            </IconButton>
            {attachments ? (
              <>
                <Menu
                  id={addMenuId}
                  anchorEl={addAnchor}
                  open={addAnchor !== null}
                  onClose={() => setAddAnchor(null)}
                  anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
                  transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                  slotProps={{
                    paper: { sx: { borderRadius: '14px', minWidth: 240, mt: -1 } },
                    list: { 'aria-label': composerText.add },
                  }}
                >
                  <MenuItem
                    onClick={() => {
                      setAddAnchor(null)
                      fileInput.current?.click()
                    }}
                    sx={{ gap: 1.5, py: 1, alignItems: 'flex-start' }}
                  >
                    <Box component="span" sx={{ display: 'flex', mt: 0.25 }}>
                      <AppIcon name="attach" size={18} />
                    </Box>
                    <ListItemText
                      primary={attachmentText.upload}
                      secondary={attachmentText.pasteHint(pasteKeys())}
                      slotProps={{
                        primary: { sx: { fontSize: 14, fontWeight: 500 } },
                        secondary: { sx: { fontSize: 13 } },
                      }}
                    />
                  </MenuItem>
                </Menu>
                {/* The dialog of the system opens from the menu above: the input itself is hidden. */}
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={attachmentAcceptAttribute}
                  data-testid="composer-files"
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const chosen = event.target.files
                    if (chosen && chosen.length > 0) attachments.add(Array.from(chosen))
                    // The same file can be chosen again after it was taken out.
                    event.target.value = ''
                  }}
                />
              </>
            ) : null}
            {effort}
          </Box>
          {filesWait !== null ? (
            <Typography
              id={filesWaitId}
              variant="body2"
              color="text.secondary"
              sx={{ ml: 'auto', textAlign: 'right', fontSize: 13 }}
            >
              {filesWait}
            </Typography>
          ) : null}
          <IconButton
            aria-label={stop ? composerText.stop : sendLabel}
            aria-describedby={
              stop
                ? stop.available
                  ? undefined
                  : describedBy || undefined
                : sendDescribedBy || undefined
            }
            disabled={stop ? !stop.available : !canSend}
            onClick={() => (stop ? stop.onStop() : void send())}
            sx={{
              // The cabinet's main action: the accent fill, the arrow in its ink.
              ...fieldControl('var(--raditi-accent)', ROUND),
              width: 44,
              p: 0,
              border: 0,
              color: 'var(--raditi-on-accent)',
              transition:
                'opacity var(--raditi-motion-fast) var(--raditi-ease-out), transform var(--raditi-motion-press) var(--raditi-ease-out)',
              '&:hover::before': { bgcolor: 'var(--raditi-accent-hover)' },
              '&.Mui-disabled': { color: 'var(--mui-palette-action-disabled)', opacity: 0.22 },
              '&.Mui-disabled::before': {
                bgcolor: 'var(--mui-palette-action-disabledBackground)',
              },
              '&:active': { transform: 'scale(0.92)' },
              '@media (prefers-reduced-motion: reduce)': { '&:active': { transform: 'none' } },
            }}
          >
            <AppIcon name={stop ? 'square' : 'send'} size={18} />
          </IconButton>
        </Box>
      </Box>

      {disabled ? (
        <Box id={reasonId} sx={offScreen}>
          {disabledReason}
        </Box>
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
      {attachments?.notice ? (
        <Typography role="alert" variant="body2" color="error.main">
          {attachments.notice}
        </Typography>
      ) : null}
      {attachments ? (
        <Box id={filesHintId} sx={offScreen}>
          {attachmentHintText}
        </Box>
      ) : (
        // «+» is there and closed where the message takes no files: read aloud why.
        <Box id={noFilesId} sx={offScreen}>
          {attachmentText.none}
        </Box>
      )}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {announcement}
      </Box>
      <Box id={secretsId} sx={offScreen}>
        {noSecrets}.
      </Box>
    </Box>
  )
}
