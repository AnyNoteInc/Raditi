'use client'

import { previewOpenUrl } from '@repo/domain/preview/hostname'
import { chatCommandRefusalText } from '@repo/domain/release/chat-commands'
import { previewPanelText, previewUnavailableText } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MuiLink from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { ChecksPanel, FilesPanel } from './candidate-panels'
import { DatabasePanel } from './database-panel'
import { ownText, paneText } from './chat-texts'
import type { CandidateHead, PreviewHead } from './chat-types'
import { changesEmptyText, toolIcons, type ChangesTool, type ToolEmptyText } from './dialog-tools'
import { PreviewFrame, previewHostOf } from './preview-frame'

// What the tabs of the preview and of the changes show beside a dialog (docs/plan/53-chat-
// preview-release.md, Р20; docs/plan/59-dialog-tools-panel.md): the preview of its changes, their
// files, the records of the site and the checks. A tab is drawn only once the client asked for its
// tool (И1, И9), so nothing here is read or framed before: choosing «Предпросмотр» is the call to
// show it (И10).

/** The client's calls for the preview of a dialog, as its tab reads them. */
export interface PreviewCalls {
  /** A stopped preview was called for after it stopped: only then it is built again. */
  woken: boolean
}

/**
 * The client's calls for the preview: every choice of «Предпросмотр» in the menu and every
 * `/preview` (И10), and «Открыть предпросмотр» of a preview that stopped while its tab was open.
 * Held by the dialog, which sees the preview stop whether its tab is drawn or not: a call that
 * opens the tab of a stopped preview wakes it at once, the call it was shown by before does not
 * (owner's request of 27.10.2026).
 */
export function usePreviewCalls(status: PreviewHead['status'] | null): PreviewCalls & {
  call: () => void
} {
  const [calls, setCalls] = useState(0)
  // The number of calls when the preview stopped: only a later one wakes it.
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const stopped = status === 'expired'
  if (stopped && stoppedAt === null) setStoppedAt(calls)
  if (!stopped && stoppedAt !== null) setStoppedAt(null)
  const call = useCallback(() => setCalls((count) => count + 1), [])
  return { woken: stoppedAt !== null && calls > stoppedAt, call }
}

const noSubscription = () => () => undefined
const cabinetOrigin = () => window.location.origin
const noOrigin = () => null

function State({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <Box role="status" sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, p: 2.5 }}>
      {busy ? <CircularProgress size={18} aria-hidden="true" sx={{ mt: '3px' }} /> : null}
      <Typography sx={{ lineHeight: 1.55 }}>{children}</Typography>
    </Box>
  )
}

/** A preview that stopped while its tab was open: its state, and the client's way to open it. */
function StoppedPreview({ onReopen }: { onReopen: () => void }) {
  return (
    <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography role="status" sx={{ lineHeight: 1.55 }}>
        {nbsp(previewPanelText.expired)}
      </Typography>
      <Button
        variant="outlined"
        onClick={onReopen}
        startIcon={<AppIcon name="eye" size={18} />}
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {paneText.reopen}
      </Button>
    </Box>
  )
}

/**
 * The tab of the preview: the frame of a ready preview, or its state in words. The tab is there
 * because the client chose the preview (И10), so a ready one is framed at once, by a ticket. A
 * stopped preview is built again only by a call made after it stopped (`usePreviewCalls`): the call
 * it was shown by before does not wake it, and the frame of the stopped one is not kept.
 */
export function PreviewTab({
  taskId,
  preview,
  calls,
  onReopen,
  canReset,
  onReset,
  resetting,
}: {
  taskId: string
  preview: PreviewHead | null
  calls: PreviewCalls
  /** «Открыть предпросмотр» of a stopped preview: the client's call. */
  onReopen: () => void
  canReset: boolean
  onReset: () => void
  resetting: boolean
}) {
  // The address of the cabinet is known in the browser only: «Открыть в новой вкладке» leads
  // through it.
  const cabinet = useSyncExternalStore(noSubscription, cabinetOrigin, noOrigin)
  if (cabinet === null) return null
  if (preview === null) return <State>{chatCommandRefusalText.no_preview}</State>
  const origin = preview.origin
  const hostname = origin === null ? null : previewHostOf(origin)
  switch (preview.status) {
    case 'pending':
    case 'building':
      return <State busy>{previewPanelText.building}</State>
    case 'unavailable':
      return (
        <State>
          {nbsp(
            ownText(previewUnavailableText, preview.unavailableReason ?? '') ??
              chatCommandRefusalText.preview_unavailable,
          )}
        </State>
      )
    case 'destroyed':
      return <State>{paneText.destroyed}</State>
    case 'failed':
      return (
        <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography role="status">{nbsp(previewPanelText.failed)}</Typography>
          {canReset ? (
            <Button
              variant="outlined"
              onClick={onReset}
              loading={resetting}
              sx={{ alignSelf: 'flex-start' }}
            >
              {paneText.reset}
            </Button>
          ) : null}
        </Box>
      )
    // A stopped preview is built again when it is opened: the press is the client's.
    case 'expired':
      if (origin === null) return <State>{nbsp(previewPanelText.expired)}</State>
      if (!calls.woken) return <StoppedPreview onReopen={onReopen} />
      break
    case 'ready':
      break
  }
  if (origin === null || hostname === null)
    return <State>{chatCommandRefusalText.preview_unavailable}</State>
  return (
    <Box sx={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          px: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <MuiLink
          href={previewOpenUrl(cabinet, hostname, '/')}
          target="_blank"
          rel="noopener noreferrer"
          variant="body2"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minHeight: 44 }}
        >
          {previewPanelText.openInNewTab}
          <AppIcon name="arrow" size={16} />
        </MuiLink>
      </Box>
      <PreviewFrame taskId={taskId} origin={origin} revision={preview.revision} />
    </Box>
  )
}

/** What a tab of the changes says in place of them (И6), under the sign of its tool. */
function NoChanges({ tool, text }: { tool: ChangesTool; text: ToolEmptyText }) {
  return (
    <Box
      sx={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        py: 4,
        textAlign: 'center',
      }}
    >
      <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
        <AppIcon name={toolIcons[tool]} size={28} />
      </Box>
      <Typography sx={{ maxWidth: 320, lineHeight: 1.55 }}>{nbsp(text.title)}</Typography>
      {text.note ? (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 320 }}>
          {nbsp(text.note)}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * A tab that reads the candidate: its files, the records of the site, its checks. Before the
 * changes — and in a dialog that ended without them — it says so in the words of its tool.
 */
export function CandidateTab({
  taskId,
  candidate,
  tool,
  ended,
}: {
  taskId: string
  candidate: CandidateHead | null
  tool: ChangesTool
  /** The dialog has ended: no changes will come any more. */
  ended: boolean
}) {
  const trpc = useTRPC()
  const view = useQuery({
    ...trpc.candidate.get.queryOptions({
      taskId,
      ...(candidate ? { revision: candidate.revision } : {}),
    }),
    enabled: candidate !== null,
  })
  // The changes the head names, unless the server has none to read for them any more.
  const empty = changesEmptyText(tool, {
    ended,
    candidate: view.data === null ? null : candidate,
  })
  if (empty !== null) return <NoChanges tool={tool} text={empty} />
  if (view.isPending)
    return (
      <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size={16} aria-hidden="true" />
      </Box>
    )
  if (view.isError)
    return (
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            sx={{ minHeight: 44 }}
            loading={view.isFetching}
            onClick={() => void view.refetch()}
          >
            {paneText.retry}
          </Button>
        }
      >
        {paneText.loadFailed}
      </Alert>
    )
  if (view.data === null || candidate === null) return null
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {candidate.status === 'stale' ? (
        <Alert severity="warning" icon={<AppIcon name="warning" />}>
          {paneText.stale}
        </Alert>
      ) : null}
      {tool === 'files' ? (
        <FilesPanel candidate={view.data} />
      ) : tool === 'database' ? (
        <DatabasePanel candidate={view.data} />
      ) : (
        <ChecksPanel candidate={view.data} />
      )}
    </Box>
  )
}
