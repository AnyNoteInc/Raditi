// Spike 7 of plan 88: what the agent gets back when a flowchart is over the edge limit, and whether a
// directive can lift the limit. maxEdges is set to 200 in initialize; maxEdges is in `secure` by default.
//   node probe-max-edges.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { LOCKED_SECURE } from './lib/mermaid-renderer.mjs'

const chain = (edges, directive = '') => {
  const nodes = Math.round(edges * 0.8)
  const lines = [directive, 'flowchart TD'].filter(Boolean)
  for (let i = 0; i < nodes; i++) lines.push(`  n${i}["Шаг ${i}"]`)
  let e = 0
  for (let i = 1; i < nodes; i++, e++) lines.push(`  n${i - 1} --> n${i}`)
  for (let i = 0; e < edges; i++, e++) lines.push(`  n${i % (nodes - 2)} --> n${(i % (nodes - 2)) + 2}`)
  return lines.join('\n')
}

const browser = await chromium.launch()
const context = await browser.newContext()
await context.route('**/*', (r) => r.abort())
const page = await context.newPage()
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
await page.addScriptTag({ content: readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8') })
const cases = { 'edges-200': chain(200), 'edges-201': chain(201), 'edges-300 + %%{init: {"maxEdges": 1000}}%%': chain(300, '%%{init: {"maxEdges": 1000}}%%') }
for (const [name, src] of Object.entries(cases)) {
  const r = await page.evaluate(async ({ src, secure }) => {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, maxEdges: 200, secure })
    try { const { svg } = await window.mermaid.render('x' + Math.random().toString(36).slice(2), src); return { ok: true, bytes: svg.length } } catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200) } }
  }, { src, secure: LOCKED_SECURE })
  console.log(name, JSON.stringify(r))
}
await browser.close()
