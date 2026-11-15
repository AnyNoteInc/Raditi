'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { ChatDocument } from '@repo/domain/tasks/chat-documents'
import { useCallback, useEffect, useState, type RefObject } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { useAgentDocument } from './agent-document'
import { resultsText } from './chat-texts'

// «Результаты» beside the chat (owner's request of 14.11.2026, as ChatGPT shows them): a card
// pinned to the top right of the chat that names what the agent made in it — a document it writes
// with how far it is, the pages and texts it left — and opens each in the tab «Документы». The
// icon in the head of the chat hides and shows it; a chat too narrow for it does not show it.

/** The card's width and the room it keeps from the feed. */
export const RESULTS_WIDTH = 280
const RESULTS_GAP = 24
/** The narrowest feed the card stands beside: the words keep a measure of 640px. */
const RESULTS_MIN_AREA = 640 + RESULTS_WIDTH + RESULTS_GAP + 64

/** The room the feed keeps on the right while the card is shown, in px. */
export const RESULTS_ROOM = RESULTS_WIDTH + RESULTS_GAP

const HIDDEN_KEY = 'raditi.chat.results.hidden'

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Whether the card is hidden by the client (kept in this browser) and whether the area of the
 * feed is wide enough for it: the card is shown when both allow it.
 */
export function useResultsCard(area: RefObject<HTMLElement | null>, enabled: boolean) {
  // The card is drawn only once the area is measured, never on the server: reading the choice at
  // once does not change the first paint.
  const [hidden, setHidden] = useState(() => typeof window !== 'undefined' && readHidden())
  const [measured, setFits] = useState(false)
  useEffect(() => {
    const element = area.current
    if (!enabled || element === null || typeof ResizeObserver === 'undefined') return
    // The observer reports the size at once, then every change of it.
    const observer = new ResizeObserver(() => setFits(element.clientWidth >= RESULTS_MIN_AREA))
    observer.observe(element)
    return () => observer.disconnect()
  }, [area, enabled])
  const fits = enabled && measured
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
  return { fits, hidden, shown: fits && !hidden, toggle }
}

/** The icon in the head of the chat that hides and shows «Результаты». */
export function ResultsToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const label = shown ? resultsText.hide : resultsText.show
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
}: {
  icon: AppIconName
  title: string
  state: string
  current: boolean
  onOpen: () => void
}) {
  return (
    <ButtonBase
      onClick={onOpen}
      aria-label={resultsText.open(title)}
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

/** The card itself: newest first, the documents of the agent and the files it left. */
export function ResultsCard({
  agentDocs,
  documents,
  shownAgentDoc,
  onOpenAgentDoc,
  onOpenFile,
}: {
  agentDocs: readonly string[]
  documents: readonly ChatDocument[]
  shownAgentDoc: string | null
  onOpenAgentDoc: (docId: string) => void
  onOpenFile: (fileId: string) => void
}) {
  return (
    <Box
      component="aside"
      aria-label={resultsText.title}
      sx={{
        width: RESULTS_WIDTH,
        maxHeight: 'min(60vh, 480px)',
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
      </Box>
    </Box>
  )
}
