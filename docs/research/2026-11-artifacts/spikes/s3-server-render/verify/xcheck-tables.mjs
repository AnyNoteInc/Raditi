// Cross-check README §5 table cells against the raw results.json of the two full runs.
// node xcheck-tables.mjs <results1.json> <results2.json>
import { readFileSync } from 'node:fs'
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')))
const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((p, q) => p - q); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
const pct = (xs, q) => { const v = xs.filter((x) => typeof x === 'number').sort((p, q2) => p - q2); return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null }
const steady = (recs) => { const last = Math.max(...recs.map((r) => r.iteration)); return recs.filter((r) => last < 2 || r.iteration > 1) }
function warmRow(res, frame, width) {
  const recs = steady(res.warm.records).filter((r) => r.frame === frame && r.width === width)
  const m = (f) => median(recs.map(f))
  return { n: recs.length, load: m((r) => r.t.load), settle: m((r) => r.t.settle), scroll: m((r) => r.t.scroll), map: m((r) => r.t.map), png: m((r) => r.t.png), pngKiB: m((r) => r.sizes.png && Math.round(r.sizes.png / 1024)), pdf: m((r) => r.t.pdf), pdfKiB: m((r) => r.sizes.pdf && Math.round(r.sizes.pdf / 1024)), pages: m((r) => r.sizes.pdfPages), total: m((r) => r.t.total), docH: m((r) => r.docH), memMb: m((r) => r.memory && r.memory.mb), cg: m((r) => r.memory && r.memory.cgroup) }
}
for (const [label, res] of [['run1', a], ['run2', b]]) {
  console.log('==', label, res.meta.chromium, res.meta.node, JSON.stringify(res.meta.versions), res.meta.started, res.meta.ended)
  for (const [f, w] of [['01-bakery-landing', 1440], ['08-about-team', 390], ['10-one-page-site', 1440], ['10-one-page-site', 390]]) {
    console.log('host warm', f, w, JSON.stringify(warmRow(res.host, f, w)))
    for (const d of res.docker) console.log(`docker ${d.config.cpus}cpu warm`, f, w, JSON.stringify(warmRow(d.result, f, w)))
  }
  // whole-run summaries
  const all = (r) => steady(r.warm.records).map((x) => x.t.total)
  console.log('host warm p50/p95/min/max', median(all(res.host)), pct(all(res.host), 0.95), Math.min(...all(res.host)), Math.max(...all(res.host)), 'n', all(res.host).length)
  for (const d of res.docker) { const xs = all(d.result); console.log(`docker ${d.config.cpus}cpu warm p50/p95/min/max`, median(xs), pct(xs, 0.95), Math.min(...xs), Math.max(...xs), 'n', xs.length) }
  // memory ranges in docker warm
  for (const d of res.docker) { const recs = steady(d.result.warm.records); console.log(`docker ${d.config.cpus}cpu PSS range`, Math.min(...recs.map((r) => r.memory.mb)), Math.max(...recs.map((r) => r.memory.mb)), 'cgroup', Math.min(...recs.map((r) => r.memory.cgroup)), Math.max(...recs.map((r) => r.memory.cgroup))) }
  // layout medians of parallel
  const lay = (r) => { const by = {}; for (const x of r.layout.records) (by[x.frame] ||= []).push(x.parallelMs); return Object.fromEntries(Object.entries(by).map(([k, v]) => [k.slice(0, 2), median(v)])) }
  console.log('host layout parallel medians', JSON.stringify(lay(res.host)), 'median of frames', median(Object.values(lay(res.host))))
  for (const d of res.docker) console.log(`docker ${d.config.cpus}cpu layout`, JSON.stringify(lay(d.result)), 'median of frames', median(Object.values(lay(d.result))))
  // concurrency
  for (const c of res.host.concurrency) console.log('host conc', c.k, c.perSecond, c.p50, c.p95, c.memory.mb, c.errors.length)
  for (const d of res.docker) for (const c of d.result.concurrency) console.log(`docker ${d.config.cpus}cpu conc`, c.k, c.perSecond, c.p50, c.p95, c.memory.mb, c.memory.cgroup, c.errors.length)
  // cold
  const cold = res.host.cold.records
  console.log('host cold p50', median(cold.map((r) => r.wallMs)), 'launch', Math.min(...cold.map((r) => r.launchMs)), Math.max(...cold.map((r) => r.launchMs)))
  for (const d of res.docker) { const c = d.result.cold.records; console.log(`docker ${d.config.cpus}cpu cold p50`, median(c.map((r) => r.wallMs)), 'launch', Math.min(...c.map((r) => r.launchMs)), Math.max(...c.map((r) => r.launchMs))) }
  // errors anywhere
  const errs = [...res.host.warm.records, ...res.host.cold.records].filter((r) => r.error)
  console.log('host errors', errs.length, errs.slice(0, 3).map((r) => r.error))
  for (const d of res.docker) { const e = [...d.result.warm.records, ...d.result.cold.records].filter((r) => r.error); console.log(`docker ${d.config.cpus}cpu errors`, e.length) }
}
