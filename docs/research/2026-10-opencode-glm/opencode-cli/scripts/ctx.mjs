// Prints contexts of a pattern inside the CLI binary: node ctx.mjs <regex> [before] [after] [max]
import { readFileSync } from 'node:fs'
const B = '/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-arm64/bin/opencode'
const [pattern, before = '200', after = '400', max = '6'] = process.argv.slice(2)
const text = readFileSync(B, 'latin1')
const re = new RegExp(pattern, 'g')
let m,
  n = 0,
  last = -1e9
while ((m = re.exec(text)) && n < Number(max)) {
  if (m.index - last < Number(after)) continue
  last = m.index
  n += 1
  const s = text
    .slice(Math.max(0, m.index - Number(before)), m.index + Number(after))
    .replace(/[^\x20-\x7e\n]/g, '.')
  console.log(`--- @${m.index}\n${s}`)
}
console.log(`(${n} shown)`)
