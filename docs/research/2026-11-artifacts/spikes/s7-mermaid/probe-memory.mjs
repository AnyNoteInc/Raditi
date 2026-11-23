// Spike 7 of plan 88: does a reused Mermaid page grow without bound? Renders the whole corpus many times
// in one page (as measure.mjs does in its warm phase) and every few rounds records the RSS of each
// Chromium process (by --type), the page's JS heap and DOM counters, before and after a forced garbage
// collection (CDP HeapProfiler.collectGarbage). At the end the page is closed and a new one opened.
//   node probe-memory.mjs [--rounds=100] [--every=10] [--out=out/probe-memory.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'

const pexec = promisify(execFile)
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
const ROUNDS = Number(args.rounds ?? 100)
const EVERY = Number(args.every ?? 10)
const OUT = args.out || 'out/probe-memory.json'
const here = new URL('./', import.meta.url).pathname
const uptime = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).trim() } catch { return os.loadavg().join(' ') } }
const mib = (b) => Math.round(b / 2 ** 20 * 10) / 10
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
// Inside a container (cgroup v2): memory of the whole container, shared pages counted once (MiB).
const cgroup = () => {
  try {
    const out = Object.fromEntries(['current', 'peak'].map((k) => [k, mib(Number(readFileSync(`/sys/fs/cgroup/memory.${k}`, 'utf8')))]))
    const stat = Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').trim().split('\n').map((l) => l.split(' ')))
    for (const k of ['anon', 'file', 'shmem', 'kernel']) if (stat[k] != null) out[k] = mib(Number(stat[k]))
    return out
  } catch { return null }
}

/** RSS of every descendant of this Node process, grouped by Chromium process type (MiB). */
async function rssByType() {
  const { stdout } = await pexec('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='])
  const rows = stdout.trim().split('\n').map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], kb: +m[3], args: m[4] } }).filter(Boolean)
  const kids = new Map()
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r) }
  const out = { total: 0 }
  const walk = (pid) => {
    for (const r of kids.get(pid) || []) {
      const t = (r.args.match(/--type=([a-z-]+)/) || [])[1]
      const key = t === 'utility' ? `utility:${(r.args.match(/--utility-sub-type=([\w.]+)/) || [])[1] || '?'}` : t || 'browser'
      if (/chrom|headless/i.test(r.args)) { out[key] = (out[key] || 0) + r.kb * 1024; out.total += r.kb * 1024 }
      walk(r.pid)
    }
  }
  walk(process.pid)
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, mib(v)]))
}

async function pageMetrics(session) {
  const { metrics } = await session.send('Performance.getMetrics')
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { heapMiB: mib(m.JSHeapUsedSize), heapTotalMiB: mib(m.JSHeapTotalSize), nodes: m.Nodes, documents: m.Documents, listeners: m.JSEventListeners }
}

const started = uptime()
console.error('[probe-memory] start', started, `rounds=${ROUNDS}`)
const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const browser = await chromium.launch()
const idle = await rssByType()
const page = new MermaidPage(browser, { mermaidJs })
await page.open()
const session = await page.page.context().newCDPSession(page.page)
await session.send('Performance.enable')
await session.send('HeapProfiler.enable')

async function sample(round, renders, times) {
  const before = { rss: await rssByType(), page: await pageMetrics(session), cgroup: cgroup() }
  await session.send('HeapProfiler.collectGarbage')
  await new Promise((r) => setTimeout(r, 300))
  const after = { rss: await rssByType(), page: await pageMetrics(session), cgroup: cgroup() }
  const row = { round, renders, renderMedianMs: times.length ? Math.round(median(times) * 10) / 10 : null, before, after }
  console.error('[probe-memory]', `round ${round}`, `renders ${renders}`, `rss ${before.rss.total} → ${after.rss.total} MiB`, `renderer ${before.rss.renderer} → ${after.rss.renderer}`, `heap ${before.page.heapMiB} → ${after.page.heapMiB}`, `nodes ${before.page.nodes} → ${after.page.nodes}`, `median ${row.renderMedianMs} ms`, before.cgroup ? `cgroup ${before.cgroup.current} → ${after.cgroup.current} MiB (anon ${after.cgroup.anon}, file ${after.cgroup.file}, shmem ${after.cgroup.shmem}, peak ${after.cgroup.peak})` : '')
  return row
}

const samples = [await sample(0, 0, [])]
let renders = 0
let times = []
for (let round = 1; round <= ROUNDS; round++) {
  for (const d of corpus) {
    const r = await page.render(d.source, { htmlLabels: false, seed: `${d.id}r${round}`, secure: LOCKED_SECURE }, 20000)
    renders++
    if (r.svg) times.push(r.ms)
  }
  if (round % EVERY === 0) { samples.push(await sample(round, renders, times)); times = [] }
}
await session.detach().catch(() => {})
await page.close()
const afterClose = { ...(await rssByType()), cgroup: cgroup() }
const page2 = new MermaidPage(browser, { mermaidJs })
await page2.open()
const afterReopen = { ...(await rssByType()), cgroup: cgroup() }
await page2.close()
await browser.close()
const finished = uptime()
const result = { started, finished, rounds: ROUNDS, rendersPerRound: corpus.length, idle, samples, afterClose, afterReopen, machine: `${os.platform()} ${os.arch()} node ${process.version}` }
writeFileSync(new URL(OUT, `file://${here}`), JSON.stringify(result, null, 1))
console.log(JSON.stringify({ idle, first: samples[0], last: samples.at(-1), afterClose, afterReopen, started, finished }, null, 1))
