// Spike s3 (plan 88): the numbers of the report from one or more full runs of measure.mjs.
//   node summarize.mjs results.json [other-results.json …]
// For every run: ranges of the warm render and its steps, sizes, cold start, artifact_layout,
// parallel renders, memory, and how much the passes of the same render differ.
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) { console.error('usage: node summarize.mjs results.json [more.json]'); process.exit(2) }

const num = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
const median = (xs) => { const v = num(xs); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
const pct = (xs, q) => { const v = num(xs); return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null }
const min = (xs) => { const v = num(xs); return v.length ? v[0] : null }
const max = (xs) => { const v = num(xs); return v.length ? v[v.length - 1] : null }
const r0 = (x) => (x === null ? '—' : Math.round(x))
const kib = (b) => (b === null ? '—' : Math.round(b / 1024))
const range = (xs, f = r0) => `${f(min(xs))}–${f(max(xs))}`
const WIDTHS = [1440, 390]

/** The passes after the first, when there are two or more. */
const steady = (records) => { const last = Math.max(...records.map((r) => r.iteration)); return records.filter((r) => last < 2 || r.iteration > 1) }
const keyOf = (r) => `${r.frame}@${r.width}`

/** Median of each frame-width over the steady passes. */
function perFrameWidth(records, f) {
  const out = new Map()
  for (const r of steady(records)) { const k = keyOf(r); if (!out.has(k)) out.set(k, []); out.get(k).push(f(r)) }
  return [...out.entries()].map(([k, v]) => [k, median(v)])
}

/** Spread of the same render over passes: (max − min) / median, per frame-width. */
function spread(records, f, passes) {
  const groups = new Map()
  for (const r of records.filter((x) => passes.includes(x.iteration))) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f(r)) }
  const s = [...groups.entries()].filter(([, v]) => v.length >= 2).map(([k, v]) => [k, (max(v) - min(v)) / median(v)])
  return { median: median(s.map((x) => x[1])), max: max(s.map((x) => x[1])), worst: s.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`) }
}

function warm(where, w) {
  const rs = steady(w.records)
  const lines = [`## ${where}: warm (${rs.length} steady renders of ${w.records.length}; launch ${w.launchMs} ms; idle ${w.idleMb} MB)`]
  const totals = rs.map((r) => r.t.total)
  lines.push(`total ms: min ${r0(min(totals))}, p50 ${r0(median(totals))}, p95 ${r0(pct(totals, 0.95))}, max ${r0(max(totals))}`)
  const fw = (f) => perFrameWidth(w.records, f).map((x) => x[1])
  lines.push(`per frame-width medians — total ${range(fw((r) => r.t.total))}, p50 ${r0(median(fw((r) => r.t.total)))}`)
  for (const step of ['context', 'load', 'settle', 'scroll', 'freeze', 'map', 'png', 'thumb', 'thumbTop', 'thumbWebp', 'strips', 'pdf', 'close']) {
    const v = fw((r) => r.t[step])
    lines.push(`  ${step}: ${range(v, (x) => (x === null ? '—' : x < 20 ? Math.round(x * 10) / 10 : Math.round(x)))} (p50 ${r0(median(v))})`)
  }
  const settleNo08 = perFrameWidth(w.records.filter((r) => r.frame !== '08-about-team'), (r) => r.t.settle).map((x) => x[1])
  lines.push(`  settle without frame 08: ${range(settleNo08)}; frame 08: ${perFrameWidth(w.records.filter((r) => r.frame === '08-about-team'), (r) => r.t.settle).map((x) => `${x[0]} ${r0(x[1])}`).join(', ')}`)
  const sz = (f) => perFrameWidth(w.records, f).map((x) => x[1])
  lines.push(`sizes KiB — png ${range(sz((r) => r.sizes.png), kib)}, pdf ${range(sz((r) => r.sizes.pdf), kib)} (${range(sz((r) => r.sizes.pdfPages))} pages), thumb ${range(sz((r) => r.sizes.thumb), kib)}, top ${range(sz((r) => r.sizes.thumbTop), kib)}, webp ${range(sz((r) => r.sizes.thumbWebp), kib)}, strips ${range(sz((r) => r.sizes.strips), kib)}, map ${range(sz((r) => r.sizes.map), (b) => (b === null ? '—' : Math.round(b / 102.4) / 10))}`)
  lines.push(`elements ${range(sz((r) => r.elements))}; height ${range(sz((r) => r.docH))} px; errors ${rs.filter((r) => r.error).length}; not settled ${rs.filter((r) => r.settled === false).map(keyOf).join(', ') || 'none'}`)
  const mem = rs.map((r) => r.memory.mb)
  const cg = rs.map((r) => r.memory.cgroup)
  lines.push(`peak memory MB: ${range(mem)} (p50 ${r0(median(mem))})${cg.some((x) => x !== null) ? `; cgroup MiB ${range(cg)} (p50 ${r0(median(cg))})` : ''}`)
  const passes = [...new Set(w.records.map((r) => r.iteration))].sort()
  if (passes.length >= 2) {
    const later = passes.filter((p) => p > 1)
    const s = later.length >= 2 ? spread(w.records, (r) => r.t.total, later) : null
    const s1 = spread(w.records, (r) => r.t.total, passes)
    const firstVsRest = median(perFrameWidth(w.records, (r) => r.t.total).map(([k, v]) => { const p1 = w.records.find((r) => keyOf(r) === k && r.iteration === 1); return p1 ? p1.t.total / v : null }))
    lines.push(`pass spread of total: ${s ? `passes ${later.join(',')} — median ${Math.round(s.median * 100)}%, max ${Math.round(s.max * 100)}% (${s.worst.join('; ')}); ` : ''}all passes — median ${Math.round(s1.median * 100)}%, max ${Math.round(s1.max * 100)}%; pass 1 / steady median ×${Math.round(firstVsRest * 100) / 100}`)
    const passMedians = passes.map((p) => `pass ${p} p50 ${r0(median(w.records.filter((r) => r.iteration === p).map((r) => r.t.total)))}`)
    lines.push(`  ${passMedians.join(', ')}`)
  }
  return lines
}

function cold(where, c) {
  const rs = c.records
  return [`## ${where}: cold (${rs.length} renders)`,
    `launch ms ${range(rs.map((r) => r.launchMs))} (p50 ${r0(median(rs.map((r) => r.launchMs)))}); render ms p50 ${r0(median(rs.map((r) => r.t.total)))}; close ms p50 ${r0(median(rs.map((r) => r.closeMs)))}; wall ms p50 ${r0(median(rs.map((r) => r.wallMs)))}, p95 ${r0(pct(rs.map((r) => r.wallMs), 0.95))}, max ${r0(max(rs.map((r) => r.wallMs)))}`,
    `peak MB ${range(rs.map((r) => r.memory.mb))} (p50 ${r0(median(rs.map((r) => r.memory.mb)))}); errors ${rs.filter((r) => r.error).length}`]
}

function layout(where, l) {
  const frames = [...new Set(l.records.map((r) => r.frame))]
  const lines = [`## ${where}: artifact_layout (${l.records.length} records)`, '| Frame | Sequential ms p50 (min–max) | Parallel ms p50 (min–max) | Peak MB | cgroup MiB | Chars | Problems |', '| --- | --- | --- | --- | --- | --- | --- |']
  const parAll = []
  const seqAll = []
  for (const f of frames) {
    const rs = l.records.filter((r) => r.frame === f)
    parAll.push(median(rs.map((r) => r.parallelMs))); seqAll.push(median(rs.map((r) => r.sequentialMs)))
    lines.push(`| ${f} | ${r0(median(rs.map((r) => r.sequentialMs)))} (${range(rs.map((r) => r.sequentialMs))}) | ${r0(median(rs.map((r) => r.parallelMs)))} (${range(rs.map((r) => r.parallelMs))}) | ${r0(max(rs.map((r) => r.parMemory.mb)))} | ${rs[0].parMemory.cgroup === null ? '—' : r0(max(rs.map((r) => r.parMemory.cgroup)))} | ${rs[0].reportChars} | ${rs[0].problems} |`)
  }
  const all = l.records
  lines.push(`parallel: frame medians ${range(parAll)}, p50 ${r0(median(parAll))}, all records p95 ${r0(pct(all.map((r) => r.parallelMs), 0.95))}, max ${r0(max(all.map((r) => r.parallelMs)))}; sequential: frame medians ${range(seqAll)}, p50 ${r0(median(seqAll))}; parallel errors ${all.reduce((s, r) => s + r.parallelErrors, 0)}`)
  const s = (() => { const g = frames.map((f) => { const v = all.filter((r) => r.frame === f).map((r) => r.parallelMs); return (max(v) - min(v)) / median(v) }); return { median: median(g), max: max(g) } })()
  lines.push(`spread of parallel over passes: median ${Math.round(s.median * 100)}%, max ${Math.round(s.max * 100)}%`)
  return lines
}

function concurrency(where, cs) {
  return [`## ${where}: parallel renders, all outputs`, '| K | Renders | Wall ms | Renders/s | p50 ms | p95 ms | Peak MB | cgroup MiB | Errors |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...cs.map((c) => `| ${c.k} | ${c.renders} | ${c.wallMs} | ${c.perSecond} | ${r0(c.p50)} | ${r0(c.p95)} | ${c.memory.mb} | ${c.memory.cgroup ?? '—'} | ${c.errors.length} |`)]
}

for (const file of files) {
  const res = JSON.parse(readFileSync(file, 'utf8'))
  const out = [`# ${file}`, `label ${res.meta.label}; Chromium ${res.meta.chromium}; Node ${res.meta.node}; iterations ${res.meta.iterations}`, `started ${res.meta.started.at} — ${res.meta.started.uptime}`, `ended   ${res.meta.ended.at} — ${res.meta.ended.uptime}`]
  out.push(...warm('host', res.host.warm), ...cold('host', res.host.cold), ...layout('host', res.host.layout), ...concurrency('host', res.host.concurrency))
  for (const d of res.docker || []) {
    const where = `docker ${d.config.cpus} CPU ${d.config.memoryMiB} MiB`
    if (!d.result) { out.push(`## ${where}: no result (exit ${d.code})`); continue }
    out.push(`## ${where}: exit ${d.code}; VM load at start ${d.result.started.load.join(' ')}, at end ${d.result.ended.load.join(' ')}; container cgroup peak ${d.result.cgroupPeakMiB} MiB; Node ${d.result.node}; ${d.result.started.at} → ${d.result.ended.at}`)
    out.push(...warm(where, d.result.warm), ...cold(where, d.result.cold), ...layout(where, d.result.layout), ...concurrency(where, d.result.concurrency))
  }
  console.log(out.join('\n') + '\n')
}

// Two runs: how far the medians of the same render moved between them.
if (files.length >= 2) {
  const [a, b] = files.slice(0, 2).map((f) => JSON.parse(readFileSync(f, 'utf8')))
  const cmp = (wa, wb, where) => {
    const ma = new Map(perFrameWidth(wa.records, (r) => r.t.total))
    const mb = new Map(perFrameWidth(wb.records, (r) => r.t.total))
    const d = [...ma.keys()].filter((k) => mb.has(k)).map((k) => [k, (mb.get(k) - ma.get(k)) / ma.get(k)])
    const abs = d.map((x) => Math.abs(x[1]))
    return `${where}: run 2 vs run 1, warm total per frame-width — median |Δ| ${Math.round(median(abs) * 100)}%, max |Δ| ${Math.round(max(abs) * 100)}% (${d.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${Math.round(v * 100)}%`).join('; ')}); p50 ${r0(median(steady(wa.records).map((r) => r.t.total)))} → ${r0(median(steady(wb.records).map((r) => r.t.total)))}`
  }
  const lines = ['# Run 2 against run 1', cmp(a.host.warm, b.host.warm, 'host')]
  for (let i = 0; i < Math.min(a.docker.length, b.docker.length); i++) if (a.docker[i].result && b.docker[i].result) lines.push(cmp(a.docker[i].result.warm, b.docker[i].result.warm, `docker ${a.docker[i].config.cpus} CPU`))
  const lay = (x) => median([...new Set(x.records.map((r) => r.frame))].map((f) => median(x.records.filter((r) => r.frame === f).map((r) => r.parallelMs))))
  lines.push(`artifact_layout parallel p50 of frame medians: host ${lay(a.host.layout)} → ${lay(b.host.layout)}${a.docker.map((d, i) => (d.result && b.docker[i] && b.docker[i].result ? `; docker ${d.config.cpus} CPU ${lay(d.result.layout)} → ${lay(b.docker[i].result.layout)}` : '')).join('')}`)
  console.log(lines.join('\n'))
}
