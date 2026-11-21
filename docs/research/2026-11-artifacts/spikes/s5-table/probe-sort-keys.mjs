// Sort of N price strings: the key parsed in every comparison (as the prototype does) against
// keys computed once per row, as numbers and as BigInt. Node's V8, laptop CPU, no throttling.
//
//   node probe-sort-keys.mjs   (no browser, no build)
const kopecks = (price) => {
  if (price === '') return null
  const [rubles = '0', fraction = '00'] = price.split('.')
  return BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}
let seed = 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const prices = (n) => Array.from({ length: n }, () => {
  const r = Math.floor(30 + rnd() * 25000)
  const k = rnd() < 0.5 ? '00' : String(Math.floor(rnd() * 100)).padStart(2, '0')
  return rnd() < 0.02 ? '' : `${r}.${k}`
})
const time = (fn, reps = 7) => {
  const t = []
  for (let i = 0; i < reps; i++) { const s = performance.now(); fn(); t.push(performance.now() - s) }
  t.sort((a, b) => a - b)
  return t[Math.floor(t.length / 2)]
}
for (const n of [5000, 20000]) {
  const ps = prices(n)
  const perCompare = () => [...ps.keys()].sort((i, j) => {
    const x = kopecks(ps[i]), y = kopecks(ps[j])
    if (x === y) return 0
    if (x === null) return 1
    if (y === null) return -1
    return x < y ? -1 : 1
  })
  const once = () => {
    const keys = ps.map((p) => { const k = kopecks(p); return k === null ? Number.POSITIVE_INFINITY : Number(k) })
    return [...ps.keys()].sort((i, j) => keys[i] - keys[j] || i - j)
  }
  // The same keys kept as BigInt kopecks (money stays exact; only the parse moves out of the loop).
  const onceBigInt = () => {
    const keys = ps.map(kopecks)
    return [...ps.keys()].sort((i, j) => {
      const x = keys[i], y = keys[j]
      if (x === y) return i - j
      if (x === null) return 1
      if (y === null) return -1
      return x < y ? -1 : 1
    })
  }
  const a = perCompare(), b = once(), c = onceBigInt()
  const same = a.every((v, k) => ps[v] === ps[b[k]] && ps[v] === ps[c[k]])
  console.log(`${n}: per comparison ${time(perCompare).toFixed(1)} ms, keys once (number) ${time(once).toFixed(1)} ms, keys once (BigInt) ${time(onceBigInt).toFixed(1)} ms, same order: ${same}`)
}
