// Test doubles of the browser worker: its configuration as a test env gives it, the containers,
// a scripted browser, an in-memory database and inbox. Only for *.test.ts files (excluded from the
// build).
import { randomUUID } from 'node:crypto'

import type { BrowserCheckpointRecord } from '@repo/db'
import {
  type BrowserCheckpointRef,
  type BrowserCheckpointState,
  type BrowserCloseReason,
  type BrowserController,
  type BrowserFile,
  type BrowserHelp,
  type BrowserInputEvent,
  type BrowserSessionRuntime,
  type BrowserSessionRuntimeSpec,
  type BrowserSessionStatus,
  type BrowserTab,
  type BrowserVerificationPlan,
  type BrowserVerificationReading,
  type BrowserVerifiedObject,
  type BrowserViewport,
  type CloudBrowserAction,
  type CloudBrowserActResult,
  type CloudBrowserConnection,
  type CloudBrowserEvent,
  type CloudBrowserFactory,
  type CloudBrowserFrame,
  type CloudBrowserObservation,
  type CloudBrowserSession,
  type SiteStack,
} from '@repo/domain'

import type { InboxStorage } from '../attachments/attachments.ts'
import { loadBrowserConfig, type BrowserWorkerConfig } from '../config/config.ts'
import type { BrowserWorkerMetrics } from '../metrics/worker-metrics.ts'
import type {
  BrowserWorkerStore,
  StoredAttachment,
  StoredBrowserSession,
  StoredSite,
} from '../store/worker-store.ts'

export { fakeInfra, TEST_METRICS_TOKEN } from '@repo/service-runtime/testing/fakes'

export const TEST_WORKER_TOKEN = 'test-browser-worker-token-0123456789abcdef'
/** `sites.url` of the sessions FakeStore opens unless a test names another. */
export const TEST_SITE = 'https://news-site.ru'
/** Digests of no real image: the fakes never pull. */
const DIGEST = (name: string) => `raditi/${name}@sha256:${'a'.repeat(64)}`

export const testEnv = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'raditi',
  S3_SECRET_ACCESS_KEY: 'raditi-test-secret',
  S3_FORCE_PATH_STYLE: 'true',
  BROWSER_WORKER_TOKEN: TEST_WORKER_TOKEN,
  BROWSER_IMAGE: DIGEST('browser'),
  BROWSER_FORWARDER_IMAGE: DIGEST('tools'),
  BROWSER_EGRESS_IMAGE: DIGEST('egress'),
}

export function testBrowserConfig(overrides: Record<string, string> = {}): BrowserWorkerConfig {
  return loadBrowserConfig({ ...testEnv, ...overrides })
}

// -----------------------------------------------------------------------------------------------
// The containers
// -----------------------------------------------------------------------------------------------

export class FakeRuntime implements BrowserSessionRuntime {
  readonly started: BrowserSessionRuntimeSpec[] = []
  readonly stopped: string[] = []
  readonly held = new Set<string>()
  /** Fails the next start. */
  failStart = false
  /** Holds every stop until it settles (docker removing the containers). */
  stopGate: Promise<void> | null = null

  async start(spec: BrowserSessionRuntimeSpec): Promise<{ endpoint: string }> {
    if (this.failStart) throw new Error('docker refused')
    this.started.push(spec)
    this.held.add(spec.sessionId)
    return { endpoint: `ws://127.0.0.1:9/${'s'.repeat(43)}` }
  }

  async stop(sessionId: string): Promise<void> {
    await this.stopGate
    this.stopped.push(sessionId)
    this.held.delete(sessionId)
  }

  async list(): Promise<string[]> {
    return [...this.held]
  }
}

// -----------------------------------------------------------------------------------------------
// The browser
// -----------------------------------------------------------------------------------------------

/** The smallest bytes encodeBrowserFrame takes for a JPEG. */
export const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
])

export class FakeCloudBrowser implements CloudBrowserSession {
  readonly connection: CloudBrowserConnection
  #tabs: BrowserTab[]
  #shown: number | null = 1
  #connected = true
  readonly acted: CloudBrowserAction[] = []
  readonly inputs: BrowserInputEvent[] = []
  readonly navigated: string[] = []
  readonly viewports: BrowserViewport[] = []
  readonly chooserFiles: { chooserId: string; files: BrowserFile[] }[] = []
  readonly dialogs: { id: string; accept: boolean }[] = []
  readonly verified: BrowserVerificationPlan[] = []
  released = 0
  closed = false
  /** The tree `observe` answers. */
  tree =
    '- button "Опубликовать" [ref=e5]\n- textbox "Заголовок" [ref=e6]\n- link "Записи" [ref=e7]'
  /** What an action does besides answering; may throw or wait. */
  onAct: (action: CloudBrowserAction) => Promise<Partial<CloudBrowserActResult> | void> =
    async () => undefined
  /** What a read of the site finds. */
  reading: (plan: BrowserVerificationPlan) => Promise<BrowserVerificationReading> = async () => ({
    state: 'unreadable',
  })
  /** What a reading of the tree waits for. */
  onObserve: () => Promise<void> = async () => undefined
  /** The element that has the focus in the shown page; may throw or wait. */
  onFocused: () => Promise<{ role: string; name: string } | null> = async () => null
  /** How many times the focus was read. */
  focusReads = 0
  /** What the page takes of an input event before it is done; may wait. */
  onInput: (event: BrowserInputEvent) => Promise<void> = async () => undefined
  /** Inputs done and releases of held keys, in the order they reached the page. */
  readonly order: ('input' | 'release')[] = []
  #onFrame: ((frame: CloudBrowserFrame) => Promise<void>) | null = null
  readonly frameStarts: { size: BrowserViewport; quality: number }[] = []
  frameStops = 0

  constructor(connection: CloudBrowserConnection) {
    this.connection = connection
    this.#tabs = [{ pageId: 1, url: connection.startUrl, title: 'Записи' }]
  }

  get streaming(): boolean {
    return this.#onFrame !== null
  }

  /** What the browser tells, as the adapter would. */
  emit(event: CloudBrowserEvent): void {
    if (event.kind === 'page') {
      this.#tabs = this.#tabs.map((tab) => (tab.pageId === event.page.pageId ? event.page : tab))
    }
    if (event.kind === 'tabs') {
      this.#tabs = event.tabs
      this.#shown = event.shown
    }
    this.connection.onEvent(event)
  }

  /** The shown page commits another address: the events the adapter sends for it. */
  go(url: string, pageId = this.#shown ?? 1): void {
    const tab = { pageId, url, title: this.#tabs.find((t) => t.pageId === pageId)?.title ?? '' }
    this.emit({ kind: 'navigation', pageId, url })
    this.emit({ kind: 'page', page: tab })
  }

  /** A frame of the shown page; resolves when the worker lets Chromium paint the next. */
  frame(overrides: Partial<CloudBrowserFrame> = {}): Promise<void> {
    if (!this.#onFrame) throw new Error('no screencast')
    return this.#onFrame({
      pageId: this.#shown ?? 1,
      jpeg: TINY_JPEG,
      timestamp: Date.now(),
      width: 1280,
      height: 800,
      ...overrides,
    })
  }

  disconnect(): void {
    this.#connected = false
    this.connection.onEvent({ kind: 'closed' })
  }

  tabs(): BrowserTab[] {
    return this.#tabs.map((tab) => ({ ...tab }))
  }

  shown(): number | null {
    return this.#shown
  }

  async selectTab(pageId: number): Promise<void> {
    if (!this.#tabs.some((tab) => tab.pageId === pageId)) throw new Error('no tab')
    this.#shown = pageId
    this.connection.onEvent({ kind: 'tabs', tabs: this.tabs(), shown: pageId })
  }

  async closeTab(pageId: number): Promise<void> {
    this.#tabs = this.#tabs.filter((tab) => tab.pageId !== pageId)
    if (this.#shown === pageId) this.#shown = this.#tabs.at(-1)?.pageId ?? null
    this.connection.onEvent({ kind: 'tabs', tabs: this.tabs(), shown: this.#shown })
  }

  async navigate(url: string): Promise<BrowserTab> {
    this.navigated.push(url)
    this.go(url)
    return this.#current()
  }

  async observe(input: { ref?: string }): Promise<CloudBrowserObservation> {
    await this.onObserve()
    return {
      page: this.#current(),
      tree: input.ref === undefined ? this.tree : `- button "Подтвердить" [ref=e9]`,
    }
  }

  async focused(): Promise<{ role: string; name: string } | null> {
    this.focusReads += 1
    return this.onFocused()
  }

  async act(action: CloudBrowserAction): Promise<CloudBrowserActResult> {
    this.acted.push(action)
    const extra = (await this.onAct(action)) ?? {}
    return { page: this.#current(), ...extra }
  }

  async startFrames(
    onFrame: (frame: CloudBrowserFrame) => Promise<void>,
    options: { size: BrowserViewport; quality: number },
  ): Promise<() => Promise<void>> {
    this.#onFrame = onFrame
    this.frameStarts.push(options)
    return async () => {
      this.#onFrame = null
      this.frameStops += 1
    }
  }

  async input(event: BrowserInputEvent): Promise<void> {
    this.inputs.push(event)
    await this.onInput(event)
    this.order.push('input')
  }

  async releaseInputs(): Promise<void> {
    this.released += 1
    this.order.push('release')
  }

  async resolveDialog(id: string, accept: boolean): Promise<void> {
    this.dialogs.push({ id, accept })
    this.connection.onEvent({ kind: 'dialog', dialog: null })
  }

  async setChooserFiles(chooserId: string, files: BrowserFile[]): Promise<void> {
    this.chooserFiles.push({ chooserId, files })
    this.connection.onEvent({ kind: 'chooser', chooser: null })
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    this.viewports.push(viewport)
  }

  async verify(plan: BrowserVerificationPlan): Promise<BrowserVerificationReading> {
    this.verified.push(plan)
    return this.reading(plan)
  }

  isConnected(): boolean {
    return this.#connected && !this.closed
  }

  async close(): Promise<void> {
    this.closed = true
  }

  #current(): BrowserTab {
    const tab = this.#tabs.find((item) => item.pageId === this.#shown)
    return tab ? { ...tab } : { pageId: 1, url: '', title: '' }
  }
}

export class FakeBrowsers implements CloudBrowserFactory {
  readonly opened: FakeCloudBrowser[] = []
  failOpen = false

  async open(connection: CloudBrowserConnection): Promise<CloudBrowserSession> {
    if (this.failOpen) throw new Error('connect refused')
    const browser = new FakeCloudBrowser(connection)
    this.opened.push(browser)
    return browser
  }

  get last(): FakeCloudBrowser {
    const browser = this.opened.at(-1)
    if (!browser) throw new Error('no browser opened')
    return browser
  }
}

// -----------------------------------------------------------------------------------------------
// The database and the inbox
// -----------------------------------------------------------------------------------------------

export class FakeStore implements BrowserWorkerStore {
  readonly sessions = new Map<string, StoredBrowserSession & { closeReason?: string }>()
  readonly sites = new Map<string, StoredSite>()
  readonly checkpointRows = new Map<string, BrowserCheckpointRecord>()
  readonly attachments = new Map<string, StoredAttachment & { taskId: string }>()
  readonly controls: { controller: BrowserController; controlEpoch: number }[] = []
  readonly helps: BrowserHelp[] = []
  readonly members = new Set<string>()
  wrote = 0
  touched = 0
  cleared = 0

  /** A live session of a new task on a site of the stack and address, as core opens it. */
  open(input: { stack?: SiteStack; siteUrl?: string; expiresInMs?: number; readyAt?: Date } = {}) {
    const row: StoredBrowserSession = {
      id: randomUUID(),
      taskId: randomUUID(),
      siteId: randomUUID(),
      status: 'starting',
      expiresAt: new Date(Date.now() + (input.expiresInMs ?? 3_600_000)),
      readyAt: input.readyAt ?? null,
    }
    this.sessions.set(row.id, row)
    this.sites.set(row.siteId, {
      stack: input.stack ?? 'wordpress',
      url: input.siteUrl ?? TEST_SITE,
    })
    return row
  }

  async session(sessionId: string) {
    const row = this.sessions.get(sessionId)
    return row ? { ...row } : null
  }

  async site(siteId: string) {
    const site = this.sites.get(siteId)
    return site ? { ...site } : null
  }

  async markReady(sessionId: string) {
    const row = this.sessions.get(sessionId)
    if (!row || (row.status !== 'starting' && row.status !== 'ready')) return false
    row.status = 'ready'
    row.readyAt ??= new Date()
    return true
  }

  async recordControl(input: {
    sessionId: string
    controller: BrowserController
    controlEpoch: number
  }) {
    this.controls.push({ controller: input.controller, controlEpoch: input.controlEpoch })
    return true
  }

  async recordHelp(input: { sessionId: string } & BrowserHelp) {
    this.helps.push({ reason: input.reason, message: input.message })
    return true
  }

  async clearHelp() {
    this.cleared += 1
    return true
  }

  async touch() {
    this.touched += 1
    return true
  }

  async markWrote() {
    this.wrote += 1
    return true
  }

  async close(input: {
    sessionId: string
    status: 'closed' | 'failed' | 'lost'
    reason: BrowserCloseReason
  }): Promise<{ status: BrowserSessionStatus } | null> {
    const row = this.sessions.get(input.sessionId)
    if (!row) return null
    if (row.status === 'starting' || row.status === 'ready') {
      row.status = input.status
      row.closeReason = input.reason
    }
    return { status: row.status }
  }

  async checkpoints(taskId: string) {
    return [...this.checkpointRows.values()].filter((row) => row.taskId === taskId)
  }

  async upsertCheckpoint(input: {
    taskId: string
    sessionId: string
    ref: BrowserCheckpointRef
    state: BrowserCheckpointState
    verified?: BrowserVerifiedObject
  }) {
    const key = `${input.taskId}:${input.ref.kind}:${input.ref.objectId}`
    const known = this.checkpointRows.get(key)
    const keep = input.state === 'seen' && known !== undefined
    const record: BrowserCheckpointRecord = {
      id: known?.id ?? randomUUID(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      ref: input.ref,
      state: keep ? known.state : input.state,
      verified: keep ? known.verified : (input.verified ?? null),
      createdAt: known?.createdAt ?? new Date(),
      updatedAt: new Date(),
    }
    this.checkpointRows.set(key, record)
    return record
  }

  async attachment(input: { id: string; taskId: string }) {
    const row = this.attachments.get(input.id)
    return row && row.taskId === input.taskId ? row : null
  }

  async viewerAllowed(input: { sessionId: string; userId: string }) {
    return this.members.has(`${input.sessionId}:${input.userId}`)
  }
}

export class FakeInbox implements InboxStorage {
  readonly objects = new Map<string, Uint8Array>()
  readonly read: string[] = []

  async get(_bucket: string, key: string) {
    this.read.push(key)
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return (async function* () {
      yield bytes
    })()
  }

  async checkBuckets() {
    return { inbox: true }
  }
}

export const countingMetrics = () => {
  const counts = { sent: 0, dropped: { replaced: 0, stale: 0 }, actions: [] as string[] }
  const metrics: BrowserWorkerMetrics = {
    frameSent: () => {
      counts.sent += 1
    },
    framesDropped: (reason, count) => {
      counts.dropped[reason] += count
    },
    action: (tool, result) => {
      counts.actions.push(`${tool}:${result}`)
    },
  }
  return { metrics, counts }
}
