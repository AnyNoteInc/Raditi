'use client'

import { previewOpenUrl } from '@repo/domain/preview/hostname'
import { chatCommandRefusalText } from '@repo/domain/release/chat-commands'
import { previewPanelText, previewUnavailableText } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MuiLink from '@mui/material/Link'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useState, useSyncExternalStore, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { ChecksPanel, FilesPanel } from './candidate-panels'
import { DatabasePanel } from './database-panel'
import { ownText, paneText } from './chat-texts'
import type { CandidateHead, PreviewHead } from './chat-types'
import { PreviewFrame, previewHostOf } from './preview-frame'

// The panel beside a dialog (docs/plan/53-chat-preview-release.md, Р20): the preview of its
// changes, their files, the records of the site and the checks. From `lg` it stands at the
// right edge the full height of the window; below, the switch above the dialog shows it in place
// of the feed.

export const paneTabs = ['preview', 'files', 'database', 'checks'] as const
export type PaneTab = (typeof paneTabs)[number]

const tabLabel: Readonly<Record<PaneTab, string>> = {
  preview: previewPanelText.preview,
  files: previewPanelText.files,
  database: previewPanelText.database,
  checks: previewPanelText.checks,
}

/** The id of a tab of the panel: `/preview` and «Посмотреть изменения» put the focus on it. */
export const paneTabId = (tab: PaneTab) => `dialog-pane-tab-${tab}`
const tabId = paneTabId
const panelId = (tab: PaneTab) => `dialog-pane-panel-${tab}`

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

/** What the tab of the preview shows: the frame of a ready preview, or its state in words. */
function PreviewTab({
  cabinet,
  taskId,
  preview,
  showFrame,
  canReset,
  onReset,
  resetting,
}: {
  /** The origin of the cabinet: «Открыть в новой вкладке» leads through it. */
  cabinet: string
  taskId: string
  preview: PreviewHead | null
  /** The frame is on the screen: only then a ticket is spent on it. */
  showFrame: boolean
  canReset: boolean
  onReset: () => void
  resetting: boolean
}) {
  // A stopped preview is built again when it is opened: the press is the client's.
  const [reopened, setReopened] = useState(false)
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
    case 'expired':
      if (!reopened || origin === null)
        return (
          <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography role="status">{nbsp(previewPanelText.expired)}</Typography>
            {origin !== null ? (
              <Button
                variant="outlined"
                onClick={() => setReopened(true)}
                sx={{ alignSelf: 'flex-start' }}
              >
                {paneText.reopen}
              </Button>
            ) : null}
          </Box>
        )
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
      {showFrame ? (
        <PreviewFrame taskId={taskId} origin={origin} revision={preview.revision} />
      ) : null}
    </Box>
  )
}

/** The tabs that read the candidate: its files, the records of the site, its checks. */
function CandidateTab({
  taskId,
  candidate,
  tab,
}: {
  taskId: string
  candidate: CandidateHead | null
  tab: Exclude<PaneTab, 'preview'>
}) {
  const trpc = useTRPC()
  const view = useQuery({
    ...trpc.candidate.get.queryOptions({
      taskId,
      ...(candidate ? { revision: candidate.revision } : {}),
    }),
    enabled: candidate !== null,
  })
  if (candidate === null)
    return <Typography color="text.secondary">{paneText.noChanges}</Typography>
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
  if (view.data === null)
    return <Typography color="text.secondary">{paneText.noChanges}</Typography>
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {candidate.status === 'stale' ? (
        <Alert severity="warning" icon={<AppIcon name="warning" />}>
          {paneText.stale}
        </Alert>
      ) : null}
      {tab === 'files' ? (
        <FilesPanel candidate={view.data} />
      ) : tab === 'database' ? (
        <DatabasePanel candidate={view.data} />
      ) : (
        <ChecksPanel candidate={view.data} />
      )}
    </Box>
  )
}

/**
 * The panel of a dialog's changes. `visible` — it is on the screen (from `lg`, or chosen by the
 * switch): the frame of the preview is made only then, so no ticket is spent on a hidden one.
 */
export function PreviewPane({
  taskId,
  preview,
  candidate,
  tab,
  onTab,
  visible,
  canReset,
  onReset,
  resetting,
}: {
  taskId: string
  preview: PreviewHead | null
  candidate: CandidateHead | null
  tab: PaneTab
  onTab: (tab: PaneTab) => void
  visible: boolean
  canReset: boolean
  onReset: () => void
  resetting: boolean
}) {
  // The address of the cabinet is known in the browser only: the tab is drawn there.
  const cabinet = useSyncExternalStore(noSubscription, cabinetOrigin, noOrigin)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
      <Tabs
        value={tab}
        onChange={(_event, next: PaneTab) => onTab(next)}
        aria-label={paneText.tabs}
        variant="scrollable"
        scrollButtons={false}
        sx={{ flex: 'none', px: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        {paneTabs.map((value) => (
          <Tab
            key={value}
            value={value}
            label={tabLabel[value]}
            id={tabId(value)}
            aria-controls={panelId(value)}
            sx={{ minHeight: 48, textTransform: 'none', fontSize: 14 }}
          />
        ))}
      </Tabs>
      {paneTabs.map((value) => (
        <Box
          key={value}
          role="tabpanel"
          id={panelId(value)}
          aria-labelledby={tabId(value)}
          hidden={value !== tab}
          sx={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: value === 'preview' ? 'hidden' : 'auto',
            display: value === tab ? 'flex' : 'none',
            flexDirection: 'column',
            ...(value === 'preview' ? {} : { p: { xs: 2, sm: 2.5 } }),
          }}
        >
          {value !== tab ? null : value === 'preview' ? (
            cabinet !== null ? (
              <PreviewTab
                cabinet={cabinet}
                taskId={taskId}
                preview={preview}
                showFrame={visible}
                canReset={canReset}
                onReset={onReset}
                resetting={resetting}
              />
            ) : null
          ) : (
            <CandidateTab taskId={taskId} candidate={candidate} tab={value} />
          )}
        </Box>
      ))}
    </Box>
  )
}
