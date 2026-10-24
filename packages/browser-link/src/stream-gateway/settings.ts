import {
  BROWSER_FRAME_MAX_BYTES,
  BROWSER_MESSAGE_MAX_CHARS,
  browserSessionTimings,
  browserStreamDefaults,
} from '@repo/domain'

// What the stream gateway is given and bound by (docs/plan/57-browser-tasks.md, Б12–Б14): its
// store, its times and its limits, shared by the gateway and each of its connections.

/** Who a spent ticket let in. */
export interface BrowserStreamViewer {
  sessionId: string
  userId: string
}

/** What the gateway asks the database (`browser_stream_tickets`, `browserViewerAllowed`). */
export interface BrowserStreamStore {
  /** Spends a ticket, once and for good; null — unknown, spent before or expired. */
  consumeTicket(ticket: string): Promise<BrowserStreamViewer | null>
  /** The user may watch the session now: a member, the session live, the site not closed. */
  viewerAllowed(viewer: BrowserStreamViewer): Promise<boolean>
}

export interface BrowserStreamTimings {
  /** The first message, `hello { ticket }`, comes within this or the socket closes (4401). */
  helloMs: number
  /** Pings to both sides (Б14); a side silent for a whole interval after a ping is cut. */
  pingMs: number
  /** The viewer's right to watch is checked again this often (Б12). */
  recheckMs: number
  /** From `hello` to the worker's stream open: the ticket spent, the viewer checked, the handshake. */
  openMs: number
}

export const browserStreamTimingDefaults: Readonly<BrowserStreamTimings> = Object.freeze({
  helloMs: 10_000,
  pingMs: browserStreamDefaults.pingMs,
  recheckMs: browserSessionTimings.recheckSeconds * 1_000,
  openMs: 15_000,
})

export interface BrowserStreamGatewayLimits {
  /** A message of a viewer in bytes: JSON of the longest text, 3 UTF-8 bytes per UTF-16 unit. */
  clientMessageBytes: number
  /** A message of the worker in bytes: a frame is the largest. */
  workerMessageBytes: number
  /** No frame goes to a viewer whose socket holds more than this (Б13). */
  clientBufferedBytes: number
  /** A viewer whose socket holds this much reads nothing: it is cut. */
  clientStalledBytes: number
  /** A worker that lets this much pile up toward it is stuck: the stream ends. */
  workerStalledBytes: number
  /** Messages of a viewer in one second: pointer moves at the display's rate and keys fit. */
  clientMessagesPerSecond: number
  /** Messages of a viewer kept while the stream to the worker opens. */
  pendingMessages: number
  /** Streams at once, those still waiting for `hello` included. */
  connections: number
}

export const browserStreamGatewayLimitDefaults: Readonly<BrowserStreamGatewayLimits> =
  Object.freeze({
    clientMessageBytes: 3 * BROWSER_MESSAGE_MAX_CHARS,
    workerMessageBytes: BROWSER_FRAME_MAX_BYTES,
    clientBufferedBytes: browserStreamDefaults.maxBufferedBytes,
    clientStalledBytes: 8 * browserStreamDefaults.maxBufferedBytes,
    workerStalledBytes: browserStreamDefaults.maxBufferedBytes,
    clientMessagesPerSecond: 240,
    pendingMessages: 32,
    connections: 512,
  })
