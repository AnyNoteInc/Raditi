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

interface PublicationRow {
  pageId: string
  url: string | null
  versionNo: number
  current: boolean
}

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
  /** «Схема» whose text has no drawn picture yet, or did not parse (88.24в). */
  notDrawn: 'Схема ещё не нарисована или в её тексте ошибка: исправьте текст и опубликуйте снова.',
  off: 'Страницы здесь не настроены.',
  cancel: 'Отмена',
  confirm: 'Опубликовать',
  close: 'Закрыть',
  // A canvas becomes a site: one page a screen (Ар8, §7.10; slice 88.15).
  publishSite: 'Опубликовать как сайт',
  updateSite: 'Обновить сайт',
  siteLead:
    'Сайт — снимок холста для всех, у кого есть ссылка: каждый экран — своя страница, из вариантов — выбранный. Ваши дальнейшие правки на него не попадут, пока вы не обновите сайт.',
  siteDone: 'Готово: сайт опубликован.',
  siteUpdated: (version: number) => `Готово: на сайте версия ${version} холста.`,
  openSite: 'Открыть сайт',
})

export function ArtifactPublishButton({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The dialog keeps what it opened on: a page that appears by this very publication changes nothing.
  const [open, setOpen] = useState<{ live: PublicationRow | null } | null>(null)
  const [versionNo, setVersionNo] = useState<number | ''>('')
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null)
  const owner = artifactRoleAtLeast(artifact.role, 'owner')
  const kind = artifactKindSpecOf(artifact.kind)?.publish ?? null
  const publishable = kind !== null
  const site = kind === 'site'
  const publication = useQuery({
    ...trpc.pages.artifactPublication.queryOptions({ artifactId: artifact.id }),
    enabled: owner && publishable,
  })
  const versions = useQuery({
    ...trpc.artifact.versions.queryOptions({ artifactId: artifact.id }),
    enabled: open !== null,
  })
  const publish = useMutation(trpc.pages.publishArtifact.mutationOptions())
  if (!owner || !publishable) return null
  const current = publication.data ?? null
  const label = site
    ? current
      ? publishTexts.updateSite
      : publishTexts.publishSite
    : current
      ? publishTexts.update
      : publishTexts.publish
  const live = open?.live ?? null

  return (
    <>
      <Tooltip title={label}>
        <IconButton
          aria-label={label}
          onClick={() => {
            setResult(null)
            setOpen({ live: current })
          }}
          sx={{ width: 40, height: 40 }}
        >
          <AppIcon name="share" size={18} />
        </IconButton>
      </Tooltip>
      {open !== null && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          maxWidth="sm"
          fullWidth
          aria-labelledby="publish-artifact-title"
        >
          <DialogTitle id="publish-artifact-title">
            {site ? label : live ? publishTexts.updateTitle : publishTexts.title}
          </DialogTitle>
          <DialogContent>
            <Typography sx={{ mb: 2 }}>
              {site ? publishTexts.siteLead : publishTexts.lead}
            </Typography>
            {live && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {publishTexts.shows(live.versionNo)} {live.current ? '' : publishTexts.stale}
                {live.url && (
                  <Box sx={{ mt: 0.5 }}>
                    <Link href={live.url} target="_blank" rel="noopener noreferrer">
                      {site ? publishTexts.openSite : publishTexts.open}
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
            <Button onClick={() => setOpen(null)}>
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
                        text: site
                          ? live
                            ? publishTexts.siteUpdated(answer.versionNo)
                            : publishTexts.siteDone
                          : live
                            ? publishTexts.updated(answer.versionNo)
                            : publishTexts.done,
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
                        text: ((code) =>
                          code === 'PAGES_OFF'
                            ? publishTexts.off
                            : code === 'ARTIFACT_DIAGRAM_NOT_DRAWN'
                              ? publishTexts.notDrawn
                              : publishTexts.failed)(
                          (error as { data?: { domainCode?: string } }).data?.domainCode,
                        ),
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
