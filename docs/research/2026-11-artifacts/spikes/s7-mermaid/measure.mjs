// Spike 7 of plan 88, measurement: time per diagram per engine (cold and warm) and memory.
// Run it from the work dir while the machine is quiet:
//   node measure.mjs                 # full: 5 cold runs, 20 warm runs per diagram
//   node measure.mjs --smoke         # one cold and one warm run, only to prove the script works
//   node measure.mjs --cold=3 --warm=10 --out=results.json
// Writes results.json (or --out) and prints a Markdown table.
//
// cold, beautiful-mermaid: a fresh Node process imports the package and renders one diagram.
// cold, Mermaid: Chromium is already running (as in apps/browser); a new context and page get the
//   network blocked, Mermaid 12 (5.5 MB) is loaded and the diagram is rendered once.
// warm: the same process or page has rendered every diagram once; then each diagram N more times.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE, pageHeap } from './lib/mermaid-renderer.mjs'
import { sanitizeFinal } from './lib/sanitize.mjs'

const pexec = promisify(execFile)
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
const smoke = !!args.smoke
const COLD = Number(args.cold ?? (smoke ? 1 : 5))
const WARM = Number(args.warm ?? (smoke ? 1 : 20))
const OUTFILE = args.out || 'results.json'
const here = new URL('./', import.meta.url).pathname
const uptime = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).trim() } catch { return os.loadavg().join(' ') } }
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] }
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10)
const mib = (b) => (b == null ? null : Math.round(b / 2 ** 20 * 10) / 10)
const log = (...a) => console.error('[measure]', ...a)

/** RSS of every descendant process of this Node process (Chromium and its helpers), bytes. */
async function childTreeRss() {
  const { stdout } = await pexec('ps', ['-A', '-o', 'pid=,ppid=,rss='])
  const rows = stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const kids = new Map()
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid) }
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb * 1024]))
  let sum = 0, count = 0
  const walk = (pid) => { for (const k of kids.get(pid) || []) { sum += rss.get(k) || 0; count++; walk(k) } }
  walk(process.pid)
  return { bytes: sum, processes: count }
}

const started = { at: new Date().toISOString(), uptime: uptime(), loadavg: os.loadavg() }
log('start', started.uptime, smoke ? '(smoke)' : '', `cold=${COLD} warm=${WARM}`)
const versions = Object.fromEntries(['beautiful-mermaid', 'mermaid', 'dompurify', 'jsdom', 'playwright-core'].map((p) => [p, JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url), 'utf8')).version]))
const per = Object.fromEntries(corpus.map((d) => [d.id, { id: d.id, type: d.type, valid: d.valid }]))

// ---------- beautiful-mermaid, cold: one fresh process per run ----------
// Baseline: RSS of a bare Node process, to tell the package's own memory from Node's.
const baseRss = median(Array.from({ length: Math.max(1, Math.min(COLD, 3)) }, () => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.memoryUsage().rss))'], { encoding: 'utf8' }))))
const bmCold = []
for (const d of corpus) {
  const runs = []
  for (let i = 0; i < COLD; i++) {
    const t0 = performance.now()
    const outText = execFileSync(process.execPath, [`${here}lib/bm-cold.mjs`, d.id], { encoding: 'utf8', cwd: here })
    const wall = performance.now() - t0
    runs.push({ ...JSON.parse(outText), wallMs: wall })
  }
  const ok = runs[0].ok
  per[d.id].bmOk = ok
  per[d.id].bmCold = { importMs: r1(median(runs.map((r) => r.importMs))), renderMs: r1(median(runs.map((r) => r.renderMs))), processMs: r1(median(runs.map((r) => r.wallMs))), rssMiB: mib(median(runs.map((r) => r.rssAfter))) }
  bmCold.push(...runs)
}
log('bm cold done', uptime())

// ---------- beautiful-mermaid, warm: this process ----------
const memBm0 = process.memoryUsage()
for (const d of corpus) { try { renderMermaidSVG(d.source) } catch {} }
const memBm1 = process.memoryUsage()
const bmSvgs = {}
for (const d of corpus) {
  const times = []
  for (let i = 0; i < WARM; i++) {
    const t0 = performance.now()
    try { bmSvgs[d.id] = renderMermaidSVG(d.source) } catch { bmSvgs[d.id] = null }
    times.push(performance.now() - t0)
  }
  per[d.id].bmWarm = { median: r1(median(times)), p95: r1(p95(times)) }
}
const memBm2 = process.memoryUsage()
log('bm warm done', uptime())

// ---------- Mermaid in Chromium ----------
const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const launches = []
for (let i = 0; i < Math.max(1, Math.min(COLD, 3)); i++) {
  const t0 = performance.now()
  const b = await chromium.launch()
  const launchMs = performance.now() - t0
  const rss = await childTreeRss()
  launches.push({ launchMs, rss: rss.bytes, processes: rss.processes })
  await b.close()
}
const browser = await chromium.launch()
const browserVersion = browser.version()
const rssIdle = await childTreeRss()

// cold: a new context and page per run, Mermaid loaded, one render
const mmColdPrep = []
for (const d of corpus) {
  const runs = []
  for (let i = 0; i < COLD; i++) {
    const t0 = performance.now()
    const page = new MermaidPage(browser, { mermaidJs })
    await page.open()
    const prepMs = performance.now() - t0
    const r = await page.render(d.source, { htmlLabels: false, seed: `${d.id}c${i}`, secure: LOCKED_SECURE }, 20000)
    runs.push({ prepMs, renderMs: r.ms, wallMs: r.wallMs, ok: !!r.svg, timedOut: !!r.timedOut })
    await page.close()
  }
  per[d.id].mmOk = runs[0].ok
  per[d.id].mmCold = { prepMs: r1(median(runs.map((r) => r.prepMs))), renderMs: r1(median(runs.map((r) => r.renderMs))), totalMs: r1(median(runs.map((r) => r.prepMs + r.wallMs))) }
  mmColdPrep.push(...runs.map((r) => r.prepMs))
}
log('mm cold done', uptime())

// warm: one page renders everything once, then N timed runs per diagram; RSS sampled meanwhile
const page = new MermaidPage(browser, { mermaidJs })
await page.open()
const heapAfterLoad = await pageHeap(page.page)
const rssAfterLoad = await childTreeRss()
let rssPeak = rssAfterLoad.bytes
const sampler = setInterval(async () => { try { const r = await childTreeRss(); if (r.bytes > rssPeak) rssPeak = r.bytes } catch {} }, 250)
const mmSvgs = {}
for (const d of corpus) { const r = await page.render(d.source, { htmlLabels: false, seed: `${d.id}w`, secure: LOCKED_SECURE }, 20000); mmSvgs[d.id] = r.svg || null }
for (const d of corpus) {
  const inPage = [], wall = []
  for (let i = 0; i < WARM; i++) {
    const r = await page.render(d.source, { htmlLabels: false, seed: `${d.id}w${i}`, secure: LOCKED_SECURE }, 20000)
    inPage.push(r.ms); wall.push(r.wallMs)
  }
  per[d.id].mmWarm = { median: r1(median(inPage)), p95: r1(p95(inPage)), wallMedian: r1(median(wall)) }
}
clearInterval(sampler)
const heapAfterWarm = await pageHeap(page.page)
const rssAfterWarm = await childTreeRss()
await page.close()
await browser.close()
log('mm warm done', uptime())

// ---------- DOMPurify + hardening (jsdom), warm ----------
for (const [engine, svgs] of [['bm', bmSvgs], ['mm', mmSvgs]]) {
  for (const d of corpus) {
    const svg = svgs[d.id]
    if (!svg) continue
    sanitizeFinal(svg)
    const times = []
    let out = ''
    for (let i = 0; i < WARM; i++) { const t0 = performance.now(); out = sanitizeFinal(svg).svg; times.push(performance.now() - t0) }
    per[d.id][`${engine}Sanitize`] = { median: r1(median(times)), rawBytes: Buffer.byteLength(svg), finalBytes: Buffer.byteLength(out) }
  }
}
const memEnd = process.memoryUsage()

const finished = { at: new Date().toISOString(), uptime: uptime(), loadavg: os.loadavg() }
const rows = Object.values(per)
// Summaries count successful renders only (a failed parse returns in about a millisecond).
const okRows = (engine) => rows.filter((r) => r[`${engine}Ok`])
const col = (k, f) => okRows(k.startsWith('bm') ? 'bm' : 'mm').map((r) => r[k] && r[k][f]).filter((x) => x != null)
const summary = {
  bm: { ok: rows.filter((r) => r.bmOk).length, nodeBaselineRssMiB: mib(baseRss), coldImportMs: r1(median(bmCold.map((r) => r.importMs))), coldRenderMs: r1(median(col('bmCold', 'renderMs'))), coldProcessMs: r1(median(col('bmCold', 'processMs'))), warmMedianOfMedians: r1(median(col('bmWarm', 'median'))), warmMaxP95: r1(Math.max(...col('bmWarm', 'p95'))), rssAfterImportMiB: mib(median(bmCold.map((r) => r.rssAfter))), heapWarmMiB: mib(memBm2.heapUsed), rssWarmMiB: mib(memBm2.rss), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10 },
  mm: { ok: rows.filter((r) => r.mmOk).length, browserLaunchMs: r1(median(launches.map((l) => l.launchMs))), browserIdleRssMiB: mib(rssIdle.bytes), coldPrepMs: r1(median(mmColdPrep)), coldRenderMs: r1(median(col('mmCold', 'renderMs'))), coldTotalMs: r1(median(col('mmCold', 'totalMs'))), warmMedianOfMedians: r1(median(col('mmWarm', 'median'))), warmMaxP95: r1(Math.max(...col('mmWarm', 'p95'))), pageHeapAfterLoadMiB: mib(heapAfterLoad.jsHeapUsed), pageHeapAfterWarmMiB: mib(heapAfterWarm.jsHeapUsed), chromiumRssAfterLoadMiB: mib(rssAfterLoad.bytes), chromiumRssAfterWarmMiB: mib(rssAfterWarm.bytes), chromiumRssPeakMiB: mib(rssPeak), chromiumProcesses: rssAfterWarm.processes },
  sanitize: { bmMedian: r1(median(col('bmSanitize', 'median'))), mmMedian: r1(median(col('mmSanitize', 'median'))), nodeRssEndMiB: mib(memEnd.rss) },
}
const result = {
  smoke, params: { cold: COLD, warm: WARM }, started, finished,
  machine: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  versions, browser: browserVersion, launches, summary, perDiagram: rows,
  memory: { bmProcess: { beforeWarmup: memBm0, afterWarmup: memBm1, afterWarm: memBm2 }, mmPage: { heapAfterLoad, heapAfterWarm } },
}
writeFileSync(new URL(OUTFILE, `file://${here}`), JSON.stringify(result, null, 1))

const md = []
md.push(`${smoke ? '**Smoke run (preliminary).** ' : ''}cold=${COLD}, warm=${WARM}. Start: ${started.uptime}. End: ${finished.uptime}.`)
md.push('', '| id | type | bm cold, ms (import + render) | bm warm, ms (median / p95) | mm cold, ms (page + render) | mm warm, ms (median / p95) | DOMPurify bm / mm, ms |', '|---|---|---|---|---|---|---|')
for (const r of rows) {
  const bmc = r.bmOk ? `${r.bmCold.importMs} + ${r.bmCold.renderMs}` : `fail (${r.bmCold.renderMs})`
  const bmw = r.bmOk ? `${r.bmWarm.median} / ${r.bmWarm.p95}` : '—'
  const mmc = r.mmOk ? `${r.mmCold.prepMs} + ${r.mmCold.renderMs}` : `fail (${r.mmCold.renderMs})`
  const mmw = r.mmOk ? `${r.mmWarm.median} / ${r.mmWarm.p95}` : '—'
  md.push(`| ${r.id} | ${r.type} | ${bmc} | ${bmw} | ${mmc} | ${mmw} | ${r.bmSanitize?.median ?? '—'} / ${r.mmSanitize?.median ?? '—'} |`)
}
const s = summary
md.push('', '| Engine | Rendered | Cold | Warm (median of medians / worst p95) | Memory |', '|---|---|---|---|---|')
md.push(`| beautiful-mermaid ${versions['beautiful-mermaid']} (Node ${process.version}) | ${s.bm.ok}/30 | import ${s.bm.coldImportMs} ms + first render ${s.bm.coldRenderMs} ms (process ${s.bm.coldProcessMs} ms) | ${s.bm.warmMedianOfMedians} / ${s.bm.warmMaxP95} ms | bare Node ${s.bm.nodeBaselineRssMiB} MiB RSS, after import and one render ${s.bm.rssAfterImportMiB} MiB |`)
md.push(`| Mermaid ${versions.mermaid} (Chromium ${browserVersion}) | ${s.mm.ok}/30 | launch ${s.mm.browserLaunchMs} ms; page + Mermaid ${s.mm.coldPrepMs} ms + first render ${s.mm.coldRenderMs} ms | ${s.mm.warmMedianOfMedians} / ${s.mm.warmMaxP95} ms | Chromium idle ${s.mm.browserIdleRssMiB} MiB, with page ${s.mm.chromiumRssAfterLoadMiB} MiB, peak ${s.mm.chromiumRssPeakMiB} MiB (${s.mm.chromiumProcesses} processes); page heap ${s.mm.pageHeapAfterLoadMiB} → ${s.mm.pageHeapAfterWarmMiB} MiB |`)
md.push(`| DOMPurify ${versions.dompurify} + jsdom ${versions.jsdom} | — | — | bm ${s.sanitize.bmMedian} ms, mm ${s.sanitize.mmMedian} ms | Node RSS at the end ${s.sanitize.nodeRssEndMiB} MiB |`)
console.log(md.join('\n'))
log('wrote', OUTFILE)
