// Whole lines as quotes (as the harness), but the reader's text comes from the real doc-render and
// table rows count too (a row as its cells' words). Raw text → canonical text of the bridge.
import { canonBridge } from '../lib/remark-bridge.mjs'
import { seen } from './canon.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const t = { lines: 0, src: 0, vis: 0, rows: 0, rowsSrc: 0, rowsVis: 0 }
const misses = []
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const raw = decode(readFileSync(dir + f, 'utf8'))
  const canon = canonBridge(raw)
  const whole = seen(canon)
  const flat = seen(canon).replace(/\s+/g, '')
  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~|\[\^?[^\]]+\]:)/.test(line) || line.trim().length < 12) continue
    if (line.startsWith('|')) {
      if (/^\|[\s|:-]+\|?$/.test(line)) continue
      t.rows += 1
      if (canon.includes(line)) t.rowsSrc += 1
      // cells are glued in textContent: compare without white space
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => seen(c.trim()).replace(/\s+/g, '')).join('')
      if (flat.includes(cells)) t.rowsVis += 1
      continue
    }
    const q = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/(?:\\| {2,})$/, '').trim()
    if (q.length < 12) continue
    t.lines += 1
    if (canon.includes(q)) t.src += 1
    const v = seen(q.replace(/\[\^[^\]]+\]/g, ''))
    if (!v || whole.includes(v)) t.vis += 1
    else if (misses.length < 10) misses.push(`${f}: ${JSON.stringify(q).slice(0, 90)}`)
  }
}
console.log(t)
console.log(misses.join('\n'))
