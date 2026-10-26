'use client'

import { previewOpenUrl } from '@repo/domain/preview/hostname'
import { chatCommandRefusalText } from '@repo/domain/release/chat-commands'
import { previewPanelText, previewUnavailableText } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import MuiLink from '@mui/material/Link'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useState, useSyncExternalStore, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
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

/** The tabs are icons (owner's request of 26.10.2026); the name is their label and their hint. */
const tabIcon: Readonly<Record<PaneTab, AppIconName>> = {
  preview: 'eye',
  files: 'file',
  database: 'database',
  checks: 'check',
}

/** A preview the client uses: being made, ready, stopped for its age or failed — not one that cannot be shown or is gone. */
const usedPreviews: ReadonlySet<PreviewHead['status']> = new Set([
  'pending',
  'building',
  'ready',
  'failed',
  'expired',
])

/** What a tab of the candidate holds: the files and media, the records of the site, the checks. */
function candidateCount(tab: Exclude<PaneTab, 'preview'>, candidate: CandidateHead | null): number {
  if (candidate === null) return 0
  if (tab === 'checks') {
    const { pending, passed, failed, stale } = candidate.checks
    return pending + passed + failed + stale
  }
  const counts = candidate.counts
  if (counts === null) return 0
  if (tab === 'database') return counts.records
  return counts.files.added + counts.files.modified + counts.files.deleted + counts.media
}

/** The changes of the candidate on the site itself: its files and media, the records of the site. */
const siteChanges = (candidate: CandidateHead | null): number =>
  candidateCount('files', candidate) + candidateCount('database', candidate)

/**
 * The tabs the panel has something for (owner's requests of 26.10.2026: it opens only when it is
 * really needed — when something on the site has changed) — the files and the records of the site
 * the changes touch, their checks, and the preview of them — in their order. The preview of a
 * dialog without changes is there only when the client asked for it (`/preview`): its first build
 * is the site as it is. None: the dialog has no panel at all.
 */
export function paneTabsOf(
  preview: PreviewHead | null,
  candidate: CandidateHead | null,
  options: { previewAsked?: boolean } = {},
): PaneTab[] {
  const changed = siteChanges(candidate) > 0
  return paneTabs.filter((tab) =>
    tab === 'preview'
      ? preview !== null &&
        usedPreviews.has(preview.status) &&
        (changed || options.previewAsked === true)
      : candidateCount(tab, candidate) > 0,
  )
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
 * `tabs` — the tabs it has something for (`paneTabsOf`); every tab when not given. A tab is an
 * icon named by its label, a tab of the candidate shows how many things it holds.
 */
export function PreviewPane({
  taskId,
  preview,
  candidate,
  tab,
  onTab,
  tabs = paneTabs,
  visible,
  canReset,
  onReset,
  resetting,
  onClose,
}: {
  taskId: string
  preview: PreviewHead | null
  candidate: CandidateHead | null
  tab: PaneTab
  onTab: (tab: PaneTab) => void
  tabs?: readonly PaneTab[]
  visible: boolean
  canReset: boolean
  onReset: () => void
  resetting: boolean
  /** «Скрыть изменения»: the panel steps aside, the dialog takes the width. */
  onClose?: () => void
}) {
  // The address of the cabinet is known in the browser only: the tab is drawn there.
  const cabinet = useSyncExternalStore(noSubscription, cabinetOrigin, noOrigin)
  // A tab that has nothing now gives way to the first that has something.
  const shown = tabs.includes(tab) ? tab : (tabs[0] ?? tab)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          pr: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Tabs
          value={shown}
          onChange={(_event, next: PaneTab) => onTab(next)}
          aria-label={paneText.tabs}
          variant="scrollable"
          scrollButtons={false}
          sx={{ flex: '1 1 auto', minWidth: 0, px: 1 }}
        >
          {tabs.map((value) => {
            const count = value === 'preview' ? 0 : candidateCount(value, candidate)
            return (
              <Tab
                key={value}
                value={value}
                icon={<AppIcon name={tabIcon[value]} size={20} />}
                iconPosition="start"
                label={
                  count > 0 ? (
                    <Box component="span" aria-hidden="true">
                      {count}
                    </Box>
                  ) : undefined
                }
                aria-label={tabLabel[value]}
                title={tabLabel[value]}
                id={tabId(value)}
                aria-controls={panelId(value)}
                sx={{
                  minHeight: 48,
                  minWidth: 52,
                  px: 1.5,
                  textTransform: 'none',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  '& .MuiTab-iconWrapper': { mr: count > 0 ? 0.75 : 0 },
                }}
              />
            )
          })}
        </Tabs>
        {onClose ? (
          <IconButton
            aria-label={paneText.hide}
            title={paneText.hide}
            onClick={onClose}
            sx={{ flex: 'none', width: 44, height: 44, color: 'text.secondary' }}
          >
            <AppIcon name="close" size={20} />
          </IconButton>
        ) : null}
      </Box>
      {tabs.map((value) => (
        <Box
          key={value}
          role="tabpanel"
          id={panelId(value)}
          aria-labelledby={tabId(value)}
          hidden={value !== shown}
          sx={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: value === 'preview' ? 'hidden' : 'auto',
            display: value === shown ? 'flex' : 'none',
            flexDirection: 'column',
            ...(value === 'preview' ? {} : { p: { xs: 2, sm: 2.5 } }),
          }}
        >
          {value !== shown ? null : value === 'preview' ? (
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
