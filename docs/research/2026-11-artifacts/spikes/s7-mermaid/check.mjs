// Spike 7 of plan 88, functional run: parse and render the 30 diagrams with beautiful-mermaid (Node,
// worker thread) and Mermaid 12 (headless Chromium, network blocked, strict, timeout), sanitize with
// DOMPurify, show as <img> in Chromium, WebKit and Firefox, compare, and probe the hostile set.
// Writes out/check-results.json and prints Markdown tables. Timings here are single runs (smoke);
// the measurement is measure.mjs.
//
//   node check.mjs [--skip-linux] [--browsers=chromium,webkit,firefox] [--only=F01,F02]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import { chromium, webkit, firefox } from 'playwright-core'
import { corpus, hostile } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { BmPool } from './lib/bm-renderer.mjs'
import { golosFontFaces } from './lib/fonts.mjs'
import { sanitizeString, sanitizeFinal, PROFILE_SVG, PROFILE_SVG_FO, scan, scanClean, xmlWellFormed, textStream, labelRecall, markupLeak } from './lib/sanitize.mjs'
import { renderedCounts } from './lib/structure.mjs'
import { displayRun } from './lib/display.mjs'
import { decode, pixelDiff, roughDiff } from './lib/images.mjs'
import { platformFonts } from './render-linux.mjs'
import { normalizeSource } from './lib/normalize.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
const only = args.only ? new Set(String(args.only).split(',')) : null
const diagrams = corpus.filter((d) => !only || only.has(d.id))
const browserNames = String(args.browsers || 'chromium,webkit,firefox').split(',')
const TIMEOUT = 15000
const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const log = (...a) => console.error('[check]', ...a)
const load = () => os.loadavg().map((x) => x.toFixed(2)).join(' ')
const started = { at: new Date().toISOString(), loadavg: load() }

const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const golos = golosFontFaces()
const GOLOS_FAMILY = "'Golos Text', sans-serif"
const versions = Object.fromEntries(['beautiful-mermaid', 'mermaid', 'dompurify', 'jsdom', 'playwright-core', '@fontsource/golos-text'].map((p) => [p, JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url), 'utf8')).version]))

// ---------- 1. Render on the host ----------
const raw = {} // raw[variant][id] = { ok, svg, ms, error, stage, structure, timedOut }
const put = (v, id, r) => { (raw[v] ||= {})[id] = r }

log('beautiful-mermaid', versions['beautiful-mermaid'])
const bm = new BmPool()
for (const d of diagrams) {
  put('bm', d.id, await bm.render(d.source, {}, TIMEOUT))
  put('bm-golos', d.id, await bm.render(d.source, { font: 'Golos Text' }, TIMEOUT))
}

// Same engines on the normalized text (code fence dropped, no-break spaces → spaces): parse only.
const normalized = {}
for (const d of diagrams) {
  const src = normalizeSource(d.source)
  const b = await bm.render(src, {}, TIMEOUT, false)
  normalized[d.id] = { changed: src !== d.source, bm: { ok: !!b.svg, error: b.error } }
  if (b.svg) normalized[d.id].bmLabels = labelRecall(textStream(b.svg), d.labels)
}

log('mermaid', versions.mermaid, 'in chromium')
const hostBrowser = await chromium.launch()
const hostChromium = hostBrowser.version()
const mmPlain = await new MermaidPage(hostBrowser, { mermaidJs }).open()
const hostFonts = {}
for (const d of diagrams) {
  const text = await mmPlain.render(d.source, { htmlLabels: false, seed: d.id, secure: LOCKED_SECURE, structure: true }, TIMEOUT)
  put('mm-text', d.id, text)
  if (text.svg && ['F01', 'S01', 'C01', 'E02', 'G01', 'J01', 'M01'].includes(d.id)) hostFonts[d.id] = await platformFonts(mmPlain.page, text.svg)
  put('mm-html', d.id, await mmPlain.render(d.source, { htmlLabels: true, seed: d.id + 'h', secure: LOCKED_SECURE }, TIMEOUT))
}
for (const d of diagrams) {
  const m = await mmPlain.render(normalizeSource(d.source), { htmlLabels: false, seed: d.id + 'n', secure: LOCKED_SECURE }, TIMEOUT)
  normalized[d.id].mm = { ok: !!m.svg, error: m.error, stage: m.stage }
  if (m.svg) normalized[d.id].mmLabels = labelRecall(textStream(m.svg), d.labels)
}
const mmGolos = await new MermaidPage(hostBrowser, { mermaidJs, fontCss: golos.css }).open()
for (const d of diagrams) {
  put('mm-text-golos', d.id, await mmGolos.render(d.source, { htmlLabels: false, seed: d.id + 'g', secure: LOCKED_SECURE, fontFamily: GOLOS_FAMILY }, TIMEOUT))
}
await mmGolos.close()

// ---------- 2. Mermaid in the production browser image (Linux fonts) ----------
const linuxFile = `${OUT}linux-render.json`
let linux = null
if (!args['skip-linux'] || !existsSync(linuxFile)) {
  log('docker: mermaid in mcr.microsoft.com/playwright:v1.63.0-noble, --network none')
  const work = new URL('./', import.meta.url).pathname
  execFileSync('docker', ['run', '--rm', '--name', 'spike88-s7-linux', '--network', 'none', '-v', `${work}:/work:ro`, '-v', `${OUT}:/out`,
    'mcr.microsoft.com/playwright:v1.63.0-noble', 'node', '/work/render-linux.mjs', '/out/linux-render.json'], { stdio: ['ignore', 'inherit', 'inherit'] })
}
linux = JSON.parse(readFileSync(linuxFile, 'utf8'))
for (const d of diagrams) {
  put('linux-mm-text', d.id, linux.variants['mm-text'][d.id])
  put('linux-mm-text-golos', d.id, linux.variants['mm-text-golos'][d.id])
}

// ---------- 3. Sanitize and inspect ----------
const VARIANTS = {
  'bm': { engine: 'bm', profile: PROFILE_SVG, font: null },
  'bm-golos': { engine: 'bm', profile: PROFILE_SVG, font: golos.css },
  'mm-text': { engine: 'mm', profile: PROFILE_SVG, font: null },
  'mm-text-golos': { engine: 'mm', profile: PROFILE_SVG, font: golos.css },
  'mm-html': { engine: 'mm', profile: PROFILE_SVG, font: null },
  'mm-html-fo': { engine: 'mm', profile: PROFILE_SVG_FO, font: null, from: 'mm-html' },
  'mm-text-nocase': { engine: 'mm', profile: PROFILE_SVG, font: null, from: 'mm-text', fixCase: false },
  'linux-mm-text': { engine: 'mm', profile: PROFILE_SVG, font: null },
  'linux-mm-text-golos': { engine: 'mm', profile: PROFILE_SVG, font: golos.css },
}
const rows = {} // rows[variant][id]
for (const [v, spec] of Object.entries(VARIANTS)) {
  rows[v] = {}
  for (const d of diagrams) {
    const r = raw[spec.from || v][d.id]
    const row = { ok: !!(r && r.svg), ms: r?.ms ?? null, error: r?.error, stage: r?.stage, timedOut: !!r?.timedOut }
    if (row.ok) {
      const t0 = performance.now()
      const fin = sanitizeFinal(r.svg, { profile: spec.profile, fontCss: spec.font, fixCase: spec.fixCase !== false })
      row.sanitizeMs = +(performance.now() - t0).toFixed(1)
      const naive = sanitizeString(r.svg, spec.profile)
      const rawStream = textStream(r.svg)
      const finStream = textStream(fin.svg)
      Object.assign(row, {
        rawBytes: Buffer.byteLength(r.svg), finalBytes: Buffer.byteLength(fin.svg), finalGzip: gzipSync(fin.svg).length,
        rawXml: xmlWellFormed(r.svg), naiveXml: xmlWellFormed(naive.svg), finalXml: xmlWellFormed(fin.svg),
        rawScan: scan(r.svg), finalScan: scan(fin.svg), finalClean: scanClean(scan(fin.svg)),
        rawRecall: labelRecall(rawStream, d.labels), finalRecall: labelRecall(finStream, d.labels),
        leak: markupLeak(finStream), removed: fin.removed, stripped: fin.stripped, size: fin.size,
        structure: r.structure, rendered: renderedCounts(r.svg, spec.engine),
        visible: finStream.slice(0, 240),
      })
      row.final = fin.svg
      row.naive = naive.svg
      row.raw = r.svg
    }
    rows[v][d.id] = row
  }
}

// ---------- 4. Show as <img> in three engines ----------
const display = {}
const types = { chromium, webkit, firefox }
for (const name of browserNames) {
  const items = []
  for (const d of diagrams) {
    const REF = { 'bm': 'bm', 'mm-text': 'mm-text', 'mm-text-nocase': 'mm-text', 'mm-html': 'mm-html', 'mm-html-fo': 'mm-html', 'linux-mm-text': 'linux-mm-text' }
    for (const v of Object.keys(VARIANTS)) if (rows[v][d.id].ok) items.push({ key: `${d.id}.${v}.final`, svg: rows[v][d.id].final, inline: true, ref: REF[v] ? rows[REF[v]][d.id].raw : undefined })
    for (const v of ['bm', 'mm-text', 'mm-html']) if (rows[v][d.id].ok) {
      items.push({ key: `${d.id}.${v}.raw`, svg: rows[v][d.id].raw })
      items.push({ key: `${d.id}.${v}.naive`, svg: rows[v][d.id].naive })
    }
  }
  log('display in', name, items.length, 'images')
  if (name === 'firefox' && os.platform() === 'darwin') {
    // On the macOS host the agent sandbox does not let Firefox open its profile: run it in the image.
    writeFileSync(`${OUT}display-items.json`, JSON.stringify(items))
    const work = new URL('./', import.meta.url).pathname
    execFileSync('docker', ['run', '--rm', '--name', 'spike88-s7-firefox', '--network', 'none', '-v', `${work}:/work:ro`, '-v', `${OUT}:/out`,
      'mcr.microsoft.com/playwright:v1.63.0-noble', 'node', '/work/display-docker.mjs', 'firefox', '/out/display-items.json', '/out/display-firefox.json', '/out/png/firefox'], { stdio: ['ignore', 'inherit', 'inherit'] })
    display[name] = { ...JSON.parse(readFileSync(`${OUT}display-firefox.json`, 'utf8')), where: 'linux container' }
  } else {
    display[name] = { ...(await displayRun(types[name], items, `${OUT}png/${name}`)), where: os.platform() }
  }
}

// Rough image differences (from the screenshots of the work dir)
const png = (b, key, kind = 'img') => { const f = `${OUT}png/${b}/${key}.${kind}.png`; return existsSync(f) ? decode(readFileSync(f)) : null }
const diffs = {}
for (const d of diagrams) {
  const x = {}
  const c = (key) => png('chromium', key)
  const pair = (a, b, fn) => (a && b ? fn(a, b) : null)
  x.bmVsMm = pair(c(`${d.id}.bm.final`), c(`${d.id}.mm-text.final`), roughDiff)
  x.htmlVsText = pair(c(`${d.id}.mm-html-fo.final`), c(`${d.id}.mm-text.final`), roughDiff)
  x.linuxVsHost = pair(c(`${d.id}.linux-mm-text.final`), c(`${d.id}.mm-text.final`), (a, b) => pixelDiff(a, b) ?? `size ${a.width}×${a.height} vs ${b.width}×${b.height}`)
  for (const v of ['mm-text', 'mm-text-golos', 'bm', 'bm-golos', 'mm-html-fo', 'linux-mm-text', 'linux-mm-text-golos']) {
    const key = `${d.id}.${v}.final`
    const ch = c(key)
    for (const other of ['webkit', 'firefox']) if (browserNames.includes(other)) {
      const o = png(other, key)
      ;(x.cross ||= {})[`${v}:${other}`] = ch && o ? (pixelDiff(ch, o) ?? `size ${ch.width}×${ch.height} vs ${o.width}×${o.height}`) : null
    }
  }
  diffs[d.id] = x
}

// ---------- 5. Hostile probes ----------
const probes = {}
const mmDefault = await new MermaidPage(hostBrowser, { mermaidJs }).open()
for (const h of hostile) {
  const p = {}
  const b = await bm.render(h.source, {}, TIMEOUT)
  if (b.svg) {
    const fin = sanitizeFinal(b.svg).svg
    p.bm = { ok: true, ms: b.ms, rawScan: scan(b.svg), finalScan: scan(fin), finalClean: scanClean(scan(fin)), inlineRaw: await mmDefault.inlineCheck(b.svg), inlineFinal: await mmDefault.inlineCheck(fin), visible: textStream(fin).slice(0, 120) }
  } else p.bm = { ok: false, error: b.error, timedOut: !!b.timedOut, wallMs: b.wallMs }
  for (const [name, page, secure] of [['mm-default', mmDefault, undefined], ['mm-locked', mmPlain, LOCKED_SECURE]]) {
    const r = await page.render(h.source, { htmlLabels: false, seed: h.id + name, secure }, h.dos ? 8000 : TIMEOUT)
    const q = { ok: !!r.svg, ms: r.ms, wallMs: r.wallMs, error: r.error, stage: r.stage, timedOut: !!r.timedOut, killMs: r.killMs, pwnedDuringRender: r.pwned, requestsDuringRender: r.requests }
    if (r.svg) {
      const fin = sanitizeFinal(r.svg)
      q.rawScan = scan(r.svg)
      q.finalScan = scan(fin.svg)
      q.finalClean = scanClean(q.finalScan)
      const inlineRaw = await page.inlineCheck(r.svg)
      const inlineFinal = await page.inlineCheck(fin.svg)
      q.inlineRaw = inlineRaw
      q.inlineFinal = inlineFinal
      q.visible = textStream(fin.svg).slice(0, 120)
    }
    p[name] = q
  }
  probes[h.id] = { title: h.title, ...p }
}
// The kill path itself: a busy loop that no in-page timer can stop.
{
  const page = await new MermaidPage(hostBrowser, { mermaidJs }).open()
  const t0 = Date.now()
  const r = await Promise.race([page.page.evaluate(() => { for (;;) {} }).then(() => 'returned', () => 'rejected'), new Promise((res) => setTimeout(() => res('timeout'), 2000))])
  const killStart = Date.now()
  await page.kill()
  const killMs = Date.now() - killStart
  const again = await page.render('flowchart LR\n  A --> B', { htmlLabels: false, seed: 'after', secure: LOCKED_SECURE }, TIMEOUT)
  probes.busyLoop = { result: r, waitedMs: killStart - t0, killMs, renderAfterKill: !!again.svg, reopenMs: page.openMs }
  await page.close()
}
// The beautiful-mermaid @import leaves the page when the SVG is inlined or opened on its own.
{
  const b = await bm.render(corpus[0].source, {}, TIMEOUT)
  probes.bmInlineRaw = await mmDefault.inlineCheck(b.svg)
  probes.bmInlineFinal = await mmDefault.inlineCheck(sanitizeFinal(b.svg).svg)
}
await mmDefault.close()
await mmPlain.close()
await bm.close()
await hostBrowser.close()

// ---------- 6. Save and print ----------
const strip = (o) => Object.fromEntries(Object.entries(o).map(([v, m]) => [v, Object.fromEntries(Object.entries(m).map(([id, r]) => { const { final, naive, raw: _r, ...rest } = r; return [id, rest] }))]))
for (const [v, m] of Object.entries(rows)) for (const [id, r] of Object.entries(m)) if (r.final) { mkdirSync(`${OUT}svg`, { recursive: true }); writeFileSync(`${OUT}svg/${id}.${v}.svg`, r.final) }
const result = {
  started, finished: { at: new Date().toISOString(), loadavg: load() },
  machine: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  versions, browsers: { hostChromium, linuxChromium: linux.browser, ...Object.fromEntries(Object.entries(display).map(([k, v]) => [k, v.version])) },
  golosEmbedBytes: golos.bytes, golosCssBytes: golos.css.length,
  fonts: { host: hostFonts, linux: Object.fromEntries(Object.entries(linux.variants['mm-text']).filter(([, r]) => r.fonts).map(([id, r]) => [id, r.fonts])), linuxGolos: Object.fromEntries(Object.entries(linux.variants['mm-text-golos']).filter(([, r]) => r.fonts).map(([id, r]) => [id, r.fonts])) },
  corpus: diagrams.map(({ id, type, valid, title, origin, mistake }) => ({ id, type, valid, title, origin, mistake })),
  normalized, rows: strip(rows), display: Object.fromEntries(Object.entries(display).map(([k, v]) => [k, { where: v.where, version: v.version, requests: v.requests, inlineRequests: v.inlineRequests, results: v.results }])), diffs, probes,
}
writeFileSync(`${OUT}check-results.json`, JSON.stringify(result, null, 1))
log('wrote', `${OUT}check-results.json`)

// Markdown summary
const md = []
const pct = (a, b) => (b ? `${a}/${b}` : '—')
md.push(`Started ${started.at}, load ${started.loadavg}; finished load ${result.finished.loadavg}.`)
md.push('', '| id | type | valid | bm | bm labels | mm text | mm labels | mm html→svg labels | mm html→fo labels | leak bm / mm |', '|---|---|---|---|---|---|---|---|---|---|')
for (const d of diagrams) {
  const b = rows.bm[d.id], m = rows['mm-text'][d.id], h = rows['mm-html'][d.id], f = rows['mm-html-fo'][d.id]
  const st = (r) => (r.ok ? 'ok' : r.timedOut ? 'timeout' : `fail (${r.stage})`)
  md.push(`| ${d.id} | ${d.type} | ${d.valid} | ${st(b)} | ${b.ok ? pct(b.finalRecall.found, b.finalRecall.total) : '—'} | ${st(m)} | ${m.ok ? pct(m.finalRecall.found, m.finalRecall.total) : '—'} | ${h.ok ? pct(h.finalRecall.found, h.finalRecall.total) : '—'} | ${f.ok ? pct(f.finalRecall.found, f.finalRecall.total) : '—'} | ${b.ok ? b.leak.length : '—'} / ${m.ok ? m.leak.length : '—'} |`)
}
console.log(md.join('\n'))
