// The skeptic's own sort probe (not the spike's probe-sort-keys.mjs): 5 000 and 20 000 prices of
// the corpus, sorted with a key parsed in every comparison (as src/table/view.ts does) against
// keys computed once. Only the ratio matters: the machine is shared and loaded.
import { makeRows } from '../rebuild/src/data.ts'

const kop = (p) => {
  if (p === '') return null
  const [r = '0', f = '00'] = p.split('.')
  return BigInt(r) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2))
}
const cmpKeys = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const n of [5000, 20000]) {
  const prices = makeRows(n, 1).map((r) => r.price)
  const ids = prices.map((_, i) => i)
  const each = []
  const once = []
  let a, b
  for (let k = 0; k < 7; k++) {
    let t = performance.now()
    a = [...ids].sort((i, j) => cmpKeys(kop(prices[i]), kop(prices[j])) || i - j)
    each.push(performance.now() - t)
    t = performance.now()
    const keys = prices.map(kop)
    b = [...ids].sort((i, j) => cmpKeys(keys[i], keys[j]) || i - j)
    once.push(performance.now() - t)
  }
  const same = a.every((v, i) => v === b[i])
  console.log(`${n}: key in every comparison ${median(each).toFixed(1)} ms, keys once ${median(once).toFixed(1)} ms, ×${(median(each) / median(once)).toFixed(1)}, same order ${same}`)
}
