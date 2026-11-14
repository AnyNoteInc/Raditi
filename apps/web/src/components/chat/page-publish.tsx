'use client'

import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

/** The words of the client's own publication of a page (docs/plan/69-pages.md, Ст25, Ст32). */
export const publishTexts = Object.freeze({
  byLink: 'Опубликовать по ссылке',
  publishing: 'Публикуем…',
  doneTitle: 'Страница опубликована',
  done: (version: number) =>
    version > 1
      ? `Опубликована новая версия v${version}: по той же ссылке теперь она.`
      : 'Страницу видит каждый, у кого есть эта ссылка.',
  password: 'Поставить пароль или снять страницу можно в разделе «Страницы».',
  failedTitle: 'Не удалось опубликовать',
  failed: 'Не получилось. Попробуйте ещё раз.',
  copy: 'Скопировать ссылку',
  copied: 'Скопировано',
  open: 'Открыть',
  close: 'Закрыть',
})

type Outcome =
  { kind: 'done'; url: string; version: number } | { kind: 'failed'; message: string } | null

/**
 * A publication the client starts and its outcome in a dialog: the address and «Скопировать
 * ссылку», or the reason it was refused in the server's own words. The list of «Страницы» is read
 * again after it.
 */
export function usePagePublish() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [copied, setCopied] = useState(false)
  // A second press before the first re-rendered is the same publication, not a second version.
  const running = useRef(false)

  async function publish(run: () => Promise<{ url: string; version: number }>) {
    if (running.current) return
    running.current = true
    setPending(true)
    setCopied(false)
    try {
      const { url, version } = await run()
      setOutcome({ kind: 'done', url, version })
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : publishTexts.failed
      setOutcome({ kind: 'failed', message })
    } finally {
      running.current = false
      setPending(false)
      void queryClient.invalidateQueries({ queryKey: trpc.pages.list.queryKey() })
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const close = () => setOutcome(null)
  const dialog = (
    <Dialog
      open={outcome !== null}
      onClose={close}
      aria-labelledby="page-publish-title"
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id="page-publish-title">
        {outcome?.kind === 'done' ? publishTexts.doneTitle : publishTexts.failedTitle}
      </DialogTitle>
      <DialogContent>
        {outcome?.kind === 'done' ? (
          <>
            <Typography sx={{ mb: 1 }}>{publishTexts.done(outcome.version)}</Typography>
            <Link
              href={outcome.url}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ overflowWrap: 'anywhere', fontWeight: 600 }}
            >
              {outcome.url}
            </Link>
            <Typography variant="body2" sx={{ mt: 1.5, color: 'text.secondary' }}>
              {publishTexts.password}
            </Typography>
          </>
        ) : outcome?.kind === 'failed' ? (
          <Typography role="alert">{outcome.message}</Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        {outcome?.kind === 'done' ? (
          <>
            <Button onClick={() => void copy(outcome.url)}>
              {copied ? publishTexts.copied : publishTexts.copy}
            </Button>
            <Button href={outcome.url} target="_blank" rel="noopener noreferrer">
              {publishTexts.open}
            </Button>
          </>
        ) : null}
        <Button onClick={close}>{publishTexts.close}</Button>
      </DialogActions>
    </Dialog>
  )
  return { publish, pending, dialog }
}
