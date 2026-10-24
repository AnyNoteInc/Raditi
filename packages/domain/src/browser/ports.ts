import type { BrowserTaskPolicy } from '../ports/site-adapter.ts'
import type { BrowserVerificationPlan, BrowserVerificationReading } from './checkpoint.ts'
import type { BrowserChooser, BrowserDialog, BrowserTab, BrowserViewport } from './session.ts'
import type { BrowserInputEvent } from './stream-messages.ts'
import type { BrowserAction } from './tools.ts'

/**
 * Ports of the cloud browser of a task (docs/plan/57-browser-tasks.md, §2): the browser itself
 * (`CloudBrowserFactory`, Playwright in `@repo/browser-providers`) and the containers it runs in
 * (`BrowserSessionRuntime`, Docker in `@repo/sandbox-providers`). Only the browser worker
 * (`apps/browser`) holds them; the agent and the cabinet reach a session through the worker's
 * tools and stream, never through these.
 *
 * Invariants of every implementation:
 * - the control endpoint of a browser is a secret (its path is the key to the whole Playwright
 *   protocol): never logged, labelled, put in an argument, an error or an answer;
 * - nothing of the session's sign-in leaves the browser: no profile, cookie or `storageState` is
 *   saved anywhere (Б19), keys the client presses are never logged or recorded;
 * - pages open only addresses `browserNavigationAllowed` admits and the stack's policy does not
 *   deny — the agent's actions and the client's input alike (Б21: it is the platform's browser);
 * - errors carry no address, selector, value of a field or text of a page.
 */

/** A file of the task the worker read from `raditi-inbox`, given to a page. */
export interface BrowserFile {
  name: string
  mimeType: string
  bytes: Uint8Array
}

type ActionOf<T extends BrowserAction['tool']> = Extract<BrowserAction, { tool: T }>
type ByRef<T> = Omit<T, 'observation'>

/**
 * An action of the agent as the browser performs it: the worker has checked the observation
 * (references are of the latest one of the shown page) and read the attachments, so a reference
 * comes alone and an upload carries the files — without a reference, into the file chooser that
 * waits. `web_observe`, `web_tab`, `web_help` and
 * `web_verify` are the worker's own (`observe`, the tab methods, its state, `verify`).
 */
export type CloudBrowserAction =
  | ActionOf<'web_open'>
  | ByRef<ActionOf<'web_click'>>
  | ByRef<ActionOf<'web_fill'>>
  | ActionOf<'web_type'>
  | ByRef<ActionOf<'web_press'>>
  | ByRef<ActionOf<'web_scroll'>>
  | (Omit<ActionOf<'web_upload'>, 'observation' | 'attachmentIds'> & { files: BrowserFile[] })
  | ActionOf<'web_dialog'>
  | ActionOf<'web_wait'>

/** Where an action left the browser; `matched` of `web_wait`, `uploaded` of `web_upload`. */
export interface CloudBrowserActResult {
  page: BrowserTab
  matched?: boolean
  uploaded?: number
}

/**
 * The tree of the shown page (Playwright's `ai` mode), whole: the worker numbers it, keeps it to
 * check references and cuts what it answers. The values of password and one-time-code fields are
 * already hidden (`redactSecretValues` with the references of such inputs the adapter found).
 */
export interface CloudBrowserObservation {
  page: BrowserTab
  tree: string
}

/** One JPEG of `page.screencast` of the shown page. */
export interface CloudBrowserFrame {
  pageId: number
  jpeg: Uint8Array
  /** When Chromium painted it, milliseconds since the epoch. */
  timestamp: number
  width: number
  height: number
}

/** What the browser tells the worker as it happens; the worker keeps the session state. */
export type CloudBrowserEvent =
  /** The address or the title of a page changed. */
  | { kind: 'page'; page: BrowserTab }
  /** A tab opened, closed or was shown; `shown` is null when none is left. */
  | { kind: 'tabs'; tabs: BrowserTab[]; shown: number | null }
  /** A document committed in the main frame of a page: where checkpoints are found. */
  | { kind: 'navigation'; pageId: number; url: string }
  /** A JavaScript dialog opened, or the one that waited was answered (null). */
  | { kind: 'dialog'; dialog: BrowserDialog | null }
  /** A file chooser opened, or the one that waited was filled or cancelled (null). */
  | { kind: 'chooser'; chooser: BrowserChooser | null }
  /** The browser or the connection to it is gone; the session is lost. */
  | { kind: 'closed' }

export interface CloudBrowserConnection {
  /** `ws://127.0.0.1:<port>/<secret path>` from `BrowserSessionRuntime.start`: never logged. */
  endpoint: string
  /** `host:port` the session may reach (`browserAllowedHosts`). */
  allowedHosts: readonly string[]
  /** Exact origins of local sites outside production (`BROWSER_LOCAL_SITES`); empty in it. */
  localSites: readonly string[]
  /** The first page: the site's origin and the stack's `startPath`. */
  startUrl: string
  viewport: BrowserViewport
  /** The stack's policy (`SiteAdapter.browserTaskPolicy`), on every navigation and request. */
  policy: BrowserTaskPolicy
  onEvent: (event: CloudBrowserEvent) => void
}

/**
 * One context in one browser for one task: tabs, the agent's actions, the client's input, the
 * screencast. A method fails with `PageBrowserError` (`timeout`, `denied`, `closed`), which the
 * worker turns into a fixed code; calls come one at a time from the worker's queue.
 */
export interface CloudBrowserSession {
  tabs(): BrowserTab[]
  /** The page the stream shows and actions and input go to; null when none is open. */
  shown(): number | null
  selectTab(pageId: number): Promise<void>
  closeTab(pageId: number): Promise<void>
  /** Opens an address in the shown page (the client's `navigate`, the start page). */
  navigate(url: string): Promise<BrowserTab>
  /** The tree of the shown page, or of the subtree of `ref` of its latest tree. */
  observe(input: { ref?: string }): Promise<CloudBrowserObservation>
  act(action: CloudBrowserAction): Promise<CloudBrowserActResult>
  /**
   * The role and accessible name of the element that has the focus in the shown page, in any of
   * its frames (the block editor's canvas is one): what a key the agent presses without a
   * reference lands on (Б22, Б34). Read from a fresh tree of the page by the browser's own script,
   * not one of the page; references of the latest tree stay on their elements. null — none has
   * it, or a dialog waits.
   */
  focused(): Promise<{ role: string; name: string } | null>
  /**
   * Starts the screencast of the shown page (and of each page shown after it). `onFrame`'s promise
   * holds Chromium's acknowledgement of the frame, so a slow consumer slows the capture itself.
   * Answers the function that stops it.
   */
  startFrames(
    onFrame: (frame: CloudBrowserFrame) => Promise<void>,
    options: { size: BrowserViewport; quality: number },
  ): Promise<() => Promise<void>>
  /** Input of the client into the shown page; the worker has admitted it (control, page, size). */
  input(event: BrowserInputEvent): Promise<void>
  /** Lets go of every key and mouse button `input` holds down. */
  releaseInputs(): Promise<void>
  resolveDialog(id: string, accept: boolean, text?: string): Promise<void>
  /** Gives files to the chooser that waits; none — cancels it. */
  setChooserFiles(chooserId: string, files: BrowserFile[]): Promise<void>
  setViewport(viewport: BrowserViewport): Promise<void>
  /**
   * Runs a read of the site with the session's own sign-in (the context's request API, no page
   * script): the plan's steps in order within `browserVerificationLimits`, then its `read`. Any
   * failure of a step is `unreadable`, never a guess.
   */
  verify(plan: BrowserVerificationPlan): Promise<BrowserVerificationReading>
  /** false once the browser or the connection is gone. */
  isConnected(): boolean
  /** Closes the context and the connection; the containers are the runtime's. */
  close(): Promise<void>
}

export interface CloudBrowserFactory {
  open(connection: CloudBrowserConnection, signal?: AbortSignal): Promise<CloudBrowserSession>
}

// ---------------------------------------------------------------------------------------------
// The containers of a session
// ---------------------------------------------------------------------------------------------

/** A local site outside production: its exact origin and the fixed `ip:port` it is served at. */
export interface BrowserLocalSite {
  origin: string
  target: string
}

export interface BrowserSessionRuntimeSpec {
  sessionId: string
  taskId: string
  siteId: string
  /** The allowlist of the egress proxy (`browserAllowedHosts`). */
  allowedHosts: readonly string[]
  /** Reached without DNS; never in production. */
  localSites: readonly BrowserLocalSite[]
  /** Milliseconds since the epoch: past it the host's watchdog removes what is left. */
  deadline: number
}

/**
 * The containers of one session (Б10): Chromium on its own internal network without the host,
 * its only way out an egress proxy with the session's hosts, its control port forwarded to the
 * host's loopback behind a secret path. Idempotent by `sessionId`; holds no state of its own.
 */
export interface BrowserSessionRuntime {
  /** Creates what is missing and answers the control endpoint, a secret: never logged. */
  start(spec: BrowserSessionRuntimeSpec, signal?: AbortSignal): Promise<{ endpoint: string }>
  /** Removes the containers, the networks and their files; stopping twice is no error. */
  stop(sessionId: string): Promise<void>
  /** Sessions this runtime holds anything of, for the collector. */
  list(): Promise<string[]>
}
