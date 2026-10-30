import { setTimeout as delay } from 'node:timers/promises'

import {
  admitBrowserAgentAction,
  admitBrowserInput,
  admitBrowserUserCommand,
  agentTakesBrowserControl,
  browserAgentActionSettled,
  browserAgentActionStarted,
  browserCheckpointAfterRead,
  browserCheckpointLimits,
  browserCheckpointsBlock,
  browserNavigationAllowed,
  browserObservationLimits,
  browserPageShown,
  browserScreenshotLimits,
  browserTaskError,
  browserToolResultSchema,
  browserToolLimits,
  browserTreeElement,
  browserTreeRefs,
  browserViewerLeft,
  browserViewportResized,
  clipTree,
  encodeBrowserFrame,
  initialBrowserControl,
  isBrowserInputInViewport,
  redactResultAddresses,
  redactTreeAddresses,
  releaseBrowserControl,
  takeBrowserControl,
  withTimeout,
  BROWSER_DEFAULT_VIEWPORT,
  type BrowserAction,
  type BrowserChooser,
  type BrowserClientMessage,
  type BrowserCloseReason,
  type BrowserControl,
  type BrowserControlStep,
  type BrowserCheckpointRef,
  type BrowserCheckpointState,
  type BrowserCommitAction,
  type BrowserDialog,
  type BrowserFile,
  type BrowserHelp,
  type BrowserInputEvent,
  type BrowserSessionRuntime,
  type BrowserSessionState,
  type BrowserSessionStatus,
  type BrowserSignIn,
  type BrowserStreamRefusal,
  type BrowserTab,
  type BrowserTaskCode,
  type BrowserTaskPolicy,
  type BrowserToolName,
  type BrowserToolResult,
  type BrowserVerifiedCheckpoint,
  type BrowserViewport,
  type CloudBrowserActResult,
  type CloudBrowserAction,
  type CloudBrowserEvent,
  type CloudBrowserFactory,
  type CloudBrowserFrame,
  type CloudBrowserSession,
  type FlowFrame,
  type SiteAdapter,
} from '@repo/domain'
import type { BrowserCheckpointRecord } from '@repo/db'

import { browserCodeOf, errorName } from '../common/browser-codes.ts'
import type { BrowserWorkerMetrics } from '../metrics/worker-metrics.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'

/** A frame as every viewer gets it: the 48-byte header and the JPEG, encoded once. */
export interface EncodedFrame extends FlowFrame {
  data: Uint8Array
}

/**
 * One connection of a tab of the cabinet, as the session sees it (the stream server implements
 * it): the session pushes its state and frames and says when the session ends.
 */
export interface SessionViewer {
  readonly id: string
  readonly userId: string
  state(state: BrowserSessionState): void
  frame(frame: EncodedFrame): void
  refused(reason: BrowserStreamRefusal): void
  /** The session ended: the viewer says why and closes its connection. */
  closed(reason: BrowserCloseReason): void
}

/** What a session needs of the worker; one object for all its sessions. */
export interface SessionContext {
  runtime: BrowserSessionRuntime
  browsers: CloudBrowserFactory
  store: BrowserWorkerStore
  files: {
    read(input: {
      taskId: string
      siteId: string
      attachmentIds: readonly string[]
    }): Promise<BrowserFile[]>
  }
  /**
   * Snapshots for the client (`web_screenshot`): the bytes into the inbox under the task, then
   * the row of the dialog that shows it; answers its number among the task's snapshots.
   */
  screenshots: {
    save(input: {
      taskId: string
      sessionId: string
      bytes: Uint8Array
      width: number
      height: number
    }): Promise<{ number: number }>
  }
  metrics: BrowserWorkerMetrics
  settings: SessionSettings
  now: () => number
  /** One line for the operator: an event name and an error's name, never a value. */
  warn(event: string, error?: unknown): void
}

export interface SessionSettings {
  stream: { maxFps: number; quality: number }
  /** «Взять управление» waits at most this long for the agent's running action (Б15). */
  agentActionTimeoutMs: number
  /** The agent's call answers within this; the action itself may still finish in the page. */
  actionBudgetMs: number
  /** An action that waited this long for the one before it is refused unrun. */
  queueWaitMs: number
  /** A check of every checkpoint stops after this; the rest keep what was known. */
  verifyBudgetMs: number
  /** last_activity_at is written at most this often. */
  touchEveryMs: number
}

export interface SessionSpec {
  id: string
  taskId: string
  siteId: string
  siteUrl: string
  adapter: SiteAdapter
  policy: BrowserTaskPolicy
  allowedHosts: readonly string[]
  /** Exact origins of local sites (`browserNavigationAllowed`); empty in production. */
  localOrigins: readonly string[]
  localSites: readonly { origin: string; target: string }[]
  startUrl: string
  /** Milliseconds since the epoch: the session ends there whatever happens in it. */
  deadline: number
  checkpoints: readonly BrowserCheckpointRecord[]
  /** The site's saved sign-in of the first `ensure` (Б36); null — none. */
  signIn: BrowserSignIn | null
}

interface Observation {
  id: string
  pageId: number
  tree: string
  refs: Set<string>
}

/**
 * A save of the agent on a page that showed no object in its address (a new one, Б22): the
 * address of what it made comes later, or never. Until then nothing new is started.
 */
interface PendingCommit {
  pageId: number
  /** A check ran since and the address still showed no object: the same editor may save again. */
  checked: boolean
  /** The page left the editor since: what its save made may never show in its address. */
  moved: boolean
  /** The client took the browser since: the hold is theirs; the page is still watched. */
  released: boolean
}

const OBSERVATION_MAX = 999_999_999
const U32 = 0x1_0000_0000
const checkpointKey = (ref: { kind: string; objectId: string }) => `${ref.kind}:${ref.objectId}`

/** A writing event of the client: the page may change by it (Б28); moves and scrolls do not. */
const writes = (event: BrowserInputEvent): boolean =>
  event.kind === 'text' ||
  (event.kind === 'key' && event.type === 'down') ||
  (event.kind === 'mouse' && event.type === 'down')

/** Messages of the client waiting for the page; past this they are refused (`busy`). */
const INPUT_BACKLOG = 256

/**
 * Keys that press the button they land on — the one the reference names, or the one that has the
 * focus: a commit as much as a click is. With any modifier: Shift+Enter presses a button too.
 */
const PRESSING_KEYS: ReadonlySet<string> = new Set(['Enter', ' ', 'Space'])
const pressingKey = (combo: string) =>
  PRESSING_KEYS.has(/^(?:(?:Alt|Control|ControlOrMeta|Meta|Shift)\+)*(.+)$/.exec(combo)?.[1] ?? '')

/**
 * Control or Command with S, other modifiers aside: the save shortcut of editors in a browser (the
 * block editor's «Сохранить» among them). Whatever the focus, it may save the object the page
 * shows, so it is a commit, with a reference or without (Б22, Б34).
 */
const SAVE_COMBO = /^((?:(?:Alt|Control|ControlOrMeta|Meta|Shift)\+)+)[sS]$/
const SAVING_MODIFIERS: ReadonlySet<string> = new Set(['Control', 'Meta', 'ControlOrMeta'])
const isSaveShortcut = (key: string): boolean =>
  (SAVE_COMBO.exec(key)?.[1] ?? '').split('+').some((modifier) => SAVING_MODIFIERS.has(modifier))

/**
 * A move to another part of the same document: only the fragment changed, to one (HTML's
 * fragment navigation). The same address again — a reload, a menu link to it — is a new document.
 */
const toFragment = (from: string, to: string) =>
  from !== to && to.includes('#') && from.split('#')[0] === to.split('#')[0]

/**
 * The browser of one task (docs/plan/57-browser-tasks.md, Б10–Б28): its containers and context,
 * who controls it (the domain's machine), the agent's actions one at a time, the viewers and
 * their frames, the checkpoints of the task. Nothing of the session survives the worker: a
 * restart loses it, and the client signs in again in a new one (Б18).
 */
export class WorkerSession {
  readonly id: string
  readonly taskId: string
  readonly siteId: string
  readonly #spec: SessionSpec
  readonly #context: SessionContext
  #status: BrowserSessionStatus = 'starting'
  #browser: CloudBrowserSession | null = null
  #control: BrowserControl = initialBrowserControl()
  #viewport: BrowserViewport = { ...BROWSER_DEFAULT_VIEWPORT }
  #tabs: BrowserTab[] = []
  #dialog: BrowserDialog | null = null
  #chooser: BrowserChooser | null = null
  #help: BrowserHelp | null = null
  readonly #checkpoints = new Map<string, BrowserCheckpointRecord>()
  #observation: Observation | null = null
  #observationSeq = 0
  #pendingCommit: PendingCommit | null = null
  /** The site's saved sign-in of the latest `ensure` (Б36): in memory only, never logged. */
  #signIn: BrowserSignIn | null
  /** A saved sign-in the site refused: not sent again until core gives another one. */
  #signInRefused: BrowserSignIn | null = null
  #wrote = false
  #lastActivity: number
  #lastTouch = Number.NEGATIVE_INFINITY
  readonly #viewers = new Map<string, SessionViewer>()
  readonly #frames = {
    stop: null as (() => Promise<void>) | null,
    /** Start and stop of the screencast, one at a time. */
    chain: Promise.resolve(),
    seq: 0,
    last: null as EncodedFrame | null,
    nextSlot: 0,
  }
  /** The agent's actions and core's checks: one at a time, in order (Б15). */
  #actions: Promise<void> = Promise.resolve()
  /** The client's input and commands, in the order they came. */
  #input: Promise<void> = Promise.resolve()
  #inputPending = 0
  /** Writes of hand-overs and checkpoints, in the order they happened. */
  #writes: Promise<void> = Promise.resolve()
  #readyTimer: ReturnType<typeof setTimeout> | undefined
  #closing: Promise<BrowserSessionStatus> | null = null
  readonly #onEnded: (session: WorkerSession) => void

  constructor(
    spec: SessionSpec,
    context: SessionContext,
    onEnded: (session: WorkerSession) => void,
  ) {
    this.id = spec.id
    this.taskId = spec.taskId
    this.siteId = spec.siteId
    this.#spec = spec
    this.#context = context
    this.#onEnded = onEnded
    this.#signIn = spec.signIn
    this.#lastActivity = context.now()
    for (const record of spec.checkpoints) this.#checkpoints.set(checkpointKey(record.ref), record)
  }

  get status(): BrowserSessionStatus {
    return this.#status
  }

  get live(): boolean {
    return this.#status === 'starting' || this.#status === 'ready'
  }

  /** The end under way (or over): it settles once the row is closed in the database. */
  get ending(): Promise<BrowserSessionStatus> | null {
    return this.#closing
  }

  get viewerCount(): number {
    return this.#viewers.size
  }

  get deadline(): number {
    return this.#spec.deadline
  }

  get lastActivity(): number {
    return this.#lastActivity
  }

  // -------------------------------------------------------------------------------------------
  // Start and end
  // -------------------------------------------------------------------------------------------

  /** The containers, the context on the start page and `ready` in the database. */
  async start(): Promise<void> {
    const { runtime, browsers, store } = this.#context
    const spec = this.#spec
    try {
      const { endpoint } = await runtime.start({
        sessionId: spec.id,
        taskId: spec.taskId,
        siteId: spec.siteId,
        allowedHosts: spec.allowedHosts,
        localSites: spec.localSites,
        deadline: spec.deadline,
      })
      // A close that came meanwhile stopped the containers before they were all there.
      if (!this.live) {
        await runtime.stop(spec.id).catch(() => undefined)
        throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
      }
      // The adapter opens the start page itself (Б31: the stack's list of posts).
      const browser = await browsers.open({
        endpoint,
        allowedHosts: spec.allowedHosts,
        localSites: spec.localOrigins,
        startUrl: spec.startUrl,
        viewport: this.#viewport,
        policy: spec.policy,
        onEvent: (event) => this.#event(event),
      })
      if (!this.live) {
        await browser.close().catch(() => undefined)
        await runtime.stop(spec.id).catch(() => undefined)
        throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
      }
      this.#browser = browser
      // A hand-over while the browser started is told now (Б37).
      browser.setController(this.#control.controller)
      // core closed the row meanwhile: the session is not to be.
      if (!(await store.markReady(spec.id))) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
      this.#tabs = browser.tabs()
      this.#status = 'ready'
      const shown = browser.shown()
      if (shown !== null) this.#apply(browserPageShown(this.#control, shown))
      this.#publish()
      this.#syncFrames()
      // The start page of a signed-out session is the stack's form: the saved sign-in, first in
      // the queue of the agent's actions.
      this.#actions = this.#actions.then(() => this.#signInIfAsked(browser))
    } catch (error) {
      this.#context.warn('browser_session_start_failed', error)
      if (this.live) await this.#end('failed', 'crashed', errorName(error))
      throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    }
  }

  /** Closes the session as core or the worker asks; a second call answers the first one's end. */
  close(reason: BrowserCloseReason): Promise<BrowserSessionStatus> {
    // Stopping the worker or a dead browser loses the sign-in: the session is lost (Б18).
    const status = reason === 'crashed' || reason === 'shutdown' ? 'lost' : 'closed'
    return this.#end(status, reason)
  }

  #end(
    status: 'closed' | 'failed' | 'lost',
    reason: BrowserCloseReason,
    errorCode?: string,
  ): Promise<BrowserSessionStatus> {
    if (this.#closing) return this.#closing
    this.#status = status
    clearTimeout(this.#readyTimer)
    const viewers = [...this.#viewers.values()]
    this.#viewers.clear()
    this.#closing = (async () => {
      for (const viewer of viewers) viewer.closed(reason)
      const browser = this.#browser
      this.#browser = null
      this.#frames.stop = null
      this.#frames.last = null
      // The context goes first: nothing of the sign-in outlives it (Б19).
      await browser
        ?.close()
        .catch((error: unknown) => this.#context.warn('browser_close_failed', error))
      await this.#context.runtime
        .stop(this.id)
        .catch((error: unknown) => this.#context.warn('browser_runtime_stop_failed', error))
      let final: BrowserSessionStatus = status
      try {
        const row = await this.#context.store.close({
          sessionId: this.id,
          status,
          reason,
          ...(errorCode && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(errorCode) ? { errorCode } : {}),
        })
        if (row) final = row.status
      } catch (error) {
        this.#context.warn('browser_session_close_not_recorded', error)
      }
      this.#onEnded(this)
      return final
    })()
    return this.#closing
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  state(): BrowserSessionState {
    const control = this.#control
    const shown = this.#tabs.find((tab) => tab.pageId === control.pageId)
    return {
      session: this.id,
      status: this.#status,
      controller: control.controller,
      controlEpoch: control.controlEpoch,
      manualReady: control.manualReady,
      holder: control.holder,
      pageId: control.pageId,
      viewportVersion: control.viewportVersion,
      viewport: { ...this.#viewport },
      url: shown?.url ?? '',
      title: shown?.title ?? '',
      tabs: this.#tabs.slice(0, 8),
      ...(this.#dialog ? { dialog: this.#dialog } : {}),
      ...(this.#chooser ? { chooser: this.#chooser } : {}),
      ...(this.#help ? { help: this.#help } : {}),
    }
  }

  #publish(): void {
    if (this.#viewers.size === 0) return
    const state = this.state()
    for (const viewer of this.#viewers.values()) viewer.state(state)
  }

  /** One step of the control machine, and what it asks for (Б15–Б17). */
  #apply(step: BrowserControlStep): void {
    const before = this.#control
    this.#control = step.control
    const browser = this.#browser
    if (step.releaseInputs && browser)
      // After the input already on its way: a key it presses after the release stays down (Б17).
      // The chain never rejects, so the client's next input still runs.
      this.#input = this.#input.then(() =>
        browser.releaseInputs().catch((error: unknown) => {
          this.#context.warn('browser_release_inputs_failed', error)
        }),
      )
    if (
      before.controller !== step.control.controller ||
      before.controlEpoch !== step.control.controlEpoch
    ) {
      // Б16: whoever gets the browser next acts on a new tree; references read before the
      // hand-over may name what the client has changed since.
      this.#observation = null
      // Б37: the pages' requests are judged for whoever holds the browser now.
      browser?.setController(step.control.controller)
      const record = {
        sessionId: this.id,
        controller: step.control.controller,
        controlEpoch: step.control.controlEpoch,
      }
      this.#write(() => this.#context.store.recordControl(record), 'browser_control_not_recorded')
    }
    // A wait for the agent's action belongs to the hand-over that started it.
    if (before.controlEpoch !== step.control.controlEpoch) clearTimeout(this.#readyTimer)
    if (step.changed) this.#publish()
  }

  #write(work: () => Promise<unknown>, event: string): void {
    this.#writes = this.#writes.then(work).then(
      () => undefined,
      (error: unknown) => this.#context.warn(event, error),
    )
  }

  #touch(): void {
    const now = this.#context.now()
    this.#lastActivity = now
    if (now - this.#lastTouch < this.#context.settings.touchEveryMs) return
    this.#lastTouch = now
    this.#write(() => this.#context.store.touch(this.id), 'browser_activity_not_recorded')
  }

  /** The first click, input or upload (Б28): «проверьте сайт» if the task ends without result. */
  #markWrote(): void {
    this.#touch()
    if (this.#wrote) return
    this.#wrote = true
    this.#write(() => this.#context.store.markWrote(this.id), 'browser_write_not_recorded')
  }

  /** Watching counts as activity: a session someone looks at is not idle. */
  keepAliveWhileWatched(): void {
    if (this.#viewers.size > 0) this.#lastActivity = this.#context.now()
  }

  /** Activity the worker did not see itself — the client looking at the dialog (И18) — at `at`. */
  noteActivity(at: number): void {
    if (at > this.#lastActivity) this.#lastActivity = at
  }

  /** The browser is gone without a close: the session is lost and the client signs in again. */
  connected(): boolean {
    return this.#status !== 'ready' || (this.#browser?.isConnected() ?? false)
  }

  // -------------------------------------------------------------------------------------------
  // What the browser tells
  // -------------------------------------------------------------------------------------------

  #event(event: CloudBrowserEvent): void {
    if (!this.live) return
    switch (event.kind) {
      case 'page': {
        const index = this.#tabs.findIndex((tab) => tab.pageId === event.page.pageId)
        if (index >= 0) this.#tabs[index] = event.page
        else this.#tabs.push(event.page)
        if (event.page.pageId === this.#control.pageId) this.#publish()
        return
      }
      case 'tabs': {
        this.#tabs = event.tabs
        if (event.shown !== null && event.shown !== this.#control.pageId) {
          // A tree of another page is no tree to act on.
          this.#observation = null
          this.#apply(browserPageShown(this.#control, event.shown))
          this.#frames.last = null
        } else this.#publish()
        return
      }
      case 'navigation': {
        if (this.#observation?.pageId === event.pageId) this.#observation = null
        this.#navigated(event.pageId, event.url)
        return
      }
      case 'dialog':
        this.#dialog = event.dialog
        this.#publish()
        return
      case 'chooser':
        this.#chooser = event.chooser
        this.#publish()
        return
      case 'closed':
        void this.#end('lost', 'crashed')
        return
    }
  }

  /**
   * Whether an address is of another site a page of the site went on to
   * (docs/plan/60-browser-foreign-redirects.md, Ч6): no object of the task is there, and a press
   * there saves nothing of the site. An address that does not read as a page — none known yet —
   * is not: a save there is judged as on the site.
   */
  #elsewhere(url: string): boolean {
    const page = URL.parse(url)
    if (!page || (page.protocol !== 'https:' && page.protocol !== 'http:')) return false
    return !browserNavigationAllowed(
      `${page.origin}/`,
      this.#spec.allowedHosts,
      this.#spec.localOrigins,
    )
  }

  /** The object of the task an address of the site edits; none on another site (Ч6). */
  #checkpointRef(url: string): BrowserCheckpointRef | null {
    if (this.#elsewhere(url)) return null
    try {
      return this.#spec.adapter.browserCheckpointOf(url)
    } catch {
      return null
    }
  }

  /**
   * A page committed an address (Б22). After a save of a new object on it, the first address
   * that names an object is what the save made — unconfirmed until a read. One that names none
   * means the page left the editor and may never show what its save made: the hold stays, and
   * an editor the page opens later is only seen. Any other editor is only seen.
   */
  #navigated(pageId: number, url: string): void {
    const ref = this.#checkpointRef(url)
    const pending = this.#pendingCommit
    if (pending?.pageId === pageId && !pending.moved) {
      if (ref !== null) {
        this.#pendingCommit = null
        return this.#record(ref, 'unverified')
      }
      // A link to a part of the same document (`#…`) leaves no editor.
      const shown = this.#tabs.find((tab) => tab.pageId === pageId)?.url
      if (shown !== undefined && toFragment(shown, url)) return
      if (pending.released) this.#pendingCommit = null
      else pending.moved = true
      return
    }
    if (ref !== null) this.#record(ref, 'seen')
  }

  /** Records a checkpoint state, in order; `seen` never moves one back (upsertBrowserCheckpoint). */
  #record(ref: BrowserCheckpointRef, state: BrowserCheckpointState): void {
    const key = checkpointKey(ref)
    const known = this.#checkpoints.get(key)
    // Kept at once, so the guard of the next action sees it before the write returns.
    if (state !== 'seen' || !known) {
      const now = new Date(this.#context.now())
      this.#checkpoints.set(key, {
        id: known?.id ?? '',
        taskId: this.taskId,
        sessionId: this.id,
        ref,
        state: state === 'seen' && known ? known.state : state,
        verified: state === 'seen' && known ? known.verified : null,
        createdAt: known?.createdAt ?? now,
        updatedAt: now,
      })
    }
    this.#write(async () => {
      const stored = await this.#context.store.upsertCheckpoint({
        taskId: this.taskId,
        sessionId: this.id,
        ref,
        state,
      })
      this.#checkpoints.set(key, stored)
    }, 'browser_checkpoint_not_recorded')
  }

  // -------------------------------------------------------------------------------------------
  // Viewers and frames
  // -------------------------------------------------------------------------------------------

  /** A tab of the cabinet starts watching; false — the session ended or the id is taken. */
  attach(viewer: SessionViewer): boolean {
    if (!this.live || this.#viewers.has(viewer.id)) return false
    this.#viewers.set(viewer.id, viewer)
    this.#touch()
    // The state and the last picture at once: a new viewer does not wait for the page to change.
    viewer.state(this.state())
    const last = this.#frames.last
    if (
      last &&
      last.pageId === this.#control.pageId &&
      last.viewportVersion === this.#control.viewportVersion
    )
      viewer.frame(last)
    this.#syncFrames()
    return true
  }

  detach(viewerId: string): void {
    if (!this.#viewers.delete(viewerId)) return
    this.#touch()
    // The pause holds (Б17); only the keys and buttons it held are let go.
    this.#apply(browserViewerLeft(this.#control, viewerId))
    this.#syncFrames()
  }

  /** The screencast runs while someone watches a ready session; one change at a time. */
  #syncFrames(restart = false): void {
    const run = async () => {
      const wanted = this.#status === 'ready' && this.#viewers.size > 0 && this.#browser !== null
      if (this.#frames.stop && (!wanted || restart)) {
        const stop = this.#frames.stop
        this.#frames.stop = null
        await stop().catch((error: unknown) =>
          this.#context.warn('browser_frames_stop_failed', error),
        )
      }
      restart = false
      const browser = this.#browser
      if (!wanted || this.#frames.stop || !browser) return
      try {
        this.#frames.stop = await browser.startFrames((frame) => this.#frame(frame), {
          size: { ...this.#viewport },
          quality: this.#context.settings.stream.quality,
        })
      } catch (error) {
        this.#context.warn('browser_frames_start_failed', error)
      }
    }
    this.#frames.chain = this.#frames.chain.then(run, run)
  }

  /**
   * One frame of the shown page, encoded once for every viewer. Its promise holds Chromium's
   * acknowledgement until the next slot of `maxFps`, so Chromium paints no faster (Б13).
   */
  #frame(frame: CloudBrowserFrame): Promise<void> {
    const control = this.#control
    if (!this.live || frame.pageId !== control.pageId) return Promise.resolve()
    const seq = (this.#frames.seq = (this.#frames.seq + 1) % U32)
    let data: Uint8Array
    try {
      data = encodeBrowserFrame(
        {
          flags: 0,
          frameSeq: seq,
          pageId: frame.pageId,
          viewportVersion: control.viewportVersion,
          controlEpoch: control.controlEpoch,
          width: frame.width,
          height: frame.height,
          timestamp: frame.timestamp,
          sessionId: this.id,
        },
        frame.jpeg,
      )
    } catch {
      // An image the header cannot carry (too large, not a JPEG) is dropped, not sent.
      return Promise.resolve()
    }
    const encoded: EncodedFrame = {
      seq,
      pageId: frame.pageId,
      viewportVersion: control.viewportVersion,
      bytes: data.byteLength,
      data,
    }
    this.#frames.last = encoded
    for (const viewer of this.#viewers.values()) viewer.frame(encoded)
    const now = this.#context.now()
    const interval = 1000 / this.#context.settings.stream.maxFps
    const slot = Math.max(now, this.#frames.nextSlot)
    this.#frames.nextSlot = slot + interval
    return slot + interval - now > 0 ? delay(slot + interval - now) : Promise.resolve()
  }

  // -------------------------------------------------------------------------------------------
  // The client (the stream)
  // -------------------------------------------------------------------------------------------

  /**
   * A message of a viewer, `ack`, `pong` and `hello` aside (the stream server's own). Hand-overs
   * take effect at once; what reaches the page goes in the order it came.
   */
  message(viewer: SessionViewer, message: BrowserClientMessage): void {
    if (!this.live || !this.#viewers.has(viewer.id)) return
    switch (message.t) {
      case 'take':
        this.#touch()
        this.#take(viewer.id)
        return
      case 'release':
        this.#touch()
        this.#apply(releaseBrowserControl(this.#control))
        return
      case 'hello':
      case 'ack':
      case 'pong':
        return
      default:
        // A page that stopped answering does not pile the client's input up behind it.
        if (this.#inputPending >= INPUT_BACKLOG) return viewer.refused('busy')
        this.#inputPending += 1
        this.#input = this.#input.then(() =>
          this.#command(viewer, message)
            .catch((error: unknown) => {
              this.#context.warn('browser_client_command_failed', error)
            })
            .finally(() => {
              this.#inputPending -= 1
            }),
        )
    }
  }

  /** «Взять управление»: the agent's running action keeps its short time, then the client's. */
  #take(viewer: string): void {
    this.#apply(takeBrowserControl(this.#control, viewer))
    // A save the agent left waiting for its object no longer holds anything back: the client sees
    // the page and decides (a pre-publish panel left open, a closed tab). Its page is still
    // watched, so an object it makes after all is unconfirmed, not just seen (Б22).
    const pending = this.#pendingCommit
    if (pending?.moved) this.#pendingCommit = null
    else if (pending) pending.released = true
    const control = this.#control
    if (control.controller !== 'user' || control.manualReady) return
    clearTimeout(this.#readyTimer)
    const epoch = control.controlEpoch
    this.#readyTimer = setTimeout(() => {
      // An action past its own timeout no longer holds the client back (Б15).
      if (this.#control.controller === 'user' && this.#control.controlEpoch === epoch)
        this.#apply(browserAgentActionSettled(this.#control))
    }, this.#context.settings.agentActionTimeoutMs)
    this.#readyTimer.unref?.()
  }

  async #command(
    viewer: SessionViewer,
    message: Exclude<BrowserClientMessage, { t: 'hello' | 'ack' | 'pong' | 'take' | 'release' }>,
  ): Promise<void> {
    const browser = this.#browser
    if (!this.live || !browser || !this.#viewers.has(viewer.id)) return
    if (message.t === 'input') {
      const verdict = admitBrowserInput(this.#control, {
        viewer: viewer.id,
        pageId: message.pageId,
        controlEpoch: message.controlEpoch,
        viewportVersion: message.viewportVersion,
      })
      if (!verdict.ok) return viewer.refused(verdict.reason)
      if (!isBrowserInputInViewport(message.event, this.#viewport))
        return viewer.refused('outside_viewport')
      if (writes(message.event)) {
        this.#markWrote()
        this.#manualWrite()
      } else this.#touch()
      // A key or a click the page did not take in time is lost, as on a slow link.
      await browser.input(message.event).catch(() => undefined)
      return
    }
    const command = admitBrowserUserCommand(this.#control, viewer.id)
    if (!command.ok) return viewer.refused(command.reason)
    this.#touch()
    switch (message.t) {
      case 'navigate': {
        if (!this.#mayOpen(message.url)) return viewer.refused('address_denied')
        await browser.navigate(message.url).catch((error: unknown) => {
          if (browserCodeOf(error) === 'BROWSER_ACTION_DENIED') viewer.refused('address_denied')
        })
        return
      }
      case 'tab':
        if (!this.#tabs.some((tab) => tab.pageId === message.pageId))
          return viewer.refused('page_unknown')
        await browser.selectTab(message.pageId).catch(() => viewer.refused('page_unknown'))
        return
      case 'dialog':
        if (this.#dialog?.id !== message.id) return viewer.refused('dialog_unknown')
        // Accepting may send a form, leave a page or remove something.
        if (message.accept) this.#markWrote()
        await browser
          .resolveDialog(message.id, message.accept, message.text)
          .catch(() => viewer.refused('dialog_unknown'))
        return
      case 'files': {
        if (this.#chooser?.id !== message.chooserId) return viewer.refused('chooser_unknown')
        let files: BrowserFile[] = []
        if (message.attachmentIds.length > 0) {
          try {
            files = await this.#context.files.read({
              taskId: this.taskId,
              siteId: this.siteId,
              attachmentIds: message.attachmentIds,
            })
          } catch {
            return viewer.refused('attachment_unknown')
          }
          this.#markWrote()
        }
        await browser.setChooserFiles(message.chooserId, files).catch(() => undefined)
        return
      }
      case 'viewport': {
        const size = { width: message.width, height: message.height }
        await browser.setViewport(size)
        this.#viewport = size
        this.#frames.last = null
        this.#apply(browserViewportResized(this.#control))
        // The screencast keeps the size it started with: it starts again at the new one.
        this.#syncFrames(true)
        return
      }
    }
  }

  /**
   * The client typed or clicked in the editor of an object: the worker cannot tell a save from a
   * click, so the object is unconfirmed until a check reads it (Б22).
   */
  #manualWrite(): void {
    const tab = this.#tabs.find((item) => item.pageId === this.#control.pageId)
    const ref = tab ? this.#checkpointRef(tab.url) : null
    if (ref === null) return
    if (this.#checkpoints.get(checkpointKey(ref))?.state === 'unverified') return
    this.#record(ref, 'unverified')
  }

  #mayOpen(url: string): boolean {
    if (!browserNavigationAllowed(url, this.#spec.allowedHosts, this.#spec.localOrigins))
      return false
    try {
      const target = new URL(url)
      // The client's own navigation: judged for whoever holds the browser (Б37).
      return !this.#spec.policy.pageDenied(
        `${target.pathname}${target.search}`,
        this.#control.controller,
      )
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------------------------
  // The agent
  // -------------------------------------------------------------------------------------------

  /**
   * The site's saved sign-in core read for this pass (Б36): it replaces the one held, and none
   * forgets it. The values stay in this object: never logged, stored or answered.
   */
  useSignIn(credentials: BrowserSignIn | null): void {
    this.#signIn = credentials
  }

  /**
   * Signs in with the saved sign-in when the shown page is the stack's form and the agent holds
   * the browser (Б36): while the client controls it, the form is theirs. One the site refused is
   * not sent again. A failure is the operator's line; the agent sees the form and asks the client.
   */
  async #signInIfAsked(browser: CloudBrowserSession): Promise<void> {
    const credentials = this.#signIn
    if (credentials === null || !this.live || this.#control.controller !== 'agent') return
    const refused = this.#signInRefused
    if (refused?.login === credentials.login && refused.password === credentials.password) return
    try {
      if ((await browser.signIn(credentials)) !== 'refused') return
      this.#context.warn('browser_sign_in_refused')
    } catch (error) {
      this.#context.warn('browser_sign_in_failed', error)
    }
    this.#signInRefused = credentials
  }

  /** core's turn starts (`ensure` with `takeControl`, Б16): the agent takes the browser back. */
  agentTakesControl(): void {
    if (!this.live) return
    this.#apply(agentTakesBrowserControl(this.#control))
    if (this.#help) {
      this.#help = null
      this.#write(() => this.#context.store.clearHelp(this.id), 'browser_help_not_cleared')
      this.#publish()
    }
  }

  /**
   * One action of the agent (`POST …/actions`): in its turn after the ones before it, refused
   * when the client controls the browser. The answer comes within `actionBudgetMs`; the next
   * action waits until this one has really finished in the page.
   */
  act(action: BrowserAction): Promise<BrowserToolResult> {
    const queuedAt = this.#context.now()
    return new Promise<BrowserToolResult>((resolve, reject) => {
      const run = async () => {
        const outcome: { result: 'ok' | BrowserTaskCode } = { result: 'ok' }
        const settle = (error: unknown) => {
          // The first outcome stands: a timeout already answered is not answered again.
          if (outcome.result !== 'ok') return
          outcome.result = browserCodeOf(error)
          reject(browserTaskError(outcome.result))
        }
        try {
          const browser = this.#browser
          if (!this.live || this.#status !== 'ready' || !browser || !browser.isConnected())
            return settle(browserTaskError('BROWSER_SESSION_UNAVAILABLE'))
          if (this.#context.now() - queuedAt > this.#context.settings.queueWaitMs)
            return settle(browserTaskError('BROWSER_TIMEOUT'))
          if (admitBrowserAgentAction(this.#control) !== 'ok')
            return settle(browserTaskError('BROWSER_USER_IN_CONTROL'))
          this.#apply(browserAgentActionStarted(this.#control))
          const timer = setTimeout(
            () => settle(browserTaskError('BROWSER_TIMEOUT')),
            this.#context.settings.actionBudgetMs,
          )
          try {
            // Signed out meanwhile (a session that expired on the site): the saved sign-in first.
            if (action.tool !== 'web_help') await this.#signInIfAsked(browser)
            resolve(await this.#perform(browser, action))
          } catch (error) {
            settle(error)
          } finally {
            clearTimeout(timer)
            this.#apply(browserAgentActionSettled(this.#control))
            this.#touch()
          }
        } finally {
          this.#context.metrics.action(action.tool, outcome.result)
          if (outcome.result === 'BROWSER_SESSION_UNAVAILABLE' && this.live && !this.connected())
            void this.#end('lost', 'crashed')
        }
      }
      this.#actions = this.#actions.then(run, run)
    })
  }

  /** core's check of every checkpoint (`POST …/verify`), in turn with the agent's actions. */
  verify(): Promise<BrowserVerifiedCheckpoint[]> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        const browser = this.#browser
        if (this.#status !== 'ready' || !browser || !browser.isConnected()) {
          reject(browserTaskError('BROWSER_SESSION_UNAVAILABLE'))
          return
        }
        try {
          resolve(await this.#verifyAll(browser))
        } catch (error) {
          reject(error)
        }
      }
      this.#actions = this.#actions.then(run, run)
    })
  }

  async #perform(browser: CloudBrowserSession, action: BrowserAction): Promise<BrowserToolResult> {
    switch (action.tool) {
      case 'web_observe': {
        if (action.ref !== undefined && !this.#observation?.refs.has(action.ref))
          throw browserTaskError('BROWSER_STALE_OBSERVATION')
        const epoch = this.#control.controlEpoch
        const observed = await browser.observe(action.ref === undefined ? {} : { ref: action.ref })
        this.#observationSeq = (this.#observationSeq % OBSERVATION_MAX) + 1
        const id = `o${this.#observationSeq}`
        // A tree read while the client took the browser is answered but not kept: its
        // references come back stale (Б16).
        this.#observation =
          this.#control.controlEpoch === epoch
            ? {
                id,
                pageId: observed.page.pageId,
                tree: observed.tree,
                refs: browserTreeRefs(observed.tree),
              }
            : null
        // The links lose their secret parameters before the cut: a marker may be longer than
        // the value it hides, and the cut tree must stay within its bound.
        const clipped = clipTree(
          redactTreeAddresses(observed.tree),
          action.maxChars ?? browserObservationLimits.defaultChars,
        )
        return this.#checked({
          tool: 'web_observe',
          observation: id,
          page: observed.page,
          tabs: browser.tabs(),
          controller: this.#control.controller,
          tree: clipped.text,
          truncated: clipped.truncated,
          ...this.#waiting(observed.page),
        })
      }
      case 'web_open': {
        if (!browserNavigationAllowed(action.url, this.#spec.allowedHosts, this.#spec.localOrigins))
          throw browserTaskError('BROWSER_ADDRESS_DENIED')
        // While a save is unconfirmed the agent opens nothing new: only an object of the task. A
        // save that waits for its object holds here whatever a check found (Б22).
        if (this.#blocked()) {
          const target = this.#checkpointRef(action.url)
          if (target === null || !this.#checkpoints.has(checkpointKey(target)))
            throw browserTaskError('BROWSER_CHECKPOINT_UNVERIFIED')
        }
        return this.#outcome('web_open', await browser.act(action))
      }
      case 'web_click': {
        const { observation, ...rest } = action
        const ref = this.#ref(observation, rest.ref)
        return this.#commitOr('web_click', browser, this.#commitOf(ref), rest)
      }
      case 'web_press': {
        const { observation, ref: named, ...rest } = action
        const ref = named === undefined ? undefined : this.#ref(observation, named)
        const press: CloudBrowserAction = ref === undefined ? rest : { ...rest, ref }
        const commit = await this.#pressCommit(browser, action.key, ref)
        return this.#commitOr('web_press', browser, commit, press)
      }
      case 'web_fill': {
        const { observation, ...rest } = action
        this.#ref(observation, rest.ref)
        this.#markWrote()
        return this.#outcome('web_fill', await browser.act(rest))
      }
      case 'web_type':
        this.#markWrote()
        return this.#outcome('web_type', await browser.act(action))
      case 'web_scroll': {
        const { observation, ref: named, ...rest } = action
        if (named === undefined) return this.#outcome('web_scroll', await browser.act(rest))
        return this.#outcome(
          'web_scroll',
          await browser.act({ ...rest, ref: this.#ref(observation, named) }),
        )
      }
      case 'web_upload': {
        const ref = action.ref === undefined ? undefined : this.#ref(action.observation, action.ref)
        const files = await this.#context.files.read({
          taskId: this.taskId,
          siteId: this.siteId,
          attachmentIds: action.attachmentIds,
        })
        this.#markWrote()
        const result = await browser.act({
          tool: 'web_upload',
          ...(ref === undefined ? {} : { ref }),
          files,
        })
        return this.#outcome('web_upload', result, { uploaded: result.uploaded ?? files.length })
      }
      case 'web_dialog':
        if (action.accept) this.#markWrote()
        return this.#outcome('web_dialog', await browser.act(action))
      case 'web_wait': {
        const result = await browser.act(action)
        return this.#outcome('web_wait', result, { matched: result.matched ?? false })
      }
      case 'web_tab':
        return this.#tab(browser, action)
      case 'web_help': {
        const help: BrowserHelp = { reason: action.reason, message: action.message }
        if (!(await this.#context.store.recordHelp({ sessionId: this.id, ...help })))
          throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
        this.#help = help
        this.#publish()
        return this.#checked({ tool: 'web_help', requested: true, reason: action.reason })
      }
      case 'web_screenshot': {
        // Taken only while the agent holds the browser, and kept only when it still does: a
        // snapshot never shows what the client typed in their own turn (Б15–Б17).
        const epoch = this.#control.controlEpoch
        const shot = await browser.screenshot({
          qualities: browserScreenshotLimits.qualities,
          maxBytes: browserScreenshotLimits.bytes,
        })
        if (this.#control.controlEpoch !== epoch || this.#control.controller !== 'agent')
          throw browserTaskError('BROWSER_USER_IN_CONTROL')
        const { number } = await this.#context.screenshots.save({
          taskId: this.taskId,
          sessionId: this.id,
          bytes: shot.bytes,
          width: shot.width,
          height: shot.height,
        })
        return this.#checked({ tool: 'web_screenshot', page: shot.page, attached: true, number })
      }
      case 'web_verify': {
        const objects = await this.#verifyAll(browser)
        const verified = objects.filter((item) => item.state === 'verified')
        const expect = action.expect ?? 'any'
        const matched =
          verified.length > 0 &&
          (expect === 'any' || verified.every((item) => item.object?.status === expect))
        return this.#checked({ tool: 'web_verify', objects, matched })
      }
    }
  }

  /** A reference of the latest observation, or the observation is stale (Б20). */
  #ref(observation: string | undefined, ref: string): string {
    const latest = this.#observation
    if (!latest || latest.id !== observation || latest.pageId !== this.#control.pageId)
      throw browserTaskError('BROWSER_STALE_OBSERVATION')
    if (!latest.refs.has(ref)) throw browserTaskError('BROWSER_STALE_OBSERVATION')
    return ref
  }

  /**
   * Some object of the task is saved and unconfirmed, or a save waits for its object (Б22). The
   * editor that saved may save again on `pageId` once a check found no object yet and it stayed
   * where it was — the block editor's «Опубликовать» opens a panel whose own button publishes.
   */
  #blocked(pageId: number | null = null): boolean {
    const pending = this.#pendingCommit
    const held =
      pending !== null &&
      !pending.released &&
      !(pending.checked && !pending.moved && pending.pageId === pageId)
    const states = [...this.#checkpoints.values()].map((record) => record.state)
    return held || browserCheckpointsBlock(states)
  }

  /**
   * Whether a save of `target` (null — an object with no address yet, a new one) would change
   * more objects than a task may (Б34, CLAUDE.md rule 4). An object the task already saved may be
   * saved again; the count is the task's, across its sessions and turns.
   */
  #overChangeLimit(target: BrowserCheckpointRef | null): boolean {
    const changed = [...this.#checkpoints.values()].filter((record) => record.state !== 'seen')
    if (
      target !== null &&
      changed.some((record) => checkpointKey(record.ref) === checkpointKey(target))
    )
      return false
    return changed.length >= browserCheckpointLimits.changedObjects
  }

  /** What the element of a reference does to the object when pressed: a stack's save or publish. */
  #commitOf(ref: string): BrowserCommitAction | null {
    const element = this.#observation ? browserTreeElement(this.#observation.tree, ref) : null
    return element ? this.#spec.adapter.browserCommitAction(element.role, element.name) : null
  }

  /**
   * What a press does to the object (Б22, Б34): the save shortcut saves whatever has the focus;
   * Enter or a space presses the element of the reference or — without one — the element that
   * has the focus now (the agent may have reached a button with Tab since its latest tree), judged
   * as a click on it. A focus the browser cannot read fails the press before anything is pressed.
   */
  async #pressCommit(
    browser: CloudBrowserSession,
    key: string,
    ref: string | undefined,
  ): Promise<BrowserCommitAction | null> {
    if (isSaveShortcut(key)) return 'save'
    if (!pressingKey(key)) return null
    if (ref !== undefined) return this.#commitOf(ref)
    const focused = await browser.focused()
    return focused ? this.#spec.adapter.browserCommitAction(focused.role, focused.name) : null
  }

  /**
   * An action that may save or publish an object (Б22): refused while another save is
   * unconfirmed or when the task has changed as many objects as it may (Б34); after it —
   * whatever came of it, a timeout included — the object is unconfirmed until a check reads it,
   * so an unclear outcome leaves no duplicate. With `asked` null — or on another site, which
   * saves nothing of the site (Ч6) — it is an ordinary action.
   */
  async #commitOr(
    tool: 'web_click' | 'web_press',
    browser: CloudBrowserSession,
    asked: BrowserCommitAction | null,
    action: CloudBrowserAction,
  ): Promise<BrowserToolResult> {
    const pageId = this.#control.pageId
    const before = this.#tabs.find((tab) => tab.pageId === pageId)?.url ?? ''
    const commit = this.#elsewhere(before) ? null : asked
    if (commit !== null) {
      if (this.#blocked(pageId)) throw browserTaskError('BROWSER_CHECKPOINT_UNVERIFIED')
      if (this.#overChangeLimit(this.#checkpointRef(before)))
        throw browserTaskError('BROWSER_ACTION_DENIED')
    }
    this.#markWrote()
    let result: CloudBrowserActResult
    try {
      result = await browser.act(action)
    } catch (error) {
      // A stale reference never reached the page; anything else may have.
      if (commit !== null && browserCodeOf(error) !== 'BROWSER_STALE_OBSERVATION')
        this.#committed(pageId, before, null)
      throw error
    }
    if (commit !== null) this.#committed(pageId, before, result.page.url)
    return this.#outcome(tool, result)
  }

  #committed(pageId: number | null, before: string, after: string | null): void {
    const ref = this.#checkpointRef(before) ?? (after === null ? null : this.#checkpointRef(after))
    const pending = this.#pendingCommit
    if (ref !== null) {
      // The page shows the object its earlier save waited for.
      if (pending?.pageId === pageId && !pending.moved) this.#pendingCommit = null
      this.#record(ref, 'unverified')
    } else if (pageId !== null)
      this.#pendingCommit = { pageId, checked: false, moved: false, released: false }
  }

  async #tab(
    browser: CloudBrowserSession,
    action: Extract<BrowserAction, { tool: 'web_tab' }>,
  ): Promise<BrowserToolResult> {
    if (action.action !== 'list') {
      const pageId = action.pageId ?? 0
      if (!browser.tabs().some((tab) => tab.pageId === pageId))
        throw browserTaskError('BROWSER_ACTION_FAILED')
      if (action.action === 'select') await browser.selectTab(pageId)
      else await browser.closeTab(pageId)
      this.#observation = null
    }
    const tabs = browser.tabs()
    const shown = browser.shown()
    return this.#checked({
      tool: 'web_tab',
      page: tabs.find((tab) => tab.pageId === shown) ?? null,
      tabs: tabs.slice(0, 8),
    })
  }

  /** Where an action left the browser, and what now waits for the agent. */
  #outcome(
    tool: Exclude<BrowserToolName, 'web_observe' | 'web_tab' | 'web_help' | 'web_verify'>,
    result: CloudBrowserActResult,
    extra: { matched?: boolean; uploaded?: number } = {},
  ): BrowserToolResult {
    return this.#checked({
      tool,
      page: result.page,
      ...this.#waiting(result.page),
      ...extra,
    } as BrowserToolResult)
  }

  /** The dialog or file chooser of the shown page, and the object it edits. */
  #waiting(page: BrowserTab) {
    const dialog = this.#dialog
    const chooser = this.#chooser
    const ref = this.#checkpointRef(page.url)
    const known = ref ? this.#checkpoints.get(checkpointKey(ref)) : undefined
    return {
      ...(dialog
        ? {
            dialog: {
              kind: dialog.kind,
              message: dialog.message,
              ...(dialog.defaultValue === undefined ? {} : { defaultValue: dialog.defaultValue }),
            },
          }
        : {}),
      ...(chooser ? { chooser: { multiple: chooser.multiple, accept: chooser.accept } } : {}),
      ...(ref
        ? { checkpoint: { kind: ref.kind, objectId: ref.objectId, state: known?.state ?? 'seen' } }
        : {}),
    }
  }

  /**
   * The answer as the contract has it; anything else is a failed action, not a broken one. Every
   * address in it loses its secret parameters and its fragment first (CLAUDE.md rule 2): the page,
   * the tabs, the objects of a check, the links of a tree — what the session keeps stays whole.
   */
  #checked(result: BrowserToolResult): BrowserToolResult {
    const parsed = browserToolResultSchema.safeParse(redactResultAddresses(result))
    if (parsed.success) return parsed.data
    this.#context.warn('browser_tool_result_refused')
    throw browserTaskError('BROWSER_ACTION_FAILED')
  }

  /**
   * Every checkpoint the task saved, read again on the site through the session's own sign-in
   * (Б22, Б23): found, gone, or unreadable — then what was known stays. Within its budget; the
   * newest ones when there are more than an answer carries.
   */
  async #verifyAll(browser: CloudBrowserSession): Promise<BrowserVerifiedCheckpoint[]> {
    // A save that waits for its object: the page may show the object by now. If not, the save may
    // still land (a slow site): the hold stays, and only the editor that saved may save again.
    const pending = this.#pendingCommit
    if (pending !== null && !pending.moved) {
      const tab = browser.tabs().find((item) => item.pageId === pending.pageId)
      const ref = tab ? this.#checkpointRef(tab.url) : null
      if (ref !== null) {
        this.#pendingCommit = null
        this.#record(ref, 'unverified')
      } else pending.checked = true
    }
    await this.#writes
    const records = [...this.#checkpoints.values()]
      .filter((record) => record.state !== 'seen')
      .slice(-browserToolLimits.verifyObjects)
    const until = this.#context.now() + this.#context.settings.verifyBudgetMs
    const out: BrowserVerifiedCheckpoint[] = []
    for (const record of records) {
      let current = record
      const left = until - this.#context.now()
      if (left > 0 && browser.isConnected()) {
        try {
          // A read that outlives the budget leaves its object as it was known.
          const reading = await withTimeout(
            browser.verify(this.#spec.adapter.browserVerification(record.ref)),
            left,
            'browser checkpoint read',
          )
          const state = browserCheckpointAfterRead(record.state, reading)
          if (reading.state === 'verified')
            current = await this.#context.store.upsertCheckpoint({
              taskId: this.taskId,
              sessionId: this.id,
              ref: record.ref,
              state,
              verified: reading.object,
            })
          else if (reading.state === 'missing')
            current = await this.#context.store.upsertCheckpoint({
              taskId: this.taskId,
              sessionId: this.id,
              ref: record.ref,
              state,
            })
          this.#checkpoints.set(checkpointKey(record.ref), current)
        } catch (error) {
          // A read that failed, or found another object than asked: what was known stays.
          this.#context.warn('browser_checkpoint_read_failed', error)
        }
      }
      out.push({
        kind: current.ref.kind,
        objectId: current.ref.objectId,
        state: current.state,
        ...(current.state === 'verified' && current.verified ? { object: current.verified } : {}),
      })
    }
    return out
  }
}
