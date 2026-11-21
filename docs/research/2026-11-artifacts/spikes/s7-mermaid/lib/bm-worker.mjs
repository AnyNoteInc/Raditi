// Worker thread: beautiful-mermaid is synchronous, so a timeout needs a thread that can be terminated.
import { parentPort } from 'node:worker_threads'
import { renderMermaidSVG, parseMermaid } from 'beautiful-mermaid'

const countOf = (v) => v == null ? null : (typeof v.size === 'number' ? v.size : Array.isArray(v) ? v.length : Object.keys(v).length)

parentPort.on('message', ({ id, src, options, structure }) => {
  const t0 = performance.now()
  try {
    const svg = renderMermaidSVG(src, options)
    const ms = performance.now() - t0
    let parsed = null
    if (structure) {
      try {
        const g = parseMermaid(src)
        const subgraphs = []
        const walk = (list) => { for (const s of list || []) { subgraphs.push(s); walk(s.children) } }
        walk(g.subgraphs)
        parsed = { vertices: countOf(g.nodes), edges: countOf(g.edges), subgraphs: subgraphs.length }
      } catch { parsed = null }
    }
    parentPort.postMessage({ id, svg, ms, structure: parsed })
  } catch (e) {
    parentPort.postMessage({ id, ms: performance.now() - t0, error: String(e && e.message || e).split('\n')[0].slice(0, 300), stage: 'parse-or-layout' })
  }
})
