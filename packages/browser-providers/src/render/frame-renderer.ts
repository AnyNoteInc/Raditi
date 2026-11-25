import { Buffer } from 'node:buffer'

import { artifactRenderLimits } from '@repo/domain/artifacts'
import { chromium, type Browser, type CDPSession, type Route } from 'playwright-core'

import {
  createDiagramRenderer,
  type DiagramJob,
  type DiagramRawResult,
} from './diagram-renderer.ts'
import { renderFontFaces } from './fonts.ts'
import { printOn, type PrintJob } from './print-renderer.ts'
import { LAYOUT_PROBE_SOURCE } from './probe-source.ts'

// The server render of a saved frame of an artifact (docs/plan/88-artifacts.md, Ар32, §7.12,
// §7.13; spike 3, lib/render.mjs). One Chromium without network: every request of the page goes
// through `context.route`, which serves the frame document with the frame's own CSP and the
// fonts and files of the platform from memory, answers 204 to a navigation away and refuses the
// rest; WebSocket is closed by its own route and by the CSP, WebRTC by the launch flag, and the
// container of the Chromium has no way out at all. Steps: load → settle → a pass of scrolling →
// freeze (scripts off, animations finished) → the probe in an isolated world → the pictures.

/** The origins the renderer serves on; `.invalid` never resolves (RFC 6761). */
export const RENDER_DOC_URL = 'https://frame.render.invalid/v/frame'
export const RENDER_FILES_ORIGIN = 'https://pages.render.invalid'

export const renderThresholds = Object.freeze({
  smallPx: 12,
  contrastNormal: 4.5,
  contrastLarge: 3,
  emptyMinPx: 300,
  emptyFrac: 0.5,
  tapPx: 24,
  maxRects: 6000,
})

/** Chromium's flags: those of the session browser, no smooth scrolling, a cap of the V8 heap. */
export function renderChromiumArgs(): string[] {
  return [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    '--disable-dev-shm-usage',
    '--disable-smooth-scrolling',
    '--disable-blink-features=AutomationControlled',
    `--js-flags=--max-old-space-size=${artifactRenderLimits.v8HeapMb}`,
  ]
}

export interface FrameRenderFile {
  type: string
  bytes: Uint8Array
}

export interface FrameRenderJob {
  /** The document of the frame as the platform assembles it. */
  html: string
  /** Its Content-Security-Policy: the one `/v/` serves it with (Ar28). */
  policy: string
  /** The files it may load: an absolute URL on `RENDER_FILES_ORIGIN` → its bytes. */
  files: ReadonlyMap<string, FrameRenderFile>
  width: number
  height: number
  outputs: {
    map?: boolean
    /** JPEG q70 strips of `stripPx` for the helper `look`, at most this many. */
    strips?: number
    /** A JPEG of the page from the top at this scale, at most `maxCssPx` CSS px of it. */
    thumb?: { scale: number; maxCssPx: number; quality?: number; format?: 'jpeg' | 'png' }
  }
  /** One width end to end; past it the context is closed. */
  deadlineMs?: number
}

export interface FrameRenderEvents {
  requests: number
  blocked: { url: string; type: string; navigation: boolean }[]
  navigations: string[]
  csp: { url: string | null; kind: string; directive: string | null }[]
  pageErrors: string[]
  consoleErrors: string[]
  dialogs: number
  popups: number
  crashed: boolean
}

/** What the probe returns (probe-source.ts): read by the report. */
export interface LayoutProbeMap {
  doc: { vw: number; vh: number; docW: number; docH: number; viewportMeta: string | null }
  issues: Record<string, unknown>[]
  photo: unknown[]
  rects: unknown[]
}

export interface FrameRenderResult {
  width: number
  height: number
  docHeight: number | null
  map: LayoutProbeMap | null
  events: FrameRenderEvents
  hung: boolean
  settled: boolean | null
  error: string | null
  strips: Uint8Array[]
  thumb: Uint8Array | null
  ms: number
}

export interface FrameRenderer {
  render(job: FrameRenderJob): Promise<FrameRenderResult>
  /**
   * A diagram on the page of its workspace and engine (88.24а; plan 91, Д2): the SVG Mermaid or
   * PlantUML drew, uncleaned.
   */
  diagram(job: DiagramJob): Promise<DiagramRawResult>
  /** A page without scripts printed into a PDF, A4 (88.32): «Скачать PDF» of «Отчёт». */
  print(job: PrintJob): Promise<Uint8Array>
  /** False after the browser went away: the pool replaces it. */
  connected(): boolean
  close(): Promise<void>
}

const limits = artifactRenderLimits

const SETTLE = `(async () => {
  const t0 = performance.now()
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, ${limits.settleMs}))])
  let last = performance.now()
  const mo = new MutationObserver(() => { last = performance.now() })
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)))
  let settled = false
  while (performance.now() - t0 < ${limits.settleMs}) {
    await frame()
    if (performance.now() - last >= 150) { settled = true; break }
  }
  mo.disconnect()
  return settled
})()`

const SCROLL = `(async () => {
  const se = document.scrollingElement || document.documentElement
  const height = Math.min(se.scrollHeight, ${limits.scrollPassPx})
  const step = Math.max(200, Math.round(innerHeight * 0.85))
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  for (let y = step; y < height; y += step) { jump(y); await frame(); await frame() }
  jump(0); await frame(); await frame()
  const pending = [...document.images].filter((i) => !i.complete)
  if (pending.length) await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r) }))), new Promise((r) => setTimeout(r, 800))])
  return true
})()`

const FREEZE = `(() => {
  for (const a of document.getAnimations()) {
    try { const t = a.effect && a.effect.getComputedTiming(); if (t && t.endTime === Infinity) a.cancel(); else a.finish() } catch (e) {}
  }
  for (const m of document.querySelectorAll('video, audio')) { try { m.pause() } catch (e) {} }
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur()
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  return true
})()`

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const CSP_URL = /'((?:https?|wss?):[^']+)'/
const CSP_KIND =
  /(?:Loading|load) the (\w+)|Refused to (?:load|connect|frame|send|apply|execute) (?:the )?(\w+)?/

function newEvents(): FrameRenderEvents {
  return {
    requests: 0,
    blocked: [],
    navigations: [],
    csp: [],
    pageErrors: [],
    consoleErrors: [],
    dialogs: 0,
    popups: 0,
    crashed: false,
  }
}

function serve(route: Route, job: FrameRenderJob, events: FrameRenderEvents) {
  const request = route.request()
  const url = request.url()
  events.requests += 1
  if (url === RENDER_DOC_URL && request.isNavigationRequest())
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': job.policy,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
      body: job.html,
    })
  const face = renderFontFaces().find((each) => url === `${RENDER_FILES_ORIGIN}/v/lib-${each.file}`)
  const file = face ? { type: 'font/woff2', bytes: face.bytes } : job.files.get(url)
  if (file)
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': file.type,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff',
      },
      body: Buffer.from(file.bytes),
    })
  let leaving = false
  try {
    leaving = request.isNavigationRequest() && request.frame().parentFrame() === null
  } catch {
    // A worker's request has no frame.
  }
  if (leaving) {
    // A link, a form, a refresh or a script leaving the frame: 204 keeps the document drawn.
    if (events.navigations.length < 10) events.navigations.push(url.slice(0, 120))
    return route.fulfill({ status: 204, body: '' })
  }
  if (events.blocked.length < 40)
    events.blocked.push({
      url: url.slice(0, 120),
      type: request.resourceType(),
      navigation: request.isNavigationRequest(),
    })
  return route.abort('blockedbyclient')
}

async function renderOn(browser: Browser, job: FrameRenderJob): Promise<FrameRenderResult> {
  const started = performance.now()
  const events = newEvents()
  const out: FrameRenderResult = {
    width: job.width,
    height: job.height,
    docHeight: null,
    map: null,
    events,
    hung: false,
    settled: null,
    error: null,
    strips: [],
    thumb: null,
    ms: 0,
  }
  const context = await browser.newContext({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
    acceptDownloads: false,
    serviceWorkers: 'block',
  })
  let deadlineTimer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`render deadline of ${job.deadlineMs ?? limits.widthMs} ms`)),
      job.deadlineMs ?? limits.widthMs,
    )
  })
  let crashed: () => void = () => undefined
  const crash = new Promise<never>((_, reject) => {
    crashed = () => reject(new Error('the frame crashed its renderer'))
  })
  crash.catch(() => undefined)
  deadline.catch(() => undefined)
  const work = async () => {
    await context.route('**/*', (route) => serve(route, job, events))
    await context.routeWebSocket(/.*/, (socket) => socket.close())
    // The frame sees no sign of the automation (spike 3: a frame that checks it draws otherwise).
    await context.addInitScript(
      "try{Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false})}catch(e){}",
    )
    const page = await context.newPage()
    page.on('pageerror', (error) => {
      if (events.pageErrors.length < 10)
        events.pageErrors.push(`${error.name || 'Error'}: ${String(error.message).slice(0, 160)}`)
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (/Content Security Policy/.test(text)) {
        if (events.csp.length < 40) {
          const url = CSP_URL.exec(text)
          const kind = CSP_KIND.exec(text)
          const directive = /directive: "([\w-]+)/.exec(text)
          events.csp.push({
            url: url ? url[1]!.slice(0, 120) : null,
            kind: kind ? (kind[1] ?? kind[2] ?? 'load') : 'load',
            directive: directive ? directive[1]! : null,
          })
        }
        return
      }
      if (/ERR_BLOCKED_BY_CLIENT|net::ERR_/.test(text)) return
      if (events.consoleErrors.length < 10) events.consoleErrors.push(text.slice(0, 160))
    })
    page.on('crash', () => {
      events.crashed = true
      crashed()
    })
    page.on('dialog', (dialog) => {
      events.dialogs += 1
      dialog.dismiss().catch(() => undefined)
    })
    page.on('popup', (popup) => {
      events.popups += 1
      popup.close().catch(() => undefined)
    })
    const cdp: CDPSession = await context.newCDPSession(page)
    const tree = (await withTimeout(cdp.send('Page.getFrameTree'), 2000, 'frame tree')) as {
      frameTree: { frame: { id: string } }
    }
    await page.goto(RENDER_DOC_URL, { waitUntil: 'commit', timeout: limits.loadMs })
    const createWorld = async () =>
      (await withTimeout(
        cdp.send('Page.createIsolatedWorld', {
          frameId: tree.frameTree.frame.id,
          worldName: 'raditi-render',
          grantUniveralAccess: false,
        }),
        1500,
        'isolated world',
      )) as { executionContextId: number }
    const terminate = () =>
      withTimeout(cdp.send('Runtime.terminateExecution'), 2000, 'terminate').catch(() => undefined)
    let world: { executionContextId: number }
    try {
      world = await createWorld()
    } catch {
      out.hung = true
      await terminate()
      world = await createWorld()
    }
    const evaluate = async <T>(expression: string, ms: number, what: string): Promise<T> => {
      const result = (await withTimeout(
        cdp.send('Runtime.evaluate', {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        }),
        ms,
        what,
      )) as { result: { value: T }; exceptionDetails?: { text: string } }
      if (result.exceptionDetails) throw new Error(`${what}: ${result.exceptionDetails.text}`)
      return result.result.value
    }
    // The document's own load event; a frame that holds the main thread answers no ping.
    const loaded = await evaluate<boolean>(
      "new Promise((r) => { if (document.readyState === 'complete') r(true); else addEventListener('load', () => r(true), { once: true }) })",
      limits.loadMs,
      'load',
    ).catch(() => false)
    if (!loaded) {
      const alive = await evaluate('1', limits.probeIntervalMs, 'ping')
        .then(() => true)
        .catch(() => false)
      if (!alive) {
        out.hung = true
        await terminate()
        await evaluate('1', 1000, 'after terminate').catch(() => undefined)
      }
    }
    if (!out.hung)
      out.settled = await evaluate<boolean>(SETTLE, limits.settleMs + 1500, 'settle').catch(() => {
        out.hung = true
        return false
      })
    if (!out.hung)
      await evaluate(SCROLL, limits.scrollPassMs, 'scroll').catch(() => {
        out.hung = true
      })
    if (out.hung) {
      await terminate()
      await evaluate('1', 1000, 'after terminate').catch(() => undefined)
    }
    await withTimeout(
      cdp.send('Emulation.setScriptExecutionDisabled', { value: true }),
      2000,
      'freeze scripts',
    )
    await evaluate(FREEZE, 2000, 'freeze')
    if (job.outputs.map || job.outputs.strips || job.outputs.thumb) {
      const map = await evaluate<LayoutProbeMap>(
        `${LAYOUT_PROBE_SOURCE}\n;raditiLayoutProbe(${JSON.stringify({ thresholds: renderThresholds, maxRects: renderThresholds.maxRects })})`,
        limits.probeMs,
        'probe',
      )
      out.docHeight = map.doc.docH
      if (job.outputs.map) out.map = map
    }
    const docHeight = out.docHeight ?? job.height
    const capture = async (params: Record<string, unknown>, what: string) => {
      const { data } = (await withTimeout(
        cdp.send('Page.captureScreenshot', {
          captureBeyondViewport: true,
          fromSurface: true,
          ...params,
        }),
        8000,
        what,
      )) as { data: string }
      return new Uint8Array(Buffer.from(data, 'base64'))
    }
    if (job.outputs.thumb) {
      const { scale, maxCssPx, quality = 70, format = 'jpeg' } = job.outputs.thumb
      out.thumb = await capture(
        {
          format,
          ...(format === 'jpeg' ? { quality } : {}),
          clip: { x: 0, y: 0, width: job.width, height: Math.min(docHeight, maxCssPx), scale },
        },
        'thumbnail',
      )
    }
    const strips = job.outputs.strips ?? 0
    for (let i = 0; i < strips && i * limits.stripPx < docHeight; i += 1) {
      const y = i * limits.stripPx
      out.strips.push(
        await capture(
          {
            format: 'jpeg',
            quality: 70,
            clip: {
              x: 0,
              y,
              width: job.width,
              height: Math.min(limits.stripPx, docHeight - y),
              scale: 1,
            },
          },
          'strip',
        ),
      )
    }
  }
  try {
    await Promise.race([work(), deadline, crash])
  } catch (error) {
    out.error = String((error as Error)?.message ?? error)
      .split('\n')[0]!
      .slice(0, 200)
  } finally {
    clearTimeout(deadlineTimer)
    await withTimeout(context.close(), 5000, 'close').catch(() => undefined)
    out.ms = Math.round(performance.now() - started)
  }
  return out
}

export type FrameRendererTarget =
  /** The control endpoint of a render container (`BrowserSessionRuntime.start`). */
  | { endpoint: string }
  /** A Chromium of this machine: tests, stands and dev without the runtime's images, never production. */
  | { launch: true; executablePath?: string }

/** A renderer on one Chromium; two renders at a time on it at most (§7.12). */
export async function createPlaywrightFrameRenderer(
  target: FrameRendererTarget,
): Promise<FrameRenderer> {
  const browser =
    'endpoint' in target
      ? await chromium.connect(target.endpoint, { timeout: 30_000 })
      : await chromium.launch({
          headless: true,
          args: renderChromiumArgs(),
          // What a route misses leaves nowhere: the proxy is a closed port, loopback included.
          proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
          ...(target.executablePath ? { executablePath: target.executablePath } : {}),
        })
  const diagrams = createDiagramRenderer(browser)
  return {
    render: (job) => renderOn(browser, job),
    diagram: (job) => diagrams.render(job),
    print: (job) => printOn(browser, job),
    connected: () => browser.isConnected(),
    close: async () => {
      await diagrams.close()
      await browser.close().catch(() => undefined)
    },
  }
}
