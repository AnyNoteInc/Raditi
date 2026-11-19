// Rendered structure, counted from the SVG markup of each engine (flowchart and state only).
import { JSDOM } from 'jsdom'
const { window } = new JSDOM('')

const SEL = {
  mm: { nodes: 'g.node', edges: 'path.flowchart-link, path.transition, path.relation', clusters: 'g.cluster' },
  bm: { nodes: 'g.node', edges: '.edge', clusters: 'g.subgraph' },
}

export function renderedCounts(svg, engine) {
  const holder = window.document.createElement('div')
  holder.innerHTML = svg // jsdom, never executed
  const s = SEL[engine]
  const count = (q) => holder.querySelectorAll(q).length
  return { nodes: count(s.nodes), edges: count(s.edges), clusters: count(s.clusters) }
}
