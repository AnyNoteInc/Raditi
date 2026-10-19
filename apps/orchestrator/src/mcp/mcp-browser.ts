import { randomUUID } from 'node:crypto'

import type { OnModuleDestroy } from '@nestjs/common'
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  clipPageText,
  DomainError,
  isDomainError,
  isPageBrowserError,
  isPreviewPath,
  PREVIEW_CONTROL_PREFIX,
  previewBrowserSecretPath,
  previewBrowserSecretSchema,
  previewBrowserSocket,
  previewOrigin,
  previewTimings,
  type ObjectStorage,
  type PageBrowser,
  type PageBrowserFactory,
  type PageLocation,
  type PreviewAddress,
  type SecretStore,
  type SiteAdapter,
  type SiteStack,
} from '@repo/domain'

import { TURN_KEY_IN_TEXT } from '../llm/turn-key.ts'
import type { ContentPrivacy } from './content-privacy.ts'
import type { McpAccess } from './mcp-access.ts'
import type {
  BrowserCheck,
  BrowserClickArguments,
  BrowserExpectArguments,
  BrowserFillArguments,
  BrowserNavigateArguments,
  BrowserRunChecksArguments,
} from './mcp-browser-tools.ts'
import {
  browserScreenshotKey,
  type McpBrowserAdmission,
  type McpBrowserRequestState,
  type McpBrowserStore,
} from './mcp-browser-store.ts'

export { browserScreenshotKey }

export const MCP_BROWSER = Symbol('MCP_BROWSER')

/**
 * The agent's browser on the preview of its dialog (docs/plan/53-chat-preview-release.md, Р21,
 * Р22, Р23, N22). Every call is admitted again for its turn; an action first asks core to bring
 * the working tree of the turn onto the preview (`preview_sync_requests`) and waits for it; the
 * first browser call of a turn asks core for the preview's browser (`preview_browser_requests`)
 * and enters it with the service ticket core put into Vault. One context per turn lives in this
 * process, closed when the turn ends, its key or lease goes, or it idles.
 *
 * What the agent gets is text of the preview with the contacts hidden (the task's contact map),
 * paths of the preview only and fixed codes; pixels of a screenshot stay in raditi-artifacts and
 * the agent gets their id. Where a page may go is the stack's policy, by the site adapter.
 */

/** Fixed codes a browser call answers with; nothing of a page, a selector or an address. */
export const browserAgentCodes = [
  'BROWSER_PREVIEW_NOT_READY',
  'BROWSER_PREVIEW_UNAVAILABLE',
  'BROWSER_SYNC_TIMEOUT',
  'BROWSER_SYNC_FAILED',
  'BROWSER_NOT_READY',
  'BROWSER_UNAVAILABLE',
  'BROWSER_BUSY',
  'BROWSER_PATH_DENIED',
  'BROWSER_ACTION_DENIED',
  'BROWSER_TIMEOUT',
  'BROWSER_ACTION_FAILED',
  'BROWSER_CREDENTIAL_REFUSED',
  'BROWSER_SCREENSHOT_UNAVAILABLE',
  'CONTENT_PRIVACY_LIMIT',
] as const
export type BrowserAgentCode = (typeof browserAgentCodes)[number]

const statuses: Record<BrowserAgentCode, number> = {
  BROWSER_PREVIEW_NOT_READY: 503,
  BROWSER_PREVIEW_UNAVAILABLE: 409,
  BROWSER_SYNC_TIMEOUT: 503,
  BROWSER_SYNC_FAILED: 502,
  BROWSER_NOT_READY: 503,
  BROWSER_UNAVAILABLE: 502,
  BROWSER_BUSY: 503,
  BROWSER_PATH_DENIED: 403,
  BROWSER_ACTION_DENIED: 403,
  BROWSER_TIMEOUT: 504,
  BROWSER_ACTION_FAILED: 502,
  BROWSER_CREDENTIAL_REFUSED: 400,
  BROWSER_SCREENSHOT_UNAVAILABLE: 502,
  CONTENT_PRIVACY_LIMIT: 413,
}
const refuse = (code: BrowserAgentCode) =>
  new DomainError(code, 'The preview browser refused the call', statuses[code])

/** What a tool answers the agent: bounded, masked JSON. */
export type BrowserToolResponse = Record<string, unknown>

export interface McpBrowserOptions {
  /** Р23: how long an action waits for core to sync the working tree onto the preview. */
  syncWaitMs?: number
  /** Р21: how long the first call of a turn waits for core to start the browser. */
  browserWaitMs?: number
  pollMs?: number
  /** All of one call; OpenCode gives an MCP request 60 s. */
  callBudgetMs?: number
  /** A context unused this long is closed (and core stops an idle browser in its time). */
  idleMs?: number
  /** How often contexts of ended turns are looked for; 0 — never (tests call `sweep`). */
  sweepMs?: number
  maxSessions?: number
  /** A response to the agent is at most this large. */
  responseBytes?: number
  screenshotBytes?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaults = {
  syncWaitMs: 20_000,
  browserWaitMs: 25_000,
  pollMs: 250,
  callBudgetMs: 55_000,
  idleMs: previewTimings.browserIdleMinutes * 60_000,
  sweepMs: 15_000,
  maxSessions: 16,
  responseBytes: 64 * 1024,
  screenshotBytes: BROWSER_SCREENSHOT_MAX_BYTES,
}
/** Entries of the console and the network one call shows; the latest go. */
const LIST_ENTRIES = 100
/** One check and one expectation wait at most this long for their element. */
const CHECK_ELEMENT_MS = 5_000

export interface McpBrowserDeps {
  store: McpBrowserStore
  factory: PageBrowserFactory
  /** Vault `kv/previews/<previewId>/browser`: the mcp-content policy reads it. */
  secrets: Pick<SecretStore, 'kvRead'>
  privacy: Pick<ContentPrivacy, 'mask' | 'rehydrate'>
  /** The artifacts bucket: screenshots (N22), each under a key of its own (`ContentStorage`). */
  storage: Pick<ObjectStorage, 'put'>
  /** The registry of site adapters: where a page of the stack may go (rule 8). */
  adapters: (stack: SiteStack) => Pick<SiteAdapter, 'browserRequestDenied'>
  /** Where previews answer (PREVIEW_BASE_DOMAIN and the rest). */
  address: PreviewAddress
}

interface Session {
  previewId: string
  browser: PageBrowser
  usedAt: number
}

interface Call {
  admission: McpBrowserAdmission
  deadline: number
  session?: Session
  /** The sync that brought the working tree of the turn onto the preview for this call. */
  syncRequestId?: string
}

/** A console message as the agent reads it, masked first. */
const CONSOLE_TEXT_CHARS = 1_000

export class McpBrowserService implements OnModuleDestroy {
  readonly #deps: McpBrowserDeps
  readonly #options: typeof defaults & Pick<McpBrowserOptions, 'now' | 'sleep'>
  readonly #sessions = new Map<string, Session>()
  /** One call at a time per turn: one page, one sequence of actions. */
  readonly #locks = new Map<string, Promise<unknown>>()
  /** Turns that entered once: the ticket of their request is spent, a new context needs a new one. */
  readonly #entered = new Set<string>()
  readonly #timer: ReturnType<typeof setInterval> | undefined

  constructor(deps: McpBrowserDeps, options: McpBrowserOptions = {}) {
    this.#deps = deps
    this.#options = { ...defaults, ...options }
    if (this.#options.sweepMs > 0) {
      this.#timer = setInterval(
        () => void this.sweep().catch(() => undefined),
        this.#options.sweepMs,
      )
      this.#timer.unref()
    }
  }

  #now() {
    return this.#options.now?.() ?? Date.now()
  }

  #sleep(ms: number) {
    return this.#options.sleep?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  // -------------------------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------------------------

  async navigate(scope: McpAccess, args: BrowserNavigateArguments): Promise<BrowserToolResponse> {
    // Refused before anything is asked of core: a path the agent may not open opens nothing.
    const path = this.#path(scope, (await this.#rehydrate(scope, { path: args.path })).path)
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const location = await this.#act(call, () => browser.navigate({ path }))
      return this.#location(scope, location)
    })
  }

  click(scope: McpAccess, args: BrowserClickArguments): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const target = await this.#rehydrate(scope, {
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.name === undefined ? {} : { name: args.name }),
      })
      const timeoutMs = this.#timeout(call)
      // Р22: a click may submit a form; the preview is no longer its revision until a reset.
      await this.#deps.store.markDirty(call.admission, scope.taskId)
      const location = await this.#act(call, () =>
        browser.click(
          target.selector !== undefined
            ? { selector: target.selector, timeoutMs }
            : {
                role: target.role!,
                ...(target.name === undefined ? {} : { name: target.name }),
                timeoutMs,
              },
        ),
      )
      return this.#location(scope, location)
    })
  }

  async fill(scope: McpAccess, args: BrowserFillArguments): Promise<BrowserToolResponse> {
    // The agent can read its own turn credentials in the sandbox: a form of the preview is not
    // where they go (its database is replayed onto the site by a release).
    if (TURN_KEY_IN_TEXT.test(args.value) || TURN_KEY_IN_TEXT.test(args.selector))
      throw refuse('BROWSER_CREDENTIAL_REFUSED')
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const input = await this.#rehydrate(scope, { selector: args.selector, value: args.value })
      const timeoutMs = this.#timeout(call)
      await this.#deps.store.markDirty(call.admission, scope.taskId)
      const location = await this.#act(call, () =>
        browser.fill({ selector: input.selector, value: input.value, timeoutMs }),
      )
      return this.#location(scope, location)
    })
  }

  expect(scope: McpAccess, args: BrowserExpectArguments): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const input = await this.#rehydrate(scope, {
        selector: args.selector,
        ...(args.text === undefined ? {} : { text: args.text }),
      })
      const outcome = await this.#act(call, () =>
        browser.expect({
          selector: input.selector,
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(input.text === undefined ? {} : { text: input.text }),
          timeoutMs: Math.min(this.#timeout(call), CHECK_ELEMENT_MS),
        }),
      )
      return { passed: outcome.passed }
    })
  }

  /** The page as text for the model (N22): its accessibility tree and its links, masked. */
  snapshot(scope: McpAccess): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const page = await this.#act(call, () => browser.snapshot({ maxChars: 60_000 }))
      const links = page.links.slice(0, 200)
      const texts: Record<string, string> = { path: page.path, title: page.title, text: page.text }
      links.forEach((link, index) => {
        texts[`l${index}`] = link.text
        texts[`p${index}`] = link.path
      })
      const masked = await this.#mask(scope, texts)
      const answer = {
        path: masked.path!,
        title: masked.title!,
        status: page.status,
        text: masked.text!,
        links: links.map((_, index) => ({
          text: masked[`l${index}`]!,
          path: masked[`p${index}`]!,
        })),
        truncated: false,
      }
      return this.#bounded(answer)
    })
  }

  /** N22: the pixels go to raditi-artifacts for the client; the agent gets their id only. */
  screenshot(scope: McpAccess): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const shot = await this.#act(call, () => browser.screenshot())
      if (shot.bytes.byteLength > this.#options.screenshotBytes)
        throw refuse('BROWSER_SCREENSHOT_UNAVAILABLE')
      const id = randomUUID()
      // Recorded before it is stored: the sweep of the task's content finds every one (spec §14).
      await this.#deps.store.recordScreenshot(call.admission, scope.taskId, id, call.syncRequestId!)
      try {
        await this.#deps.storage.put(
          'artifacts',
          browserScreenshotKey(scope.taskId, id),
          shot.bytes,
          {
            contentType: 'image/png',
            sizeBytes: shot.bytes.byteLength,
          },
        )
      } catch {
        throw refuse('BROWSER_SCREENSHOT_UNAVAILABLE')
      }
      return { screenshotId: id, width: shot.width, height: shot.height }
    })
  }

  /** Messages of the page since the last call, masked; nothing before the turn opened a page. */
  console(scope: McpAccess): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: false, browser: false }, async (call) => {
      const session = this.#open(call)
      if (!session) return { entries: [] }
      const entries = (await this.#act(call, () => session.browser.console())).slice(-LIST_ENTRIES)
      // Masked whole, then cut: a cut through a contact would leave a part the search misses.
      const masked = await this.#mask(
        scope,
        Object.fromEntries(entries.map((entry, index) => [`e${index}`, entry.text])),
      )
      return this.#bounded({
        entries: entries.map((entry, index) => ({
          level: entry.level,
          text: clipPageText(masked[`e${index}`]!, CONSOLE_TEXT_CHARS),
        })),
      })
    })
  }

  /**
   * Requests of the page since the last call that failed or were answered with an error: those
   * to the preview by their path, any other address as null (the page was not let go there).
   */
  network(scope: McpAccess): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: false, browser: false }, async (call) => {
      const session = this.#open(call)
      if (!session) return { requests: [] }
      const failed = (await this.#act(call, () => session.browser.network()))
        .filter((entry) => entry.status === null || entry.status >= 400)
        .slice(-LIST_ENTRIES)
      const masked = await this.#mask(
        scope,
        Object.fromEntries(
          failed.flatMap((entry, index) =>
            entry.path === null ? [] : [[`p${index}`, entry.path]],
          ),
        ),
      )
      return this.#bounded({
        requests: failed.map((entry, index) => ({
          method: entry.method,
          path: entry.path === null ? null : masked[`p${index}`]!,
          status: entry.status,
          type: entry.resourceType,
        })),
      })
    })
  }

  /**
   * Declarative checks the platform runs, never code of the agent (Р21): a page, the status of
   * its document, an element and its state or text. The run is an internal event of the task,
   * bound to the sync it looked at; the pass that records the turn's candidate makes it a
   * `candidate_checks` row of kind `agent_browser` (R3, `carryBrowserChecks`).
   */
  runChecks(scope: McpAccess, args: BrowserRunChecksArguments): Promise<BrowserToolResponse> {
    return this.#call(scope, { sync: true, browser: true }, async (call) => {
      const browser = this.#browser(call)
      const results: Array<{ check: number; passed: boolean; reason?: string }> = []
      for (const [index, check] of args.checks.entries()) {
        const reason = await this.#check(scope, call, browser, check)
        results.push(
          reason === null
            ? { check: index + 1, passed: true }
            : { check: index + 1, passed: false, reason },
        )
      }
      const passed = results.filter((result) => result.passed).length
      const summary = { total: results.length, passed, failed: results.length - passed }
      await this.#deps.store.recordChecks(
        call.admission,
        scope.taskId,
        summary,
        call.syncRequestId!,
      )
      return { ...summary, results }
    })
  }

  /** null — the check passed; otherwise why not, as a word. */
  async #check(
    scope: McpAccess,
    call: Call,
    browser: PageBrowser,
    check: BrowserCheck,
  ): Promise<string | null> {
    if (this.#now() >= call.deadline) return 'not_run'
    const input = await this.#rehydrate(scope, {
      path: check.path,
      ...(check.selector === undefined ? {} : { selector: check.selector }),
      ...(check.text === undefined ? {} : { text: check.text }),
    })
    let path: string
    try {
      path = this.#path(scope, input.path)
    } catch {
      return 'denied'
    }
    try {
      const location = await this.#act(call, () => browser.navigate({ path }))
      const status = location.status
      if (
        status === null ||
        (check.status === undefined ? status < 200 || status >= 400 : status !== check.status)
      )
        return 'status'
      if (input.selector === undefined) return null
      const outcome = await this.#act(call, () =>
        browser.expect({
          selector: input.selector!,
          ...(check.state === undefined ? {} : { state: check.state }),
          ...(input.text === undefined ? {} : { text: input.text }),
          timeoutMs: Math.min(this.#timeout(call), CHECK_ELEMENT_MS),
        }),
      )
      return outcome.passed ? null : 'element'
    } catch (error) {
      if (isDomainError(error) && error.code === 'BROWSER_ACTION_DENIED') return 'denied'
      if (isDomainError(error) && error.code === 'BROWSER_TIMEOUT') return 'timeout'
      throw error
    }
  }

  // -------------------------------------------------------------------------------------------
  // One call: admission, the sync of the working tree, the browser of the turn
  // -------------------------------------------------------------------------------------------

  async #call<T>(
    scope: McpAccess,
    needs: { sync: boolean; browser: boolean },
    work: (call: Call) => Promise<T>,
  ): Promise<T> {
    const started = this.#now()
    let admission = await this.#deps.store.admit(scope)
    const key = admission.assignmentId
    return this.#serial(key, async () => {
      const call: Call = { admission, deadline: started + this.#options.callBudgetMs }
      this.#ready(admission)
      if (needs.sync) {
        call.syncRequestId = await this.#sync(call)
        admission = await this.#deps.store.admit(scope)
        this.#ready(admission)
        call.admission = admission
      }
      // A call that needs no browser of its own reads what an open one has.
      call.session = needs.browser ? await this.#session(scope, call) : this.#sessions.get(key)
      if (call.session) call.session.usedAt = this.#now()
      return work(call)
    })
  }

  #browser(call: Call): PageBrowser {
    if (!call.session) throw refuse('BROWSER_UNAVAILABLE')
    return call.session.browser
  }

  async #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const current = previous.then(work, work)
    const settled = current.catch(() => undefined)
    this.#locks.set(key, settled)
    try {
      return await current
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key)
    }
  }

  /** The preview answers pages now: built and serving (Р22). */
  #ready(admission: McpBrowserAdmission) {
    const { status } = admission.preview
    if (status === 'ready') return
    if (status === 'pending' || status === 'building' || status === 'expired')
      throw refuse('BROWSER_PREVIEW_NOT_READY')
    throw refuse('BROWSER_PREVIEW_UNAVAILABLE')
  }

  /** Р23: core brings the working tree of the turn onto the preview; this call waits for it. */
  async #sync(call: Call): Promise<string> {
    const id = await this.#deps.store.requestSync(call.admission)
    const state = await this.#wait(
      () => this.#deps.store.syncState(id),
      Math.min(this.#now() + this.#options.syncWaitMs, call.deadline),
    )
    if (!state) throw refuse('BROWSER_SYNC_TIMEOUT')
    if (state.errorCode !== null) throw refuse('BROWSER_SYNC_FAILED')
    return id
  }

  async #wait(
    read: () => Promise<McpBrowserRequestState>,
    until: number,
  ): Promise<McpBrowserRequestState | null> {
    for (;;) {
      const state = await read()
      if (state.done) return state
      const left = until - this.#now()
      if (left <= 0) return null
      await this.#sleep(Math.min(this.#options.pollMs, left))
    }
  }

  /** The open context of the turn, when there is one that still works. */
  #open(call: Call): Session | undefined {
    const session = call.session
    return session &&
      session.previewId === call.admission.preview.id &&
      session.browser.isConnected()
      ? session
      : undefined
  }

  /**
   * The browser of the turn: its open context, or a new one on the browser core starts for the
   * request. A ticket is spent by one entry: a turn that entered before, and a connection that
   * failed, ask for a new request.
   */
  async #session(scope: McpAccess, call: Call): Promise<Session> {
    const key = call.admission.assignmentId
    const existing = this.#sessions.get(key)
    if (
      existing &&
      existing.previewId === call.admission.preview.id &&
      existing.browser.isConnected()
    )
      return existing
    if (existing) this.#close(key)
    if (this.#sessions.size >= this.#options.maxSessions) {
      for (const [other, session] of this.#sessions)
        if (!session.browser.isConnected()) this.#close(other)
      if (this.#sessions.size >= this.#options.maxSessions) throw refuse('BROWSER_BUSY')
    }
    const preview = call.admission.preview
    const origin = previewOrigin(preview.hostname, this.#deps.address)
    const adapter = this.#deps.adapters(scope.stack)
    for (const fresh of this.#entered.has(key) ? [true] : [false, true]) {
      const requestId = await this.#deps.store.requestBrowser(call.admission, fresh)
      const state = await this.#wait(
        () => this.#deps.store.browserState(requestId),
        Math.min(this.#now() + this.#options.browserWaitMs, call.deadline),
      )
      if (!state) throw refuse('BROWSER_NOT_READY')
      if (state.errorCode !== null) {
        if (state.errorCode === 'stopped' && !fresh) continue
        throw refuse('BROWSER_UNAVAILABLE')
      }
      const secret = await this.#secret(preview.id)
      // The ticket in Vault is that of a later request: this one's is spent or replaced.
      if (!secret || secret.requestId !== requestId) {
        if (!fresh) continue
        throw refuse('BROWSER_UNAVAILABLE')
      }
      let browser: PageBrowser
      try {
        browser = await this.#deps.factory.connect(
          {
            endpoint: { wsEndpoint: previewBrowserSocket(secret) },
            origin,
            enterUrl: secret.enterUrl,
            denyRequest: (request) => adapter.browserRequestDenied(request),
          },
          AbortSignal.timeout(Math.max(1_000, call.deadline - this.#now())),
        )
      } catch {
        if (!fresh) continue
        throw refuse('BROWSER_UNAVAILABLE')
      }
      const session = { previewId: preview.id, browser, usedAt: this.#now() }
      this.#sessions.set(key, session)
      this.#entered.add(key)
      return session
    }
    throw refuse('BROWSER_UNAVAILABLE')
  }

  async #secret(previewId: string) {
    try {
      const stored = await this.#deps.secrets.kvRead(previewBrowserSecretPath(previewId))
      const parsed = previewBrowserSecretSchema.safeParse(stored?.data)
      return parsed.success ? parsed.data : null
    } catch {
      throw refuse('BROWSER_UNAVAILABLE')
    }
  }

  // -------------------------------------------------------------------------------------------
  // What the agent sends and what it gets back
  // -------------------------------------------------------------------------------------------

  /**
   * A path of the preview the agent may open: given as a path, or as an address on the
   * preview's own origin; never the gateway's own paths, never what the stack's policy denies.
   */
  #path(scope: McpAccess, input: string): string {
    if (!scope.preview) throw refuse('BROWSER_PREVIEW_UNAVAILABLE')
    let path = input
    if (!input.startsWith('/')) {
      const url = URL.parse(input)
      const origin = previewOrigin(scope.preview.hostname, this.#deps.address)
      if (!url || url.origin !== origin) throw refuse('BROWSER_PATH_DENIED')
      path = `${url.pathname}${url.search}`
    }
    const hash = path.indexOf('#')
    if (hash >= 0) path = path.slice(0, hash)
    if (
      !isPreviewPath(path) ||
      path.startsWith(PREVIEW_CONTROL_PREFIX) ||
      this.#deps.adapters(scope.stack).browserRequestDenied({ path, method: 'GET', postData: null })
    )
      throw refuse('BROWSER_PATH_DENIED')
    return path
  }

  /** What the agent wrote in place of a contact goes to the page as the contact. */
  async #rehydrate<Fields extends Record<string, string>>(
    scope: McpAccess,
    fields: Fields,
  ): Promise<Fields> {
    try {
      return await this.#deps.privacy.rehydrate(scope, fields)
    } catch {
      // An unknown marker, or a contact the page would show unmasked where it would stand.
      throw refuse('BROWSER_ACTION_FAILED')
    }
  }

  async #mask(scope: McpAccess, texts: Record<string, string>): Promise<Record<string, string>> {
    if (Object.keys(texts).length === 0) return {}
    try {
      return await this.#deps.privacy.mask(scope, texts)
    } catch (error) {
      if (isDomainError(error) && error.code === 'CONTENT_PRIVACY_LIMIT')
        throw refuse('CONTENT_PRIVACY_LIMIT')
      throw refuse('BROWSER_ACTION_FAILED')
    }
  }

  async #location(scope: McpAccess, location: PageLocation): Promise<BrowserToolResponse> {
    const masked = await this.#mask(scope, { path: location.path, title: location.title })
    return { path: masked.path!, title: masked.title!, status: location.status }
  }

  /**
   * Text of a page beyond the bound is cut, and the answer says so. The text is masked already;
   * it is cut where no marker is split (`clipPageText`).
   */
  #bounded(answer: Record<string, unknown>): BrowserToolResponse {
    const limit = this.#options.responseBytes - 512
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    if (size(answer) <= limit) return answer
    const result: Record<string, unknown> = { ...answer, truncated: true }
    for (const field of ['text', 'links', 'entries', 'requests'] as const) {
      const value = result[field]
      if (typeof value === 'string') {
        let text = value
        while (text.length > 0 && size({ ...result, [field]: text }) > limit)
          text = clipPageText(text, Math.floor(text.length * 0.8))
        result[field] = text
      } else if (Array.isArray(value)) {
        let list = value
        while (list.length > 0 && size({ ...result, [field]: list }) > limit)
          list = list.slice(0, Math.floor(list.length * 0.8))
        result[field] = list
      }
      if (size(result) <= limit) return result
    }
    throw refuse('BROWSER_ACTION_FAILED')
  }

  #timeout(call: Call): number {
    return Math.max(1_000, Math.min(10_000, call.deadline - this.#now()))
  }

  /** What the browser raised, as a fixed code; a lost browser closes the turn's context. */
  async #act<T>(call: Call, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isPageBrowserError(error)) {
        if (error.reason === 'timeout') throw refuse('BROWSER_TIMEOUT')
        if (error.reason === 'denied') throw refuse('BROWSER_ACTION_DENIED')
        this.#close(call.admission.assignmentId)
        throw refuse('BROWSER_UNAVAILABLE')
      }
      if (isDomainError(error)) throw error
      throw refuse('BROWSER_ACTION_FAILED')
    }
  }

  // -------------------------------------------------------------------------------------------
  // Contexts of ended turns
  // -------------------------------------------------------------------------------------------

  #close(key: string) {
    const session = this.#sessions.get(key)
    if (!session) return
    this.#sessions.delete(key)
    void session.browser.close().catch(() => undefined)
  }

  /**
   * Closes the contexts of turns that ended — finished, revoked, the lease lost — of browsers
   * that went away and of turns idle for `idleMs`. A turn in the middle of a call is left be.
   */
  async sweep(): Promise<number> {
    const before = this.#sessions.size
    const now = this.#now()
    for (const [key, session] of this.#sessions)
      if (
        !this.#locks.has(key) &&
        (!session.browser.isConnected() || now - session.usedAt >= this.#options.idleMs)
      )
        this.#close(key)
    const keys = [...new Set([...this.#sessions.keys(), ...this.#entered])]
    if (keys.length > 0) {
      const live = await this.#deps.store.liveAssignments(keys)
      for (const key of keys)
        if (!live.has(key) && !this.#locks.has(key)) {
          this.#close(key)
          this.#entered.delete(key)
        }
    }
    return before - this.#sessions.size
  }

  /** How many turns have an open context in this process. */
  get sessions(): number {
    return this.#sessions.size
  }

  async onModuleDestroy() {
    if (this.#timer) clearInterval(this.#timer)
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#entered.clear()
    await Promise.all(sessions.map((session) => session.browser.close().catch(() => undefined)))
  }
}
