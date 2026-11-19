// Skeptic order-of-magnitude check of spike 7 timings and memory (one shot, not a measurement): Chromium
// start, a new page with Mermaid, the first and ten warm renders of F05, the corpus once, memory after.
//   node verify/quickperf.mjs
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { corpus } = await import(new URL('../corpus.mjs', import.meta.url))
const mermaidJs = readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const mib = (b) => Math.round(b / 2 ** 20)
const rss = () => { const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)); const kids = new Map(); for (const [p, pp] of out) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p) } const r = new Map(out.map(([p, , k]) => [p, k * 1024])); let s = 0; const w = (p) => { for (const k of kids.get(p) || []) { s += r.get(k) || 0; w(k) } }; w(process.pid); return mib(s) }
const cg = () => existsSync('/sys/fs/cgroup/memory.current') ? `cgroup ${mib(Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8')))} MiB (peak ${mib(Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8')))})` : ''
const t = () => performance.now()
console.log('load', os.loadavg().map((x) => x.toFixed(2)).join(' '))
let a = t()
const browser = await chromium.launch()
console.log('launch', Math.round(t() - a), 'ms; rss', rss(), 'MiB', cg())
a = t()
const ctx = await browser.newContext()
await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
await page.addScriptTag({ content: mermaidJs })
console.log('new page with Mermaid', Math.round(t() - a), 'ms; rss', rss(), 'MiB', cg())
const render = (src, i) => page.evaluate(async ({ src, i, secure }) => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, secure }); const t0 = performance.now(); try { await window.mermaid.render('q' + i, src); return performance.now() - t0 } catch { return -1 } }, { src, i, secure: LOCKED })
const f05 = corpus.find((d) => d.id === 'F05').source
console.log('first render F05', Math.round(await render(f05, 0)), 'ms')
const warm = []
for (let i = 1; i <= 10; i++) warm.push(await render(f05, i))
warm.sort((x, y) => x - y)
console.log('warm F05 median of 10', Math.round(warm[5]), 'ms, max', Math.round(warm[9]), 'ms')
const each = []
for (const d of corpus) { const ms = await render(d.source, 'c' + d.id); if (ms >= 0) each.push(ms) }
each.sort((x, y) => x - y)
console.log('corpus once:', each.length, 'rendered, median', Math.round(each[each.length >> 1]), 'ms; rss', rss(), 'MiB', cg())
await browser.close()
