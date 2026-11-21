// Functional checks of spike s3 (plan 88): detectors against the planted bugs, the report, the
// network lock, the script stop, huge and greedy frames, axe-core as a reference.
//   node check.mjs [--only 05] [--no-hostile] [--no-axe] [--buffers] [--out <dir>]
// In Docker: see docker-check.sh (network none, 1 CPU, 1536 MiB — the session container's limits).
// Writes out/check/<frame>/{1440,390}.{png,pdf}, thumbnails, map.json, report.txt and
// out/check/summary.json; prints Markdown tables. Not a timing run: numbers here are incidental.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { assembleFrame, ensureAssets, listFixtures, manifest, ROOT } from './lib/frames.mjs'
import { launch, renderFrame, LIMITS } from './lib/render.mjs'
import { findingsOf, layoutReport } from './lib/report.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'out', 'check')
mkdirSync(OUT, { recursive: true })
const require = createRequire(import.meta.url)
const AXE = flag('--no-axe') ? null : readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const WIDTHS = [1440, 390]
const ALL_OUTPUTS = { png: true, pdf: true, thumb: true, thumbWebp: true, strips: true, pixels: true }
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
const summary = { at: new Date().toISOString(), node: process.version, frames: {}, scoring: [], unplanned: [], extra: {} }

const { browser, server, launchMs } = await launch(chromium)
summary.chromium = browser.version()
summary.launchMs = launchMs
const assets = await ensureAssets(browser)
const plan = manifest().frames

// ------------------------------------------------------------------ A. typical frames
const related = (frame, a, b) => {
  if (!a || !b) return false
  if (a === b) return true
  for (const [x, y] of [[a, b], [b, a]]) {
    let p = frame.parents[x]
    for (let i = 0; i < 2 && p; i++) { if (p === y) return true; p = frame.parents[p] }
  }
  return false
}
function matches(frame, bug, f) {
  if (f.kind !== bug.kind) return false
  const target = frame.bugs[bug.id] ? frame.bugs[bug.id].id : null
  switch (bug.kind) {
    case 'hscroll': return (f.culprits || []).some((c) => related(frame, c.id, target))
    case 'overlap': return related(frame, f.id, target) || related(frame, f.under && f.under.id, target)
    case 'blocked': return frame.bugs[bug.id] && f.url && f.url.startsWith(frame.bugs[bug.id].url.slice(0, 60))
    case 'script-error': case 'no-viewport': case 'font-missing': case 'invisible': return true
    default: return related(frame, f.id, target)
  }
}
const INFO = new Set(['unsettled', 'photo-text', 'console-error'])

for (const name of listFixtures('typical').filter((n) => !only || n.startsWith(only))) {
  const frame = assembleFrame(name, { assets })
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  const byWidth = {}
  for (const width of WIDTHS) {
    const r = await renderFrame(browser, frame, { width, assets, outputs: ALL_OUTPUTS, axe: AXE, keep: { png: true, pdf: true, thumb: true } })
    byWidth[width] = r
    if (r.buffers.png) writeFileSync(join(dir, `${width}.png`), r.buffers.png)
    if (r.buffers.pdf) writeFileSync(join(dir, `${width}.pdf`), r.buffers.pdf)
    if (r.buffers.thumb) writeFileSync(join(dir, `${width}-thumb.jpg`), r.buffers.thumb)
    if (r.buffers.thumbTop) writeFileSync(join(dir, `${width}-thumb-top.jpg`), r.buffers.thumbTop)
    writeFileSync(join(dir, `${width}-map.json`), JSON.stringify({ doc: r.map && r.map.doc, issues: r.map && r.map.issues, photo: r.map && r.map.photo, pixels: r.pixels, events: r.events, rects: r.map && r.map.rects }, null, 1))
  }
  const report = layoutReport({ name, title: plan[name].title, byWidth })
  writeFileSync(join(dir, 'report.txt'), `${report.text}\n\n«Ход работы»: ${report.ru}\n`)
  const findings = findingsOf(byWidth)
  const used = new Set()
  for (const bug of plan[name].bugs) {
    for (const width of bug.width === 'both' ? WIDTHS : [bug.width]) {
      if (bug.scrollPassOff) continue
      const hit = findings.find((f) => f.w === width && matches(frame, bug, f))
      findings.forEach((f, i) => { if (f.w === width && matches(frame, bug, f)) used.add(i) })
      summary.scoring.push({ frame: name, bug: bug.id, kind: bug.kind, width, hit: Boolean(hit), what: bug.what })
    }
  }
  // A finding that repeats a planted one on another element with the same style (the other review
  // authors, the other footnotes) belongs to that bug: the planted style is on all of them.
  const style = (f) => `${f.w}|${f.kind}|${f.tag}|${f.ratio || ''}|${f.fg || ''}|${f.bg || ''}|${f.px || ''}`
  const plantedStyles = new Set([...used].map((i) => style(findings[i])))
  findings.forEach((f, i) => {
    if (used.has(i) || INFO.has(f.kind)) return
    if (plantedStyles.has(style(f))) { summary.siblings = (summary.siblings || 0) + 1; return }
    summary.unplanned.push({ frame: name, width: f.w, kind: f.kind, id: f.id || null, tag: f.tag || null, detail: f.ratio ? `${f.ratio}:1 ${f.fg || ''} on ${f.bg || ''}`.trim() : f.px ? `${f.px} px` : f.text || f.url || f.family || (f.culprits ? f.culprits.map((c) => c.tag).join(',') : '') })
  })
  summary.frames[name] = {
    title: plan[name].title,
    bytes: { stored: frame.storedBytes, stamped: frame.stampedBytes, assembled: frame.bytes, ids: frame.ids.length },
    report: { chars: report.chars, problems: report.problems, ru: report.ru },
    widths: Object.fromEntries(WIDTHS.map((w) => {
      const r = byWidth[w]
      return [w, { error: r.error || null, hung: r.hung, settled: r.settle ? r.settle.settled : null, doc: r.map ? r.map.doc : null, t: r.t, sizes: r.sizes, issues: r.map ? r.map.issues.length : null, rects: r.map ? r.map.rects.length : 0, csp: r.events.csp.length, pageErrors: r.events.pageErrors, requests: r.events.requests, served: r.events.served, blocked: r.events.blocked.length, axe: r.axe ? { ms: r.axe.ms, violations: r.axe.violations.map((v) => ({ id: v.id, n: v.nodes.length, els: v.nodes.map((x) => x.el) })), incomplete: r.axe.incomplete.map((v) => ({ id: v.id, n: v.nodes.length, els: v.nodes.map((x) => x.el), reasons: [...new Set(v.nodes.map((x) => x.reason))] })) } : null, ourContrast: r.map ? r.map.issues.filter((i) => i.kind === 'contrast').map((i) => i.id) : [], pixels: r.pixels ? r.pixels.verdicts : null }]
    })),
  }
  process.stdout.write(`${name}: ${report.problems} problems, report ${report.chars} chars\n`)
}

// ------------------------------------------------------------------ B. scroll pass off
if (!only || only.startsWith('10')) {
  const frame = assembleFrame('10-one-page-site', { assets })
  const byWidth = {}
  for (const width of WIDTHS) byWidth[width] = await renderFrame(browser, frame, { width, assets, scrollPass: false, outputs: { png: true, thumb: true }, keep: { png: true } })
  for (const width of WIDTHS) if (byWidth[width].buffers.png) writeFileSync(join(OUT, `10-one-page-site-noscroll-${width}.png`), byWidth[width].buffers.png)
  const findings = findingsOf(byWidth)
  const report = layoutReport({ name: '10-one-page-site', title: plan['10-one-page-site'].title, byWidth })
  writeFileSync(join(OUT, '10-one-page-site-noscroll-report.txt'), `${report.text}\n\n«Ход работы»: ${report.ru}\n`)
  const frameBugs = plan['10-one-page-site'].bugs
  summary.extra.scrollPassOff = {
    invisibleFound: WIDTHS.map((w) => findings.some((f) => f.w === w && f.kind === 'invisible')),
    planted: frameBugs.filter((b) => !b.scrollPassOff).flatMap((bug) => (bug.width === 'both' ? WIDTHS : [bug.width]).map((w) => ({ bug: bug.id, width: w, hit: findings.some((f) => f.w === w && matches(frame, bug, f)) }))),
    emptyGaps: findings.filter((f) => f.kind === 'empty').map((f) => ({ w: f.w, h: f.h, id: f.id })),
    t: WIDTHS.map((w) => byWidth[w].t),
  }
  for (const w of WIDTHS) summary.scoring.push({ frame: '10-one-page-site', bug: 'B19', kind: 'invisible', width: w, hit: summary.extra.scrollPassOff.invisibleFound[WIDTHS.indexOf(w)], what: 'scroll pass off' })
}

// ------------------------------------------------------------------ C. the sandbox matters
if (!only || only.startsWith('04')) {
  const frame = assembleFrame('04-calculator', { assets })
  const sandboxed = await renderFrame(browser, frame, { width: 1440, assets, extract: '#total' })
  const open = await renderFrame(browser, frame, { width: 1440, assets, extract: '#total', policy: null })
  summary.extra.sandbox = { withFramePolicy: { total: sandboxed.extract, pageErrors: sandboxed.events.pageErrors }, withoutPolicy: { total: open.extract, pageErrors: open.events.pageErrors } }
}

// ------------------------------------------------------------------ D. fonts inline or by the library path
if (!only || only.startsWith('01')) {
  const out = {}
  for (const fonts of ['route', 'data']) {
    const frame = assembleFrame('01-bakery-landing', { assets, fonts })
    const r = await renderFrame(browser, frame, { width: 1440, assets, outputs: { png: true }, keep: { png: true } })
    out[fonts] = { htmlBytes: frame.bytes, faces: r.map.faces, docH: r.map.doc.docH, issues: r.map.issues.length, png: sha(r.buffers.png), served: r.events.served, t: r.t }
  }
  out.samePixels = out.route.png === out.data.png
  summary.extra.fonts = out
}

// ------------------------------------------------------------------ E. the same frame twice
if (!only) {
  const out = {}
  for (const name of ['02-price-list', '09-faq-accordion', '05-promo-banner']) {
    const frame = assembleFrame(name, { assets })
    const a = await renderFrame(browser, frame, { width: 390, assets, outputs: { png: true }, keep: { png: true } })
    const b = await renderFrame(browser, frame, { width: 390, assets, outputs: { png: true }, keep: { png: true } })
    out[name] = { samePng: sha(a.buffers.png) === sha(b.buffers.png), sameIssues: JSON.stringify(a.map.issues) === JSON.stringify(b.map.issues), sameRects: JSON.stringify(a.map.rects) === JSON.stringify(b.map.rects) }
  }
  summary.extra.determinism = out
}

// ------------------------------------------------------------------ F. hostile frames
if (!flag('--no-hostile') && !only) {
  const hostile = {}
  // F1. The network: a trap on loopback counts every connection and request that reaches it.
  const trap = { connections: 0, requests: [] }
  const trapServer = createServer((req, res) => { trap.requests.push(`${req.method} ${req.url}`); res.end('trap') })
  trapServer.on('connection', () => { trap.connections++ })
  await new Promise((resolve) => trapServer.listen(0, '127.0.0.1', resolve))
  const trapOrigin = `http://127.0.0.1:${trapServer.address().port}`
  const net = assembleFrame('h1-network', { assets, trap: trapOrigin })
  const r1 = await renderFrame(browser, net, { width: 1440, assets, outputs: { png: true }, extract: '#out', keep: { png: true } })
  await new Promise((resolve) => setTimeout(resolve, 1500)) // the meta refresh (1 s) and the late navigation
  trapServer.close()
  if (r1.buffers.png) writeFileSync(join(OUT, 'h1-network.png'), r1.buffers.png)
  hostile.network = { trapConnections: trap.connections, trapRequests: trap.requests, tried: r1.extract, routeSeen: r1.events.requests, served: r1.events.served, navigations: r1.events.navigations, blocked: r1.events.blocked, csp: r1.events.csp, popups: r1.events.popups, dialogs: r1.events.dialogs, pageErrors: r1.events.pageErrors, error: r1.error || null, t: r1.t }

  // F2. A loop that never ends: the load times out, the script is stopped, the frame is drawn.
  const loop = assembleFrame('h2-loop', { assets })
  const r2 = await renderFrame(browser, loop, { width: 1440, assets, outputs: { png: true }, keep: { png: true } })
  if (r2.buffers.png) writeFileSync(join(OUT, 'h2-loop.png'), r2.buffers.png)
  const after2 = await renderFrame(browser, assembleFrame('09-faq-accordion', { assets }), { width: 390, assets })
  hostile.loop = { hung: r2.hung, loadError: r2.loadError || null, error: r2.error || null, issues: r2.map ? r2.map.issues.map((i) => i.kind) : null, textBlocks: r2.map ? r2.map.doc.textBlocks : null, png: r2.sizes.png || null, t: r2.t, nextRenderOk: !after2.error && Boolean(after2.map) }

  // F3. 200 000 px tall, 3 000 px wide, 3 000 rows built by a script.
  const huge = assembleFrame('h3-huge', { assets })
  const r3 = await renderFrame(browser, huge, { width: 1440, assets, outputs: { png: true, pdf: true, thumb: true, strips: true } })
  hostile.huge = { error: r3.error || null, doc: r3.map ? r3.map.doc : null, sizes: r3.sizes, issues: r3.map ? r3.map.issues.map((i) => i.kind) : null, rects: r3.map ? r3.map.rects.length : 0, mapBytes: r3.sizes.map, t: r3.t }

  // F4. Memory: the V8 heap grows until the renderer gives up (--max-old-space-size=512).
  const kinds = flag('--buffers') ? ['heap', 'buffers'] : ['heap']
  hostile.memory = {}
  for (const memory of kinds) {
    const greedy = assembleFrame('h4-memory', { assets, memory })
    const r4 = await renderFrame(browser, greedy, { width: 1440, assets, outputs: { png: true }, extract: '#n' })
    const after4 = await renderFrame(browser, assembleFrame('09-faq-accordion', { assets }), { width: 390, assets })
    hostile.memory[memory] = { crashed: r4.events.crashed, error: r4.error || null, hung: r4.hung, extract: r4.extract || null, t: r4.t, nextRenderOk: !after4.error && Boolean(after4.map), browserConnected: browser.isConnected() }
  }
  summary.extra.hostile = hostile
}

await browser.close()
await server.close()
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1))

// ------------------------------------------------------------------ tables
const rows = (list) => list.join('\n')
const hits = summary.scoring.filter((s) => s.hit).length
console.log(`\n## Planted bugs: ${hits} of ${summary.scoring.length} hit\n`)
console.log(rows(['| Frame | Bug | Kind | Width | Hit |', '| --- | --- | --- | --- | --- |', ...summary.scoring.map((s) => `| ${s.frame} | ${s.bug} | ${s.kind} | ${s.width} | ${s.hit ? 'yes' : '**no**'} |`)]))
console.log(`\n## Findings outside the planted bugs: ${summary.unplanned.length} (and ${summary.siblings || 0} repeats of a planted style on other elements)\n`)
console.log(rows(['| Frame | Width | Kind | Element | Detail |', '| --- | --- | --- | --- | --- |', ...summary.unplanned.map((u) => `| ${u.frame} | ${u.width} | ${u.kind} | ${u.id || ''} ${u.tag || ''} | ${String(u.detail).slice(0, 60)} |`)]))
console.log('\n## Extra checks\n')
console.log('```json\n' + JSON.stringify(summary.extra, null, 1).slice(0, 6000) + '\n```')
