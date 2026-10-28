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
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'

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

/**
 * The tabs the panel has something for, in their order: the preview of the dialog while it is
 * made or can be opened, and the files and the records of the site the changes touch and their
 * checks. The preview's tab is there before the changes too — the client opens the panel by the
 * button of the head (owner's request of 27.10.2026) — but the preview itself is shown only when
 * the client asks for it (`PreviewTab`). None: the dialog has no panel at all.
 */
export function paneTabsOf(
  preview: PreviewHead | null,
  candidate: CandidateHead | null,
): PaneTab[] {
  return paneTabs.filter((tab) =>
    tab === 'preview'
      ? preview !== null && usedPreviews.has(preview.status)
      : candidateCount(tab, candidate) > 0,
  )
}

/**
 * The panel opens by itself only for what the changes hold — their files, records or checks
 * (owner's requests of 26.10.2026), never for the preview alone.
 */
export const paneOpensItself = (tabs: readonly PaneTab[]): boolean =>
  tabs.some((tab) => tab !== 'preview')

/**
 * The tab the panel shows: the one the client chose while it has something; otherwise the first
 * tab of the changes — the preview is never the tab the panel opens on by itself.
 */
export function shownPaneTab(tabs: readonly PaneTab[], chosen: PaneTab | null): PaneTab {
  if (chosen !== null && tabs.includes(chosen)) return chosen
  return tabs.find((tab) => tab !== 'preview') ?? tabs[0] ?? 'preview'
}

/** The client's calls for the preview of a dialog, as the panel reads them. */
export interface PreviewCalls {
  /** At least one call on this screen: until then the preview is not shown. */
  asked: boolean
  /** A stopped preview was called for after it stopped: only then it is built again. */
  woken: boolean
}

/**
 * The client's calls for the preview (owner's request of 27.10.2026: no demonstration before an
 * explicit call) — `/preview` or the button of its tab. Held by the dialog, which sees the
 * preview stop whether its tab is drawn or not: a call that both draws the tab and asks — `/preview`
 * on a closed panel — wakes a stopped preview at once.
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
  return { asked: calls > 0, woken: stoppedAt !== null && calls > stoppedAt, call }
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

/** The way to the preview before the client asked for it: a sentence and the button that asks. */
function PreviewAsk({ text, label, onAsk }: { text: string; label: string; onAsk: () => void }) {
  return (
    <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography role="status" sx={{ lineHeight: 1.55 }}>
        {nbsp(text)}
      </Typography>
      <Button
        variant="outlined"
        onClick={onAsk}
        startIcon={<AppIcon name="eye" size={18} />}
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {label}
      </Button>
    </Box>
  )
}

/**
 * What the tab of the preview shows: the frame of a ready preview, or its state in words. The
 * preview is shown only once the client asked for it (owner's request of 27.10.2026: no
 * demonstration before an explicit call) — by the button here or by `/preview`; until then no
 * ticket is spent. A stopped preview is built again only by a call made after it stopped
 * (`usePreviewCalls`): the call it was shown by before does not wake it, and the frame of the
 * stopped one is not kept.
 */
function PreviewTab({
  cabinet,
  taskId,
  preview,
  showFrame,
  calls,
  onAsk,
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
  calls: PreviewCalls
  onAsk: () => void
  canReset: boolean
  onReset: () => void
  resetting: boolean
}) {
  const { asked, woken } = calls
  if (preview === null) return <State>{chatCommandRefusalText.no_preview}</State>
  const origin = preview.origin
  const hostname = origin === null ? null : previewHostOf(origin)
  switch (preview.status) {
    case 'pending':
    case 'building':
      if (!asked) return <PreviewAsk text={paneText.ask} label={paneText.show} onAsk={onAsk} />
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
      if (!woken)
        return <PreviewAsk text={previewPanelText.expired} label={paneText.reopen} onAsk={onAsk} />
      break
    case 'ready':
      if (!asked) return <PreviewAsk text={paneText.ask} label={paneText.show} onAsk={onAsk} />
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
 * icon named by its label, a tab of the candidate shows how many things it holds. `tab` — the
 * one the client chose (`shownPaneTab`).
 */
export function PreviewPane({
  taskId,
  preview,
  candidate,
  tab,
  onTab,
  tabs = paneTabs,
  visible,
  previewCalls,
  onAskPreview,
  canReset,
  onReset,
  resetting,
  onClose,
}: {
  taskId: string
  preview: PreviewHead | null
  candidate: CandidateHead | null
  tab: PaneTab | null
  onTab: (tab: PaneTab) => void
  tabs?: readonly PaneTab[]
  visible: boolean
  /** The client's calls for the preview (`usePreviewCalls`). */
  previewCalls: PreviewCalls
  onAskPreview: () => void
  canReset: boolean
  onReset: () => void
  resetting: boolean
  /** «Скрыть панель»: the panel steps aside, the dialog takes the width. */
  onClose?: () => void
}) {
  // The address of the cabinet is known in the browser only: the tab is drawn there.
  const cabinet = useSyncExternalStore(noSubscription, cabinetOrigin, noOrigin)
  const shown = shownPaneTab(tabs, tab)
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
                calls={previewCalls}
                onAsk={onAskPreview}
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
