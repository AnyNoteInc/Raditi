import {
  clipPageText,
  isPreviewPath,
  PageBrowserError,
  pageClickInputSchema,
  pageExpectInputSchema,
  pageFillInputSchema,
  pageNavigateInputSchema,
  pageSnapshotInputSchema,
  previewGatewayPaths,
  type PageBrowser,
  type PageBrowserConnection,
  type PageBrowserFactory,
  type PageClickInput,
  type PageConsoleEntry,
  type PageExpectInput,
  type PageFillInput,
  type PageLocation,
  type PageNavigateInput,
  type PageNetworkEntry,
  type PageScreenshot,
  type PageSnapshot,
  type PageSnapshotInput,
} from '@repo/domain'
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Route,
} from 'playwright-core'

/**
 * The agent's browser on a preview (docs/plan/53-chat-preview-release.md, Р21): Playwright
 * connected to the Chromium server of the preview's browser container (`launchServer` behind a
 * secret path, `PreviewRuntime.startBrowser`). Each connection is one context of its own — no
 * profile, no cookie of anyone else — that enters through the gateway with its one-time ticket
 * and gets the gateway's session of its own. Every request a page makes is checked here before
 * it leaves: to the preview's origin only, and never what the stack's policy denies; the network
 * of the container is the barrier, this is the second line and what the model is told.
 */

export interface PlaywrightBrowserOptions {
  /** Connecting to the browser server and opening the context. */
  connectTimeoutMs?: number
  navigationTimeoutMs?: number
  /** A click, a fill or an expectation without its own `timeoutMs`. */
  actionTimeoutMs?: number
  viewport?: { width: number; height: number }
  /** Entries kept between two reads of the console or the network; the oldest go first. */
  maxConsoleEntries?: number
  maxNetworkEntries?: number
  /** `chromium.connect` of playwright-core; a seam for tests only. */
  connect?: (wsEndpoint: string, options: { timeout: number }) => Promise<Browser>
}

const defaults = {
  connectTimeoutMs: 15_000,
  navigationTimeoutMs: 20_000,
  actionTimeoutMs: 10_000,
  viewport: { width: 1280, height: 800 },
  maxConsoleEntries: 200,
  maxNetworkEntries: 500,
}
/** A console message as kept: one line of a bounded length, never more of a page than that. */
const CONSOLE_TEXT_LIMIT = 2_000
/** Links of a snapshot: their text and the path of a link to the preview itself. */
const SNAPSHOT_LINKS = 200
const LINK_TEXT_LIMIT = 200
const SNAPSHOT_DEFAULT_CHARS = 60_000

/** Whether the stack's policy denies a request of a page; a policy that cannot read it does. */
function denied(connection: PageBrowserConnection, request: Request, url: URL): boolean {
  try {
    return connection.denyRequest({
      path: `${url.pathname}${url.search}`,
      method: request.method(),
      postData: request.postData(),
    })
  } catch {
    return true
  }
}

/**
 * A navigation the network refused — the policy's abort, a host the gateway does not serve — and
 * not one cancelled by another: Chromium commits its own error page for it a moment later.
 */
function refusedByNetwork(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /net::ERR_/.test(message) && !/net::ERR_ABORTED/.test(message)
}

/**
 * How long the error page of a refused navigation, or a navigation an error page interrupted, is
 * waited for before the browser goes on without it.
 */
const SETTLE_NAVIGATION_MS = 5_000

/** A navigation Chromium's own error page took over (`chrome-error://`), not one of the page. */
function interruptedByErrorPage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /is interrupted by another navigation to "chrome-error:\/\//.test(message)
}

/** What Playwright raised, as one of the port's reasons; a page's message never goes on. */
function failure(error: unknown, connected: boolean): Error {
  if (error instanceof PageBrowserError) return error
  if (error instanceof errors.TimeoutError) return new PageBrowserError('timeout')
  const message = error instanceof Error ? error.message : ''
  if (/ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED/.test(message)) return new PageBrowserError('denied')
  if (!connected || /has been closed|Target closed|Browser closed/i.test(message))
    return new PageBrowserError('closed')
  return new Error('Page browser action failed')
}

const consoleLevels: Record<string, PageConsoleEntry['level']> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

/** One line of a page, cut where no part of a contact is left (`clipPageText`). */
function oneLine(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex -- control characters of a page become spaces
  return clipPageText(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(), limit)
}

/** Keeps the last `limit` entries. */
class Ring<T> {
  #items: T[] = []
  readonly #limit: number
  constructor(limit: number) {
    this.#limit = limit
  }
  push(item: T) {
    this.#items.push(item)
    if (this.#items.length > this.#limit) this.#items.splice(0, this.#items.length - this.#limit)
  }
  drain(): T[] {
    const items = this.#items
    this.#items = []
    return items
  }
}

function checkedConnection(connection: PageBrowserConnection): URL {
  const origin = URL.parse(connection.origin)
  const socket = URL.parse(connection.endpoint.wsEndpoint)
  const enter = URL.parse(connection.enterUrl)
  if (
    !origin ||
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== connection.origin ||
    !socket ||
    socket.protocol !== 'ws:' ||
    socket.hostname !== '127.0.0.1' ||
    !enter ||
    enter.origin !== origin.origin ||
    enter.pathname !== previewGatewayPaths.enter
  )
    throw new Error('Invalid page browser connection')
  return origin
}

export function createPlaywrightBrowserFactory(
  options: PlaywrightBrowserOptions = {},
): PageBrowserFactory {
  const settings = { ...defaults, ...options }
  const connect = options.connect ?? ((endpoint, opts) => chromium.connect(endpoint, opts))
  return {
    async connect(connection, signal) {
      const origin = checkedConnection(connection)
      signal?.throwIfAborted()
      let browser: Browser
      try {
        browser = await connect(connection.endpoint.wsEndpoint, {
          timeout: settings.connectTimeoutMs,
        })
      } catch {
        // The endpoint carries the secret path: never in a message.
        throw new PageBrowserError('closed')
      }
      const abort = () => void browser.close().catch(() => undefined)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const opened = await PlaywrightPageBrowser.open(browser, origin, connection, settings)
        signal?.throwIfAborted()
        return opened
      } catch (error) {
        await browser.close().catch(() => undefined)
        throw failure(error, false)
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}

type Settings = typeof defaults

class PlaywrightPageBrowser implements PageBrowser {
  readonly #browser: Browser
  readonly #context: BrowserContext
  readonly #page: Page
  readonly #origin: URL
  readonly #settings: Settings
  readonly #console: Ring<PageConsoleEntry>
  readonly #network: Ring<PageNetworkEntry>
  /** The status of the last document the main frame loaded, and how many it loaded. */
  #document: { status: number | null; count: number } = { status: null, count: 0 }
  /**
   * The main frame was sent to another origin since the action began. A redirect is not routed
   * (Playwright calls the handler for the first URL of a chain only), so it is seen here; the
   * request itself goes to the gateway, which serves the preview's host alone.
   */
  #leftOrigin = false
  /**
   * A request of the page was redirected to a path the stack's policy denies. A redirect is not
   * routed, so it is sent before it is seen: the action is refused and the page it loaded is
   * dropped before anything reads it.
   */
  #deniedRedirect = false
  /** How many error pages of Chromium (`chrome-error://`) the main frame has committed. */
  #errorPages = 0

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    origin: URL,
    settings: Settings,
  ) {
    this.#browser = browser
    this.#context = context
    this.#page = page
    this.#origin = origin
    this.#settings = settings
    this.#console = new Ring(settings.maxConsoleEntries)
    this.#network = new Ring(settings.maxNetworkEntries)
  }

  static async open(
    browser: Browser,
    origin: URL,
    connection: PageBrowserConnection,
    settings: Settings,
  ): Promise<PlaywrightPageBrowser> {
    const context = await browser.newContext({
      viewport: settings.viewport,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: 'ru-RU',
      permissions: [],
    })
    context.setDefaultTimeout(settings.actionTimeoutMs)
    context.setDefaultNavigationTimeout(settings.navigationTimeoutMs)
    const page = await context.newPage()
    const opened = new PlaywrightPageBrowser(browser, context, page, origin, settings)
    await opened.#watch(connection)
    const response = await page.goto(connection.enterUrl, { waitUntil: 'domcontentloaded' })
    // The gateway trades a good ticket for a session and a redirect to the page it was for; a
    // spent, expired or unknown one is answered on the entry path itself (403, a page saying so).
    // Without that redirect the context has no session, and every later page would be refused.
    const landed = URL.parse(page.url())
    if (
      !response ||
      response.request().redirectedFrom() === null ||
      landed?.origin !== origin.origin ||
      landed.pathname === previewGatewayPaths.enter
    )
      throw new PageBrowserError('denied')
    return opened
  }

  async #watch(connection: PageBrowserConnection) {
    const context = this.#context
    const page = this.#page
    // Every request of every page of the context: the preview's origin only, by the stack's rule.
    await context.route('**/*', (route: Route) => {
      const request = route.request()
      const url = URL.parse(request.url())
      if (!url || url.origin !== this.#origin.origin) return route.abort('blockedbyclient')
      return denied(connection, request, url) ? route.abort('accessdenied') : route.continue()
    })
    // A page that opens another one, a dialog or a download never waits for anyone.
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => undefined)
    })
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined))
    page.on('console', (message: ConsoleMessage) =>
      this.#console.push({
        level: consoleLevels[message.type()] ?? 'log',
        text: oneLine(message.text(), CONSOLE_TEXT_LIMIT),
      }),
    )
    page.on('pageerror', (error) =>
      this.#console.push({ level: 'error', text: oneLine(error.message, CONSOLE_TEXT_LIMIT) }),
    )
    page.on('request', (request) => {
      const url = URL.parse(request.url())
      let main: boolean
      let redirected: boolean
      try {
        main = request.isNavigationRequest() && request.frame() === page.mainFrame()
        redirected = request.redirectedFrom() !== null
      } catch {
        return
      }
      if (!url || url.origin !== this.#origin.origin) {
        if (main) this.#leftOrigin = true
        return
      }
      // Any request of the page, a document or not: the route saw only the first of its chain.
      if (redirected && denied(connection, request, url)) this.#deniedRedirect = true
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().startsWith('chrome-error:')) this.#errorPages++
    })
    page.on('response', (response) => {
      const request = response.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        this.#document = { status: response.status(), count: this.#document.count + 1 }
    })
    page.on('requestfinished', (request) => {
      void request
        .response()
        .then((response) => this.#network.push(this.#entry(request, response?.status() ?? null)))
        .catch(() => undefined)
    })
    page.on('requestfailed', (request) => this.#network.push(this.#entry(request, null)))
  }

  #entry(request: Request, status: number | null): PageNetworkEntry {
    const url = URL.parse(request.url())
    return {
      method: request.method(),
      path: url && url.origin === this.#origin.origin ? `${url.pathname}${url.search}` : null,
      status,
      resourceType: request.resourceType(),
    }
  }

  /** One action: a way out of the preview is refused, whatever the page did of it. */
  async #act<T>(work: () => Promise<T>): Promise<T> {
    await this.#dropDenied()
    this.#leftOrigin = false
    const errorPages = this.#errorPages
    let result: T
    try {
      result = await work()
    } catch (error) {
      // A refused or failed navigation commits Chromium's error page a moment later: let it,
      // or it interrupts the next action of the agent.
      await this.#errorPageAfter(error, errorPages)
      await this.#settle()
      if (this.#leftOrigin || this.#deniedRedirect) {
        await this.#dropDenied()
        throw new PageBrowserError('denied')
      }
      throw failure(error, this.isConnected())
    }
    if (this.#leftOrigin || this.#deniedRedirect) {
      await this.#settle()
      await this.#dropDenied()
      throw new PageBrowserError('denied')
    }
    return result
  }

  /**
   * What a redirect the policy denies loaded — in this action or on its own between two — is
   * left for an empty page before anything of it is read.
   */
  async #dropDenied() {
    if (!this.#deniedRedirect) return
    this.#deniedRedirect = false
    if (!this.#page.isClosed())
      await this.#page.goto('about:blank', { waitUntil: 'commit' }).catch(() => undefined)
  }

  /** Where the page is: a path of the preview — another origin is never named. */
  async #location(before: number): Promise<PageLocation> {
    const url = URL.parse(this.#page.url())
    const path = url && url.origin === this.#origin.origin ? `${url.pathname}${url.search}` : '/'
    return {
      path: isPreviewPath(path) ? path : '/',
      title: oneLine(await this.#page.title(), 1_000),
      status: this.#document.count > before ? this.#document.status : null,
    }
  }

  /**
   * The error page a navigation the network refused leaves commits after the navigation has
   * failed — later still on a loaded machine: the action ends only once it is in, counted from
   * `before`, the commits of error pages when the action began. Waiting for `load` alone is not
   * enough: it answers at once for the document already there — an earlier error page, as often
   * as not —, and the late commit then interrupts the next navigation of the agent (preview.yml
   * on GitHub's runners, 30.10.2026). No error page in `SETTLE_NAVIGATION_MS` — the browser goes
   * on without it.
   */
  async #errorPageAfter(error: unknown, before: number) {
    if (this.#page.isClosed() || !refusedByNetwork(error) || this.#errorPages > before) return
    const mainFrame = this.#page.mainFrame()
    await this.#page
      .waitForEvent('framenavigated', {
        predicate: (frame) => frame === mainFrame && frame.url().startsWith('chrome-error:'),
        timeout: SETTLE_NAVIGATION_MS,
      })
      .catch(() => undefined)
  }

  /** A click or a submit may start a navigation: its document is waited for, briefly. */
  async #settle() {
    if (this.#page.isClosed()) return
    await this.#page
      .waitForLoadState('load', { timeout: this.#settings.actionTimeoutMs })
      .catch(() => undefined)
  }

  navigate(input: PageNavigateInput): Promise<PageLocation> {
    const { path, waitUntil } = pageNavigateInputSchema.parse(input)
    return this.#act(async () => {
      const before = this.#document.count
      const target = `${this.#origin.origin}${path}`
      const options = { waitUntil: waitUntil ?? 'load' }
      // The error page of an earlier refusal may commit only now, over this navigation. The
      // navigation it interrupted goes on and lands a moment later: it is waited for, and asked
      // once more only if it never lands — asked at once, it would be interrupted in turn by the
      // one it repeats.
      await this.#page.goto(target, options).catch(async (error: unknown) => {
        if (!interruptedByErrorPage(error)) throw error
        await this.#page
          .waitForURL(target, { waitUntil: options.waitUntil, timeout: SETTLE_NAVIGATION_MS })
          .catch(() => this.#page.goto(target, options))
      })
      if (URL.parse(this.#page.url())?.origin !== this.#origin.origin)
        throw new PageBrowserError('denied')
      return this.#location(before)
    })
  }

  click(input: PageClickInput): Promise<PageLocation> {
    const parsed = pageClickInputSchema.parse(input)
    return this.#act(async () => {
      const before = this.#document.count
      const locator =
        'selector' in parsed
          ? this.#page.locator(parsed.selector)
          : this.#page.getByRole(parsed.role as Parameters<Page['getByRole']>[0], {
              ...(parsed.name === undefined ? {} : { name: parsed.name }),
            })
      await locator.first().click({ timeout: parsed.timeoutMs ?? this.#settings.actionTimeoutMs })
      await this.#settle()
      return this.#location(before)
    })
  }

  fill(input: PageFillInput): Promise<PageLocation> {
    const parsed = pageFillInputSchema.parse(input)
    return this.#act(async () => {
      const before = this.#document.count
      await this.#page
        .locator(parsed.selector)
        .first()
        .fill(parsed.value, { timeout: parsed.timeoutMs ?? this.#settings.actionTimeoutMs })
      return this.#location(before)
    })
  }

  async expect(input: PageExpectInput): Promise<{ passed: boolean }> {
    const parsed = pageExpectInputSchema.parse(input)
    // An expectation reads the page too: never one a denied redirect loaded.
    await this.#dropDenied()
    const timeout = parsed.timeoutMs ?? this.#settings.actionTimeoutMs
    const base = this.#page.locator(parsed.selector)
    try {
      if (parsed.text !== undefined)
        await base.filter({ hasText: parsed.text }).first().waitFor({ state: 'visible', timeout })
      else await base.first().waitFor({ state: parsed.state ?? 'visible', timeout })
      return { passed: true }
    } catch (error) {
      const reason = failure(error, this.isConnected())
      // An expectation that did not come true in time is an answer, not a failure.
      if (reason instanceof PageBrowserError && reason.reason === 'timeout')
        return { passed: false }
      throw reason
    }
  }

  snapshot(input: PageSnapshotInput): Promise<PageSnapshot> {
    const parsed = pageSnapshotInputSchema.parse(input)
    return this.#act(async () => {
      // The status of the document on screen, whichever action loaded it.
      const location = await this.#location(-1)
      const tree = await this.#page.ariaSnapshot({ timeout: this.#settings.actionTimeoutMs })
      const anchors = await this.#page.locator('a[href]').evaluateAll(
        // Runs in the page: what it answers is text for the model, checked again here.
        (elements: Array<{ textContent: string | null; href?: unknown }>, limit: number) =>
          elements.slice(0, limit).map((element) => ({
            text: element.textContent ?? '',
            href: element.href,
          })),
        SNAPSHOT_LINKS,
      )
      const links: PageSnapshot['links'] = []
      for (const anchor of anchors) {
        const url = URL.parse(String(anchor.href))
        if (!url || url.origin !== this.#origin.origin) continue
        const path = `${url.pathname}${url.search}`
        if (isPreviewPath(path))
          links.push({ text: oneLine(String(anchor.text), LINK_TEXT_LIMIT), path })
      }
      const limit = parsed.maxChars ?? SNAPSHOT_DEFAULT_CHARS
      return { ...location, text: clipPageText(tree, limit), links }
    })
  }

  screenshot(): Promise<PageScreenshot> {
    return this.#act(async () => {
      const bytes = await this.#page.screenshot({
        type: 'png',
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
        timeout: this.#settings.actionTimeoutMs,
      })
      const size = this.#page.viewportSize() ?? this.#settings.viewport
      return {
        bytes: new Uint8Array(bytes),
        contentType: 'image/png' as const,
        width: size.width,
        height: size.height,
      }
    })
  }

  async console(): Promise<PageConsoleEntry[]> {
    return this.#console.drain()
  }

  async network(): Promise<PageNetworkEntry[]> {
    return this.#network.drain()
  }

  isConnected(): boolean {
    return this.#browser.isConnected() && !this.#page.isClosed()
  }

  async close(): Promise<void> {
    // A connected browser closes only what this connection opened; the server stays.
    await this.#context.close().catch(() => undefined)
    await this.#browser.close().catch(() => undefined)
  }
}
