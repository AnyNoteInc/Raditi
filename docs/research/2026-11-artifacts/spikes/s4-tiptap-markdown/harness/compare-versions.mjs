import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { canonPlan } from './lib/canon.mjs'
import { lineDiff, show } from './lib/compare.mjs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const old = JSON.parse(readFileSync('results/canon-2.1.2.json', 'utf8'))
let docs = 0, lines = 0
const examples = []
for (const f of readdirSync('corpus').filter((f) => f.endsWith('.md')).sort()) {
  const now = canonPlan(decode(readFileSync('corpus/' + f, 'utf8')))
  if (now !== old[f]) {
    docs += 1
    const d = lineDiff(old[f], now, 1e9)
    lines += d.filter((l) => l.startsWith('+')).length
    examples.push(f + '\n' + d.slice(0, 6).map(show).join('\n'))
  }
}
console.log(`документов с другим каноном: ${docs} из 30; строк: ${lines}`)
console.log(examples.join('\n'))
