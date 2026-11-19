// Shared helpers of check.mjs and measure.mjs: browser launch with the test hosts mapped to
// 127.0.0.1, the board URL, process list and memory dumps over CDP, and input gestures.
import { chromium, webkit, firefox, devices } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { HOST_RULES } from './server.mjs'

// Playwright passes its own --disable-features and --enable-features; Chromium keeps the last
// occurrence of a switch, so ours repeat Playwright's list and add to it.
const PW_DISABLED = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']
const PW_ENABLED = ['CDPScreenshotNewSurface']

export async function launchChromium({ disable = [], enable = [], args = [], shell = false } = {}) {
  const a = [HOST_RULES, ...args]
  if (disable.length) a.push(`--disable-features=${[...PW_DISABLED, ...disable].join(',')}`)
  if (enable.length) a.push(`--enable-features=${[...PW_ENABLED, ...enable].join(',')}`)
  // channel 'chromium' — the full Chromium in the new headless mode (the same browser code as a
  // window); shell: true — chromium-headless-shell
  return chromium.launch(shell ? { args: a } : { channel: 'chromium', args: a })
}
export { webkit, firefox, devices }

export const LAPTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
export const PHONE = { ...devices['Pixel 7'] }

export function boardUrl(cabinet, q) {
  const u = new URL('/', cabinet)
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  return u.toString()
}

export async function openBoard(page, url, { timeout = 120_000 } = {}) {
  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__board?.ready, null, { timeout })
  const r = await page.evaluate(() => window.__board.ready)
  return { ...r, wall: Date.now() - t0 }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function loadavg() { return os.loadavg().map((x) => Math.round(x * 100) / 100) }
export function uptimeLine() { try { return execFileSync('uptime', { encoding: 'utf8' }).trim() } catch { return '' } }

// --- processes and memory -------------------------------------------------------------------

export async function processes(bs) {
  const r = await bs.send('SystemInfo.getProcessInfo')
  return r.processInfo.map((p) => ({ type: p.type, pid: p.id, cpu: p.cpuTime }))
}

// A memory-infra dump of every process of the browser: private footprint (what Chrome's task
// manager and macOS Activity Monitor call memory) and the allocators: V8 (JS heap), Blink GC (DOM),
// cc tiles (rasterised content), decoded images and discardable memory (decoded images too).
// Totals and allocators come as separate events of one process; they are merged by pid.
export async function memoryDump(bs, { detail = 'light' } = {}) {
  const events = []
  const onData = (e) => { for (const v of e.value) events.push(v) }
  bs.on('Tracing.dataCollected', onData)
  const complete = new Promise((r) => bs.once('Tracing.tracingComplete', r))
  await bs.send('Tracing.start', {
    traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['disabled-by-default-memory-infra', '__metadata'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } },
    transferMode: 'ReportEvents',
  })
  let ok = false
  for (let i = 0; i < 4 && !ok; i++) {
    const r = await bs.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: detail })
    ok = r.success
    if (!ok) await sleep(300)
  }
  await bs.send('Tracing.end')
  await complete
  bs.off('Tracing.dataCollected', onData)
  const names = new Map()
  for (const e of events) if (e.ph === 'M' && e.name === 'process_name') names.set(e.pid, e.args?.name)
  const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v ?? 0))
  const procs = new Map()
  const get = (pid) => { if (!procs.has(pid)) procs.set(pid, { pid, name: names.get(pid) ?? '?', footprint: 0 }); return procs.get(pid) }
  for (const e of events) {
    if (e.ph !== 'v') continue
    const d = e.args?.dumps
    if (!d) continue
    const p = get(e.pid)
    if (d.process_totals) p.footprint = hex(d.process_totals.private_footprint_bytes)
    const a = d.allocators
    if (!a) continue
    const eff = (k) => (a[k] ? hex(a[k].attrs?.effective_size?.value ?? a[k].attrs?.size?.value) : 0)
    Object.assign(p, {
      v8: eff('v8'), blinkGc: eff('blink_gc'), partitionAlloc: eff('partition_alloc'), malloc: eff('malloc'),
      tiles: eff('cc/tile_memory'), images: eff('cc/image_memory'), discardable: eff('discardable'), gpu: eff('gpu'),
    })
  }
  return { ok, procs: [...procs.values()] }
}

const MB = (b) => Math.round(((b ?? 0) / 1048576) * 10) / 10

// Footprint by role: the cabinet's renderer, the renderers of its frames, the GPU process, the
// browser process and the rest (the omnibox WebUI renderer of new headless, spare renderers,
// network and storage services). The tracing service exists only because of the dump.
export function summarizeMemory(dump, procList, id = {}) {
  const type = new Map(procList.map((p) => [p.pid, p.type]))
  const out = { total: 0, cabinet: 0, frames: 0, gpu: 0, browser: 0, other: 0, js: 0, dom: 0, tiles: 0, images: 0, gpuProcAlloc: 0, renderers: 0 }
  const frames = new Set((id.frames ?? []).filter((x) => x !== id.cabinet))
  for (const p of dump.procs) {
    if (/tracing/i.test(p.name)) continue
    const t = type.get(p.pid) ?? (/gpu/i.test(p.name) ? 'GPU' : /browser/i.test(p.name) ? 'browser' : /renderer/i.test(p.name) ? 'renderer' : 'other')
    out.total += p.footprint
    if (t === 'renderer') out.renderers++
    const page = p.pid === id.cabinet || frames.has(p.pid)
    if (p.pid === id.cabinet) out.cabinet += p.footprint
    else if (frames.has(p.pid)) out.frames += p.footprint
    else if (t === 'GPU') { out.gpu += p.footprint; out.gpuProcAlloc += p.gpu ?? 0 }
    else if (t === 'browser') out.browser += p.footprint
    else out.other += p.footprint
    // decoded images live in discardable memory, cc/image_memory is the compositor's view of the same bytes
    if (page) { out.js += p.v8 ?? 0; out.dom += p.blinkGc ?? 0; out.tiles += p.tiles ?? 0; out.images += Math.max(p.images ?? 0, p.discardable ?? 0) }
  }
  const r = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, k === 'renderers' ? v : MB(v)]))
  r.procs = dump.procs.filter((p) => !/tracing/i.test(p.name)).map((p) => ({ pid: p.pid, role: p.pid === id.cabinet ? 'cabinet' : frames.has(p.pid) ? 'frames' : type.get(p.pid) ?? p.name, name: p.name, footprintMB: MB(p.footprint), v8MB: MB(p.v8), domMB: MB(p.blinkGc), tilesMB: MB(p.tiles), imagesMB: MB(p.images), discardableMB: MB(p.discardable) }))
  return r
}

// Which renderer process runs a target: a 250 ms busy loop in it, compared with an idle window of
// the same length (other processes keep their own background work, e.g. 20 animated frames).
export async function whichProcess(bs, run) {
  const cpu = async () => Object.fromEntries((await processes(bs)).map((p) => [p.pid, p.cpu]))
  const a = await cpu(); await sleep(250); const b = await cpu()
  await run(); const c = await cpu()
  let best = null
  for (const pid of Object.keys(c)) {
    const base = (b[pid] ?? 0) - (a[pid] ?? 0)
    const busy = c[pid] - (b[pid] ?? 0)
    const gain = busy - base
    if (!best || gain > best.gain) best = { pid: Number(pid), gain }
  }
  return best.pid
}
export const BUSY_EXPR = 'const t=performance.now();while(performance.now()-t<250){}'

// The cabinet's renderer and the renderers of its frames (first and last out-of-process frame: all
// sandboxed frames of one site share one process in Chromium, the probe checks it).
export async function identify(page, bs) {
  const cabinet = await whichProcess(bs, () => page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 250) {} }).catch(() => {}))
  const oop = await oopifSessions(page)
  const frames = new Set()
  for (const o of [oop[0], oop.at(-1)].filter(Boolean)) frames.add(await whichProcess(bs, () => o.session.send('Runtime.evaluate', { expression: BUSY_EXPR })))
  for (const o of oop) o.session.detach().catch(() => {})
  return { cabinet, frames: [...frames], oopif: oop.length }
}

// Every out-of-process iframe of the page as its own CDP session (in-process frames throw).
export async function oopifSessions(page) {
  const out = []
  for (const fr of page.frames()) {
    if (fr === page.mainFrame()) continue
    try { out.push({ frame: fr, session: await page.context().newCDPSession(fr) }) } catch {}
  }
  return out
}

// --- input ------------------------------------------------------------------------------------

// Mouse moves go through CDP one by one; each awaits the renderer's ack, so the time per move is
// also a rough input latency. `gap` keeps the rate near a real mouse (~100 Hz).
export async function mouseDrag(page, from, to, { steps = 40, gap = 8, lat } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    const t = performance.now()
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    lat?.push(performance.now() - t)
    if (gap) await sleep(gap)
  }
  await page.mouse.up()
}

export async function wheel(page, at, { dx = 0, dy = 0, n = 20, ctrl = false, gap = 12, lat } = {}) {
  await page.mouse.move(at.x, at.y)
  if (ctrl) await page.keyboard.down('Control')
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await page.mouse.wheel(dx, dy)
    lat?.push(performance.now() - t)
    if (gap) await sleep(gap)
  }
  if (ctrl) await page.keyboard.up('Control')
}

// Touch through CDP Input.dispatchTouchEvent: one finger pans, two fingers pinch.
export async function touchPan(cdp, from, to, { steps = 30, gap = 12, lat } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
  for (let i = 1; i <= steps; i++) {
    const t = performance.now()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }] })
    lat?.push(performance.now() - t)
    if (gap) await sleep(gap)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

export async function touchPinch(cdp, center, { from = 60, to = 180, steps = 30, gap = 12, lat } = {}) {
  const pts = (d) => [{ x: center.x - d / 2, y: center.y, id: 1 }, { x: center.x + d / 2, y: center.y, id: 2 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) })
  for (let i = 1; i <= steps; i++) {
    const t = performance.now()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / steps) })
    lat?.push(performance.now() - t)
    if (gap) await sleep(gap)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

// --- frame statistics ---------------------------------------------------------------------------

export function frameStats(rec) {
  if (!rec) return null
  const iv = []
  for (let i = 1; i < rec.raf.length; i++) if (rec.raf[i] != null && rec.raf[i - 1] != null) iv.push(rec.raf[i] - rec.raf[i - 1])
  const s = [...iv].sort((a, b) => a - b)
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0)
  const paused = (rec.gaps ?? []).reduce((a, [x, y]) => a + (y - x), 0)
  const dur = rec.t1 - rec.t0 - paused
  const r1 = (x) => Math.round(x * 10) / 10
  return {
    durationMs: Math.round(dur),
    frames: iv.length,
    fps: r1((iv.length / dur) * 1000),
    p50: r1(q(0.5)), p95: r1(q(0.95)), p99: r1(q(0.99)), max: r1(s.at(-1) ?? 0),
    over25: iv.filter((x) => x > 25).length,
    over50: iv.filter((x) => x > 50).length,
    // time not covered by 60 Hz frames: sum over intervals of (interval − 16.7)
    jankMs: Math.round(iv.reduce((a, x) => a + Math.max(0, x - 16.7), 0)),
    longTasks: rec.long.length,
    longTaskMs: Math.round(rec.long.reduce((a, x) => a + x.d, 0)),
    loaf: rec.loaf.length,
    loafBlockingMs: Math.round(rec.loaf.reduce((a, x) => a + (x.b ?? 0), 0)),
  }
}

export function pct(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10
}
