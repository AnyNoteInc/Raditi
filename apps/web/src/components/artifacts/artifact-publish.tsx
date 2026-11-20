'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { artifactKindSpecOf, artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import type { CabinetArtifact } from './use-artifact'

// «Опубликовать как страницу» of a document (docs/plan/88-artifacts.md, Ар2, Ар23, §7.10; board
// F-publish; slice 88.11б): only its owner; a version of it becomes a page for everyone with the
// link — a snapshot: later edits reach the page by «Обновить страницу» only.

export const publishTexts = Object.freeze({
  publish: 'Опубликовать как страницу',
  update: 'Обновить страницу',
  title: 'Опубликовать как страницу',
  updateTitle: 'Обновить страницу',
  lead: 'Страница — снимок артефакта для всех, у кого есть ссылка. Ваши дальнейшие правки на неё не попадут, пока вы не обновите страницу.',
  version: 'Какую версию показать',
  current: (no: number) => `Текущая — версия ${no}`,
  versionOf: (no: number, label: string | null) =>
    label ? `Версия ${no} · «${label}»` : `Версия ${no}`,
  latest: 'Текущий текст',
  shows: (no: number) => `Страница показывает версию ${no}.`,
  stale: 'С тех пор артефакт изменился.',
  open: 'Открыть страницу',
  done: 'Готово: страница опубликована.',
  updated: (version: number) => `Готово: на странице версия ${version}.`,
  failed: 'Не получилось опубликовать. Попробуйте ещё раз.',
  off: 'Страницы здесь не настроены.',
  cancel: 'Отмена',
  confirm: 'Опубликовать',
  close: 'Закрыть',
})

export function ArtifactPublishButton({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [versionNo, setVersionNo] = useState<number | ''>('')
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null)
  const owner = artifactRoleAtLeast(artifact.role, 'owner')
  const publishable = artifactKindSpecOf(artifact.kind)?.publish === 'reading-page'
  const publication = useQuery({
    ...trpc.pages.artifactPublication.queryOptions({ artifactId: artifact.id }),
    enabled: owner && publishable,
  })
  const versions = useQuery({
    ...trpc.artifact.versions.queryOptions({ artifactId: artifact.id }),
    enabled: open,
  })
  const publish = useMutation(trpc.pages.publishArtifact.mutationOptions())
  if (!owner || !publishable) return null
  const live = publication.data ?? null
  const label = live ? publishTexts.update : publishTexts.publish

  return (
    <>
      <Tooltip title={label}>
        <IconButton aria-label={label} onClick={() => setOpen(true)} sx={{ width: 40, height: 40 }}>
          <AppIcon name="share" size={18} />
        </IconButton>
      </Tooltip>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          maxWidth="sm"
          fullWidth
          aria-labelledby="publish-artifact-title"
        >
          <DialogTitle id="publish-artifact-title">
            {live ? publishTexts.updateTitle : publishTexts.title}
          </DialogTitle>
          <DialogContent>
            <Typography sx={{ mb: 2 }}>{publishTexts.lead}</Typography>
            {live && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {publishTexts.shows(live.versionNo)} {live.current ? '' : publishTexts.stale}
                {live.url && (
                  <Box sx={{ mt: 0.5 }}>
                    <Link href={live.url} target="_blank" rel="noopener noreferrer">
                      {publishTexts.open}
                    </Link>
                  </Box>
                )}
              </Alert>
            )}
            <TextField
              select
              fullWidth
              label={publishTexts.version}
              value={versionNo}
              onChange={(event) =>
                setVersionNo(event.target.value === '' ? '' : Number(event.target.value))
              }
              slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            >
              <MenuItem value="">
                {artifact.version > 0
                  ? publishTexts.current(artifact.version)
                  : publishTexts.latest}
              </MenuItem>
              {(versions.data ?? [])
                .filter((each) => !each.current)
                .map((each) => (
                  <MenuItem key={each.no} value={each.no}>
                    {publishTexts.versionOf(each.no, each.label)}
                  </MenuItem>
                ))}
            </TextField>
            {result && (
              <Alert severity={result.ok ? 'success' : 'error'} sx={{ mt: 2 }}>
                {result.text}
                {result.url && (
                  <Box sx={{ mt: 0.5 }}>
                    <Link href={result.url} target="_blank" rel="noopener noreferrer">
                      {result.url}
                    </Link>
                  </Box>
                )}
              </Alert>
            )}
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setOpen(false)}>
              {result?.ok ? publishTexts.close : publishTexts.cancel}
            </Button>
            {!result?.ok && (
              <Button
                variant="contained"
                disabled={publish.isPending}
                onClick={() =>
                  void publish
                    .mutateAsync({
                      artifactId: artifact.id,
                      versionNo: versionNo === '' ? null : versionNo,
                    })
                    .then((answer) => {
                      setResult({
                        ok: true,
                        text: live ? publishTexts.updated(answer.versionNo) : publishTexts.done,
                        url: answer.url,
                      })
                      void queryClient.invalidateQueries({
                        queryKey: trpc.pages.artifactPublication.queryKey({
                          artifactId: artifact.id,
                        }),
                      })
                    })
                    .catch((error: unknown) =>
                      setResult({
                        ok: false,
                        text:
                          (error as { data?: { domainCode?: string } }).data?.domainCode ===
                          'PAGES_OFF'
                            ? publishTexts.off
                            : publishTexts.failed,
                      }),
                    )
                }
              >
                {live ? publishTexts.update : publishTexts.confirm}
              </Button>
            )}
          </DialogActions>
        </Dialog>
      )}
    </>
  )
}
