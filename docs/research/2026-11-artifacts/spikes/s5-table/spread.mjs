// Spread of each measured value across the iterations of one or more measure.mjs runs.
// Prints, per profile and row count, the median, min and max of every value and the spread
// (max − min) / median, and marks values whose spread is over the threshold.
//
//   node spread.mjs results.json [results-2.json] [--threshold=20] [--min-ms=5]
//
// Values below --min-ms (median) are reported but not marked: a 0.6 ms sort that moves by 0.3 ms
// is timer noise, not a change of the answer.
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const files = argv.filter((a) => !a.startsWith('--'))
const threshold = Number(flag('threshold') ?? 20)
const minMs = Number(flag('min-ms') ?? 5)

const VALUES = {
  renderToPaintMs: (r) => r.renderToPaintMs,
  pageToTableMs: (r) => r.pageToTableMs,
  scrollP95: (r) => r.scroll?.p95,
  scrollMax: (r) => r.scroll?.max,
  droppedPct: (r) => r.scroll?.droppedPct,
  remoteP95: (r) => r.scrollRemote?.p95,
  remoteDroppedPct: (r) => r.scrollRemote?.droppedPct,
  jumpP95: (r) => r.jumps?.p95,
  jumpMax: (r) => r.jumps?.max,
  heapMB: (r) => r.idle?.heapUsedMB,
  heapAfterMB: (r) => r.afterInteractions?.heapUsedMB,
  domElements: (r) => r.domElements,
  editStart: (r) => r.interactions?.editStart ?? r.interactions?.sheetOpen,
  editCommit: (r) => r.interactions?.editCommit ?? r.interactions?.sheetSave,
  move: (r) => r.interactions?.move ?? r.interactions?.toggle,
  sort: (r) => r.interactions?.sort,
  sortNameViewMs: (r) => r.interactions?.sortNameViewMs,
  sortPriceViewMs: (r) => r.interactions?.sortPriceViewMs,
  filter: (r) => r.interactions?.filter,
  filterViewMs: (r) => r.interactions?.filterViewMs,
  paste300: (r) => r.interactions?.paste300,
  totalsMs: (r) => r.totalsMs,
  xlsxMs: (r) => r.xlsxMs,
  eventMaxMs: (r) => r.eventTiming?.maxMs,
}
// Values that are counts or percentages, not milliseconds: marked whatever their size.
const NOT_MS = new Set(['droppedPct', 'remoteDroppedPct', 'heapMB', 'heapAfterMB', 'domElements'])

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const r1 = (x) => Math.round(x * 10) / 10

const medians = []
for (const file of files) {
  const { meta, runs } = JSON.parse(readFileSync(file, 'utf8'))
  const byKey = new Map()
  medians.push(byKey)
  console.log(`\n# ${file}: ${meta.startedAt} → ${meta.finishedAt}`)
  console.log(`  ${meta.uptimeBefore}\n  ${meta.uptimeAfter}`)
  const errors = runs.filter((r) => r.error)
  if (errors.length) console.log(`  errors: ${errors.map((r) => `${r.profile} ${r.rows} #${r.iteration + 1}: ${r.error}`).join('; ')}`)
  const keys = [...new Set(runs.filter((r) => r.rows > 0).map((r) => `${r.profile}|${r.rows}`))]
  const flagged = []
  for (const key of keys) {
    const [profile, rows] = key.split('|')
    const rs = runs.filter((r) => r.profile === profile && String(r.rows) === rows && !r.error)
    const lines = []
    for (const [name, get] of Object.entries(VALUES)) {
      const xs = rs.map(get).filter((x) => typeof x === 'number' && Number.isFinite(x))
      if (xs.length < 2) continue
      const med = median(xs)
      const lo = Math.min(...xs)
      const hi = Math.max(...xs)
      const spread = med === 0 ? (hi === lo ? 0 : Infinity) : (100 * (hi - lo)) / Math.abs(med)
      byKey.set(`${profile} ${rows} ${name}`, med)
      const counts = NOT_MS.has(name) || med >= minMs
      const over = counts && spread > threshold
      if (over) flagged.push(`${profile} ${rows} ${name}`)
      lines.push(`    ${over ? '!' : ' '} ${name.padEnd(17)} median ${String(r1(med)).padStart(8)}  min ${String(r1(lo)).padStart(8)}  max ${String(r1(hi)).padStart(8)}  spread ${spread === Infinity ? '∞' : `${Math.round(spread)} %`}  [${xs.map(r1).join(', ')}]`)
    }
    console.log(`\n  ${profile} ${rows} (${rs.length} runs)`)
    console.log(lines.join('\n'))
  }
  console.log(`\n  over ${threshold} % (median ≥ ${minMs} ms, or a count): ${flagged.length ? flagged.join('; ') : 'none'}`)
}

// Two runs: how far apart their medians are.
if (medians.length === 2) {
  const [a, b] = medians
  const rows = []
  for (const [key, x] of a) {
    const y = b.get(key)
    if (y === undefined) continue
    const name = key.split(' ').at(-1)
    const diff = x === 0 ? (y === 0 ? 0 : Infinity) : (100 * (y - x)) / Math.abs(x)
    const counts = NOT_MS.has(name) || Math.max(x, y) >= minMs
    rows.push({ key, x, y, diff, over: counts && Math.abs(diff) > threshold })
  }
  console.log(`\n# medians, ${files[0]} → ${files[1]}`)
  for (const r of rows) {
    console.log(`  ${r.over ? '!' : ' '} ${r.key.padEnd(34)} ${String(r1(r.x)).padStart(8)} → ${String(r1(r.y)).padStart(8)}  ${r.diff === Infinity ? '∞' : `${r.diff >= 0 ? '+' : ''}${Math.round(r.diff)} %`}`)
  }
  const counted = rows.filter((r) => NOT_MS.has(r.key.split(' ').at(-1)) || Math.max(r.x, r.y) >= minMs)
  const worst = counted.reduce((w, r) => (Math.abs(r.diff) > Math.abs(w.diff) ? r : w), { diff: 0 })
  console.log(`\n  largest difference (median ≥ ${minMs} ms, or a count): ${worst.key ?? '—'} ${worst.key ? `${Math.round(worst.diff)} %` : ''}`)
  console.log(`  over ${threshold} %: ${rows.filter((r) => r.over).map((r) => r.key).join('; ') || 'none'}`)
}
