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
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { ArtifactHeadButton } from './artifact-head'
import { formatDateTime } from './artifact-texts'
import type { CabinetArtifact } from './use-artifact'

interface PublicationRow {
  pageId: string
  url: string | null
  versionNo: number
  current: boolean
}

// «Опубликовать» of an artifact (docs/plan/88-artifacts.md, Ар2, Ар23, §7.10; board F-publish;
// docs/plan/93-artifacts-trim.md, АТ9): only its owner; the current version becomes a page (or a
// site of a canvas) for everyone with the link — a snapshot: later edits reach it by «Обновить»
// only. An older version is behind «Другая версия».

export const publishTexts = Object.freeze({
  open: 'Опубликовать',
  title: 'Опубликовать страницу',
  updateTitle: 'Обновить страницу',
  lead: 'Страница — снимок артефакта для всех, у кого есть ссылка: новые правки появятся на ней, когда вы её обновите.',
  liveCurrent: 'Страница показывает текущую версию.',
  liveStale: 'Страница показывает более раннюю версию: с тех пор артефакт изменился.',
  openPage: 'Открыть страницу',
  done: 'Готово: страница опубликована.',
  updated: 'Готово: страница обновлена.',
  // A canvas becomes a site: one page a screen (Ар8, §7.10; slice 88.15).
  siteTitle: 'Опубликовать сайт',
  siteUpdateTitle: 'Обновить сайт',
  siteLead:
    'Сайт — снимок холста для всех, у кого есть ссылка, по странице на каждый экран: новые правки появятся на нём, когда вы его обновите.',
  siteLiveCurrent: 'Сайт показывает текущую версию.',
  siteLiveStale: 'Сайт показывает более раннюю версию: с тех пор холст изменился.',
  openSite: 'Открыть сайт',
  siteDone: 'Готово: сайт опубликован.',
  siteUpdated: 'Готово: сайт обновлён.',
  otherVersion: 'Другая версия',
  version: 'Версия',
  current: 'Текущая',
  versionOf: (no: number, at: string, label: string | null) =>
    `Версия ${no} · ${formatDateTime(at)}${label ? ` · «${label}»` : ''}`,
  failed: 'Не получилось опубликовать. Попробуйте ещё раз.',
  off: 'Страницы здесь не настроены.',
  cancel: 'Отмена',
  confirm: 'Опубликовать',
  update: 'Обновить',
  close: 'Закрыть',
})

/**
 * «Опубликовать» in the head of an artifact: a button with a globe on its page, a globe alone in
 * its tab beside a chat (`compact`).
 */
export function ArtifactPublishButton({
  artifact,
  compact = false,
}: {
  artifact: CabinetArtifact
  compact?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The dialog keeps what it opened on: a page that appears by this very publication changes nothing.
  const [open, setOpen] = useState<{ live: PublicationRow | null } | null>(null)
  const [other, setOther] = useState(false)
  const [versionNo, setVersionNo] = useState<number | ''>('')
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null)
  const titleId = useId()
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
    enabled: open !== null && other,
  })
  const publish = useMutation(trpc.pages.publishArtifact.mutationOptions())
  if (!owner || !publishable) return null
  const live = open?.live ?? null
  const start = () => {
    setResult(null)
    setOther(false)
    setVersionNo('')
    setOpen({ live: publication.data ?? null })
  }
  const older = (versions.data ?? []).filter((each) => !each.current)

  return (
    <>
      {compact ? (
        <Tooltip title={publishTexts.open}>
          <IconButton
            aria-label={publishTexts.open}
            aria-haspopup="dialog"
            onClick={start}
            sx={{ width: 40, height: 40 }}
          >
            <AppIcon name="globe" size={18} />
          </IconButton>
        </Tooltip>
      ) : (
        <ArtifactHeadButton
          variant="outlined"
          color="inherit"
          icon={<AppIcon name="globe" size={16} />}
          label={publishTexts.open}
          aria-haspopup="dialog"
          onClick={start}
          sx={{ borderColor: 'divider' }}
        />
      )}
      {open !== null && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          maxWidth="sm"
          fullWidth
          aria-labelledby={titleId}
        >
          <DialogTitle id={titleId}>
            {site
              ? live
                ? publishTexts.siteUpdateTitle
                : publishTexts.siteTitle
              : live
                ? publishTexts.updateTitle
                : publishTexts.title}
          </DialogTitle>
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            <Typography>{site ? publishTexts.siteLead : publishTexts.lead}</Typography>
            {live && (
              <Typography variant="body2" color="text.secondary">
                {site
                  ? live.current
                    ? publishTexts.siteLiveCurrent
                    : publishTexts.siteLiveStale
                  : live.current
                    ? publishTexts.liveCurrent
                    : publishTexts.liveStale}
                {live.url && (
                  <>
                    {' '}
                    <Link href={live.url} target="_blank" rel="noopener noreferrer">
                      {site ? publishTexts.openSite : publishTexts.openPage}
                    </Link>
                  </>
                )}
              </Typography>
            )}
            {!result?.ok &&
              (other ? (
                <TextField
                  select
                  fullWidth
                  size="small"
                  label={publishTexts.version}
                  value={versionNo}
                  onChange={(event) =>
                    setVersionNo(event.target.value === '' ? '' : Number(event.target.value))
                  }
                  slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
                >
                  <MenuItem value="">{publishTexts.current}</MenuItem>
                  {older.map((each) => (
                    <MenuItem key={each.no} value={each.no}>
                      {publishTexts.versionOf(each.no, each.createdAt, each.label)}
                    </MenuItem>
                  ))}
                </TextField>
              ) : (
                <Box>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => setOther(true)}
                    sx={{ ml: -1, color: 'text.secondary' }}
                  >
                    {publishTexts.otherVersion}
                  </Button>
                </Box>
              ))}
            {result && (
              <Alert severity={result.ok ? 'success' : 'error'}>
                {result.text}
                {result.url && (
                  <Box sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
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
                disableElevation
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
                            ? publishTexts.siteUpdated
                            : publishTexts.siteDone
                          : live
                            ? publishTexts.updated
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
