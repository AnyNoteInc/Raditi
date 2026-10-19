'use client'

import type { CandidateFileChange } from '@repo/domain'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { paletteOf } from '@/components/billing/billing-surface'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { diffLines, fileSizeText, type DiffLineKind } from './chat-format'
import {
  checkKindText,
  checkScreenshotUrl,
  checkStatusLabel,
  checksText,
  runtimeMatchText,
  fileChangeLabel,
  filesText,
} from './chat-texts'
import type { CandidateView } from './chat-types'
import { offScreen } from './composer'

// The tabs of the panel beside a dialog that read its candidate (docs/plan/53, Р20): the files
// with the diff of each and the checks; the database is database-panel.tsx. The diff is shown
// here and nowhere in the feed. A line of the site's code is only ever set as text.

type FileChange = CandidateFileChange

const changeIcon: Readonly<Record<FileChange, AppIconName>> = {
  added: 'plus',
  modified: 'changes',
  deleted: 'close',
}

/** The badge of a change: a sign and a word. */
function ChangeBadge({ change }: { change: FileChange }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1,
        py: '2px',
        border: 1,
        borderColor: 'divider',
        borderRadius: '999px',
        fontSize: 12,
        fontWeight: 600,
        color: change === 'deleted' ? 'error.main' : 'text.primary',
        whiteSpace: 'nowrap',
      }}
    >
      <AppIcon name={changeIcon[change]} size={12} />
      {fileChangeLabel[change]}
    </Box>
  )
}

/** A path for reading: it may break at any point, it never widens the panel. */
const pathStyle = {
  fontFamily: 'var(--font-jetbrains, ui-monospace), ui-monospace, Menlo, monospace',
  fontSize: 13,
  overflowWrap: 'anywhere',
  wordBreak: 'break-all',
} as const

const lineTone: Readonly<Record<DiffLineKind, { sign: string; hidden: string | null }>> = {
  add: { sign: '+', hidden: filesText.added },
  remove: { sign: '−', hidden: filesText.removed },
  hunk: { sign: '', hidden: null },
  meta: { sign: '', hidden: null },
  context: { sign: ' ', hidden: null },
}

/** One file's diff: added lines and removed ones marked by a sign and by a tone of the theme. */
function FileDiff({
  candidateId,
  path,
  onBack,
}: {
  candidateId: string
  path: string
  onBack: () => void
}) {
  const trpc = useTRPC()
  const diff = useQuery(trpc.candidate.fileDiff.queryOptions({ candidateId, path }))
  let body
  if (diff.isPending) {
    body = (
      <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size={16} aria-hidden="true" />
        <Typography variant="body2">{filesText.loading}</Typography>
      </Box>
    )
  } else if (diff.isError) {
    body = <Typography role="alert">{callErrorText(diff.error)}</Typography>
  } else if (diff.data.state !== 'ready' || diff.data.diff === null) {
    const state = diff.data.state
    body = (
      <Typography color="text.secondary">
        {state === 'binary'
          ? filesText.binary
          : state === 'too_large'
            ? filesText.tooLarge
            : filesText.missing}
      </Typography>
    )
  } else {
    body = (
      <>
        <Typography variant="body2" color="text.secondary">
          {filesText.legend}
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 0,
            overflowX: 'auto',
            border: 1,
            borderColor: 'divider',
            borderRadius: '12px',
            bgcolor: 'background.default',
            fontFamily: 'var(--font-jetbrains, ui-monospace), ui-monospace, Menlo, monospace',
            fontSize: 12.5,
            lineHeight: 1.6,
          }}
        >
          <Box
            component="code"
            sx={(theme) => {
              const palette = paletteOf(theme)
              return {
                display: 'block',
                minWidth: 'max-content',
                py: 1,
                '& > span': { display: 'block', px: 1.5, whiteSpace: 'pre' },
                '& > [data-kind="hunk"], & > [data-kind="meta"]': {
                  color: palette.text.secondary,
                },
                // A tint of the theme's own success and error roles: right in both schemes.
                '& > [data-kind="add"]': {
                  backgroundColor: `color-mix(in srgb, ${palette.success.main} 16%, transparent)`,
                },
                '& > [data-kind="remove"]': {
                  backgroundColor: `color-mix(in srgb, ${palette.error.main} 14%, transparent)`,
                },
                '& [data-sign]': { display: 'inline-block', width: '1.5ch', userSelect: 'none' },
                '& [data-said]': offScreen,
              }
            }}
          >
            {diffLines(diff.data.diff).map((line, index) => {
              const tone = lineTone[line.kind]
              return (
                <span key={index} data-kind={line.kind}>
                  {tone.hidden ? <span data-said="">{tone.hidden}</span> : null}
                  <span data-sign="" aria-hidden="true">
                    {tone.sign}
                  </span>
                  {line.text}
                </span>
              )
            })}
          </Box>
        </Box>
      </>
    )
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Button
        onClick={onBack}
        startIcon={<AppIcon name="back" size={18} />}
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {filesText.back}
      </Button>
      <Typography component="h3" sx={{ ...pathStyle, fontSize: 14, fontWeight: 600 }}>
        {path}
      </Typography>
      {body}
    </Box>
  )
}

/** «Файлы»: what the candidate adds, changes and removes; a file opens its diff. */
export function FilesPanel({ candidate }: { candidate: CandidateView }) {
  const [open, setOpen] = useState<string | null>(null)
  if (open !== null)
    return <FileDiff candidateId={candidate.id} path={open} onBack={() => setOpen(null)} />
  if (candidate.files.length === 0 && candidate.media.length === 0)
    return <Typography color="text.secondary">{filesText.none}</Typography>
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {candidate.files.length > 0 ? (
        <Box component="section" aria-label={filesText.files}>
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.5 }}>
            {candidate.files.map((file) => (
              <li key={file.path}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => setOpen(file.path)}
                  sx={{
                    width: '100%',
                    minHeight: 44,
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 1.25,
                    px: 1.25,
                    py: 1,
                    border: 0,
                    borderRadius: '10px',
                    bgcolor: 'transparent',
                    color: 'text.primary',
                    font: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'action.hover' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
                  }}
                >
                  <ChangeBadge change={file.change} />
                  <Box component="span" sx={pathStyle}>
                    {file.path}
                  </Box>
                  <Typography component="span" variant="caption" color="text.secondary">
                    {file.change === 'deleted' ? '' : nbsp(fileSizeText(file.sizeBytes))}
                  </Typography>
                </Box>
              </li>
            ))}
          </Box>
        </Box>
      ) : null}
      {candidate.media.length > 0 ? (
        <Box component="section" aria-labelledby="candidate-media-title">
          <Typography
            id="candidate-media-title"
            component="h3"
            sx={{ fontSize: 14, fontWeight: 600, mb: 1 }}
          >
            {filesText.media}
          </Typography>
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.75 }}>
            {candidate.media.map((media) => (
              <Box
                component="li"
                key={media.path}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr)',
                  gap: 1.25,
                  alignItems: 'start',
                  px: 1.25,
                }}
              >
                <ChangeBadge change="added" />
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={pathStyle}>{media.path}</Box>
                  <Typography variant="caption" color="text.secondary">
                    {nbsp(`${media.contentType}, ${fileSizeText(media.sizeBytes)}`)}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

const checkIcon: Readonly<Record<CandidateView['checks'][number]['status'], AppIconName>> = {
  pending: 'clock',
  passed: 'check',
  failed: 'warning',
  stale: 'changes',
}

/** The preview runs otherwise than the site: said above the checks, in a sign and words. */
function RuntimeNote({ candidate }: { candidate: CandidateView }) {
  const parts = candidate.runtime ? runtimeMatchText(candidate.runtime) : []
  if (parts.length === 0) return null
  return (
    <Box
      role="note"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: 1.25,
        alignItems: 'start',
        p: 1.5,
        border: 1,
        borderColor: 'warning.main',
        borderRadius: '12px',
      }}
    >
      <Box sx={{ display: 'flex', pt: '2px', color: 'warning.main' }}>
        <AppIcon name="warning" size={18} />
      </Box>
      <Box sx={{ minWidth: 0, display: 'grid', gap: 0.5 }}>
        {parts.map((part) => (
          <Typography key={part} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {nbsp(part)}
          </Typography>
        ))}
      </Box>
    </Box>
  )
}

/** «Проверки»: each check of the candidate with its state in a sign and words. */
export function ChecksPanel({ candidate }: { candidate: CandidateView }) {
  if (candidate.checks.length === 0)
    return (
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        <RuntimeNote candidate={candidate} />
        <Typography color="text.secondary">{checksText.none}</Typography>
      </Box>
    )
  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <RuntimeNote candidate={candidate} />
      <ChecksList candidate={candidate} />
    </Box>
  )
}

function ChecksList({ candidate }: { candidate: CandidateView }) {
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
      {candidate.checks.map((check) => (
        <Box
          component="li"
          key={check.id}
          sx={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            gap: 1.25,
            alignItems: 'start',
            p: 1.5,
            border: 1,
            borderColor: 'divider',
            borderRadius: '12px',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              pt: '2px',
              color: check.status === 'failed' ? 'error.main' : 'text.primary',
            }}
          >
            {check.status === 'pending' ? (
              <CircularProgress size={16} aria-hidden="true" />
            ) : (
              <AppIcon name={checkIcon[check.status]} size={18} />
            )}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }}>{checkKindText(check.kind)}</Typography>
            <Typography
              variant="body2"
              sx={{ color: check.status === 'failed' ? 'error.main' : 'text.secondary' }}
            >
              {checkStatusLabel[check.status]}
            </Typography>
            {check.screenshot ? (
              <Box
                component="img"
                src={checkScreenshotUrl(candidate.taskId, check.id)}
                alt={checksText.screenshot}
                loading="lazy"
                sx={{
                  display: 'block',
                  mt: 1,
                  maxWidth: '100%',
                  height: 'auto',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: '8px',
                }}
              />
            ) : null}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
