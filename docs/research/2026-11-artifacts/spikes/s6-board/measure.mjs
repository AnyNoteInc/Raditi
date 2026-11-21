// The measurement of spike s6: a board of 10 screens × 2 live views on a laptop and on a phone.
//   node measure.mjs                — the full run (28 configurations × 2, ≈ 32 min), writes results.json, prints Markdown
//   node measure.mjs --smoke        — one iteration of four configurations, writes results-smoke.json
//   node measure.mjs --reps=3 --only=laptop|phone --filter=<substring of a run id>
//   node measure.mjs --ids="<run id>,<run id>" --out=results-rerun.json — only these rows (exact ids), after the warm-up
// Every run gets a fresh Chromium 153 (new headless). Laptop: 1440×900 at DPR 2. Phone: Playwright's
// Pixel 7 (412×839, DPR 2.625, touch) with 4× CPU throttling. Measured: time to the full board, memory
// footprint of every process after load and after the gestures (memory-infra dumps), JS heap, rAF frame
// times, long tasks and long animation frames of the cabinet during a scripted pan and zoom, main-thread
// busy time, and the round trip of each input event. results.json is rewritten after every run.
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startServers } from './server.mjs'
import { makeThumbs } from './thumbs.mjs'
import { launchChromium, LAPTOP, PHONE, boardUrl, openBoard, processes, memoryDump, summarizeMemory, identify, whichProcess, oopifSessions, mouseDrag, wheel, touchPan, touchPinch, sleep, frameStats, pct, loadavg, uptimeLine } from './lib.mjs'

const argv = process.argv.slice(2)
const flag = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const SMOKE = argv.includes('--smoke')
const REPS = Number(flag('reps', SMOKE ? 1 : 2))
const ONLY = flag('only', '')
const FILTER = flag('filter', '')
const IDS = flag('ids', '').split(',').map((x) => x.trim()).filter(Boolean)
const OUT = SMOKE ? 'results-smoke.json' : flag('out', 'results.json')
const BG = flag('bg', '1') // the dotted background of the board (1) or a plain one (0)

// --- the matrix ---------------------------------------------------------------------------------
// proc: default — Chromium desktop as it ships (sandboxed frames in their own renderer process);
// shared — frames in the cabinet's process: on the laptop by --disable-features=IsolateSandboxedIframes,
// on the phone by --disable-site-isolation-trials (like Chrome on Android without isolation, and iOS WebKit).
const LIVES = ['0', '2', '6', '12', '20']
// hz — live iframes hidden while the board zooms, a thumbnail under each (board A only)
const MATRIX = [
  ...['a', 'b'].flatMap((impl) => [...LIVES, 'auto4'].map((live) => ({ device: 'laptop', impl, live, proc: 'default' }))),
  { device: 'laptop', impl: 'a', live: '20', proc: 'default', hz: true },
  { device: 'laptop', impl: 'a', live: '20', proc: 'default', site: 'cross' },
  { device: 'laptop', impl: 'a', live: '6', proc: 'shared' },
  { device: 'laptop', impl: 'a', live: '20', proc: 'shared' },
  { device: 'laptop', impl: 'a', live: '2', proc: 'default', busy: true },
  { device: 'laptop', impl: 'a', live: '2', proc: 'default', busy: true, hz: true },
  { device: 'laptop', impl: 'a', live: '2', proc: 'shared', busy: true },
  ...LIVES.map((live) => ({ device: 'phone', impl: 'a', live, proc: 'shared' })),
  { device: 'phone', impl: 'b', live: '2', proc: 'shared' },
  { device: 'phone', impl: 'b', live: '20', proc: 'shared' },
  { device: 'phone', impl: 'list', live: '0', proc: 'shared' },
  { device: 'phone', impl: 'a', live: '6', proc: 'default' },
]
const SMOKE_SET = [
  { device: 'laptop', impl: 'a', live: '2', proc: 'default' },
  { device: 'laptop', impl: 'b', live: '2', proc: 'default' },
  { device: 'phone', impl: 'a', live: '2', proc: 'shared' },
  { device: 'phone', impl: 'list', live: '0', proc: 'shared' },
]
const WARMUP = { device: 'laptop', impl: 'a', live: '2', proc: 'default' }
const runId = (c) => [c.device, c.impl === 'a' ? 'css' : c.impl === 'b' ? 'xyflow' : 'list', `live${c.live}`, c.proc, c.site === 'cross' ? 'cross-site' : '', c.busy ? 'busy' : '', c.hz ? 'hz' : ''].filter(Boolean).join(' ')

// --- gestures -----------------------------------------------------------------------------------
async function view(page) { return page.evaluate(() => ({ v: window.__board.getViewport(), r: window.__board.rect(), f: window.__board.frames })) }
function screenOf({ v, r }, wx, wy) { return { x: r.x + v.x + wx * v.zoom, y: r.y + v.y + wy * v.zoom } }

// ctrl+wheel (a trackpad pinch) in steps of 4 events until the zoom reaches the target. The page sees
// wheel deltas divided by the device scale factor, so the number of events is read back, not computed.
async function zoomTo(page, at, target, lat) {
  for (let i = 0; i < 60; i++) {
    const z = (await view(page)).v.zoom
    if (target > z ? z >= target * 0.97 : z <= target * 1.03) return z
    await wheel(page, at, { dy: target > z ? -8 : 8, n: 4, ctrl: true, gap: 12, lat })
  }
}

async function laptopScript(page, lat, atDeep) {
  const s0 = await view(page)
  const z0 = s0.v.zoom
  const center = { x: s0.r.x + s0.r.w / 2, y: s0.r.y + s0.r.h / 2 }
  const s1 = screenOf(s0, 965, 600) // the middle of screen 1 (desktop and phone views)
  await zoomTo(page, s1, 0.25, lat)                                                    // zoom in to 25 %
  await mouseDrag(page, center, { x: center.x - 900, y: center.y }, { steps: 45, gap: 10, lat }) // pan across screens
  await mouseDrag(page, center, { x: center.x + 900, y: center.y }, { steps: 45, gap: 10, lat })
  await wheel(page, center, { dy: 60, n: 35, gap: 12, lat })                          // trackpad scroll down…
  await wheel(page, center, { dy: -60, n: 35, gap: 12, lat })                         // …and up
  await zoomTo(page, center, 0.75, lat)                                                // zoom in to 75 %
  await mouseDrag(page, center, { x: center.x - 600, y: center.y - 200 }, { steps: 30, gap: 10, lat })
  await mouseDrag(page, center, { x: center.x + 600, y: center.y + 200 }, { steps: 30, gap: 10, lat })
  await atDeep()                                                                       // memory dump at the deepest zoom
  await zoomTo(page, center, z0, lat)                                                  // back to the whole board
}

async function phoneScript(page, cdp, lat, atDeep) {
  const s0 = await view(page)
  const c = { x: s0.r.x + s0.r.w / 2, y: s0.r.y + s0.r.h / 2 }
  const s1 = screenOf(s0, 965, 600)
  const at = { x: Math.min(Math.max(s1.x, 80), s0.r.w - 80), y: Math.min(Math.max(s1.y, s0.r.y + 120), s0.r.y + s0.r.h - 120) }
  await touchPinch(cdp, at, { from: 60, to: 260, steps: 24, gap: 16, lat })           // ×4.3
  await touchPinch(cdp, c, { from: 100, to: 200, steps: 20, gap: 16, lat })           // ×2
  for (const [dx, dy] of [[-250, 0], [250, 0], [0, -300], [0, 300]]) await touchPan(cdp, { x: c.x - dx / 2, y: c.y - dy / 2 }, { x: c.x + dx / 2, y: c.y + dy / 2 }, { steps: 20, gap: 16, lat })
  await touchPinch(cdp, c, { from: 100, to: 250, steps: 20, gap: 16, lat })           // ×2.5
  for (const [dx, dy] of [[-250, -150], [250, 150]]) await touchPan(cdp, { x: c.x - dx / 2, y: c.y - dy / 2 }, { x: c.x + dx / 2, y: c.y + dy / 2 }, { steps: 20, gap: 16, lat })
  await atDeep()
  for (let i = 0; i < 3; i++) await touchPinch(cdp, c, { from: 260, to: 60, steps: 20, gap: 16, lat }) // back out
}

async function listScript(page, cdp, lat, atDeep) {
  const r = await page.evaluate(() => window.__board.rect())
  const x = r.x + r.w / 2
  for (let i = 0; i < 6; i++) { await touchPan(cdp, { x, y: r.y + r.h - 80 }, { x, y: r.y + 120 }, { steps: 10, gap: 12, lat }); await sleep(450) }
  await atDeep()
  for (let i = 0; i < 6; i++) { await touchPan(cdp, { x, y: r.y + 120 }, { x, y: r.y + r.h - 80 }, { steps: 10, gap: 12, lat }); await sleep(450) }
}

// --- one run ------------------------------------------------------------------------------------
function metricsDelta(a, b) {
  const m = (x) => Object.fromEntries(x.metrics.map((e) => [e.name, e.value]))
  const ma = m(a), mb = m(b)
  const d = (k) => Math.round(((mb[k] ?? 0) - (ma[k] ?? 0)) * 1000)
  return { taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'), jsHeapMB: Math.round(((mb.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10, nodes: mb.Nodes, documents: mb.Documents, frames: mb.Frames }
}

async function runOne(cfg, rep, srv) {
  const phone = cfg.device === 'phone'
  const opts = cfg.proc === 'shared' ? (phone ? { args: ['--disable-site-isolation-trials'] } : { disable: ['IsolateSandboxedIframes'] }) : {}
  const browser = await launchChromium(opts)
  const context = await browser.newContext(phone ? PHONE : LAPTOP)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const throttled = new Set()
  const throttleFrames = async () => {
    if (!phone) return
    for (const o of await oopifSessions(page)) {
      if (throttled.has(o.frame)) { o.session.detach().catch(() => {}); continue }
      throttled.add(o.frame)
      await o.session.send('Emulation.setCPUThrottlingRate', { rate: 4 }).catch(() => {})
    }
  }
  if (phone) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    page.on('framenavigated', (f) => { if (f !== page.mainFrame()) throttleFrames().catch(() => {}) })
  }
  const bs = await browser.newBrowserCDPSession()
  const frames = cfg.site === 'cross' ? srv.origins.crossSite : srv.origins.sameSite
  const url = boardUrl(srv.origins.cabinet, { impl: cfg.impl, live: cfg.live, pe: 'shield', frames, busy: cfg.busy ? 1 : undefined, hz: cfg.hz ? 1 : undefined, bg: BG })
  const la0 = loadavg()
  const ready = await openBoard(page, url, { timeout: 300_000 })
  await sleep(2000)
  const afterLoadDump = await memoryDump(bs)
  const procsLoad = await processes(bs)
  const pm0 = await cdp.send('Performance.getMetrics')
  await page.evaluate(() => window.__perf.start())
  const lat = []
  let deep = null
  const atDeep = async () => {
    await page.evaluate(() => window.__perf.pause())
    await sleep(300)
    deep = { dump: await memoryDump(bs), procs: await processes(bs), zoom: (await page.evaluate(() => window.__board.getViewport())).zoom, live: await page.evaluate(() => window.__board.liveIds().length) }
    await page.evaluate(() => window.__perf.start())
  }
  const t0 = Date.now()
  if (cfg.impl === 'list') await listScript(page, cdp, lat, atDeep)
  else if (phone) await phoneScript(page, cdp, lat, atDeep)
  else await laptopScript(page, lat, atDeep)
  const scriptMs = Date.now() - t0
  const rec = await page.evaluate(() => window.__perf.stop())
  const pm1 = await cdp.send('Performance.getMetrics')
  await sleep(1000)
  await page.evaluate(() => window.__board.idle())
  const afterScriptDump = await memoryDump(bs)
  const procsEnd = await processes(bs)
  const id = cfg.impl === 'list'
    ? { cabinet: await whichProcess(bs, () => page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 250) {} })), frames: [], oopif: 0 }
    : await identify(page, bs)
  const swaps = await page.evaluate(() => window.__board.swaps())
  const live = await page.evaluate(() => window.__board.liveIds().length)
  const out = {
    id: runId(cfg), ...cfg, rep,
    readyMs: Math.round(ready.t), readyWallMs: ready.wall, loads: ready.loads.length,
    memLoad: summarizeMemory(afterLoadDump, procsLoad, id),
    memDeep: deep ? { ...summarizeMemory(deep.dump, deep.procs, id), zoom: Math.round(deep.zoom * 1000) / 1000, live: deep.live } : null,
    memEnd: summarizeMemory(afterScriptDump, procsEnd, id),
    liveLoadMs: (() => { const l = ready.loads.filter((x) => x.kind === 'live').map((x) => x.t - x.t0); return l.length ? { n: l.length, p50: pct(l, 0.5), max: pct(l, 1) } : null })(),
    thumbLoadMs: (() => { const l = ready.loads.filter((x) => x.kind === 'thumb').map((x) => x.t - x.t0); return l.length ? { n: l.length, p50: pct(l, 0.5), max: pct(l, 1) } : null })(),
    frames: frameStats(rec),
    loafTop: rec.loaf.sort((x, y) => y.d - x.d).slice(0, 3),
    inputMs: { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1) },
    main: metricsDelta(pm0, pm1),
    scriptMs, swaps, liveAtEnd: live, oopif: id.oopif, frameProcesses: id.frames.filter((x) => x !== id.cabinet).length,
    loadavgBefore: la0, loadavgAfter: loadavg(),
  }
  await browser.close()
  return out
}

// --- aggregation and the table --------------------------------------------------------------------
const med = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10 }
function summarize(runs) {
  const byId = new Map()
  for (const r of runs) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r) }
  const rows = []
  for (const [id, rs] of byId) {
    const g = (f) => med(rs.map(f))
    rows.push({
      id, device: rs[0].device, impl: rs[0].impl, live: rs[0].live, proc: rs[0].proc, reps: rs.length,
      readyMs: g((r) => r.readyMs),
      loadMB: g((r) => r.memLoad.total), deepMB: g((r) => r.memDeep?.total), endMB: g((r) => r.memEnd.total),
      cabinetMB: g((r) => r.memLoad.cabinet), framesMB: g((r) => r.memLoad.frames), gpuMB: g((r) => r.memLoad.gpu), gpuDeepMB: g((r) => r.memDeep?.gpu),
      jsMB: g((r) => r.memLoad.js), domMB: g((r) => r.memLoad.dom), tilesMB: g((r) => r.memLoad.tiles), imagesMB: g((r) => r.memLoad.images),
      liveLoadP50: g((r) => r.liveLoadMs?.p50), liveLoadMax: g((r) => r.liveLoadMs?.max),
      fps: g((r) => r.frames.fps), p95: g((r) => r.frames.p95), p99: g((r) => r.frames.p99), max: g((r) => r.frames.max),
      jankMs: g((r) => r.frames.jankMs), over50: g((r) => r.frames.over50), longTasks: g((r) => r.frames.longTasks), longTaskMs: g((r) => r.frames.longTaskMs),
      inputP95: g((r) => r.inputMs.p95), mainTaskMs: g((r) => r.main.taskMs), swaps: g((r) => r.swaps),
      loadavg: rs.map((r) => r.loadavgBefore[0]),
    })
  }
  for (const row of rows) {
    const base = rows.find((x) => x.device === row.device && x.impl === row.impl && x.live === '0' && x.proc === row.proc && !x.id.includes('busy') && !x.id.includes('cross'))
    row.plusMB = base && row !== base ? Math.round((row.loadMB - base.loadMB) * 10) / 10 : null
  }
  return rows
}
function table(rows) {
  const a = ['| Прогон | Готов, мс | Загрузка кадра p50 / макс, мс | Память после загрузки, МБ | +к live0 | При приближении | В конце | Кабинет | Кадры | GPU | GPU при приближении | JS | DOM | Тайлы | Картинки |', '|' + ' --- |'.repeat(15)]
  for (const r of rows) a.push(`| ${r.id} | ${r.readyMs} | ${r.liveLoadP50 ?? '—'} / ${r.liveLoadMax ?? '—'} | ${r.loadMB} | ${r.plusMB ?? '—'} | ${r.deepMB ?? '—'} | ${r.endMB} | ${r.cabinetMB} | ${r.framesMB} | ${r.gpuMB} | ${r.gpuDeepMB ?? '—'} | ${r.jsMB} | ${r.domMB} | ${r.tilesMB} | ${r.imagesMB} |`)
  const b = ['| Прогон | fps | p95, мс | p99, мс | макс, мс | Рывки, мс | Кадров >50 мс | Длинные задачи (мс) | Ввод p95, мс | Главный поток, мс | Подмен кадров | Нагрузка (1 мин) |', '|' + ' --- |'.repeat(12)]
  for (const r of rows) b.push(`| ${r.id} | ${r.fps} | ${r.p95} | ${r.p99} | ${r.max} | ${r.jankMs} | ${r.over50} | ${r.longTasks} (${r.longTaskMs}) | ${r.inputP95} | ${r.mainTaskMs} | ${r.swaps} | ${r.loadavg.join(', ')} |`)
  return `Память и загрузка (медиана по повторам)\n\n${a.join('\n')}\n\nПлавность во время панорамы и масштаба (медиана по повторам)\n\n${b.join('\n')}`
}

// --- main -----------------------------------------------------------------------------------------
if (!fs.existsSync('dist/index.html')) execFileSync('pnpm', ['build'], { stdio: 'inherit' })
await makeThumbs()
const srv = await startServers()
const probe = await launchChromium(); const chromium = probe.version(); await probe.close()
const set = (SMOKE ? SMOKE_SET : MATRIX).filter((c) => (!ONLY || c.device === ONLY) && (!FILTER || runId(c).includes(FILTER)) && (!IDS.length || IDS.includes(runId(c))))
if (IDS.length && set.length !== IDS.length) throw new Error(`unknown run ids: ${IDS.filter((x) => !set.some((c) => runId(c) === x)).join('; ')}`)
const result = {
  spike: 's6', smoke: SMOKE, startedAt: new Date().toISOString(),
  env: { chromium, playwrightCore: JSON.parse(fs.readFileSync('node_modules/playwright-core/package.json', 'utf8')).version, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), uptimeStart: uptimeLine() },
  matrix: set.map(runId), reps: REPS, runs: [], errors: [],
}
console.log(`spike s6: ${set.length} configurations × ${REPS} → ${OUT}\n${result.env.uptimeStart}`)
const save = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
// a warm-up run, not recorded: the first browser start and cold file caches
if (!SMOKE && !FILTER && !ONLY) { try { await runOne(WARMUP, 0, srv); console.log('warm-up done') } catch (e) { console.log('warm-up failed', String(e?.message ?? e).slice(0, 200)) } }
for (let rep = 1; rep <= REPS; rep++) {
  for (const cfg of set) {
    const t = Date.now()
    try {
      const r = await runOne(cfg, rep, srv)
      result.runs.push(r)
      console.log(`[${rep}/${REPS}] ${r.id}: ready ${r.readyMs} ms, total ${r.memEnd.total} MB (cabinet ${r.memEnd.cabinet}, frames ${r.memEnd.frames}, gpu ${r.memEnd.gpu}), fps ${r.frames.fps}, p95 ${r.frames.p95} ms, >50 ms ${r.frames.over50}, long tasks ${r.frames.longTasks}, input p95 ${r.inputMs.p95} ms, load ${r.loadavgBefore[0]} — ${Math.round((Date.now() - t) / 1000)} s`)
    } catch (e) {
      result.errors.push({ id: runId(cfg), rep, error: String(e?.stack ?? e).slice(0, 2000) })
      console.log(`[${rep}/${REPS}] ${runId(cfg)}: ERROR ${String(e?.message ?? e).slice(0, 300)}`)
    }
    save()
  }
}
result.finishedAt = new Date().toISOString()
result.env.uptimeEnd = uptimeLine()
result.summary = summarize(result.runs)
save()
await srv.close()
console.log(`\n${result.env.uptimeEnd}\n`)
console.log(table(result.summary))
