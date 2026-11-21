// The same canon on 2.2.3 (this directory's packages) against the file written on 2.1.2.
import { canonBridge } from '../lib/remark-bridge.mjs'
import { constructs } from '../constructs.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const old = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const items = [...constructs.map(([id, , md]) => [id, md]), ...readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => [f, decode(readFileSync(dir + f, 'utf8'))])]
const differ = items.filter(([id, raw]) => canonBridge(raw) !== old[id]).map(([id, raw]) => {
  const a = old[id].split('\n'), b = canonBridge(raw).split('\n')
  return `${id}: ${a.filter((l, i) => l !== b[i]).slice(0, 2).map((l, i) => JSON.stringify(l) + ' → ' + JSON.stringify(b[a.indexOf(l)])).join('; ')}`
})
console.log('2.1.2 vs 2.2.3, bridge canon differs in', differ.length, 'of', items.length)
console.log(differ.join('\n'))
console.log('snake_case_name on 2.2.3 →', JSON.stringify(canonBridge('snake_case_name и @sintetika_example')))
