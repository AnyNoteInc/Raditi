// Spike 7 of plan 88: how render time and SVG size grow with the size of a diagram, to check the limits
// proposed for §7.12 (up to 500 edges, render timeout 10 s, final SVG up to 256 KiB). Synthetic
// flowcharts and sequence diagrams with Cyrillic labels, warm page, htmlLabels false, then the same
// DOMPurify + hardening as the main path.
//   node probe-scale.mjs [--out=out/probe-scale.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { sanitizeFinal } from './lib/sanitize.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
const OUT = args.out || 'out/probe-scale.json'
const here = new URL('./', import.meta.url).pathname
const uptime = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).trim() } catch { return os.loadavg().join(' ') } }
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const WORDS = ['заказ', 'оплата', 'доставка', 'склад', 'клиент', 'звонок', 'проверка', 'возврат', 'курьер', 'счёт']

// A flowchart with `edges` edges: a spanning tree over the nodes plus cross links to earlier nodes.
function flowchart(edges) {
  let seed = 7
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const nodes = Math.max(2, Math.round(edges * 0.8))
  const lines = ['flowchart TD']
  for (let i = 0; i < nodes; i++) lines.push(`  n${i}["Шаг ${i}: ${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]}"]`)
  let e = 0
  for (let i = 1; i < nodes && e < edges; i++, e++) lines.push(`  n${rnd(i)} --> n${i}`)
  while (e < edges) { const a = rnd(nodes - 1); const b = a + 1 + rnd(nodes - a - 1); lines.push(`  n${a} -->|${WORDS[e % WORDS.length]}| n${b}`); e++ }
  return { source: lines.join('\n'), nodes, edges }
}

function sequence(messages) {
  const who = ['Клиент', 'Сайт', 'Касса', 'Склад', 'Курьер', 'Менеджер']
  const lines = ['sequenceDiagram', ...who.map((w, i) => `  participant P${i} as ${w}`)]
  for (let i = 0; i < messages; i++) lines.push(`  P${i % who.length}->>P${(i * 5 + 1) % who.length}: ${WORDS[i % WORDS.length]} номер ${i}`)
  return { source: lines.join('\n'), messages }
}

const cases = [
  ...[25, 50, 100, 200, 300, 400, 500].map((n) => ({ id: `flow-${n}`, kind: 'flowchart', ...flowchart(n) })),
  ...[50, 200, 500].map((n) => ({ id: `seq-${n}`, kind: 'sequence', ...sequence(n) })),
]

const started = uptime()
console.error('[probe-scale] start', started)
const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const browser = await chromium.launch()
const page = new MermaidPage(browser, { mermaidJs })
await page.open()
// Warm the page the same way as measure.mjs does before timing.
await page.render('flowchart TD\n  a[Начало] --> b[Конец]', { htmlLabels: false, seed: 'warm', secure: LOCKED_SECURE }, 20000)
const rows = []
for (const c of cases) {
  const inPage = [], wall = []
  let last
  for (let i = 0; i < 3; i++) {
    last = await page.render(c.source, { htmlLabels: false, seed: `${c.id}s${i}`, secure: LOCKED_SECURE }, 120000)
    if (last.timedOut) { await page.open(); break }
    inPage.push(last.ms); wall.push(last.wallMs)
  }
  const row = { id: c.id, kind: c.kind, nodes: c.nodes, edges: c.edges, messages: c.messages, sourceChars: c.source.length, ok: !!last.svg, error: last.error, timedOut: !!last.timedOut }
  if (last.svg) {
    const t0 = performance.now()
    const fin = sanitizeFinal(last.svg)
    row.sanitizeMs = Math.round(performance.now() - t0)
    row.renderMs = Math.round(median(inPage))
    row.wallMs = Math.round(median(wall))
    row.rawBytes = Buffer.byteLength(last.svg)
    row.finalBytes = Buffer.byteLength(fin.svg)
    row.finalGzip = gzipSync(fin.svg).length
  }
  rows.push(row)
  console.error('[probe-scale]', JSON.stringify(row))
}
await page.close()
await browser.close()
const result = { started, finished: uptime(), machine: `${os.platform()} ${os.arch()} node ${process.version}`, browser: browser.version(), rows }
writeFileSync(new URL(OUT, `file://${here}`), JSON.stringify(result, null, 1))
console.log(JSON.stringify(result, null, 1))
