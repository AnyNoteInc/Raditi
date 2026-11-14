'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { pageLimits } from '@repo/domain'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isTRPCClientError } from '@trpc/client'
import { useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import {
  fileTexts,
  nameTexts,
  pageTexts,
  passwordTexts,
  trashTexts,
  treeTexts,
} from './page-labels'

/** What the actions of a page read of it: the row of `pages.list`. */
export interface PageActionsPage {
  pageId: string
  title: string
  url: string
  state: 'pending' | 'live' | 'taken_down'
  hasPassword: boolean
  takenDownBy: 'client' | 'operator' | null
  /** In the trash (docs/plan/73-pages-sites.md, Дер2); null — not deleted. */
  trash: { deletedAt: string; purgeAfter: string } | null
  canManage: boolean
  /** Its site and its place in it (Дер11, Дер12); none — a card that knows no site. */
  treeId?: string
  parentId?: string | null
  path?: string
  position?: number
  /** The own name of its site, and whether its tariff gives names (Дер32). */
  name?: string | null
  namesAllowed?: boolean
}

/**
 * What a refusal says to the client: the server's words for a refusal of the domain — Russian, by
 * `@repo/trpc` errors —, «try again» for anything else (the network, a fault of the platform).
 */
export const messageOf = (error: unknown): string =>
  isTRPCClientError<AppRouter>(error) && error.data?.domainCode && error.message
    ? error.message
    : pageTexts.failed

/** The mutations of a page; each reads the list again when it ends. */
export function usePageActions() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settled = () => void queryClient.invalidateQueries({ queryKey: trpc.pages.list.queryKey() })
  return {
    setPassword: useMutation(trpc.pages.setPassword.mutationOptions({ onSettled: settled })),
    takeDown: useMutation(trpc.pages.takeDown.mutationOptions({ onSettled: settled })),
    restore: useMutation(trpc.pages.restore.mutationOptions({ onSettled: settled })),
    remove: useMutation(trpc.pages.delete.mutationOptions({ onSettled: settled })),
    returnDeleted: useMutation(trpc.pages.returnDeleted.mutationOptions({ onSettled: settled })),
    purge: useMutation(trpc.pages.purge.mutationOptions({ onSettled: settled })),
    update: useMutation(trpc.pages.update.mutationOptions({ onSettled: settled })),
    setName: useMutation(trpc.pages.setName.mutationOptions({ onSettled: settled })),
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

type ActionId =
  | 'copy'
  | 'password'
  | 'clearPassword'
  | 'takeDown'
  | 'restore'
  | 'delete'
  | 'returnDeleted'
  | 'purge'
  | 'rename'
  | 'readdress'
  | 'move'
  | 'up'
  | 'down'
  | 'name'
  | 'files'

/**
 * What «⋯» offers for a page, in order: a member gets the link alone (Ст13–Ст15). A page in the
 * trash offers only to return it or purge it; one the support took down is not deleted
 * (docs/plan/73-pages-sites.md, Дер3).
 */
export function pageActionsOf(
  page: PageActionsPage,
  options: { purge?: boolean; siblings?: number } = {},
): ActionId[] {
  const byOperator = page.state === 'taken_down' && page.takenDownBy === 'operator'
  if (page.trash !== null)
    return page.canManage
      ? ['returnDeleted', ...(options.purge !== false && !byOperator ? (['purge'] as const) : [])]
      : []
  const live = page.state === 'live'
  // The password is the site's (Дер17): set at its home page; a page of a site has the site's.
  const home = page.parentId === undefined || page.parentId === null
  const manage = page.canManage && !byOperator
  const place = manage && !home && page.treeId !== undefined
  return [
    ...(live ? (['copy'] as const) : []),
    ...(manage && page.treeId !== undefined ? (['rename'] as const) : []),
    ...(place ? (['readdress', 'move'] as const) : []),
    ...(place && (options.siblings ?? 0) > 1 ? (['up', 'down'] as const) : []),
    ...(manage && home && page.treeId !== undefined ? (['name'] as const) : []),
    ...(manage && home && page.treeId !== undefined ? (['files'] as const) : []),
    ...(page.canManage && home && page.state !== 'pending' ? (['password'] as const) : []),
    ...(page.canManage && home && page.hasPassword ? (['clearPassword'] as const) : []),
    ...(page.canManage && live ? (['takeDown'] as const) : []),
    ...(page.canManage && page.state === 'taken_down' && page.takenDownBy === 'client'
      ? (['restore'] as const)
      : []),
    ...(page.canManage && !byOperator ? (['delete'] as const) : []),
  ]
}

/** The confirmation of «Удалить…» and of «Удалить навсегда…» (§7.3). */
export function PageDeleteDialog({
  page,
  forever,
  below = 0,
  open,
  pending,
  onConfirm,
  onClose,
}: {
  page: Pick<PageActionsPage, 'title'>
  forever: boolean
  /** The pages below it that go with it. */
  below?: number
  open: boolean
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const id = forever ? 'page-purge-title' : 'page-delete-title'
  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={id} fullWidth maxWidth="xs">
      <DialogTitle id={id} sx={{ overflowWrap: 'anywhere' }}>
        {forever
          ? trashTexts.purgeTitle(page.title, below)
          : trashTexts.confirmTitle(page.title, below)}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {forever ? trashTexts.purgeText(below) : trashTexts.confirmText(pageLimits.trashDays)}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{trashTexts.cancel}</Button>
        <Button variant="contained" color="error" disabled={pending} onClick={onConfirm}>
          {forever ? trashTexts.purgeConfirm : trashTexts.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** The address a page gets by its segment under the page it is in. */
function addressOf(page: PageActionsPage, parentPath: string, segment: string): string {
  const origin = new URL(page.url).origin
  return `${origin}${parentPath === '/' ? '' : parentPath}/${segment}`
}

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * «Переименовать…», «Изменить адрес…» and «Переместить…» of a page of a site
 * (docs/plan/73-pages-sites.md, Дер30, §7.4): one field each; the address shows what it becomes,
 * and that the old one will lead to the new.
 */
export function PagePlaceDialog({
  page,
  kind,
  nodes,
  open,
  onClose,
  onNotice,
}: {
  page: PageActionsPage
  kind: 'rename' | 'readdress' | 'move'
  /** The pages of its site, to put it under one. */
  nodes: readonly PageActionsPage[]
  open: boolean
  onClose: () => void
  onNotice: (notice: PageNotice) => void
}) {
  const { update } = usePageActions()
  const path = page.path ?? '/'
  const parentPath = path.slice(0, path.lastIndexOf('/')) || '/'
  const segment = path.slice(path.lastIndexOf('/') + 1)
  const [title, setTitle] = useState(page.title)
  const [newSegment, setSegment] = useState(segment)
  // Not under itself or a page below it.
  const parents = nodes.filter(
    (node) =>
      node.trash === null &&
      node.path !== undefined &&
      node.path !== path &&
      !node.path.startsWith(`${path}/`),
  )
  const [parentId, setParentId] = useState(page.parentId ?? '')
  const parent = parents.find((node) => node.pageId === parentId)
  const valid =
    kind === 'rename'
      ? title.trim() !== '' && [...title.trim()].length <= pageLimits.titleChars
      : kind === 'readdress'
        ? SEGMENT.test(newSegment)
        : parent !== undefined
  function save(event: FormEvent) {
    event.preventDefault()
    if (!valid || update.isPending) return
    update.mutate(
      {
        pageId: page.pageId,
        ...(kind === 'rename' ? { title: title.trim() } : {}),
        ...(kind === 'readdress' ? { segment: newSegment } : {}),
        ...(kind === 'move' ? { parentId } : {}),
      },
      {
        onSuccess: () => {
          onClose()
          onNotice({ text: treeTexts.saved })
        },
        onError: (error) => onNotice({ text: messageOf(error) }),
      },
    )
  }
  const id = `page-${kind}-title`
  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={id} fullWidth maxWidth="xs">
      <form onSubmit={save} noValidate>
        <DialogTitle id={id} sx={{ overflowWrap: 'anywhere' }}>
          {treeTexts.dialogTitle[kind](page.title)}
        </DialogTitle>
        <DialogContent>
          {kind === 'rename' && (
            <TextField
              autoFocus
              fullWidth
              label={treeTexts.titleLabel}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              slotProps={{ htmlInput: { maxLength: pageLimits.titleChars } }}
              sx={{ mt: 1 }}
            />
          )}
          {kind === 'readdress' && (
            <>
              <TextField
                autoFocus
                fullWidth
                label={treeTexts.segmentLabel}
                value={newSegment}
                onChange={(event) => setSegment(event.target.value.toLowerCase())}
                error={!SEGMENT.test(newSegment)}
                helperText={treeTexts.segmentHint}
                slotProps={{ htmlInput: { maxLength: 63, spellCheck: false } }}
                sx={{ mt: 1 }}
              />
              <Typography
                variant="body2"
                sx={{
                  mt: 1.5,
                  color: 'text.secondary',
                  fontFamily: 'var(--font-jetbrains), monospace',
                  overflowWrap: 'anywhere',
                }}
              >
                {addressOf(page, parentPath, SEGMENT.test(newSegment) ? newSegment : segment)}
              </Typography>
            </>
          )}
          {kind === 'move' && (
            <TextField
              select
              fullWidth
              label={treeTexts.parentLabel}
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              sx={{ mt: 1 }}
            >
              {parents.map((node) => (
                <MenuItem key={node.pageId} value={node.pageId} sx={{ whiteSpace: 'normal' }}>
                  {node.title} · {node.path}
                </MenuItem>
              ))}
            </TextField>
          )}
          {kind !== 'rename' && (
            <Typography variant="body2" sx={{ mt: 1.5, color: 'text.secondary' }}>
              {treeTexts.redirectNote}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{passwordTexts.cancel}</Button>
          <Button type="submit" variant="contained" disabled={!valid || update.isPending}>
            {passwordTexts.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * «Файлы сайта» (docs/plan/73-pages-sites.md, Дер34): the shared files its pages load from its
 * host — CSS, scripts, pictures, fonts — with their addresses; the owner or an administrator
 * deletes one. The agent puts them: ask it in a chat.
 */
export function PageFilesDialog({
  page,
  open,
  onClose,
  onNotice,
}: {
  page: PageActionsPage
  open: boolean
  onClose: () => void
  onNotice: (notice: PageNotice) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const files = useQuery(trpc.pages.files.queryOptions({ pageId: page.pageId }))
  const remove = useMutation(
    trpc.pages.deleteFile.mutationOptions({
      onSettled: () =>
        void queryClient.invalidateQueries({
          queryKey: trpc.pages.files.queryKey({ pageId: page.pageId }),
        }),
    }),
  )
  const origin = new URL(page.url).origin
  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby="page-files-title"
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle id="page-files-title" sx={{ overflowWrap: 'anywhere' }}>
        {fileTexts.title(page.title)}
      </DialogTitle>
      <DialogContent>
        {files.isPending ? (
          <Typography variant="body2">{fileTexts.loading}</Typography>
        ) : files.isError ? (
          <Typography variant="body2" role="alert">
            {pageTexts.failed}
          </Typography>
        ) : files.data.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {fileTexts.empty}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {files.data.map((file) => (
              <Box
                component="li"
                key={file.path}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  py: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Link
                    href={`${origin}${file.path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                    sx={{
                      fontFamily: 'var(--font-jetbrains), monospace',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {file.path}
                  </Link>
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                    {fileTexts.size(file.sizeBytes)}
                  </Typography>
                </Box>
                {page.canManage && (
                  <Button
                    size="small"
                    color="error"
                    disabled={remove.isPending}
                    aria-label={fileTexts.deleteLabel(file.path)}
                    onClick={() =>
                      remove.mutate(
                        { pageId: page.pageId, path: file.path },
                        {
                          onSuccess: () => onNotice({ text: fileTexts.deleted }),
                          onError: (error) => onNotice({ text: messageOf(error) }),
                        },
                      )
                    }
                  >
                    {fileTexts.delete}
                  </Button>
                )}
              </Box>
            ))}
          </Box>
        )}
        <Typography variant="body2" sx={{ mt: 2, color: 'text.secondary' }}>
          {fileTexts.note}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{fileTexts.close}</Button>
      </DialogActions>
    </Dialog>
  )
}

const NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,23}[a-z0-9]$/

/**
 * «Адрес сайта…» (docs/plan/73-pages-sites.md, Дер32): the own name of a site on «Бизнес» and
 * above, the address it becomes, and that a readable address is easy to guess. On another
 * tariff — where the names are.
 */
export function PageNameDialog({
  page,
  open,
  onClose,
  onNotice,
}: {
  page: PageActionsPage
  open: boolean
  onClose: () => void
  onNotice: (notice: PageNotice) => void
}) {
  const { setName } = usePageActions()
  const [name, setValue] = useState(page.name ?? '')
  const url = new URL(page.url)
  const base = url.host.slice(url.host.indexOf('.') + 1)
  const valid = NAME.test(name) && name !== page.name
  function save(event: FormEvent) {
    event.preventDefault()
    if (!valid || setName.isPending) return
    setName.mutate(
      { pageId: page.pageId, name },
      {
        onSuccess: () => {
          onClose()
          onNotice({ text: nameTexts.saved })
        },
        onError: (error) => onNotice({ text: messageOf(error) }),
      },
    )
  }
  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="page-name-title" fullWidth maxWidth="xs">
      <form onSubmit={save} noValidate>
        <DialogTitle id="page-name-title" sx={{ overflowWrap: 'anywhere' }}>
          {nameTexts.title(page.title)}
        </DialogTitle>
        <DialogContent>
          {page.namesAllowed ? (
            <>
              <TextField
                autoFocus
                fullWidth
                label={nameTexts.label}
                value={name}
                onChange={(event) => setValue(event.target.value.toLowerCase())}
                error={name !== '' && !NAME.test(name)}
                helperText={nameTexts.hint}
                slotProps={{ htmlInput: { maxLength: 25, spellCheck: false } }}
                sx={{ mt: 1 }}
              />
              <Typography
                variant="body2"
                sx={{
                  mt: 1.5,
                  color: 'text.secondary',
                  fontFamily: 'var(--font-jetbrains), monospace',
                  overflowWrap: 'anywhere',
                }}
              >
                {`${url.protocol}//${NAME.test(name) ? name : nameTexts.placeholder}.${base}/`}
              </Typography>
              <Typography variant="body2" sx={{ mt: 1.5, color: 'text.secondary' }}>
                {nameTexts.note}
              </Typography>
            </>
          ) : (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {nameTexts.needsPlan} <Link href="/settings/plans">{nameTexts.plans}</Link>
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{passwordTexts.cancel}</Button>
          {page.namesAllowed ? (
            <Button type="submit" variant="contained" disabled={!valid || setName.isPending}>
              {passwordTexts.save}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  )
}

/** What an action says when it ends; `undo` — the page just deleted, with «Вернуть». */
export interface PageNotice {
  text: string
  undo?: string
}

/**
 * The line that says what came of an action. It lives above the rows — a deleted page leaves the
 * list at once, and «Вернуть» must outlive its row.
 */
export function PageNoticeBar({
  notice,
  onClose,
  onNotice,
}: {
  notice: PageNotice | null
  onClose: () => void
  /** What «Вернуть» came to: returned, or not done. */
  onNotice: (notice: PageNotice) => void
}) {
  const { returnDeleted } = usePageActions()
  const [last, setLast] = useState<PageNotice | null>(notice)
  if (notice !== null && notice !== last) setLast(notice)
  const shown = notice ?? last
  return (
    <Snackbar
      open={notice !== null}
      autoHideDuration={notice?.undo ? 6000 : 3000}
      onClose={onClose}
      message={shown?.text}
      action={
        shown?.undo ? (
          <Button
            color="inherit"
            size="small"
            onClick={() => {
              const pageId = shown.undo!
              onClose()
              returnDeleted.mutate(
                { pageId },
                {
                  onSuccess: () => onNotice({ text: trashTexts.returned }),
                  onError: (error) => onNotice({ text: messageOf(error) }),
                },
              )
            }}
          >
            {trashTexts.returnBack}
          </Button>
        ) : undefined
      }
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    />
  )
}

/**
 * «⋯» of a page: the link, the password, taking it down and putting it back, deleting it to the
 * trash; in the trash — returning it and purging it. No button when there is nothing to offer;
 * what came of an action — copied, deleted with «Вернуть», or not done — is said beside the list,
 * not in the menu that closed.
 */
export function PageActionsMenu({
  page,
  onNotice,
  purge = true,
  nodes = [],
}: {
  page: PageActionsPage
  /** Where the outcome is said; none — beside the menu (the card of a page in a chat). */
  onNotice?: (notice: PageNotice) => void
  /** The pages of its site: its siblings for «Выше» and «Ниже», its parents for «Переместить». */
  nodes?: readonly PageActionsPage[]
  /**
   * Whether «Удалить навсегда» is offered: not on a card in a chat, whose menu goes with the
   * page — the card then says «Страницы больше нет» itself.
   */
  purge?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'purge' | null>(null)
  const [local, setLocal] = useState<PageNotice | null>(null)
  const setNotice = onNotice ?? setLocal
  const actions = usePageActions()
  const siblings = nodes
    .filter((node) => node.trash === null && node.parentId === page.parentId)
    .sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.path ?? '').localeCompare(b.path ?? ''),
    )
  const offered = pageActionsOf(page, { purge, siblings: siblings.length })
  // The pages that go with it: below it, or the whole site of a home page (Дер2) — in the trash,
  // the pages deleted with it, which «Вернуть» and «Удалить навсегда» take along.
  const path = page.path ?? '/'
  const below = nodes.filter(
    (node) =>
      node.pageId !== page.pageId &&
      (page.trash === null
        ? node.trash === null
        : node.trash !== null && node.trash.deletedAt === page.trash.deletedAt) &&
      (path === '/' || (node.path ?? '').startsWith(`${path}/`)),
  ).length
  const isSite = page.parentId === null && below > 0
  const [placing, setPlacing] = useState<'rename' | 'readdress' | 'move' | null>(null)
  const [naming, setNaming] = useState(false)
  const [filing, setFiling] = useState(false)
  // «Выше» / «Ниже»: the page changes places with its neighbour, and the siblings are numbered
  // 0, 1, 2… as they stand — two pages at one position would not move otherwise. One at a time:
  // the first refusal stops it and is said.
  async function shift(by: -1 | 1) {
    const at = siblings.findIndex((node) => node.pageId === page.pageId)
    if (siblings[at + by] === undefined) return
    const order = [...siblings]
    ;[order[at], order[at + by]] = [order[at + by]!, order[at]!]
    try {
      for (const [position, node] of order.entries())
        if (node.position !== position)
          await actions.update.mutateAsync({ pageId: node.pageId, position })
    } catch (error) {
      setNotice({ text: messageOf(error) })
    }
  }
  if (offered.length === 0 && local === null) return null
  const close = () => setAnchor(null)
  const failed = { onError: (error: unknown) => setNotice({ text: messageOf(error) }) }
  const input = { pageId: page.pageId }
  const run: Record<ActionId, () => void> = {
    copy: () =>
      void copyLink(page.url).then((ok) =>
        setNotice({ text: ok ? pageTexts.copied : pageTexts.failed }),
      ),
    password: () => setPasswordOpen(true),
    clearPassword: () => actions.setPassword.mutate({ ...input, password: null }, failed),
    takeDown: () => actions.takeDown.mutate(input, failed),
    restore: () => actions.restore.mutate(input, failed),
    delete: () => setConfirm('delete'),
    returnDeleted: () =>
      actions.returnDeleted.mutate(input, {
        ...failed,
        onSuccess: () => setNotice({ text: trashTexts.returned }),
      }),
    purge: () => setConfirm('purge'),
    rename: () => setPlacing('rename'),
    readdress: () => setPlacing('readdress'),
    move: () => setPlacing('move'),
    up: () => void shift(-1),
    down: () => void shift(1),
    name: () => setNaming(true),
    files: () => setFiling(true),
  }
  const label: Record<ActionId, string> = {
    copy: pageTexts.copy,
    password: page.hasPassword ? pageTexts.changePassword : pageTexts.setPassword,
    clearPassword: pageTexts.clearPassword,
    takeDown: isSite ? treeTexts.takeDownSite : pageTexts.takeDown,
    restore: pageTexts.restore,
    delete: isSite ? treeTexts.deleteSite : trashTexts.delete,
    returnDeleted: trashTexts.returnBack,
    purge: trashTexts.purge,
    rename: treeTexts.rename,
    readdress: treeTexts.readdress,
    move: treeTexts.move,
    up: treeTexts.up,
    down: treeTexts.down,
    name: nameTexts.action,
    files: fileTexts.action,
  }
  const danger: readonly ActionId[] = ['takeDown', 'delete', 'purge']
  function confirmed() {
    const done = () => setConfirm(null)
    if (confirm === 'delete')
      actions.remove.mutate(input, {
        onSuccess: () => {
          done()
          setNotice({ text: trashTexts.movedToTrash, undo: page.pageId })
        },
        onError: (error) => {
          done()
          setNotice({ text: messageOf(error) })
        },
      })
    else if (confirm === 'purge')
      actions.purge.mutate(input, {
        onSuccess: () => {
          done()
          setNotice({ text: trashTexts.purged })
        },
        onError: (error) => {
          done()
          setNotice({ text: messageOf(error) })
        },
      })
  }
  return (
    <>
      {offered.length > 0 && (
        <IconButton
          aria-label={pageTexts.more(page.title)}
          aria-haspopup="menu"
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ width: 40, height: 40, borderRadius: '10px', border: 1, borderColor: 'divider' }}
        >
          <AppIcon name="more" size={18} />
        </IconButton>
      )}
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {offered.map((id) => (
          <MenuItem
            key={id}
            sx={danger.includes(id) ? { color: 'error.main' } : undefined}
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
      {filing && (
        <PageFilesDialog page={page} open onClose={() => setFiling(false)} onNotice={setNotice} />
      )}
      {naming && (
        <PageNameDialog page={page} open onClose={() => setNaming(false)} onNotice={setNotice} />
      )}
      {placing !== null && (
        <PagePlaceDialog
          page={page}
          kind={placing}
          nodes={nodes}
          open
          onClose={() => setPlacing(null)}
          onNotice={setNotice}
        />
      )}
      <PageDeleteDialog
        page={page}
        forever={confirm === 'purge'}
        below={below}
        open={confirm !== null}
        pending={actions.remove.isPending || actions.purge.isPending}
        onConfirm={confirmed}
        onClose={() => setConfirm(null)}
      />
      {onNotice === undefined && (
        <PageNoticeBar notice={local} onClose={() => setLocal(null)} onNotice={setLocal} />
      )}
    </>
  )
}
