// Skeptic check of spike 7 limits (single renders, not a timing loop): SVG size of flowcharts from a
// different generator (layered graph, two-word labels, every third edge labelled), whether maxEdges also
// limits sequence messages and other kinds, and what maxTextSize does.   node verify/scale.mjs
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { sanitizeFinal } = await import(new URL('../lib/sanitize.mjs', import.meta.url))
const mermaidJs = readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const W = ['приём', 'оплата', 'склад', 'курьер', 'звонок', 'возврат']
function layered(edges) {
  const perLayer = 6, nodes = Math.ceil(edges * 0.6)
  const lines = ['flowchart LR']
  for (let i = 0; i < nodes; i++) lines.push(`  v${i}("${W[i % 6]} ${i}")`)
  let e = 0
  for (let i = perLayer; i < nodes && e < edges; i++) { lines.push(`  v${i - perLayer} --> v${i}`); e++ }
  for (let i = 0; e < edges; i++) { const a = i % (nodes - perLayer - 1); lines.push(e % 3 ? `  v${a} --> v${a + perLayer + 1}` : `  v${a} -->|${W[e % 6]}| v${a + perLayer + 1}`); e++ }
  return lines.join('\n')
}
const seq = (n) => ['sequenceDiagram', '  participant A as Клиент', '  participant B as Касса', ...Array.from({ length: n }, (_, i) => `  ${i % 2 ? 'B->>A' : 'A->>B'}: шаг ${i}`)].join('\n')
const browser = await chromium.launch()
const ctx = await browser.newContext()
await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
await page.addScriptTag({ content: mermaidJs })
const render = (src, maxEdges, extra = {}) => page.evaluate(async ({ src, maxEdges, secure, extra }) => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, maxEdges, secure, ...extra })
  const t0 = performance.now()
  try { const { svg } = await window.mermaid.render('s' + Math.random().toString(36).slice(2), src); return { svg, ms: performance.now() - t0 } } catch (e) { return { error: String(e.message || e).split('\n')[0].slice(0, 120) } }
}, { src, maxEdges, secure: LOCKED, extra })
for (const n of [100, 130, 200]) {
  const r = await render(layered(n), 500)
  if (r.error) { console.log('flow', n, 'ERR', r.error); continue }
  const fin = sanitizeFinal(r.svg).svg
  console.log(`flow ${n} edges: raw ${Math.round(r.svg.length / 1024)} KiB, final ${Math.round(Buffer.byteLength(fin) / 1024)} KiB, gzip ${Math.round(gzipSync(fin).length / 1024)} KiB, ${Math.round(r.ms)} ms`)
}
for (const n of [250, 600]) { const r = await render(seq(n), 200); console.log(`sequence ${n} messages with maxEdges 200:`, r.error ? 'ERR ' + r.error : `ok, final ${Math.round(Buffer.byteLength(sanitizeFinal(r.svg).svg) / 1024)} KiB`) }
const st = ['stateDiagram-v2', ...Array.from({ length: 260 }, (_, i) => `  s${i} --> s${i + 1}`)].join('\n')
const r1 = await render(st, 200); console.log('state 260 transitions with maxEdges 200:', r1.error ? 'ERR ' + r1.error : 'ok')
const big = 'flowchart TD\n' + Array.from({ length: 1400 }, (_, i) => `  n${i}["${'длинная подпись '.repeat(2)}${i}"]`).join('\n')
const r2 = await render(big, 500); console.log(`text of ${big.length} chars (maxTextSize default 50000):`, r2.error ? 'ERR ' + r2.error : `no error; svg ${Math.round(r2.svg.length / 1024)} KiB; visible text: ${JSON.stringify(r2.svg.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80))}`)
await browser.close()
