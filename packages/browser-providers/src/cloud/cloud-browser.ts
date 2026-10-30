import {
  badRequest,
  BROWSER_CHOOSER_MAX_FILES,
  browserModifiers,
  browserNamedKeys,
  browserRefSchema,
  browserSessionLimits,
  browserSessionTimings,
  browserTaskCodeNames,
  browserTaskError,
  browserTreeActiveElement,
  browserVerificationLimits,
  clipPageText,
  isBrowserKeyCombo,
  isBrowserViewport,
  isDomainError,
  isPageBrowserError,
  PageBrowserError,
  withTimeout,
  type BrowserChooser,
  type BrowserController,
  type BrowserDialog,
  type BrowserDialogKind,
  type BrowserFile,
  type BrowserInputEvent,
  type BrowserModifier,
  type BrowserSignIn,
  type BrowserSignInForm,
  type BrowserSignInOutcome,
  type BrowserTab,
  type BrowserVerificationPlan,
  type BrowserVerificationReading,
  type BrowserViewport,
  type CloudBrowserAction,
  type CloudBrowserActResult,
  type CloudBrowserConnection,
  type CloudBrowserEvent,
  type CloudBrowserFactory,
  type CloudBrowserFrame,
  type CloudBrowserObservation,
  type CloudBrowserSession,
} from '@repo/domain'
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Dialog,
  type FileChooser,
  type Frame,
  type Locator,
  type Page,
  type Route,
} from 'playwright-core'

import { jpegSize } from './jpeg.ts'
import { committedAllowed, openAllowed, requestVerdict, type PageRules } from './page-rules.ts'
import { withEditableText } from './editable-text.ts'
import { findSecretFields, hideSecrets } from './secret-fields.ts'
import { runVerification, VERIFICATION_REPLY_BYTES, type VerificationSite } from './verification.ts'

/**
 * The cloud browser of a task (docs/plan/57-browser-tasks.md, Б10–Б22): Playwright connected to
 * the Chromium server of the session's container (`launchServer` behind a secret path,
 * `BrowserSessionRuntime.start`), one context for the whole task — no profile, nothing of its
 * sign-in saved anywhere, no trace, video or HAR. Every page of the context is a tab with a number
 * of its own; the one shown is streamed by `page.screencast` and takes the client's input; the
 * agent reads it as Playwright's `ai` tree, secret fields hidden, and acts on references of it.
 * Every request of every page is checked before it leaves and every committed page after it
 * (page-rules.ts); the egress proxy of the container is the barrier, this the second line.
 *
 * What it never does: log, label or echo the control endpoint; answer a dialog or a file chooser
 * on its own (they wait for the agent or the client, Б27); put a page's text, an address or a
 * value of a field into an error.
 */

export interface PlaywrightCloudBrowserOptions {
  /** Connecting to the browser server and opening the context. */
  connectTimeoutMs?: number
  /** One action of the agent end to end; never more than the domain's. */
  actionTimeoutMs?: number
  /** One event of the client's input: a move, a key, a piece of text. */
  inputTimeoutMs?: number
  /** `chromium.connect` of playwright-core; a seam for tests only. */
  connect?: (wsEndpoint: string, options: { timeout: number }) => Promise<Browser>
}

interface Settings {
  connectTimeoutMs: number
  actionTimeoutMs: number
  inputTimeoutMs: number
}

const defaults: Settings = {
  connectTimeoutMs: 15_000,
  actionTimeoutMs: browserSessionTimings.agentActionTimeoutMs,
  inputTimeoutMs: 5_000,
}

/** Reading a title never holds anything up for long. */
const TITLE_TIMEOUT_MS = 2_000
/**
 * A refused navigation commits Chromium's error page a moment later — on a loaded machine, seconds
 * later —; this much is waited for it, and for a navigation such a page interrupted.
 */
const ERROR_PAGE_SETTLE_MS = 5_000

type MouseButton = 'left' | 'middle' | 'right'

const NAMED_KEYS: ReadonlySet<string> = new Set(browserNamedKeys)
/**
 * A key Playwright's keyboard knows (its US layout): a named key of the stream or one printable
 * ASCII character. Any other it refuses as unknown — after the modifiers of a combination went
 * down, which would stay held.
 */
const knownKey = (key: string) => NAMED_KEYS.has(key) || /^[\x20-\x7e]$/.test(key)

/** The key of a combination: `Enter` of `Shift+Enter`, `+` of `Control++`. */
const comboKey = (combo: string) =>
  /^(?:(?:Alt|Control|ControlOrMeta|Meta|Shift)\+)*(.+)$/.exec(combo)?.[1] ?? combo

interface PageEntry {
  id: number
  page: Page
  title: string
  /** What the last `page` event said, so the same is not said twice. */
  reported: { url: string; title: string }
  /** Moves on with every navigation of the main frame: references of an older tree are stale. */
  generation: number
  dialog: { info: BrowserDialog; handle: Dialog } | null
  chooser: { info: BrowserChooser; handle: FileChooser } | null
  /** An upload of the agent waits for this page's file chooser itself. */
  agentChooser: boolean
  /** A navigation of this page was refused, or what it committed was dropped. */
  refused: boolean
  /** How many error pages of Chromium (`chrome-error://`) the main frame has committed. */
  errorPages: number
  /** The empty page that replaces a dropped one, while it loads. */
  dropping: Promise<void> | null
  /** Called when a dialog opens: an action that waits gives up waiting. */
  onDialog: Set<() => void>
}

interface FrameConsumer {
  onFrame: (frame: CloudBrowserFrame) => Promise<void>
  size: BrowserViewport
  quality: number
}

/** What an action may still spend; an abort or no time left ends it between steps. */
class Deadline {
  readonly #at: number
  readonly #signal: AbortSignal | undefined

  constructor(ms: number, signal?: AbortSignal) {
    this.#at = Date.now() + ms
    this.#signal = signal
  }

  /** Milliseconds left, at least one; none left — the action timed out. */
  left(): number {
    this.#signal?.throwIfAborted()
    const left = this.#at - Date.now()
    if (left <= 0) throw new PageBrowserError('timeout')
    return left
  }

  /** Milliseconds left, zero when none. */
  remaining(): number {
    return Math.max(0, this.#at - Date.now())
  }
}

const browserCodes: ReadonlySet<string> = new Set(browserTaskCodeNames)
const isBrowserTaskFailure = (error: unknown) =>
  isDomainError(error) && browserCodes.has(error.code)

/** What Playwright raised, as the port's reasons or a fixed code; a page's message never goes on. */
function failure(error: unknown, connected: boolean): Error {
  if (isPageBrowserError(error) || isBrowserTaskFailure(error)) return error as Error
  if (error instanceof Error && error.name === 'AbortError') return error
  if (
    error instanceof errors.TimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  )
    return new PageBrowserError('timeout')
  const message = error instanceof Error ? error.message : ''
  if (/ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED/.test(message)) return new PageBrowserError('denied')
  // A closed tab is a failed action; only a browser that is gone is `closed`.
  if (!connected) return new PageBrowserError('closed')
  return browserTaskError('BROWSER_ACTION_FAILED')
}

/**
 * A navigation the network refused — a host nothing answers on, one the egress proxy does not
 * serve — and not one cancelled by another: Chromium commits its own error page for it later.
 */
function refusedByNetwork(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /net::ERR_/.test(message) && !/net::ERR_ABORTED/.test(message)
}

/** A navigation Chromium's own error page took over (`chrome-error://`), not one of the page. */
function interruptedByErrorPage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /is interrupted by another navigation to "chrome-error:\/\//.test(message)
}

/** One line of a page, cut where no part of a contact is left (`clipPageText`). */
function oneLine(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex -- control characters of a page become spaces
  return clipPageText(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(), limit)
}

const clipUrl = (url: string) =>
  url.length <= browserSessionLimits.urlChars ? url : url.slice(0, browserSessionLimits.urlChars)

const DIALOG_KINDS: ReadonlySet<string> = new Set(['alert', 'confirm', 'prompt', 'beforeunload'])

/** The `accept` of a file input as a list: `image/*`, `.pdf`. */
function acceptList(accept: string | null): string[] {
  return (accept ?? '')
    .split(',')
    .map((entry) => oneLine(entry, 128))
    .filter((entry) => entry.length > 0)
    .slice(0, browserSessionLimits.chooserAccept)
}

const filePayload = (files: readonly BrowserFile[]) =>
  files.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength),
  }))

/** The connection as the port promises it; anything else never reaches a browser. */
function checkedConnection(connection: CloudBrowserConnection): PageRules {
  const socket = URL.parse(connection.endpoint)
  const rules: PageRules = {
    allowedHosts: connection.allowedHosts,
    localSites: connection.localSites,
    policy: connection.policy,
  }
  if (
    !socket ||
    socket.protocol !== 'ws:' ||
    socket.hostname !== '127.0.0.1' ||
    !isBrowserViewport(connection.viewport) ||
    !openAllowed(rules, connection.startUrl)
  )
    throw new Error('Invalid cloud browser connection')
  return rules
}

export function createPlaywrightCloudBrowser(
  options: PlaywrightCloudBrowserOptions = {},
): CloudBrowserFactory {
  const settings: Settings = {
    connectTimeoutMs: options.connectTimeoutMs ?? defaults.connectTimeoutMs,
    actionTimeoutMs: Math.min(
      options.actionTimeoutMs ?? defaults.actionTimeoutMs,
      browserSessionTimings.agentActionTimeoutMs,
    ),
    inputTimeoutMs: options.inputTimeoutMs ?? defaults.inputTimeoutMs,
  }
  const connect = options.connect ?? ((endpoint, opts) => chromium.connect(endpoint, opts))
  return {
    async open(connection, signal) {
      const rules = checkedConnection(connection)
      signal?.throwIfAborted()
      let browser: Browser
      try {
        browser = await connect(connection.endpoint, { timeout: settings.connectTimeoutMs })
      } catch {
        // The endpoint carries the secret path: never in a message.
        throw new PageBrowserError('closed')
      }
      const abort = () => void browser.close().catch(() => undefined)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const session = await PlaywrightCloudBrowser.open(browser, connection, rules, settings)
        signal?.throwIfAborted()
        return session
      } catch (error) {
        await browser.close().catch(() => undefined)
        throw failure(error, false)
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}

class PlaywrightCloudBrowser implements CloudBrowserSession {
  readonly #browser: Browser
  readonly #context: BrowserContext
  readonly #connection: CloudBrowserConnection
  readonly #rules: PageRules
  /** Who holds the browser: the policy judges the pages' requests for them (Б37). */
  #controller: BrowserController = 'agent'
  readonly #settings: Settings
  #viewport: BrowserViewport
  readonly #pages = new Map<number, PageEntry>()
  readonly #entries = new WeakMap<Page, PageEntry>()
  #nextPageId = 1
  #nextEventId = 1
  #shown: PageEntry | null = null
  /** The tree the agent may act on: the shown page's, before it navigated again. */
  #observed: { entry: PageEntry; generation: number } | null = null
  /** Keys and buttons the client holds down, and the page they went to. */
  readonly #held = {
    entry: null as PageEntry | null,
    buttons: new Set<MouseButton>(),
    /** Every key down in the page, the modifiers among them, in the order they went down. */
    keys: new Set<string>(),
    /**
     * Each key the client holds, and the modifiers it went down with. The cabinet sends a modifier
     * only with its key, never its own key-up: they go up with the key (Playwright puts the
     * modifiers it holds on every later click).
     */
    with: new Map<string, ReadonlySet<BrowserModifier>>(),
  }
  readonly #cast = {
    consumers: new Set<FrameConsumer>(),
    on: null as PageEntry | null,
    /** Moves on with every start: frames of an earlier one are dropped. */
    token: 0,
    last: null as CloudBrowserFrame | null,
    chain: Promise.resolve(),
  }
  #closing = false
  #lostReported = false

  private constructor(
    browser: Browser,
    context: BrowserContext,
    connection: CloudBrowserConnection,
    rules: PageRules,
    settings: Settings,
  ) {
    this.#browser = browser
    this.#context = context
    this.#connection = connection
    this.#rules = rules
    this.#settings = settings
    this.#viewport = { ...connection.viewport }
  }

  static async open(
    browser: Browser,
    connection: CloudBrowserConnection,
    rules: PageRules,
    settings: Settings,
  ): Promise<PlaywrightCloudBrowser> {
    // Never a trace, a video or a HAR: nothing of the session is recorded (Б19).
    const context = await browser.newContext({
      viewport: { ...connection.viewport },
      locale: 'ru-RU',
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
    })
    context.setDefaultTimeout(settings.actionTimeoutMs)
    context.setDefaultNavigationTimeout(settings.actionTimeoutMs)
    const session = new PlaywrightCloudBrowser(browser, context, connection, rules, settings)
    await session.#watch()
    const entry = await session.#newShownPage()
    // A site that does not answer yet still gives a session: the client sees the error page.
    await session
      .#run(entry, (deadline) => session.#goto(entry, connection.startUrl, deadline))
      .catch(() => undefined)
    if (!session.isConnected()) throw new PageBrowserError('closed')
    return session
  }

  async #watch() {
    await this.#context.route('**/*', (route) => this.#route(route))
    this.#context.on('page', (page) => this.#register(page))
    this.#context.on('close', () => this.#lost())
    this.#browser.on('disconnected', () => this.#lost())
  }

  // -------------------------------------------------------------------------------------------
  // What happens in the browser
  // -------------------------------------------------------------------------------------------

  #emit(event: CloudBrowserEvent) {
    if (this.#closing) return
    try {
      this.#connection.onEvent(event)
    } catch {
      // The worker's trouble is not the browser's.
    }
  }

  #lost() {
    if (this.#closing || this.#lostReported) return
    this.#lostReported = true
    this.#emit({ kind: 'closed' })
  }

  /** Every request of every page: to a host of the session, by the stack's rule. */
  async #route(route: Route) {
    const request = route.request()
    let navigation = false
    let owner: PageEntry | undefined
    let main = false
    let postData: string | null = null
    let headers: Record<string, string> = {}
    try {
      navigation = request.isNavigationRequest()
      const frame = request.frame()
      owner = this.#entries.get(frame.page())
      main = frame.parentFrame() === null
    } catch {
      // A request without a frame (a worker's): judged by its address alone.
    }
    try {
      postData = request.postData()
    } catch {
      // A body that does not read as text: the policy sees none.
    }
    try {
      headers = request.headers()
    } catch {
      // Headers that cannot be read carry no method override the policy could judge.
    }
    const verdict = requestVerdict(
      this.#rules,
      { url: request.url(), method: request.method(), postData, navigation, headers },
      this.#controller,
    )
    if (verdict === 'continue') return route.continue().catch(() => undefined)
    if (navigation && main && owner) owner.refused = true
    return route.abort(verdict).catch(() => undefined)
  }

  #register(page: Page) {
    if (this.#entries.has(page) || this.#closing) return
    // A page past the limit is closed before anyone sees it.
    if (this.#pages.size >= browserSessionLimits.tabs) {
      void page.close().catch(() => undefined)
      return
    }
    const entry: PageEntry = {
      id: this.#nextPageId++,
      page,
      title: '',
      reported: { url: '', title: '' },
      generation: 0,
      dialog: null,
      chooser: null,
      agentChooser: false,
      refused: false,
      errorPages: 0,
      dropping: null,
      onDialog: new Set(),
    }
    this.#entries.set(page, entry)
    this.#pages.set(entry.id, entry)
    page.on('dialog', (dialog) => this.#dialogOpened(entry, dialog))
    page.on('filechooser', (chooser) => void this.#chooserOpened(entry, chooser))
    page.on('framenavigated', (frame) => this.#navigated(entry, frame))
    page.on('domcontentloaded', () => void this.#refreshTitle(entry))
    page.on('load', () => void this.#refreshTitle(entry))
    page.on('close', () => this.#unregister(entry))
    page.on('crash', () => void page.close().catch(() => undefined))
    // The context keeps the size it was opened with; a page opened after a change gets the new.
    const { width, height } = this.#connection.viewport
    if (this.#viewport.width !== width || this.#viewport.height !== height)
      void page.setViewportSize(this.#viewport).catch(() => undefined)
    if (this.#shown === null) void this.#show(entry)
    else this.#emitTabs()
  }

  #unregister(entry: PageEntry) {
    if (this.#pages.get(entry.id) !== entry) return
    this.#pages.delete(entry.id)
    if (this.#observed?.entry === entry) this.#observed = null
    if (this.#held.entry === entry) this.#held.entry = null
    if (this.#shown !== entry) return this.#emitTabs()
    // The tab opened last is shown instead, none when none is left.
    const next = [...this.#pages.values()].at(-1) ?? null
    void this.#show(next)
  }

  /** Shows a page: the stream, the input and the agent's actions go to it from now on. */
  #show(entry: PageEntry | null): Promise<void> {
    if (this.#shown !== entry) {
      this.#shown = entry
      // A tree of another page is no tree to act on.
      this.#observed = null
      this.#cast.last = null
    }
    if (entry) void entry.page.bringToFront().catch(() => undefined)
    this.#emitTabs()
    this.#emit({ kind: 'dialog', dialog: entry?.dialog?.info ?? null })
    this.#emit({ kind: 'chooser', chooser: entry?.chooser?.info ?? null })
    return this.#castOn(entry)
  }

  #emitTabs() {
    this.#emit({ kind: 'tabs', tabs: this.tabs(), shown: this.#shown?.id ?? null })
  }

  #tabOf(entry: PageEntry): BrowserTab {
    return { pageId: entry.id, url: clipUrl(entry.page.url()), title: entry.title }
  }

  #reportPage(entry: PageEntry) {
    const tab = this.#tabOf(entry)
    if (tab.url === entry.reported.url && tab.title === entry.reported.title) return
    entry.reported = { url: tab.url, title: tab.title }
    this.#emit({ kind: 'page', page: tab })
  }

  async #refreshTitle(entry: PageEntry) {
    // A page under a dialog answers nothing until it is closed.
    if (entry.dialog || entry.page.isClosed()) return
    const title = await withTimeout(entry.page.title(), TITLE_TIMEOUT_MS, 'title').catch(() => null)
    if (title === null || !this.#pages.has(entry.id)) return
    entry.title = oneLine(title, browserSessionLimits.titleChars)
    this.#reportPage(entry)
  }

  #navigated(entry: PageEntry, frame: Frame) {
    const main = frame === entry.page.mainFrame()
    if (main) entry.generation++
    if (main && frame.url().startsWith('chrome-error:')) entry.errorPages++
    // A redirect is not routed: what it committed is judged here, and dropped unseen.
    if (!committedAllowed(this.#rules, frame.url(), this.#controller)) {
      entry.refused = true
      entry.dropping ??= entry.page
        .goto('about:blank', { waitUntil: 'commit', timeout: this.#settings.actionTimeoutMs })
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          entry.dropping = null
        })
      return
    }
    if (!main) return
    this.#emit({ kind: 'navigation', pageId: entry.id, url: clipUrl(frame.url()) })
    this.#reportPage(entry)
    void this.#refreshTitle(entry)
  }

  #dialogOpened(entry: PageEntry, dialog: Dialog) {
    const type = dialog.type()
    const kind = (DIALOG_KINDS.has(type) ? type : 'alert') as BrowserDialogKind
    const limit = browserSessionLimits.dialogChars
    const info: BrowserDialog = {
      id: `d${this.#nextEventId++}`,
      kind,
      message: oneLine(dialog.message(), limit),
      ...(kind === 'prompt' ? { defaultValue: oneLine(dialog.defaultValue(), limit) } : {}),
    }
    // It waits for the agent or the client, `beforeunload` too: never answered here.
    entry.dialog = { info, handle: dialog }
    for (const wake of entry.onDialog) wake()
    if (entry === this.#shown) this.#emit({ kind: 'dialog', dialog: info })
  }

  async #chooserOpened(entry: PageEntry, chooser: FileChooser) {
    // The agent's upload clicked to open it and takes it itself.
    if (entry.agentChooser) return
    const accept = await chooser
      .element()
      .getAttribute('accept')
      .catch(() => null)
    const info: BrowserChooser = {
      id: `c${this.#nextEventId++}`,
      multiple: chooser.isMultiple(),
      accept: acceptList(accept),
    }
    entry.chooser = { info, handle: chooser }
    if (entry === this.#shown) this.#emit({ kind: 'chooser', chooser: info })
  }

  // -------------------------------------------------------------------------------------------
  // Tabs and pages
  // -------------------------------------------------------------------------------------------

  tabs(): BrowserTab[] {
    return [...this.#pages.values()].map((entry) => this.#tabOf(entry))
  }

  shown(): number | null {
    return this.#shown?.id ?? null
  }

  #entry(pageId: number): PageEntry {
    const entry = this.#pages.get(pageId)
    if (!entry) throw browserTaskError('BROWSER_ACTION_FAILED')
    return entry
  }

  async #newShownPage(): Promise<PageEntry> {
    const page = await this.#context.newPage()
    this.#register(page)
    const entry = this.#entries.get(page)
    if (!entry) throw browserTaskError('BROWSER_ACTION_FAILED')
    if (this.#shown !== entry) await this.#show(entry)
    return entry
  }

  async #ensureShown(): Promise<PageEntry> {
    if (!this.isConnected()) throw new PageBrowserError('closed')
    return this.#shown ?? (await this.#newShownPage())
  }

  async selectTab(pageId: number): Promise<void> {
    await this.#show(this.#entry(pageId))
  }

  async closeTab(pageId: number): Promise<void> {
    const entry = this.#entry(pageId)
    await entry.page.close({ runBeforeUnload: false }).catch(() => undefined)
    this.#unregister(entry)
  }

  async navigate(url: string): Promise<BrowserTab> {
    if (!openAllowed(this.#rules, url, this.#controller)) throw new PageBrowserError('denied')
    const entry = await this.#ensureShown()
    if (entry.dialog) throw browserTaskError('BROWSER_ACTION_FAILED')
    await this.#run(entry, (deadline) => this.#goto(entry, url, deadline))
    return this.#tabOf(entry)
  }

  async #goto(entry: PageEntry, url: string, deadline: Deadline) {
    const go = () => entry.page.goto(url, { waitUntil: 'commit', timeout: deadline.left() })
    // The error page of an earlier refusal may commit only now, over this navigation. The
    // navigation it interrupted goes on and commits a moment later: it is waited for, and asked
    // once more only if it never commits — asked at once, it would be interrupted in turn by the
    // one it repeats.
    await go().catch(async (error: unknown) => {
      if (!interruptedByErrorPage(error)) throw error
      await entry.page
        .waitForURL(url, {
          waitUntil: 'commit',
          timeout: Math.min(deadline.left(), ERROR_PAGE_SETTLE_MS),
        })
        .catch(() => go())
    })
    await this.#settle(entry, deadline)
  }

  /**
   * The error page a navigation the network refused leaves commits after the navigation has
   * failed — later still on a loaded machine: the action ends only once it is in, counted from
   * `before`, the commits of error pages when the action began. Waiting for `load` alone is not
   * enough: it answers at once for the document already there, and the late commit then
   * interrupts the next navigation of the agent. No error page within the action's time or
   * `ERROR_PAGE_SETTLE_MS` — the browser goes on without it.
   */
  async #errorPageAfter(entry: PageEntry, error: unknown, before: number, deadline: Deadline) {
    const timeout = Math.min(deadline.remaining(), ERROR_PAGE_SETTLE_MS)
    if (timeout <= 0 || entry.page.isClosed() || !refusedByNetwork(error)) return
    if (entry.errorPages > before) return
    const mainFrame = entry.page.mainFrame()
    await entry.page
      .waitForEvent('framenavigated', {
        predicate: (frame) => frame === mainFrame && frame.url().startsWith('chrome-error:'),
        timeout,
      })
      .catch(() => undefined)
  }

  /** A click or a navigation may load a document: it is waited for within the action's time. */
  async #settle(entry: PageEntry, deadline: Deadline, atMost = Number.POSITIVE_INFINITY) {
    const timeout = Math.min(deadline.remaining(), atMost)
    if (timeout <= 0 || entry.page.isClosed()) return
    await entry.page.waitForLoadState('load', { timeout }).catch(() => undefined)
  }

  /**
   * One action in one page within its time: a refused navigation or a dropped page is `denied`,
   * whatever else happened; a dialog that opens ends the waiting (the action's result says it
   * waits). The worker sends one at a time.
   */
  async #run(
    entry: PageEntry,
    work: (deadline: Deadline) => Promise<void>,
    options: { budgetMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.isConnected()) throw new PageBrowserError('closed')
    await entry.dropping
    entry.refused = false
    const errorPages = entry.errorPages
    const deadline = new Deadline(
      options.budgetMs ?? this.#settings.actionTimeoutMs,
      options.signal,
    )
    let wake = () => {}
    const dialog = new Promise<void>((resolve) => {
      wake = resolve
    })
    entry.onDialog.add(wake)
    try {
      const working = work(deadline)
      // Left behind when a dialog stops the wait: it ends with the dialog, unheard.
      working.catch(() => undefined)
      await Promise.race([working, dialog])
    } catch (error) {
      await this.#errorPageAfter(entry, error, errorPages, deadline)
      await this.#settle(entry, deadline, ERROR_PAGE_SETTLE_MS)
      if (entry.refused) {
        await entry.dropping
        throw new PageBrowserError('denied')
      }
      throw failure(error, this.isConnected())
    } finally {
      entry.onDialog.delete(wake)
    }
    if (entry.refused) {
      await this.#settle(entry, deadline, ERROR_PAGE_SETTLE_MS)
      await entry.dropping
      throw new PageBrowserError('denied')
    }
  }

  // -------------------------------------------------------------------------------------------
  // The agent
  // -------------------------------------------------------------------------------------------

  /**
   * The element of a reference of the shown page's latest tree. Stale when the page navigated
   * or another one was shown since that tree, or when Playwright no longer finds it (it resolves
   * a reference against the last tree of its frame only).
   */
  async #target(entry: PageEntry, ref: string): Promise<Locator> {
    const stale = browserTaskError('BROWSER_STALE_OBSERVATION')
    const observed = this.#observed
    if (!browserRefSchema.safeParse(ref).success) throw stale
    if (!observed || observed.entry !== entry || observed.generation !== entry.generation)
      throw stale
    const locator = entry.page.locator(`aria-ref=${ref}`)
    const found = await locator.count().catch(() => 0)
    if (found !== 1) throw stale
    return locator
  }

  async observe(input: { ref?: string }): Promise<CloudBrowserObservation> {
    const entry = await this.#ensureShown()
    await entry.dropping
    // A page under a dialog answers nothing until it is closed; the state names the dialog.
    if (entry.dialog) {
      this.#observed = null
      return { page: this.#tabOf(entry), tree: '' }
    }
    const deadline = new Deadline(this.#settings.actionTimeoutMs)
    const generation = entry.generation
    try {
      const target = input.ref === undefined ? null : await this.#target(entry, input.ref)
      // The secret fields first: their own trees must not be the last one actions resolve on.
      const secrets = await findSecretFields(entry.page, deadline.left())
      const whole = () => entry.page.ariaSnapshot({ mode: 'ai', timeout: deadline.left() })
      // A field's own tree replaced the one the reference resolves on: the page's is read again
      // (a reference stays on its element), then the subtree.
      if (target && secrets.read > 0) await whole()
      const tree = target
        ? await target.ariaSnapshot({ mode: 'ai', timeout: deadline.left() })
        : await whole()
      const written = await withEditableText(entry.page, tree, deadline.left())
      // A navigation during the read leaves this tree stale already.
      this.#observed = { entry, generation }
      return { page: this.#tabOf(entry), tree: hideSecrets(written, secrets) }
    } catch (error) {
      throw failure(error, this.isConnected())
    }
  }

  async act(action: CloudBrowserAction, signal?: AbortSignal): Promise<CloudBrowserActResult> {
    if (action.tool === 'web_open' && !openAllowed(this.#rules, action.url))
      throw new PageBrowserError('denied')
    const entry = await this.#ensureShown()
    if (action.tool === 'web_dialog') {
      if (!entry.dialog) throw browserTaskError('BROWSER_ACTION_FAILED')
      await this.resolveDialog(entry.dialog.info.id, action.accept, action.text)
      return this.#result(entry)
    }
    // Nothing reaches a page under a dialog: the agent answers it first.
    if (entry.dialog && action.tool !== 'web_wait') throw browserTaskError('BROWSER_ACTION_FAILED')
    let extra: { matched?: boolean; uploaded?: number } = {}
    const page = entry.page
    switch (action.tool) {
      case 'web_open':
        await this.#run(entry, (deadline) => this.#goto(entry, action.url, deadline), { signal })
        break
      case 'web_click':
        await this.#run(
          entry,
          async (deadline) => {
            const target = await this.#target(entry, action.ref)
            await target.click({
              button: action.button ?? 'left',
              clickCount: action.double ? 2 : 1,
              timeout: deadline.left(),
            })
            await this.#settle(entry, deadline)
          },
          { signal },
        )
        break
      case 'web_fill':
        await this.#run(
          entry,
          async (deadline) => {
            // An input, a text area or an editable block (the editor's paragraphs).
            const target = await this.#target(entry, action.ref)
            await target.fill(action.text, { timeout: deadline.left() })
          },
          { signal },
        )
        break
      case 'web_type':
        await this.#run(
          entry,
          async (deadline) => {
            await withTimeout(page.keyboard.insertText(action.text), deadline.left(), 'type')
          },
          { signal },
        )
        break
      case 'web_press':
        // A key Playwright does not know would leave the combination's modifiers held.
        if (!isBrowserKeyCombo(action.key) || !knownKey(comboKey(action.key)))
          throw browserTaskError('BROWSER_ACTION_FAILED')
        await this.#run(
          entry,
          async (deadline) => {
            if (action.ref === undefined)
              await withTimeout(page.keyboard.press(action.key), deadline.left(), 'press')
            else
              await (
                await this.#target(entry, action.ref)
              ).press(action.key, { timeout: deadline.left() })
            await this.#settle(entry, deadline)
          },
          { signal },
        )
        break
      case 'web_scroll':
        await this.#run(entry, (deadline) => this.#scroll(entry, action, deadline), { signal })
        break
      case 'web_upload':
        await this.#run(
          entry,
          async (deadline) => {
            extra = { uploaded: await this.#upload(entry, action.ref, action.files, deadline) }
          },
          { signal },
        )
        break
      case 'web_wait':
        extra = { matched: false }
        await this.#run(
          entry,
          async (deadline) => {
            extra = { matched: await this.#wait(entry, action, deadline) }
          },
          { budgetMs: action.ms, signal },
        )
        break
    }
    return this.#result(entry, extra)
  }

  async focused(): Promise<{ role: string; name: string } | null> {
    const entry = await this.#ensureShown()
    await entry.dropping
    // A page under a dialog takes no key until it is answered.
    if (entry.dialog) return null
    try {
      // Playwright's own script reads it, in every frame (`[active]`). A whole tree, as `observe`
      // reads last: a reference stays on its element, so the agent's latest tree still acts.
      const tree = await entry.page.ariaSnapshot({
        mode: 'ai',
        timeout: this.#settings.actionTimeoutMs,
      })
      return browserTreeActiveElement(tree)
    } catch (error) {
      throw failure(error, this.isConnected())
    }
  }

  async screenshot(options: {
    qualities: readonly number[]
    maxBytes: number
  }): Promise<{ page: BrowserTab; bytes: Uint8Array; width: number; height: number }> {
    const entry = await this.#ensureShown()
    await entry.dropping
    // A page under a dialog draws nothing new until it is answered.
    if (entry.dialog) throw browserTaskError('BROWSER_ACTION_FAILED')
    const deadline = new Deadline(this.#settings.actionTimeoutMs)
    try {
      for (const quality of options.qualities) {
        // The viewport only, as the client sees it in the stream; no animation is waited for.
        const bytes = await entry.page.screenshot({
          type: 'jpeg',
          quality,
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
          timeout: deadline.left(),
        })
        if (bytes.byteLength > options.maxBytes) continue
        const size = jpegSize(bytes)
        if (size === null) break
        return { page: this.#tabOf(entry), bytes: new Uint8Array(bytes), ...size }
      }
    } catch (error) {
      throw failure(error, this.isConnected())
    }
    throw browserTaskError('BROWSER_ACTION_FAILED')
  }

  async #result(
    entry: PageEntry,
    extra: { matched?: boolean; uploaded?: number } = {},
  ): Promise<CloudBrowserActResult> {
    await this.#refreshTitle(entry)
    return { page: this.#tabOf(entry), ...extra }
  }

  async #scroll(
    entry: PageEntry,
    action: Extract<CloudBrowserAction, { tool: 'web_scroll' }>,
    deadline: Deadline,
  ) {
    const vertical = action.direction === 'up' || action.direction === 'down'
    const sign = action.direction === 'up' || action.direction === 'left' ? -1 : 1
    // A screen of the window when the agent names no amount.
    const amount = action.amount ?? (vertical ? this.#viewport.height : this.#viewport.width)
    let point = { x: this.#viewport.width / 2, y: this.#viewport.height / 2 }
    if (action.ref !== undefined) {
      // The element is brought into view and the wheel turns over it: a panel scrolls its own.
      const target = await this.#target(entry, action.ref)
      await target.scrollIntoViewIfNeeded({ timeout: deadline.left() })
      const box = await target.boundingBox({ timeout: deadline.left() })
      if (box)
        point = {
          x: Math.min(Math.max(box.x + box.width / 2, 0), this.#viewport.width - 1),
          y: Math.min(Math.max(box.y + box.height / 2, 0), this.#viewport.height - 1),
        }
    }
    const mouse = entry.page.mouse
    await withTimeout(mouse.move(point.x, point.y), deadline.left(), 'scroll')
    await withTimeout(
      mouse.wheel(vertical ? 0 : sign * amount, vertical ? sign * amount : 0),
      deadline.left(),
      'scroll',
    )
  }

  /**
   * Files of the task into a page (Б27): straight into a file input the reference names, through
   * the file chooser a click on it opens (the chooser is awaited before the click), or — with no
   * reference — into the chooser that waits. A page that does not take them refuses the upload.
   */
  async #upload(
    entry: PageEntry,
    ref: string | undefined,
    files: readonly BrowserFile[],
    deadline: Deadline,
  ): Promise<number> {
    const refused = browserTaskError('BROWSER_UPLOAD_REFUSED')
    if (files.length === 0 || files.length > BROWSER_CHOOSER_MAX_FILES) throw refused
    const payload = filePayload(files)
    const into = async (work: () => Promise<void>) => {
      try {
        await work()
      } catch (error) {
        const reason = failure(error, this.isConnected())
        throw isPageBrowserError(reason) ? reason : refused
      }
    }
    if (ref === undefined) {
      const waiting = entry.chooser
      if (!waiting) throw browserTaskError('BROWSER_ACTION_FAILED')
      if (!waiting.info.multiple && files.length > 1) throw refused
      entry.chooser = null
      if (entry === this.#shown) this.#emit({ kind: 'chooser', chooser: null })
      await into(() => waiting.handle.setFiles(payload, { timeout: deadline.left() }))
      return files.length
    }
    const target = await this.#target(entry, ref)
    const type = await target.getAttribute('type', { timeout: deadline.left() })
    if (type?.toLowerCase() === 'file') {
      await into(() => target.setInputFiles(payload, { timeout: deadline.left() }))
      return files.length
    }
    entry.agentChooser = true
    try {
      const opened = entry.page.waitForEvent('filechooser', { timeout: deadline.left() })
      opened.catch(() => undefined)
      await target.click({ timeout: deadline.left() })
      const chooser = await opened
      if (!chooser.isMultiple() && files.length > 1) throw refused
      await into(() => chooser.setFiles(payload, { timeout: deadline.left() }))
      return files.length
    } finally {
      entry.agentChooser = false
    }
  }

  async #wait(
    entry: PageEntry,
    action: Extract<CloudBrowserAction, { tool: 'web_wait' }>,
    deadline: Deadline,
  ): Promise<boolean> {
    const page = entry.page
    if (action.text !== undefined) {
      const text = action.text
      // In any frame: the block editor's canvas is one.
      const shown = page
        .frames()
        .map((frame) =>
          frame.getByText(text).first().waitFor({ state: 'visible', timeout: deadline.left() }),
        )
      return Promise.any(shown).then(
        () => true,
        () => false,
      )
    }
    if (action.until !== undefined)
      return page.waitForLoadState(action.until, { timeout: deadline.left() }).then(
        () => true,
        () => false,
      )
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline.remaining() - 1)))
    return true
  }

  // -------------------------------------------------------------------------------------------
  // The stream and the client's input
  // -------------------------------------------------------------------------------------------

  async startFrames(
    onFrame: (frame: CloudBrowserFrame) => Promise<void>,
    options: { size: BrowserViewport; quality: number },
  ): Promise<() => Promise<void>> {
    const consumer: FrameConsumer = { onFrame, size: { ...options.size }, quality: options.quality }
    this.#cast.consumers.add(consumer)
    // The last picture at once, so a new viewer does not wait for the page to change.
    const last = this.#cast.last
    if (last) void consumer.onFrame(last).catch(() => undefined)
    if (this.#cast.consumers.size === 1) await this.#castOn(this.#shown)
    let stopped = false
    return async () => {
      if (stopped) return
      stopped = true
      this.#cast.consumers.delete(consumer)
      if (this.#cast.consumers.size === 0) await this.#castOn(null)
    }
  }

  /**
   * Runs the screencast on `target` alone while anyone takes frames: stopped on the page shown
   * before, started on the one shown now, restarted when the window changes size. The options are
   * the first consumer's. In order, one change at a time.
   */
  #castOn(target: PageEntry | null, restart = false): Promise<void> {
    const run = async () => {
      const wanted = this.#cast.consumers.size > 0 && !this.#closing ? target : null
      if (!restart && wanted === this.#cast.on) return
      const previous = this.#cast.on
      this.#cast.on = null
      this.#cast.token++
      if (previous && !previous.page.isClosed())
        await previous.page.screencast.stop().catch(() => undefined)
      const [first] = this.#cast.consumers
      if (!wanted || !first || wanted.page.isClosed()) return
      const token = this.#cast.token
      this.#cast.on = wanted
      await wanted.page.screencast
        .start({
          size: first.size,
          quality: first.quality,
          onFrame: (frame) => this.#frame(wanted, token, frame),
        })
        .catch(() => {
          if (this.#cast.on === wanted) this.#cast.on = null
        })
    }
    this.#cast.chain = this.#cast.chain.then(run, run)
    return this.#cast.chain
  }

  /**
   * One frame of Chromium. Its acknowledgement waits for the consumers' promises, so Chromium
   * captures no faster than they take (Б13). A frame of a screencast stopped since, or of a page
   * no longer shown, is dropped.
   */
  async #frame(
    entry: PageEntry,
    token: number,
    frame: { data: Buffer; timestamp: number },
  ): Promise<void> {
    if (token !== this.#cast.token || entry !== this.#shown) return
    const jpeg = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
    const size = jpegSize(jpeg)
    if (!size) return
    const delivered: CloudBrowserFrame = {
      pageId: entry.id,
      jpeg,
      timestamp: frame.timestamp,
      width: size.width,
      height: size.height,
    }
    this.#cast.last = delivered
    await Promise.all(
      [...this.#cast.consumers].map((consumer) =>
        consumer.onFrame(delivered).catch(() => undefined),
      ),
    )
  }

  async input(event: BrowserInputEvent): Promise<void> {
    const entry = this.#shown
    // A page under a dialog takes no input until the dialog is answered (the Радити window).
    if (!entry || entry.dialog || entry.page.isClosed()) return
    if (this.#held.entry !== entry) {
      await this.releaseInputs()
      this.#held.entry = entry
    }
    try {
      await withTimeout(this.#send(entry.page, event), this.#settings.inputTimeoutMs, 'input')
    } catch (error) {
      throw failure(error, this.isConnected())
    }
  }

  async #send(page: Page, event: BrowserInputEvent) {
    const held = this.#held
    switch (event.kind) {
      case 'mouse': {
        await this.#releaseModifiers(page, browserModifiers)
        await page.mouse.move(event.x, event.y)
        if (event.button === 'none' || event.type === 'move') return
        const options = { button: event.button, clickCount: Math.max(1, event.clickCount) }
        if (event.type === 'down') {
          held.buttons.add(event.button)
          await page.mouse.down(options)
        } else {
          held.buttons.delete(event.button)
          await page.mouse.up(options)
        }
        return
      }
      case 'wheel':
        await this.#releaseModifiers(page, browserModifiers)
        await page.mouse.move(event.x, event.y)
        await page.mouse.wheel(event.dx, event.dy)
        return
      case 'key': {
        // Playwright refuses a key it does not know only after the modifiers went down.
        if (!knownKey(event.key)) return
        if (event.type === 'up') {
          const pressedWith = held.with.get(event.key) ?? new Set()
          held.with.delete(event.key)
          held.keys.delete(event.key)
          await page.keyboard.up(event.key)
          await this.#releaseModifiers(page, pressedWith)
          return
        }
        // The modifiers the event says are held, and no other: a lost key-up does not stick.
        for (const modifier of browserModifiers) {
          if (modifier === event.key) continue
          const wanted = event.modifiers.includes(modifier)
          if (wanted && !held.keys.has(modifier)) {
            held.keys.add(modifier)
            await page.keyboard.down(modifier)
          } else if (!wanted && held.keys.has(modifier)) {
            held.keys.delete(modifier)
            held.with.delete(modifier)
            await page.keyboard.up(modifier)
          }
        }
        held.keys.add(event.key)
        held.with.set(event.key, new Set(event.modifiers.filter((key) => key !== event.key)))
        await page.keyboard.down(event.key)
        return
      }
      case 'text':
        // A paste or a finished composition, in any script, where the focus is.
        await page.keyboard.insertText(event.text)
        return
    }
  }

  /**
   * Lets go of those of `modifiers` the page holds that no key the client still holds needs: one
   * pressed as a key of its own, or one another key went down with, stays down.
   */
  async #releaseModifiers(page: Page, modifiers: Iterable<BrowserModifier>) {
    const held = this.#held
    for (const modifier of modifiers) {
      if (!held.keys.has(modifier) || held.with.has(modifier)) continue
      if ([...held.with.values()].some((pressedWith) => pressedWith.has(modifier))) continue
      held.keys.delete(modifier)
      await page.keyboard.up(modifier)
    }
  }

  async releaseInputs(): Promise<void> {
    const { entry } = this.#held
    const buttons = [...this.#held.buttons]
    const keys = [...this.#held.keys].reverse()
    this.#held.buttons.clear()
    this.#held.keys.clear()
    this.#held.with.clear()
    if (!entry || entry.page.isClosed()) return
    const timeout = this.#settings.inputTimeoutMs
    for (const button of buttons)
      await withTimeout(entry.page.mouse.up({ button }), timeout, 'release').catch(() => undefined)
    for (const key of keys)
      await withTimeout(entry.page.keyboard.up(key), timeout, 'release').catch(() => undefined)
  }

  async resolveDialog(id: string, accept: boolean, text?: string): Promise<void> {
    const entry = [...this.#pages.values()].find((candidate) => candidate.dialog?.info.id === id)
    const waiting = entry?.dialog
    if (!entry || !waiting) throw browserTaskError('BROWSER_ACTION_FAILED')
    entry.dialog = null
    const { handle, info } = waiting
    const answer = accept
      ? handle.accept(info.kind === 'prompt' ? (text ?? info.defaultValue ?? '') : undefined)
      : handle.dismiss()
    await withTimeout(answer, this.#settings.actionTimeoutMs, 'dialog').catch((error: unknown) => {
      throw failure(error, this.isConnected())
    })
    if (entry === this.#shown) this.#emit({ kind: 'dialog', dialog: null })
    // Key-ups the dialog swallowed would leave keys down in the page.
    await this.releaseInputs()
    void this.#refreshTitle(entry)
  }

  async setChooserFiles(chooserId: string, files: BrowserFile[]): Promise<void> {
    const entry = [...this.#pages.values()].find(
      (candidate) => candidate.chooser?.info.id === chooserId,
    )
    const waiting = entry?.chooser
    if (!entry || !waiting) throw browserTaskError('BROWSER_ACTION_FAILED')
    entry.chooser = null
    if (entry === this.#shown) this.#emit({ kind: 'chooser', chooser: null })
    // None: cancelled, as the system's «Отмена» — the page's input keeps what it had.
    if (files.length === 0) return
    const refused = browserTaskError('BROWSER_UPLOAD_REFUSED')
    if (files.length > BROWSER_CHOOSER_MAX_FILES || (!waiting.info.multiple && files.length > 1))
      throw refused
    try {
      await waiting.handle.setFiles(filePayload(files), { timeout: this.#settings.actionTimeoutMs })
    } catch (error) {
      const reason = failure(error, this.isConnected())
      throw isPageBrowserError(reason) ? reason : refused
    }
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    if (!isBrowserViewport(viewport)) throw badRequest('Invalid browser window size')
    this.#viewport = { width: viewport.width, height: viewport.height }
    this.#cast.last = null
    const timeout = this.#settings.actionTimeoutMs
    for (const entry of this.#pages.values()) {
      const resized = withTimeout(entry.page.setViewportSize(this.#viewport), timeout, 'viewport')
      if (entry !== this.#shown) await resized.catch(() => undefined)
      else
        await resized.catch((error: unknown) => {
          throw failure(error, this.isConnected())
        })
    }
    await this.#castOn(this.#shown, true)
  }

  setController(controller: BrowserController): void {
    this.#controller = controller
  }

  // -------------------------------------------------------------------------------------------
  // The saved sign-in (Б36)
  // -------------------------------------------------------------------------------------------

  /**
   * Whether a page shows the stack's sign-in form of the site itself: its origin is the start
   * page's — another host the session reaches (one of the stack's, `BROWSER_EXTRA_HOSTS`) never
   * gets the site's sign-in —, and the policy reads its path as the form. A policy that cannot
   * read it says no.
   */
  #onSignInPage(entry: PageEntry, form: BrowserSignInForm): boolean {
    const url = URL.parse(entry.page.url())
    const site = URL.parse(this.#connection.startUrl)
    if (!url || !site || url.origin !== site.origin) return false
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    try {
      return form.isSignInPage(`${url.pathname}${url.search}`)
    } catch {
      return false
    }
  }

  async signIn(credentials: BrowserSignIn): Promise<BrowserSignInOutcome> {
    const form = this.#rules.policy.signIn
    const entry = await this.#ensureShown()
    if (!form || entry.dialog || !this.#onSignInPage(entry, form)) return 'absent'
    const { page } = entry
    let signedIn = false
    try {
      try {
        await this.#run(entry, async (deadline) => {
          // The page's own form by the stack's selectors, never a reference an agent could hold.
          await page.locator(form.login).fill(credentials.login, { timeout: deadline.left() })
          await page.locator(form.password).fill(credentials.password, { timeout: deadline.left() })
          const sent = page
            .waitForEvent('framenavigated', {
              predicate: (frame) => frame === page.mainFrame(),
              timeout: deadline.left(),
            })
            // A script of the form that keeps it (a CAPTCHA) sends nothing: read below.
            .catch(() => undefined)
          await page.locator(form.submit).click({ timeout: deadline.left() })
          await sent
          await this.#settle(entry, deadline)
        })
      } catch (error) {
        // Signed in, then sent where the task may not go (the dashboard): the start page instead.
        if (!isPageBrowserError(error) || error.reason !== 'denied') throw error
        await this.navigate(this.#connection.startUrl)
      }
      signedIn = !this.#onSignInPage(entry, form)
      return signedIn ? 'signed_in' : 'refused'
    } finally {
      // Whatever stopped it — the form came back, a step failed —, nothing of the saved sign-in
      // stays on the page for an observation.
      if (!signedIn) await this.#forgetSignIn(entry, form)
    }
  }

  /**
   * Empties the fields of a sign-in form the browser filled; one it cannot empty is left for an
   * empty document, so no value of the saved sign-in is read from it.
   */
  async #forgetSignIn(entry: PageEntry, form: BrowserSignInForm): Promise<void> {
    if (!this.#onSignInPage(entry, form)) return
    try {
      await this.#run(entry, async (deadline) => {
        await entry.page.locator(form.login).fill('', { timeout: deadline.left() })
        await entry.page.locator(form.password).fill('', { timeout: deadline.left() })
      })
    } catch {
      await entry.page.goto('about:blank').catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------------------------
  // The trusted read, the end
  // -------------------------------------------------------------------------------------------

  async verify(plan: BrowserVerificationPlan): Promise<BrowserVerificationReading> {
    return runVerification(plan, this.#site(), async (url, headers) => {
      const response = await this.#context.request.get(url, {
        headers,
        timeout: browserVerificationLimits.stepTimeoutMs,
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      try {
        const declared = Number(response.headers()['content-length'])
        const body =
          Number.isFinite(declared) && declared > VERIFICATION_REPLY_BYTES
            ? null
            : await response.body()
        return {
          status: response.status(),
          location: response.headers()['location'] ?? null,
          bytes: body && body.byteLength <= VERIFICATION_REPLY_BYTES ? new Uint8Array(body) : null,
        }
      } finally {
        await response.dispose().catch(() => undefined)
      }
    })
  }

  /**
   * The site a read goes to: its address and its `www.` twin, starting where the shown page is
   * when that is one of them — where the client signed in, the cookies of the read are.
   */
  #site(): VerificationSite {
    const start = new URL(this.#connection.startUrl)
    const twin = new URL(start.origin)
    twin.hostname = start.hostname.startsWith('www.')
      ? start.hostname.slice('www.'.length)
      : `www.${start.hostname}`
    const origins = new Set([start.origin, twin.origin])
    const shown = URL.parse(this.#shown?.page.url() ?? '')?.origin ?? ''
    return { origin: origins.has(shown) ? shown : start.origin, origins }
  }

  isConnected(): boolean {
    return !this.#closing && this.#browser.isConnected()
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.#cast.consumers.clear()
    this.#cast.token++
    // The context goes with everything in it; the server and its container are the runtime's.
    await this.#context.close().catch(() => undefined)
    await this.#browser.close().catch(() => undefined)
  }
}
