import type { BrowserHelpReason } from '@repo/domain/browser/session'
import type { BrowserStreamEndReason } from '@repo/domain/browser/stream-messages'
import type { TaskStatus } from '@repo/domain'

import type { BrowserState, StreamConnection } from './browser-stream'
import { browserText } from './chat-texts'
import type { BrowserHead } from './chat-types'

// What the panel of a task's browser shows, decided from the head of the feed and the stream
// (docs/plan/57-browser-tasks.md, Б14–Б18, Б23). Pure: the panel draws what these functions say.

export type PaneStatus = keyof typeof browserText.status

/** The session still holds a browser: the stream can be opened. */
export const sessionLive = (session: BrowserHead | null): boolean =>
  session !== null && (session.status === 'starting' || session.status === 'ready')

export interface PaneFacts {
  session: BrowserHead | null
  taskStatus: TaskStatus | undefined
  connection: StreamConnection
  /** The latest state of the stream; null before the first. */
  state: BrowserState | null
  /** The cabinet knows where the stream is (`BROWSER_STREAM_PUBLIC_URL`). */
  configured: boolean
}

const TERMINAL: readonly (TaskStatus | undefined)[] = ['done', 'failed', 'cancelled', 'rolled_back']

/** The chip of the toolbar: who drives the browser, or why nothing is shown. */
export function paneStatus(facts: PaneFacts): PaneStatus {
  const { session, taskStatus, connection } = facts
  const finished = taskStatus === 'done' ? 'finished' : 'closed'
  if (!sessionLive(session))
    return session === null && !TERMINAL.includes(taskStatus) ? 'connecting' : finished
  if (connection === 'ended') return finished
  if (!facts.configured || connection === 'failed') return 'error'
  if (connection === 'reconnecting') return 'reconnecting'
  if (connection !== 'open') return 'connecting'
  if ((facts.state?.controller ?? session!.controller) === 'user') return 'user'
  if (taskStatus === 'awaiting_user') return 'waiting'
  return 'agent'
}

export type PaneOverlay =
  | { kind: 'none' }
  /** No session yet: the browser opens when the agent starts. */
  | { kind: 'starting' }
  | { kind: 'connecting' }
  /** Over the last frame, which stays on the screen. */
  | { kind: 'reconnecting' }
  | { kind: 'failed' }
  | { kind: 'closed'; title: string; note: string }
  /** The agent asked the client to act in the browser (`web_help`). */
  | { kind: 'help'; reason: BrowserHelpReason; message: string | null }

/** The words of a closed session, by why it closed. */
export function closedWords(
  reason: BrowserHead['closeReason'] | BrowserStreamEndReason | null,
  taskStatus: TaskStatus | undefined,
): { title: string; note: string } {
  if (taskStatus === 'done' || reason === 'task_done')
    return { title: browserText.status.finished, note: browserText.finishedNote }
  const title =
    reason === 'idle'
      ? browserText.closedIdle
      : reason === 'expired'
        ? browserText.closedExpired
        : reason === 'crashed' || reason === 'shutdown'
          ? browserText.closedCrashed
          : browserText.closed
  const ended = TERMINAL.includes(taskStatus)
  return { title, note: ended ? browserText.finishedNote : browserText.closedNote }
}

/** What covers the picture of the page, if anything. */
export function paneOverlay(
  facts: PaneFacts & { painted: boolean; endReason: BrowserStreamEndReason | null },
): PaneOverlay {
  const { session, taskStatus, connection, state } = facts
  if (session === null)
    return TERMINAL.includes(taskStatus)
      ? { kind: 'closed', ...closedWords(null, taskStatus) }
      : { kind: 'starting' }
  if (!sessionLive(session))
    return { kind: 'closed', ...closedWords(session.closeReason, taskStatus) }
  if (connection === 'ended') return { kind: 'closed', ...closedWords(facts.endReason, taskStatus) }
  if (!facts.configured || connection === 'failed') return { kind: 'failed' }
  if (connection === 'reconnecting')
    return facts.painted ? { kind: 'reconnecting' } : { kind: 'connecting' }
  if (connection !== 'open') return { kind: 'connecting' }
  const controller = state?.controller ?? session.controller
  const help =
    state?.help ??
    (session.help ? { reason: session.help.reason, message: session.help.message } : null)
  if (help && controller === 'agent')
    return { kind: 'help', reason: help.reason, message: help.message ?? null }
  return { kind: 'none' }
}

/** The address of the page as the toolbar shows it: a lock for https, the host, the rest. */
export function addressParts(url: string): { secure: boolean; host: string; rest: string } | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return {
    secure: parsed.protocol === 'https:',
    host: parsed.host,
    rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  }
}
