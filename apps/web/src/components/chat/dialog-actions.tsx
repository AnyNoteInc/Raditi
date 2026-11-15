'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { callErrorText, isNotFound } from './call-error'
import { chatHref, CHATS_HREF } from './chat-address'
import { dialogMenuText } from './chat-texts'

// What the client does to a dialog as a whole (owner's request of 26.10.2026): renames it in
// place and deletes it, from its menu in the list or in its head.

/** The longest name `tasks.title` holds (`feedLimits.title`); the server checks it again. */
const TITLE_LIMIT = 120

/**
 * The key every read of the list of chats starts with — one list, the folders, each folder: a
 * change of a chat makes them all read again.
 */
export const dialogListKey = ['chat', 'dialogs'] as const

/**
 * «Закрепить» and «В архив» of a chat (ВВ21): the press, then every read of the list again. A
 * refusal is the list's own: it reads again and shows the chat as the server has it.
 */
export function usePinArchive() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const pin = useMutation(trpc.task.pin.mutationOptions())
  const archive = useMutation(trpc.task.archive.mutationOptions())
  const settle = () => void queryClient.invalidateQueries({ queryKey: dialogListKey })
  return {
    pin: (taskId: string, pinned: boolean) => pin.mutate({ taskId, pinned }, { onSettled: settle }),
    archive: (taskId: string, archived: boolean) =>
      archive.mutate({ taskId, archived }, { onSettled: settle }),
  }
}

/** «⋯» of a dialog: «Закрепить», «В архив», «Переименовать» and «Удалить». */
export function DialogMenuButton({
  title,
  onRename,
  onRemove,
  quiet = false,
  pin,
  archive,
}: {
  /** The name of the dialog, so the button says whose actions it opens. */
  title: string
  onRename: () => void
  onRemove: () => void
  /** «Закрепить» / «Открепить» (docs/plan/75, ВВ21); absent — not offered here. */
  pin?: { pinned: boolean; onToggle: () => void }
  /** «В архив» / «Из архива» (ВВ21); absent — not offered here. */
  archive?: { archived: boolean; onToggle: () => void }
  /** In a row of the list: seen on hover and focus of the row, or while the menu is open. */
  quiet?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuId = useId()
  const open = anchor !== null
  return (
    <>
      <IconButton
        aria-label={`${dialogMenuText.open}: ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-dialog-menu=""
        data-open={open ? '' : undefined}
        onClick={(event) => {
          // A button inside a row of links: the row is not followed.
          event.preventDefault()
          event.stopPropagation()
          setAnchor(event.currentTarget)
        }}
        sx={{
          // The pressing area of 44px on every width (DESIGN.md).
          width: 44,
          height: 44,
          flex: 'none',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          // Where a pointer can hover, the row shows it; a finger has it always.
          ...(quiet && {
            '@media (hover: hover)': { opacity: 0 },
            '&[data-open], &:focus-visible': { opacity: 1 },
          }),
        }}
      >
        <AppIcon name="more" size={20} />
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { borderRadius: '12px', minWidth: 200 } } }}
      >
        {/* The height of an item is given by breakpoint: MUI lets a menu item shrink to its
            content from `sm` up by a media query of its own, which wins over a plain value — an
            item stays 44px high, a finger's (DESIGN.md), on every width. */}
        {pin && !archive?.archived ? (
          <MenuItem
            onClick={() => {
              setAnchor(null)
              pin.onToggle()
            }}
            sx={{ minHeight: { xs: 44 }, fontSize: 14 }}
          >
            <ListItemIcon>
              <AppIcon name="pin" size={18} />
            </ListItemIcon>
            {pin.pinned ? dialogMenuText.unpin : dialogMenuText.pin}
          </MenuItem>
        ) : null}
        {archive ? (
          <MenuItem
            onClick={() => {
              setAnchor(null)
              archive.onToggle()
            }}
            sx={{ minHeight: { xs: 44 }, fontSize: 14 }}
          >
            <ListItemIcon>
              <AppIcon name="archive" size={18} />
            </ListItemIcon>
            {archive.archived ? dialogMenuText.unarchive : dialogMenuText.archive}
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onRename()
          }}
          sx={{ minHeight: { xs: 44 }, fontSize: 14 }}
        >
          <ListItemIcon>
            <AppIcon name="pencil" size={18} />
          </ListItemIcon>
          {dialogMenuText.rename}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onRemove()
          }}
          sx={{ minHeight: { xs: 44 }, fontSize: 14, color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <AppIcon name="trash" size={18} />
          </ListItemIcon>
          {dialogMenuText.remove}
        </MenuItem>
      </Menu>
    </>
  )
}

/**
 * The name of a dialog written in place of it: Enter or leaving the field saves it, Escape keeps
 * the old one. A refusal of the server stays under the field and the field stays open.
 */
export function RenameField({
  taskId,
  initial,
  onDone,
  fontSize = 14,
}: {
  taskId: string
  initial: string
  /** The field closes: with the new name the server took, or null — nothing changed. */
  onDone: (title: string | null) => void
  fontSize?: number
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rename = useMutation(trpc.task.rename.mutationOptions())
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const errorId = useId()
  // One save per edit: Enter and the blur that follows it do not send it twice.
  const saving = useRef(false)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  async function save() {
    if (saving.current) return
    const next = value.replace(/\s+/gu, ' ').trim()
    if (next === '' || next === initial) {
      onDone(null)
      return
    }
    saving.current = true
    setError(null)
    try {
      const saved = await rename.mutateAsync({ taskId, title: next })
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      onDone(saved.title)
    } catch (failure) {
      setError(callErrorText(failure))
      saving.current = false
      field.current?.focus()
    }
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      saving.current = true
      onDone(null)
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0, flex: '1 1 auto' }}>
      <Box
        component="input"
        ref={field}
        value={value}
        maxLength={TITLE_LIMIT}
        aria-label={dialogMenuText.name}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        disabled={rename.isPending}
        onChange={(event: { target: HTMLInputElement }) => setValue(event.target.value)}
        onKeyDown={keyDown}
        onBlur={() => void save()}
        sx={{
          width: '100%',
          minHeight: 36,
          px: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: '8px',
          bgcolor: 'background.paper',
          color: 'text.primary',
          font: 'inherit',
          fontSize,
          outline: 'none',
          '&:focus-visible': { borderColor: 'text.primary' },
        }}
      />
      {error !== null ? (
        <Typography id={errorId} role="alert" variant="body2" color="error.main" sx={{ px: 1 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * «Удалить чат?»: what the deletion leads to and two buttons. The deleted dialog leaves the list;
 * the page of it, when it is the one open, goes to the root of «Чаты». A dialog already gone (another
 * tab deleted it) counts as deleted.
 */
export function RemoveDialogConfirm({
  taskId,
  open,
  onClose,
  withSite,
  undoable = false,
}: {
  taskId: string
  open: boolean
  onClose: () => void
  /** The chat has a project; without one the words say nothing of a site. */
  withSite: boolean
  /** «Отменить выпуск» of the dialog is offered now: deleting it takes the button away too. */
  undoable?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const pathname = usePathname()
  const remove = useMutation(trpc.task.remove.mutationOptions())
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    try {
      await remove.mutateAsync({ taskId })
    } catch (failure) {
      if (!isNotFound(failure)) {
        setError(callErrorText(failure))
        return
      }
    }
    void queryClient.invalidateQueries({ queryKey: dialogListKey })
    // Credits the dialog held came back.
    void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
    onClose()
    if (pathname.toLowerCase() === chatHref(taskId).toLowerCase()) router.replace(CHATS_HREF)
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title={dialogMenuText.removeTitle}
      busy={remove.isPending}
      error={error}
      keepLabel={dialogMenuText.removeKeep}
      confirmLabel={dialogMenuText.removeConfirm}
      danger
      onConfirm={() => void confirm()}
    >
      <Typography sx={{ mt: 1.5 }}>{nbsp(dialogMenuText.removeBody(withSite))}</Typography>
      {undoable ? <Typography sx={{ mt: 1 }}>{nbsp(dialogMenuText.removeUndo)}</Typography> : null}
    </ConfirmDialog>
  )
}
