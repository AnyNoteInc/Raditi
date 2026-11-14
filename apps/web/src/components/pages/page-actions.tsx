'use client'

import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { pageLimits } from '@repo/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { pageTexts, passwordTexts } from './page-labels'

/** What the actions of a page read of it: the row of `pages.list`. */
export interface PageActionsPage {
  pageId: string
  title: string
  url: string
  state: 'pending' | 'live' | 'taken_down'
  hasPassword: boolean
  takenDownBy: 'client' | 'operator' | null
  canManage: boolean
}

/** The mutations of a page; each reads the list again when it ends. */
export function usePageActions() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settled = () => void queryClient.invalidateQueries({ queryKey: trpc.pages.list.queryKey() })
  return {
    setPassword: useMutation(trpc.pages.setPassword.mutationOptions({ onSettled: settled })),
    takeDown: useMutation(trpc.pages.takeDown.mutationOptions({ onSettled: settled })),
    restore: useMutation(trpc.pages.restore.mutationOptions({ onSettled: settled })),
  }
}

/** The password of a page: set or changed by the owner or an administrator (Ст13). */
export function PagePasswordDialog({
  page,
  open,
  onClose,
}: {
  page: Pick<PageActionsPage, 'pageId' | 'title'>
  open: boolean
  onClose: () => void
}) {
  const { setPassword } = usePageActions()
  const [value, setValue] = useState('')
  const length = [...value].length
  const valid = length >= pageLimits.passwordMinChars && length <= pageLimits.passwordMaxChars
  // Nothing typed and no former failure outlives the dialog.
  function close() {
    setValue('')
    setPassword.reset()
    onClose()
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!valid || setPassword.isPending) return
    setPassword.mutate({ pageId: page.pageId, password: value }, { onSuccess: close })
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      aria-labelledby="page-password-title"
      fullWidth
      maxWidth="xs"
    >
      <form onSubmit={save} noValidate>
        <DialogTitle id="page-password-title">{passwordTexts.title}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            «{page.title}». {passwordTexts.lead}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            type="password"
            autoComplete="new-password"
            label={passwordTexts.label}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            helperText={
              setPassword.isError
                ? pageTexts.failed
                : passwordTexts.hint(pageLimits.passwordMinChars, pageLimits.passwordMaxChars)
            }
            error={setPassword.isError}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{passwordTexts.cancel}</Button>
          <Button type="submit" variant="contained" disabled={!valid || setPassword.isPending}>
            {passwordTexts.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/** Copies the address of a page; true — it was copied. */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

/** Copies the address of a page; says so for a moment, beside the button that did it. */
export function useCopyLink(url: string) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    setCopied(await copyLink(url))
    setTimeout(() => setCopied(false), 2000)
  }
  return { copied, copy }
}

type ActionId = 'copy' | 'password' | 'clearPassword' | 'takeDown' | 'restore'

/** What «⋯» offers for a page, in order: a member gets the link alone (Ст13–Ст15). */
export function pageActionsOf(page: PageActionsPage): ActionId[] {
  const live = page.state === 'live'
  return [
    ...(live ? (['copy'] as const) : []),
    ...(page.canManage && page.state !== 'pending' ? (['password'] as const) : []),
    ...(page.canManage && page.hasPassword ? (['clearPassword'] as const) : []),
    ...(page.canManage && live ? (['takeDown'] as const) : []),
    ...(page.canManage && page.state === 'taken_down' && page.takenDownBy === 'client'
      ? (['restore'] as const)
      : []),
  ]
}

/**
 * «⋯» of a page: the link, the password, taking it down and putting it back. No button when
 * there is nothing to offer; what came of an action — copied, or not done — is said beside the
 * list, not in the menu that closed.
 */
export function PageActionsMenu({ page }: { page: PageActionsPage }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const actions = usePageActions()
  const offered = pageActionsOf(page)
  if (offered.length === 0) return null
  const close = () => setAnchor(null)
  const failed = { onError: () => setNotice(pageTexts.failed) }
  const run: Record<ActionId, () => void> = {
    copy: () =>
      void copyLink(page.url).then((ok) => setNotice(ok ? pageTexts.copied : pageTexts.failed)),
    password: () => setPasswordOpen(true),
    clearPassword: () =>
      actions.setPassword.mutate({ pageId: page.pageId, password: null }, failed),
    takeDown: () => actions.takeDown.mutate({ pageId: page.pageId }, failed),
    restore: () => actions.restore.mutate({ pageId: page.pageId }, failed),
  }
  const label: Record<ActionId, string> = {
    copy: pageTexts.copy,
    password: page.hasPassword ? pageTexts.changePassword : pageTexts.setPassword,
    clearPassword: pageTexts.clearPassword,
    takeDown: pageTexts.takeDown,
    restore: pageTexts.restore,
  }
  return (
    <>
      <IconButton
        aria-label={pageTexts.more(page.title)}
        aria-haspopup="menu"
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ width: 40, height: 40, borderRadius: '10px', border: 1, borderColor: 'divider' }}
      >
        <AppIcon name="more" size={18} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {offered.map((id) => (
          <MenuItem
            key={id}
            sx={id === 'takeDown' ? { color: 'error.main' } : undefined}
            onClick={() => {
              run[id]()
              close()
            }}
          >
            {label[id]}
          </MenuItem>
        ))}
      </Menu>
      <PagePasswordDialog page={page} open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <Snackbar
        open={notice !== null}
        autoHideDuration={3000}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  )
}
