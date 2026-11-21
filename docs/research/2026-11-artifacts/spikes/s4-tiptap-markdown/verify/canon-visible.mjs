// What the bridge's canon (raw → A) changes in what the reader sees, by the real doc-render, for the
// spike's 109 constructs and 30 documents. The round trip is checked from A; this is the step before.
import { canonBridge } from '../lib/remark-bridge.mjs'
import { constructs } from '../constructs.mjs'
import { seen, html } from './canon.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const items = [...constructs.map(([id, , md]) => [id, md]), ...readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => [f, decode(readFileSync(dir + f, 'utf8'))])]
let words = 0, shape = 0
for (const [id, raw] of items) {
  const a = canonBridge(raw)
  if (seen(raw) !== seen(a)) { words += 1; console.log(`W ${id}: ${JSON.stringify(seen(raw)).slice(0, 110)}\n     → ${JSON.stringify(seen(a)).slice(0, 110)}`) }
  else if (html(raw) !== html(a)) { shape += 1; console.log(`F ${id}`) }
}
console.log({ items: items.length, visibleWordsChanged: words, sameWordsOtherHtml: shape })
