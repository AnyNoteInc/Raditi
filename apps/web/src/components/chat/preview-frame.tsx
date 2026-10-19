'use client'

import { isPreviewPath } from '@repo/domain/preview/hostname'
import { previewPanelText } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '@/trpc/client'

import { callErrorCode, callErrorText } from './call-error'
import { paneText } from './chat-texts'

// The parent side of the frame-ticket contract (docs/plan/53-chat-preview-release.md,
// «Маршруты», R6): the iframe of a preview opens only by a one-time ticket; when its session ends
// inside the frame, the gateway's page `/__raditi/frame-ticket` asks the cabinet for a new one by
// `postMessage`. The cabinet answers by putting a new frame with a new ticket in place of the old
// one — never by sending the ticket into the frame, where the scripts of the site run too.

/** The type of the request the gateway's page sends. */
export const TICKET_REQUEST_TYPE = 'raditi-preview-ticket-request'

/** At most one request of a frame is answered in this time; the rest are dropped silently. */
export const TICKET_REQUEST_INTERVAL_MS = 10_000

/**
 * How long a preview being built again is waited for before it is asked anew. The server asks
 * core to build a stopped preview at most once a minute (`REBUILD_REQUEST_SECONDS` of
 * @repo/trpc), so a request lost on the way is asked again by the next one, and no sooner.
 */
export const NOT_READY_RETRY_MS = 60_000

/** What the iframe is allowed: the site's own scripts, forms and windows, nothing of the cabinet. */
export const PREVIEW_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'

interface TicketRequestEvent {
  source: unknown
  origin: string
  data: unknown
}

/**
 * The path a ticket request asks for, when the request is the preview's own: it comes from the
 * window of this very frame, from the origin of this preview, names its hostname and the type of
 * the contract. A path the gateway would not lead to becomes `/`. null — not a request to answer.
 */
export function ticketRequestPath(
  event: TicketRequestEvent,
  frame: { window: unknown; origin: string; hostname: string },
): string | null {
  if (frame.window === null || frame.window === undefined || event.source !== frame.window)
    return null
  if (event.origin !== frame.origin) return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const { type, host, path } = data as { type?: unknown; host?: unknown; path?: unknown }
  if (type !== TICKET_REQUEST_TYPE || host !== frame.hostname) return null
  return typeof path === 'string' && isPreviewPath(path) ? path : '/'
}

/** Whether a request may be answered now: not sooner than 10 s after the last one answered. */
export function ticketRequestAllowed(lastAnsweredAt: number | null, now: number): boolean {
  return lastAnsweredAt === null || now - lastAnsweredAt >= TICKET_REQUEST_INTERVAL_MS
}

/** The hostname of a preview's origin; null when it is not an address. */
export function previewHostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

interface Entry {
  round: number
  path: string
}

/** Another ticket for the same entry: a new round, and the old frame with its ticket goes. */
const nextRound = (previous: Entry): Entry => ({ round: previous.round + 1, path: previous.path })

/**
 * The frame of a ready preview. Each mount takes a fresh ticket, and so does a new revision of
 * the preview: a frame never outlives the changes it shows. The frame-ticket requests of the
 * frame are answered as the contract says.
 */
export function PreviewFrame({
  taskId,
  origin,
  revision,
}: {
  taskId: string
  /** `scheme://host[:port]` of the preview. */
  origin: string
  revision: number
}) {
  const client = useTRPCClient()
  const hostname = previewHostOf(origin)
  // Which entry the frame wants: a new round for every request the contract answers. The ticket
  // of a round is taken once and never kept after the frame is gone.
  const [entry, setEntry] = useState<Entry>({ round: 0, path: '/' })
  const iframe = useRef<HTMLIFrameElement>(null)
  const lastAnswered = useRef<number | null>(null)
  const ticket = useQuery({
    queryKey: ['chat', 'preview-ticket', taskId, revision, entry.round, entry.path],
    queryFn: () => client.preview.ticket.mutate({ taskId, to: entry.path }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const notReady = ticket.isError && callErrorCode(ticket.error) === 'PREVIEW_NOT_READY'

  // A stopped preview is being built again: once it is served the frame opens without a press.
  useEffect(() => {
    if (!notReady) return
    const timer = window.setTimeout(() => setEntry(nextRound), NOT_READY_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [notReady])

  useEffect(() => {
    if (hostname === null) return
    const answer = (event: MessageEvent) => {
      const path = ticketRequestPath(event, {
        window: iframe.current?.contentWindow,
        origin,
        hostname,
      })
      if (path === null) return
      const now = Date.now()
      if (!ticketRequestAllowed(lastAnswered.current, now)) return
      lastAnswered.current = now
      setEntry((previous) => ({ round: previous.round + 1, path }))
    }
    window.addEventListener('message', answer)
    return () => window.removeEventListener('message', answer)
  }, [hostname, origin])

  // A stopped preview is being built again: the panel shows it so, and asks again by itself.
  if (notReady) return <Building />
  if (ticket.isError) {
    return (
      <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography role="alert">{callErrorText(ticket.error)}</Typography>
        <Button
          variant="outlined"
          onClick={() => setEntry(nextRound)}
          sx={{ alignSelf: 'flex-start', minHeight: 44 }}
        >
          {paneText.retry}
        </Button>
      </Box>
    )
  }
  if (ticket.data === undefined) return <Building />
  // Only an entry of this very preview: never another origin in the frame.
  if (!sameOrigin(ticket.data.url, origin)) {
    return (
      <Typography role="alert" sx={{ p: 2.5 }}>
        {previewPanelText.failed}
      </Typography>
    )
  }
  return (
    <Box sx={{ flex: '1 1 auto', display: 'flex', minHeight: 420, bgcolor: 'common.white' }}>
      <iframe
        // A new element for every ticket: the window of the old frame goes with it.
        key={`${revision}-${entry.round}`}
        ref={iframe}
        src={ticket.data.url}
        title={paneText.frameTitle}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        style={{ display: 'block', flex: '1 1 auto', width: '100%', border: 0 }}
      />
    </Box>
  )
}

function Building() {
  return (
    <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, p: 2.5 }}>
      <CircularProgress size={18} aria-hidden="true" />
      <Typography>{previewPanelText.building}</Typography>
    </Box>
  )
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}
