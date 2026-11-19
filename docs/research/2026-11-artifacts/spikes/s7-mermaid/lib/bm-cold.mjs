// One cold beautiful-mermaid render in a fresh Node process: import time, first render, memory.
//   node lib/bm-cold.mjs <diagram id> [font]
import { corpus } from '../corpus.mjs'
const [id, font] = process.argv.slice(2)
const d = corpus.find((c) => c.id === id)
const m0 = process.memoryUsage()
const t0 = performance.now()
const { renderMermaidSVG } = await import('beautiful-mermaid')
const t1 = performance.now()
let ok = true, error, bytes = 0
try { bytes = renderMermaidSVG(d.source, font ? { font } : {}).length } catch (e) { ok = false; error = String(e.message).slice(0, 120) }
const t2 = performance.now()
const m1 = process.memoryUsage()
process.stdout.write(JSON.stringify({ id, ok, error, bytes, importMs: t1 - t0, renderMs: t2 - t1, rssBefore: m0.rss, rssAfter: m1.rss, heapAfter: m1.heapUsed, maxRSS: process.resourceUsage().maxRSS }))
