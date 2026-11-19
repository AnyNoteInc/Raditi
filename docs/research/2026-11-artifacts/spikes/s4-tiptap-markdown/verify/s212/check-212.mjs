// The bridge's canon on the serializer the repository's lockfile holds (mdast-util-to-markdown
// 2.1.2, mdast-util-from-markdown 2.0.3): is it still a fixed point (the editor only carries JSON),
// and how does it differ from 2.2.3? Prints the canon of every construct and document as JSON for
// the comparison with the 2.2.3 run.
import { canonBridge, mdToPm, pmToMd } from './lib/remark-bridge.mjs'
import { constructs } from './constructs.mjs'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const items = [...constructs.map(([id, , md]) => [id, md]), ...readdirSync('corpus').filter((f) => f.endsWith('.md')).sort().map((f) => [f, decode(readFileSync('corpus/' + f, 'utf8'))])]
const out = {}
let notFixed = []
for (const [id, raw] of items) {
  const a = canonBridge(raw)
  out[id] = a
  if (pmToMd(mdToPm(a)) !== a) notFixed.push(id)
}
writeFileSync(process.argv[2], JSON.stringify(out))
console.log('items', items.length, 'not a fixed point on 2.1.2:', notFixed.length, notFixed)
console.log('snake_case_name →', JSON.stringify(canonBridge('snake_case_name и @sintetika_example')))
