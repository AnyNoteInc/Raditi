'use client'

import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState } from 'react'

/** The words of the choice where a file of the chat goes (docs/plan/73-pages-sites.md, Дер9). */
export const targetTexts = Object.freeze({
  title: (name: string) => `Опубликовать «${name}»`,
  asNew: 'Новой страницей',
  asNewHint: 'У неё будет своя ссылка.',
  pageTitle: 'Название страницы',
  asVersion: 'Новой версией страницы',
  asVersionHint: 'По прежней ссылке откроется этот файл, название страницы останется.',
  choosePage: 'Страница',
  sameFile: 'из этого же файла',
  noPages: 'Опубликованных страниц пока нет.',
  loading: 'Загружаем страницы…',
  failed: 'Не удалось загрузить страницы — можно опубликовать новой.',
  publish: 'Опубликовать',
  publishing: 'Публикуем…',
  cancel: 'Отмена',
})

/** A page a file may become the next version of: `pages.targets` — of this chat's workspace. */
export interface PublishablePage {
  pageId: string
  title: string
  version: number
  sourceFileName: string | null
}

export type PublishTarget =
  { new: { title?: string } } | { pageId: string; expectedVersion: number }

/** The pages a file of the chat may go into, the one made of the same file first. */
export function publishablePages<P extends PublishablePage>(pages: readonly P[], fileName: string) {
  return [
    ...pages.filter((page) => page.sourceFileName === fileName),
    ...pages.filter((page) => page.sourceFileName !== fileName),
  ]
}

/**
 * «Опубликовать как страницу»: where the file goes — a new page with its own address, or the
 * next version of a live page of this chat's workspace at the version shown here; a version keeps
 * the title of its page. A page made of the same file is offered first and marked so, a hint and
 * not a key: the chat it came from does not matter (Дер9). The window opens at once; while the
 * pages load, or if they could not, only a new page is offered. It stays open, its button
 * «Публикуем…», until the publication ends.
 */
export function PublishTargetDialog({
  open,
  fileName,
  defaultTitle,
  pages,
  loading,
  failed,
  pending,
  onPublish,
  onClose,
}: {
  open: boolean
  fileName: string
  defaultTitle: string
  /** null — not loaded (yet). */
  pages: readonly PublishablePage[] | null
  loading: boolean
  failed: boolean
  pending: boolean
  onPublish: (target: PublishTarget) => void
  onClose: () => void
}) {
  const offered = publishablePages(pages ?? [], fileName)
  const same = offered[0]?.sourceFileName === fileName ? offered[0] : undefined
  // Chosen by the client, or else the default of the pages as they are now: pages that come
  // late change the default, never a choice.
  const [chosenMode, setMode] = useState<'new' | 'version' | null>(null)
  const [title, setTitle] = useState(defaultTitle)
  const [chosenPageId, setPageId] = useState<string | null>(null)
  const mode = offered.length === 0 ? 'new' : (chosenMode ?? (same ? 'version' : 'new'))
  const pageId = chosenPageId ?? same?.pageId ?? offered[0]?.pageId ?? ''
  const chosen = offered.find((page) => page.pageId === pageId)
  const ready = !pending && (mode === 'new' ? title.trim() !== '' : chosen !== undefined)
  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    onPublish(
      mode === 'new'
        ? { new: { title: title.trim() } }
        : { pageId: chosen!.pageId, expectedVersion: chosen!.version },
    )
  }
  const versionNote = loading
    ? targetTexts.loading
    : failed
      ? targetTexts.failed
      : offered.length === 0
        ? targetTexts.noPages
        : targetTexts.asVersionHint
  const field = { ml: 4, width: 'calc(100% - 32px)' } as const
  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      aria-labelledby="page-target-title"
      fullWidth
      maxWidth="xs"
    >
      <form onSubmit={submit} noValidate>
        <DialogTitle id="page-target-title" sx={{ overflowWrap: 'anywhere' }}>
          {targetTexts.title(fileName)}
        </DialogTitle>
        <DialogContent>
          <RadioGroup
            value={mode}
            onChange={(event) => setMode(event.target.value as 'new' | 'version')}
          >
            <FormControlLabel value="new" control={<Radio />} label={targetTexts.asNew} />
            <Typography variant="body2" sx={{ color: 'text.secondary', ml: 4, mt: -0.5 }}>
              {targetTexts.asNewHint}
            </Typography>
            {mode === 'new' && (
              <TextField
                size="small"
                label={targetTexts.pageTitle}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 200 } }}
                sx={{ ...field, mt: 1.5, mb: 1 }}
              />
            )}
            <FormControlLabel
              value="version"
              control={<Radio />}
              label={targetTexts.asVersion}
              disabled={offered.length === 0}
              sx={{ mt: 1 }}
            />
            <Typography
              variant="body2"
              role={failed ? 'alert' : undefined}
              sx={{ color: 'text.secondary', ml: 4, mt: -0.5 }}
            >
              {versionNote}
            </Typography>
            {mode === 'version' && offered.length > 0 && (
              <TextField
                select
                size="small"
                label={targetTexts.choosePage}
                value={pageId}
                onChange={(event) => setPageId(event.target.value)}
                sx={{ ...field, mt: 1.5 }}
                slotProps={{
                  select: {
                    MenuProps: { slotProps: { paper: { sx: { maxWidth: 'calc(100vw - 32px)' } } } },
                    sx: {
                      '& .MuiSelect-select': { whiteSpace: 'normal', overflowWrap: 'anywhere' },
                    },
                  },
                }}
              >
                {offered.map((page) => (
                  <MenuItem
                    key={page.pageId}
                    value={page.pageId}
                    sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  >
                    {page.title} · v{page.version}
                    {page.sourceFileName === fileName ? ` · ${targetTexts.sameFile}` : ''}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </RadioGroup>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={pending}>
            {targetTexts.cancel}
          </Button>
          <Button type="submit" variant="contained" disabled={!ready}>
            {pending ? targetTexts.publishing : targetTexts.publish}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
