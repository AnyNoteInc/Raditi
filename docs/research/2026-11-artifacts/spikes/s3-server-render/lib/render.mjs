// The server render of a saved artifact frame (spike s3 of plan 88, Ар32, §7.13 «Выгрузка»).
// One Chromium, a fresh context per render, no network: every request of the page goes through
// `context.route`, which serves the frame document with the frame's CSP and the platform's fonts
// and files from memory and refuses the rest; the launch proxy is a black hole behind it.
// Steps: load → settle (fonts, DOM quiet) → scroll pass → freeze (scripts off, animations
// finished) → layout map in an isolated world → PNG, PDF, thumbnail, strips → optional pixel check.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_URL, PLATFORM_ORIGIN, FONT_FACES, ROOT } from './frames.mjs'

export const LIMITS = Object.freeze({
  loadMs: 3000, // navigation to `load`
  settleQuietMs: 150, // the DOM is quiet this long…
  settleMaxMs: 1000, // …or this long passed after `load`
  scrollMaxMs: 2500, // the scroll pass that wakes reveal-on-scroll and lazy pictures
  probeMs: 5000, // the layout probe
  captureMs: 8000, // one capture (PNG, PDF, thumbnail)
  maxHeight: 16000, // CSS px of the full PNG and of the scroll pass
  pdfMaxPages: 30,
  thumbWidth: 480,
  thumbMaxCss: 4800, // CSS px of the page the full thumbnail shows
  stripHeight: 2000,
  strips: 2,
  pixelsMax: 24, // text blocks on pictures the pixel check samples
  deadlineMs: 30000, // the whole render of one width; past it the context is closed
})

export const THRESHOLDS = Object.freeze({ smallPx: 12, contrastNormal: 4.5, contrastLarge: 3, emptyMinPx: 300, emptyFrac: 0.5, tapPx: 24, maxRects: 6000 })

/** The frame's policy as plan 88 has it (Ар28): scripts inline, no popups, no network but the platform's paths. */
export function framePolicy() {
  return [
    'sandbox allow-scripts',
    "script-src 'unsafe-inline'",
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${PLATFORM_ORIGIN}/_a/`,
    `font-src data: blob: ${PLATFORM_ORIGIN}/_lib/`,
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** Chromium's flags: as the session browser (infra/preview/browser-server.mjs) plus a V8 heap cap. */
export function chromiumArgs() {
  return [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=512',
  ]
}

/** Launch the way apps/browser reaches Chromium: launchServer in its container, connect over WS. */
export async function launch(chromium) {
  const started = performance.now()
  const server = await chromium.launchServer({
    headless: true,
    args: chromiumArgs(),
    // Nothing the routes miss may leave: the proxy is a closed port, loopback included.
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    timeout: 60_000,
  })
  const browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 })
  return { server, browser, pid: server.process().pid, launchMs: Math.round(performance.now() - started) }
}

const PROBE = readFileSync(join(ROOT, 'lib', 'probe.js'), 'utf8')

const SETTLE = (limits) => `(async () => {
  const t0 = performance.now()
  const fonts = await Promise.race([document.fonts.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('timeout'), ${limits.settleMaxMs}))])
  const fontsMs = performance.now() - t0
  let last = performance.now()
  const mo = new MutationObserver(() => { last = performance.now() })
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)))
  let settled = false
  while (performance.now() - t0 < ${limits.settleMaxMs}) {
    await frame()
    if (performance.now() - last >= ${limits.settleQuietMs}) { settled = true; break }
  }
  mo.disconnect()
  return { settled, fonts, fontsMs: Math.round(fontsMs), ms: Math.round(performance.now() - t0) }
})()`

const SCROLL = (limits) => `(async () => {
  const se = document.scrollingElement || document.documentElement
  const height = Math.min(se.scrollHeight, ${limits.maxHeight})
  const step = Math.max(200, Math.round(innerHeight * 0.85))
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  let steps = 0
  for (let y = step; y < height; y += step) { jump(y); await frame(); await frame(); steps++ }
  jump(0); await frame(); await frame()
  const pending = [...document.images].filter((i) => !i.complete)
  if (pending.length) await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r) }))), new Promise((r) => setTimeout(r, 800))])
  return { steps, pending: pending.length }
})()`

const FREEZE = `(() => {
  let finished = 0, canceled = 0
  for (const a of document.getAnimations()) {
    try { const t = a.effect && a.effect.getComputedTiming(); if (t && t.endTime === Infinity) { a.cancel(); canceled++ } else { a.finish(); finished++ } } catch (e) {}
  }
  for (const m of document.querySelectorAll('video, audio')) { try { m.pause() } catch (e) {} }
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur()
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  return { finished, canceled }
})()`

const FINISH_ANIMATIONS = `(() => { for (const a of document.getAnimations()) { try { const t = a.effect && a.effect.getComputedTiming(); if (t && t.endTime === Infinity) a.cancel(); else a.finish() } catch (e) {} } return true })()`

const HIDE_TEXT = `(() => { const s = document.createElement('style'); s.id = 'raditi-hide-text'; s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}'; (document.head || document.documentElement).appendChild(s); return true })()`
const SHOW_TEXT = `(() => { const s = document.getElementById('raditi-hide-text'); if (s) s.remove(); return true })()`

const withTimeout = (promise, ms, what) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) })]).finally(() => clearTimeout(timer))
}

const CSP_URL = /'((?:https?|wss?):[^']+)'/
const CSP_KIND = /(?:Loading|load) the (\w+)|Refused to (?:load|connect|frame|send|apply|execute) (?:the )?(\w+)?|Connecting to|(\w+) API cannot load|Framing|Sending form data/

function serve(route, frame, assets, events, policy) {
  const request = route.request()
  const url = request.url()
  events.requests++
  if (url === DOC_URL && request.isNavigationRequest()) {
    events.served++
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(policy ? { 'content-security-policy': policy } : {}), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }, body: frame.html })
  }
  if (url.startsWith(`${PLATFORM_ORIGIN}/_lib/`)) {
    const face = FONT_FACES.find((f) => url === `${PLATFORM_ORIGIN}/_lib/${f.file}`)
    if (face) {
      events.served++
      return route.fulfill({ status: 200, headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'public, max-age=31536000, immutable' }, body: face.bytes })
    }
  }
  let leaving = false
  try { leaving = request.isNavigationRequest() && request.frame().parentFrame() === null } catch { /* a worker's request has no frame */ }
  if (leaving) {
    // A link, a form, a meta refresh or a script leaving the frame: 204 keeps the document drawn
    // (an aborted navigation would commit Chromium's error page instead).
    if (events.navigations.length < 10) events.navigations.push(url.slice(0, 120))
    return route.fulfill({ status: 204, body: '' })
  }
  const file = /^https:\/\/pages\.render\.invalid\/_a\/([\w-]+)\.jpg\?s=[0-9a-f]+$/.exec(url)
  if (file && assets[file[1]]) {
    events.served++
    return route.fulfill({ status: 200, headers: { 'content-type': 'image/jpeg', 'cross-origin-resource-policy': 'cross-origin', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300' }, body: assets[file[1]] })
  }
  if (events.blocked.length < 40) events.blocked.push({ url: url.slice(0, 120), type: request.resourceType(), navigation: request.isNavigationRequest() })
  else events.blockedMore++
  return route.abort('blockedbyclient')
}

/**
 * Render one frame at one width. `outputs`: { map, png, pdf, thumb, thumbWebp, strips, pixels }.
 * Returns timings (ms), sizes (bytes), the probe's map, what the page tried and the buffers asked
 * for in `keep`.
 */
export async function renderFrame(browser, frame, opts) {
  const { width, height = width <= 480 ? 844 : 900, outputs = {}, limits = LIMITS, thresholds = THRESHOLDS, assets, scrollPass = true, keep = {}, policy = framePolicy(), extract = null, axe = null } = opts
  const t = {}
  const sizes = {}
  const buffers = {}
  const events = { requests: 0, served: 0, blocked: [], blockedMore: 0, navigations: [], csp: [], pageErrors: [], consoleErrors: [], dialogs: 0, popups: 0, crashed: false }
  const started = performance.now()
  let last = started
  const lap = (name) => { const now = performance.now(); t[name] = Math.round((now - last) * 10) / 10; last = now }
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'ru-RU', timezoneId: 'Europe/Moscow', colorScheme: 'light', acceptDownloads: false })
  const out = { width, height, t, sizes, buffers, events }
  let deadlineTimer
  const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error(`render deadline of ${limits.deadlineMs} ms`)), limits.deadlineMs) })
  let crashed
  const crash = new Promise((_, reject) => { crashed = () => reject(new Error('the frame crashed its renderer (out of memory?)')) })
  crash.catch(() => {})
  const work = async () => {
    await context.route('**/*', (route) => serve(route, frame, assets, events, policy))
    const page = await context.newPage()
    page.on('pageerror', (e) => { if (events.pageErrors.length < 10) events.pageErrors.push(`${e.name || 'Error'}: ${String(e.message).slice(0, 160)}`) })
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const text = m.text()
      if (/Content Security Policy/.test(text)) {
        if (events.csp.length < 40) {
          const u = CSP_URL.exec(text)
          const k = CSP_KIND.exec(text)
          const directive = /directive: "([\w-]+)/.exec(text)
          events.csp.push({ url: u ? u[1].slice(0, 120) : null, kind: k ? (k[1] || k[2] || (k[3] ? 'fetch' : text.startsWith('Connecting') ? 'connect' : 'load')) : 'load', directive: directive ? directive[1] : null })
        }
        return
      }
      if (/ERR_BLOCKED_BY_CLIENT|net::ERR_/.test(text)) return
      if (events.consoleErrors.length < 10) events.consoleErrors.push(text.slice(0, 160))
    })
    page.on('crash', () => { events.crashed = true; crashed() })
    page.on('dialog', (d) => { events.dialogs++; d.dismiss().catch(() => {}) })
    page.on('popup', (p) => { events.popups++; p.close().catch(() => {}) })
    const cdp = await context.newCDPSession(page)
    lap('context')

    let hung = false
    // `commit`, not `load`: after a link click or a refresh of the frame Playwright follows the new
    // navigation, which the routes answer 204 and which never commits.
    // The main frame keeps its id across the navigation; read it while the renderer is idle.
    const { frameTree } = await withTimeout(cdp.send('Page.getFrameTree'), 2000, 'frame tree')
    await page.goto(DOC_URL, { waitUntil: 'commit', timeout: limits.loadMs })
    const createWorld = () => withTimeout(cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'raditi-render', grantUniveralAccess: false }), 1500, 'isolated world')
    // A script that never ends holds the renderer: stop it, then ask again.
    const terminate = () => withTimeout(cdp.send('Runtime.terminateExecution'), 2000, 'terminate').catch(() => {})
    let world
    try {
      world = await createWorld()
    } catch {
      hung = true
      out.loadError = "the frame's script held the page at its start"
      await terminate()
      world = await createWorld()
    }
    const evaluate = async (expression, ms, what) => {
      const r = await withTimeout(cdp.send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true }), ms, what)
      if (r.exceptionDetails) throw new Error(`${what}: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`.slice(0, 300))
      return r.result.value
    }
    // The document's own load event; no answer to a ping means its script holds the main thread.
    const loaded = await evaluate(`new Promise((r) => { if (document.readyState === 'complete') r(true); else addEventListener('load', () => r(true), { once: true }) })`, limits.loadMs, 'load').catch(() => false)
    if (!loaded) {
      const alive = await evaluate('1', 500, 'ping').then(() => true).catch(() => false)
      if (alive) out.slowLoad = true
      else { hung = true; out.loadError = `the frame's script held the page past ${limits.loadMs} ms`; await terminate(); await evaluate('1', 1000, 'after terminate').catch(() => {}) }
    }
    lap('load')
    if (!hung) {
      try { out.settle = await evaluate(SETTLE(limits), limits.settleMaxMs + 1500, 'settle') } catch { hung = true }
    }
    lap('settle')
    if (scrollPass && !hung) {
      try { out.scroll = await evaluate(SCROLL(limits), limits.scrollMaxMs, 'scroll') } catch { hung = true }
    }
    lap('scroll')
    if (axe && !hung) {
      // The reference check only: axe.run waits on timers, which stop once scripts are frozen,
      // so it runs before the freeze, while the frame's own scripts may still run.
      const a0 = performance.now()
      try {
        await evaluate(FINISH_ANIMATIONS, 2000, 'finish animations')
        await evaluate(`${axe}\n;true`, 5000, 'axe load')
        out.axe = await evaluate(`axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] }, resultTypes: ['violations', 'incomplete'] }).then((r) => {
          const ids = (n) => { const e = document.querySelector(n.target[0]); let x = e; while (x && !(x.getAttribute && x.getAttribute('data-raditi-id'))) x = x.parentElement; return x ? x.getAttribute('data-raditi-id') : null }
          const pick = (list) => list.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ el: ids(n), ratio: n.any && n.any[0] && n.any[0].data ? n.any[0].data.contrastRatio : null, reason: n.any && n.any[0] && n.any[0].data ? n.any[0].data.messageKey || null : null })) }))
          return { violations: pick(r.violations), incomplete: pick(r.incomplete) }
        })`, 20000, 'axe run')
        out.axe.ms = Math.round(performance.now() - a0)
      } catch (error) {
        out.axeError = String(error.message).slice(0, 160)
      }
      await evaluate("window.scrollTo({ top: 0, left: 0, behavior: 'instant' })", 1000, 'scroll reset').catch(() => {})
      lap('axe')
    }
    if (hung) {
      // The frame's script still runs: stop it, then everything else is frozen too.
      await withTimeout(cdp.send('Runtime.terminateExecution'), 2000, 'terminate').catch(() => {})
      await evaluate('1', 1000, 'after terminate').catch(() => {})
    }
    await withTimeout(cdp.send('Emulation.setScriptExecutionDisabled', { value: true }), 2000, 'freeze scripts')
    out.frozen = await evaluate(FREEZE, 2000, 'freeze')
    out.hung = hung
    lap('freeze')

    const map = await evaluate(`${PROBE}\n;raditiLayoutProbe(${JSON.stringify({ ids: frame.ids, thresholds, maxRects: thresholds.maxRects })})`, limits.probeMs, 'probe')
    out.map = map
    sizes.map = Buffer.byteLength(JSON.stringify(map.rects))
    lap('map')
    if (extract) out.extract = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(extract)}); return e ? e.textContent.slice(0, 600) : null })()`, 1000, 'extract')

    const docH = map.doc.docH
    const capture = async (params, what) => {
      const { data } = await withTimeout(cdp.send('Page.captureScreenshot', { captureBeyondViewport: true, fromSurface: true, ...params }), limits.captureMs, what)
      return Buffer.from(data, 'base64')
    }

    if (outputs.png) {
      const h = Math.min(docH, limits.maxHeight)
      const png = await capture({ format: 'png', clip: { x: 0, y: 0, width, height: h, scale: 1 } }, 'png')
      sizes.png = png.length
      sizes.pngHeight = h
      if (keep.png) buffers.png = png
      lap('png')
    }
    if (outputs.thumb) {
      // 1440 → 480 px (1/3); a phone width is not blown up: 390 → 195 px (1/2).
      const scale = width > limits.thumbWidth * 2 ? limits.thumbWidth / width : 0.5
      const full = await capture({ format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width, height: Math.min(docH, limits.thumbMaxCss), scale } }, 'thumb')
      sizes.thumb = full.length
      sizes.thumbHeight = Math.round(Math.min(docH, limits.thumbMaxCss) * scale)
      if (keep.thumb) buffers.thumb = full
      lap('thumb')
      const top = await capture({ format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width, height: Math.min(docH, height), scale } }, 'thumb-top')
      sizes.thumbTop = top.length
      if (keep.thumb) buffers.thumbTop = top
      lap('thumbTop')
      if (outputs.thumbWebp) {
        const webp = await capture({ format: 'webp', quality: 70, clip: { x: 0, y: 0, width, height: Math.min(docH, limits.thumbMaxCss), scale } }, 'thumb-webp')
        sizes.thumbWebp = webp.length
        lap('thumbWebp')
      }
    }
    if (outputs.strips) {
      let bytes = 0
      const strips = []
      for (let i = 0; i < limits.strips && i * limits.stripHeight < docH; i++) {
        const y = i * limits.stripHeight
        const jpeg = await capture({ format: 'jpeg', quality: 70, clip: { x: 0, y, width, height: Math.min(limits.stripHeight, docH - y), scale: 1 } }, 'strip')
        bytes += jpeg.length
        strips.push(jpeg)
      }
      sizes.strips = bytes
      sizes.stripCount = strips.length
      if (keep.strips) buffers.strips = strips
      lap('strips')
    }
    if (outputs.pdf) {
      await withTimeout(page.emulateMedia({ media: 'screen' }), 2000, 'media')
      const pdf = await withTimeout(page.pdf({ width: `${width}px`, height: `${Math.round(width * Math.SQRT2)}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' }, pageRanges: `1-${limits.pdfMaxPages}` }), limits.captureMs * 2, 'pdf')
      sizes.pdf = pdf.length
      const text = pdf.toString('latin1')
      const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => +m[1])
      sizes.pdfPages = counts.length ? Math.max(...counts) : (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length
      if (keep.pdf) buffers.pdf = pdf
      lap('pdf')
    }
    if (outputs.pixels && map.photo.length) {
      out.pixels = await pixelContrast({ cdp, evaluate, capture, map, width, limits, thresholds })
      lap('pixels')
    }
  }
  try {
    await Promise.race([work(), deadline, crash])
  } catch (error) {
    out.error = String(error.message || error).split('\n')[0].slice(0, 200)
  } finally {
    clearTimeout(deadlineTimer)
    const closing = performance.now()
    await withTimeout(context.close(), 5000, 'close').catch((e) => { out.closeError = e.message })
    t.close = Math.round((performance.now() - closing) * 10) / 10
    t.total = Math.round((performance.now() - started) * 10) / 10
  }
  return out
}

/**
 * Text on pictures: hide every glyph, capture the area once, and read the pixels under each block
 * in the frame's isolated world (Blob → createImageBitmap, no URL is loaded). The verdict is the
 * contrast that 90 % of the block's background reaches.
 */
async function pixelContrast({ evaluate, capture, map, width, limits, thresholds }) {
  const items = map.photo.filter((p) => p.fg).slice(0, limits.pixelsMax)
  if (!items.length) return { checked: 0, issues: [] }
  const ys = items.flatMap((p) => p.rects.map((r) => [r[1], r[1] + r[3]]))
  const y0 = Math.max(0, Math.floor(Math.min(...ys.map((v) => v[0]))))
  const y1 = Math.ceil(Math.max(...ys.map((v) => v[1])))
  await evaluate(HIDE_TEXT, 2000, 'hide text')
  let png
  try {
    png = await capture({ format: 'png', clip: { x: 0, y: y0, width, height: Math.max(1, y1 - y0), scale: 1 } }, 'pixels')
  } finally {
    await evaluate(SHOW_TEXT, 2000, 'show text').catch(() => {})
  }
  const verdicts = await evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d', { willReadFrequently: true })
    g.drawImage(bitmap, 0, 0)
    const items = ${JSON.stringify(items.map((p) => ({ id: p.id, tag: p.tag, text: p.text, fg: p.fg, large: p.large, rects: p.rects })))}
    const lum = (r, g, b) => { const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b) }
    return items.map((p) => {
      const ks = []
      for (const [x, y, w, h] of p.rects) {
        const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y - ${y0}))
        const sw = Math.min(bitmap.width - sx, Math.ceil(w)), sh = Math.min(bitmap.height - sy, Math.ceil(h))
        if (sw <= 0 || sh <= 0) continue
        const d = g.getImageData(sx, sy, sw, sh).data
        const stride = Math.max(1, Math.floor(d.length / 4 / 1500))
        for (let i = 0; i < d.length / 4; i += stride) {
          const a = p.fg.a
          const r = p.fg.r * a + d[i * 4] * (1 - a), gg = p.fg.g * a + d[i * 4 + 1] * (1 - a), b = p.fg.b * a + d[i * 4 + 2] * (1 - a)
          const lf = lum(r, gg, b), lb = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
          ks.push((Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05))
        }
      }
      ks.sort((a, b) => a - b)
      const at = (q) => ks.length ? Math.round(ks[Math.min(ks.length - 1, Math.floor(q * ks.length))] * 10) / 10 : null
      return { id: p.id, tag: p.tag, text: p.text, large: p.large, p10: at(0.1), median: at(0.5), samples: ks.length }
    })
  })()`, 5000, 'pixels')
  const issues = verdicts.filter((v) => v.p10 !== null && v.p10 < (v.large ? thresholds.contrastLarge : thresholds.contrastNormal)).map((v) => ({ kind: 'contrast', id: v.id, tag: v.tag, text: v.text, ratio: v.p10, median: v.median, photo: true, need: v.large ? thresholds.contrastLarge : thresholds.contrastNormal }))
  return { checked: verdicts.length, bytes: png.length, verdicts, issues }
}
