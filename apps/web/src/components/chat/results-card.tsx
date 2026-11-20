'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { ChatDocument, ChatFile } from '@repo/domain/tasks/chat-documents'
import { useCallback, useEffect, useState, type RefObject } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { useAgentDocument } from './agent-document'
import { fileSizeText } from './chat-format'
import { resultsText, todoText } from './chat-texts'
import { taskFileHref } from './feed-file'

// «Результаты» beside the chat (owner's request of 14.11.2026, as ChatGPT shows them): a card
// pinned to the top right of the chat that names what the agent made in it — a document it writes
// with how far it is, the pages and texts it left — and opens each in the tab «Документы». It
// shares the column beside the chat with «План работы» (docs/plan/89-agent-todos.md, ТД6), which
// stands over it. The icon in the head of the chat hides and shows the column; a chat too narrow
// for it does not show it.

/** The card's width and the room it keeps from the feed. */
export const RESULTS_WIDTH = 280
const RESULTS_GAP = 24
/** The narrowest feed the card stands beside: the words keep a measure of 640px. */
const RESULTS_MIN_AREA = 640 + RESULTS_WIDTH + RESULTS_GAP + 64

/** The room the feed keeps on the right while the card is shown, in px. */
export const RESULTS_ROOM = RESULTS_WIDTH + RESULTS_GAP

/**
 * The client hid the column (ТД6). A key of its own since the plan came into the column: one who
 * once hid «Результаты» under `raditi.chat.results.hidden` would never see the plan otherwise.
 */
const HIDDEN_KEY = 'raditi.chat.side.hidden'

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Whether the column beside the chat is hidden by the client (kept in this browser) and whether
 * the area of the feed is wide enough for it: the column is shown when both allow it. `measured`
 * — the area was measured: before it, the column neither fits nor fails to.
 */
export function useResultsCard(area: RefObject<HTMLElement | null>, enabled: boolean) {
  // The card is drawn only once the area is measured, never on the server: reading the choice at
  // once does not change the first paint.
  const [hidden, setHidden] = useState(() => typeof window !== 'undefined' && readHidden())
  const [width, setFits] = useState<'unknown' | 'fits' | 'narrow'>('unknown')
  useEffect(() => {
    const element = area.current
    if (!enabled || element === null || typeof ResizeObserver === 'undefined') return
    // The observer reports the size at once, then every change of it.
    const observer = new ResizeObserver(() =>
      setFits(element.clientWidth >= RESULTS_MIN_AREA ? 'fits' : 'narrow'),
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      // A width read while the column was wanted says nothing of the next time it is: enabled
      // again, the column waits for a new reading, and neither it nor the line over the field
      // flashes in for a frame on the old one.
      setFits('unknown')
    }
  }, [area, enabled])
  const fits = enabled && width === 'fits'
  const measured = enabled && width !== 'unknown'
  const toggle = useCallback(() => {
    setHidden((was) => {
      const next = !was
      try {
        window.localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
      } catch {
        // The choice lasts for the page then.
      }
      return next
    })
  }, [])
  return { fits, measured, hidden, shown: fits && !hidden, toggle }
}

/** What the column beside the chat holds: «Результаты», «План работы», or both. */
export type SideHolds = 'results' | 'plan' | 'both'

const toggleWords: Record<SideHolds, { show: string; hide: string }> = {
  results: resultsText,
  plan: todoText.side.plan,
  both: todoText.side.both,
}

/** The icon in the head of the chat that hides and shows the column beside it. */
export function ResultsToggle({
  shown,
  onToggle,
  holds = 'results',
}: {
  shown: boolean
  onToggle: () => void
  holds?: SideHolds
}) {
  const label = shown ? toggleWords[holds].hide : toggleWords[holds].show
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-pressed={shown}
        onClick={onToggle}
        sx={{
          width: 40,
          height: 40,
          borderRadius: '10px',
          color: shown ? 'text.primary' : 'text.secondary',
          bgcolor: shown ? 'var(--mui-palette-action-selected)' : 'transparent',
        }}
      >
        <AppIcon name="results" size={18} />
      </IconButton>
    </Tooltip>
  )
}

function ResultLine({
  icon,
  title,
  state,
  current,
  onOpen,
  download,
}: {
  icon: AppIconName
  title: string
  state: string
  current: boolean
  onOpen?: () => void
  /** A file the browser saves: the line is a link to it, not a tab of «Документы». */
  download?: string
}) {
  const link =
    download === undefined ? {} : { component: 'a' as const, href: download, download: true }
  return (
    <ButtonBase
      {...link}
      onClick={onOpen}
      aria-label={download === undefined ? resultsText.open(title) : resultsText.download(title)}
      aria-current={current || undefined}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 1.25,
        px: 1,
        py: 0.75,
        minHeight: 40,
        borderRadius: '10px',
        textAlign: 'left',
        color: 'text.primary',
        bgcolor: current ? 'var(--mui-palette-action-selected)' : 'transparent',
        '&:hover': { bgcolor: 'var(--mui-palette-action-hover)' },
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
        <AppIcon name={icon} size={16} />
      </Box>
      <Box
        component="span"
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 14,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </Box>
      <Box
        component="span"
        sx={{ flexShrink: 0, fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}
      >
        {state}
      </Box>
    </ButtonBase>
  )
}

function AgentDocLine({
  docId,
  current,
  onOpen,
}: {
  docId: string
  current: boolean
  onOpen: (docId: string) => void
}) {
  const doc = useAgentDocument(docId)
  const data = doc.data
  if (!data) return null
  return (
    <ResultLine
      icon="pages"
      title={data.title}
      state={
        data.draft && (data.version === 0 || data.progress.written < data.progress.total)
          ? resultsText.writing(data.progress.written, data.progress.total)
          : resultsText.version(Math.max(1, data.version))
      }
      current={current}
      onOpen={() => onOpen(docId)}
    />
  )
}

/** How many lines «Результаты» has: the card is drawn only with one at least. */
export const resultCountOf = (parts: {
  agentDocs: readonly string[]
  documents: readonly ChatDocument[]
  files: readonly ChatFile[]
}): number => parts.agentDocs.length + parts.documents.length + parts.files.length

/**
 * The card itself, newest first: the documents of the agent, the pages and texts it left, then
 * the other files it left — a Word or Excel file, a PDF —, which the client downloads.
 */
export function ResultsCard({
  taskId,
  agentDocs,
  documents,
  files,
  shownAgentDoc,
  onOpenAgentDoc,
  onOpenFile,
  underPlan = false,
}: {
  taskId: string
  agentDocs: readonly string[]
  documents: readonly ChatDocument[]
  files: readonly ChatFile[]
  shownAgentDoc: string | null
  onOpenAgentDoc: (docId: string) => void
  onOpenFile: (fileId: string) => void
  /** «План работы» stands over it: the card leaves the column room for both (ТД6). */
  underPlan?: boolean
}) {
  return (
    <Box
      component="aside"
      aria-label={resultsText.title}
      sx={{
        width: RESULTS_WIDTH,
        maxHeight: underPlan ? 'min(40vh, 320px)' : 'min(60vh, 480px)',
        overflowY: 'auto',
        p: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        bgcolor: 'background.paper',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
      }}
    >
      <Typography
        component="h2"
        sx={{ px: 1, pt: 0.5, pb: 0.75, fontSize: 13, fontWeight: 500, color: 'text.secondary' }}
      >
        {resultsText.title}
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.25 }}>
        {[...agentDocs].reverse().map((docId) => (
          <li key={docId}>
            <AgentDocLine docId={docId} current={shownAgentDoc === docId} onOpen={onOpenAgentDoc} />
          </li>
        ))}
        {[...documents].reverse().map((document) => {
          const latest = document.versions.at(-1)
          if (!latest) return null
          return (
            <li key={document.name}>
              <ResultLine
                icon={document.kind === 'page' ? 'globe' : 'document'}
                title={document.title}
                state={resultsText.version(document.versions.length)}
                current={false}
                onOpen={() => onOpenFile(latest.fileId)}
              />
            </li>
          )
        })}
        {[...files].reverse().map((file) => (
          <li key={file.name}>
            <ResultLine
              icon="file"
              title={file.name}
              state={fileSizeText(file.sizeBytes)}
              current={false}
              download={taskFileHref(taskId, file.fileId)}
            />
          </li>
        ))}
      </Box>
    </Box>
  )
}
