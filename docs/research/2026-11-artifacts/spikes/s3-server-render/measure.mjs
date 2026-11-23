// The measurement of spike s3 (plan 88): time and memory of the server render of ten typical
// frames at 1440 and 390 — warm (one browser, a context per render), cold (a browser per render),
// the artifact_layout fast path, parallel renders, and the same inside Docker
// (mcr.microsoft.com/playwright:v1.63.0-noble, --network none, the session container's limits).
//   node measure.mjs            — the full run (about 15 minutes on a quiet machine)
//   node measure.mjs --smoke    — one short pass of every phase, to prove the script works
//   flags: --no-docker, --iterations N, --label <text>
// Writes results.json (and results-smoke.json for --smoke) and prints Markdown tables.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { assembleFrame, ensureAssets, listFixtures, ROOT } from './lib/frames.mjs'
import { launch, renderFrame, LIMITS, THRESHOLDS } from './lib/render.mjs'
import { layoutReport } from './lib/report.mjs'
import { MemorySampler, memoryKind } from './lib/memory.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const SMOKE = flag('--smoke')
const INSIDE = flag('--inside-docker')
const IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
const WIDTHS = [1440, 390]
const FULL = { png: true, pdf: true, thumb: true, thumbWebp: true, strips: true }
const ITER = Number(value('--iterations', SMOKE ? 1 : INSIDE ? 2 : 3))
const frames = listFixtures('typical')
const loadOf = () => os.loadavg().map((v) => Math.round(v * 100) / 100)
const uptime = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).trim() } catch { return null } }
const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
const pct = (xs, q) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null }
const log = (...m) => process.stderr.write(`[${INSIDE ? 'docker' : 'host'} ${new Date().toISOString().slice(11, 19)}] ${m.join(' ')}\n`)

/** One render with the memory of the tree around it. */
async function measured(sampler, browser, frame, width, opts) {
  const from = performance.now()
  const r = await renderFrame(browser, frame, { width, assets: opts.assets, outputs: opts.outputs ?? FULL, scrollPass: true })
  const memory = sampler.peak(from)
  return {
    frame: frame.name, width, error: r.error || null, hung: r.hung, settled: r.settle ? r.settle.settled : null,
    docH: r.map ? r.map.doc.docH : null, elements: r.map ? r.map.doc.elements : null, issues: r.map ? r.map.issues.length : null,
    t: r.t, sizes: r.sizes, memory, map: r.map, events: { pageErrors: r.events.pageErrors.length, csp: r.events.csp.length }, settle: r.settle, pixels: r.pixels,
  }
}
const strip = (rec) => { const { map, pixels, ...rest } = rec; return rest }

async function phaseWarm(assets, sampler, iterations) {
  const { browser, server, pid, launchMs } = await launch(chromium)
  sampler.watch(pid)
  await new Promise((r) => setTimeout(r, 400))
  const idle = sampler.peak(performance.now() - 300)
  const records = []
  for (let it = 1; it <= iterations; it++) {
    for (const name of (SMOKE && INSIDE ? frames.slice(0, 2) : frames)) {
      const frame = assembleFrame(name, { assets })
      for (const width of WIDTHS) {
        const rec = await measured(sampler, browser, frame, width, { assets })
        records.push({ ...strip(rec), iteration: it })
      }
    }
    log('warm iteration', it, 'done')
  }
  await browser.close(); await server.close()
  sampler.unwatch(pid)
  return { launchMs, idleMb: idle.mb, records }
}

async function phaseCold(assets, sampler, iterations) {
  const records = []
  const list = SMOKE ? frames.slice(0, INSIDE ? 1 : 2) : frames
  for (let it = 1; it <= iterations; it++) {
    for (const name of list) {
      const frame = assembleFrame(name, { assets })
      for (const width of WIDTHS) {
        const from = performance.now()
        const { browser, server, pid, launchMs } = await launch(chromium)
        sampler.watch(pid)
        const rec = await measured(sampler, browser, frame, width, { assets })
        const closing = performance.now()
        await browser.close(); await server.close()
        const closeMs = Math.round(performance.now() - closing)
        const memory = sampler.peak(from)
        sampler.unwatch(pid)
        records.push({ ...strip(rec), iteration: it, launchMs, closeMs, wallMs: Math.round(performance.now() - from), memory })
      }
    }
    log('cold iteration', it, 'done')
  }
  return { records }
}

/** artifact_layout: the map of both widths, no pictures; one after the other and side by side. */
async function phaseLayout(assets, sampler, iterations) {
  const { browser, server, pid } = await launch(chromium)
  sampler.watch(pid)
  const titles = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'manifest.json'), 'utf8')).frames
  const records = []
  const list = SMOKE ? frames.slice(0, INSIDE ? 1 : 3) : frames
  for (let it = 1; it <= iterations; it++) {
    for (const name of list) {
      const frame = assembleFrame(name, { assets })
      let from = performance.now()
      const seq = {}
      for (const width of WIDTHS) seq[width] = await renderFrame(browser, frame, { width, assets, outputs: {} })
      const sequentialMs = Math.round(performance.now() - from)
      const seqMemory = sampler.peak(from)
      from = performance.now()
      const both = await Promise.all(WIDTHS.map((width) => renderFrame(browser, frame, { width, assets, outputs: {} })))
      const parallelMs = Math.round(performance.now() - from)
      const parMemory = sampler.peak(from)
      const report = layoutReport({ name, title: titles[name].title, byWidth: seq })
      records.push({ frame: name, iteration: it, sequentialMs, parallelMs, seqMemory, parMemory, perWidth: WIDTHS.map((w) => seq[w].t.total), parallelErrors: both.filter((r) => r.error).length, reportChars: report.chars, problems: report.problems, ru: report.ru })
    }
    log('layout iteration', it, 'done')
  }
  await browser.close(); await server.close()
  sampler.unwatch(pid)
  return { records }
}

/** K renders at once in one browser over the 20 frame-widths. */
async function phaseConcurrency(assets, sampler, levels) {
  const out = []
  for (const k of levels) {
    const { browser, server, pid } = await launch(chromium)
    sampler.watch(pid)
    const jobs = []
    for (const name of (SMOKE ? frames.slice(0, 2) : frames)) for (const width of WIDTHS) jobs.push({ name, width })
    const latencies = []
    const errors = []
    const from = performance.now()
    let next = 0
    await Promise.all(Array.from({ length: k }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        const r = await renderFrame(browser, assembleFrame(job.name, { assets }), { width: job.width, assets, outputs: FULL })
        latencies.push(r.t.total)
        if (r.error) errors.push(`${job.name}@${job.width}: ${r.error}`)
      }
    }))
    const wallMs = Math.round(performance.now() - from)
    const memory = sampler.peak(from)
    await browser.close(); await server.close()
    sampler.unwatch(pid)
    out.push({ k, renders: jobs.length, wallMs, perSecond: Math.round((jobs.length / (wallMs / 1000)) * 100) / 100, p50: median(latencies), p95: pct(latencies, 0.95), max: Math.max(...latencies), memory, errors })
    log('concurrency', k, 'done', wallMs, 'ms')
  }
  return out
}

async function runAll() {
  const assets = await (async () => {
    const { browser, server } = await launch(chromium)
    const a = await ensureAssets(browser)
    await browser.close(); await server.close()
    return a
  })()
  const sampler = new MemorySampler().start()
  const result = { warm: null, cold: null, layout: null, concurrency: null }
  result.warm = await phaseWarm(assets, sampler, ITER)
  result.cold = await phaseCold(assets, sampler, SMOKE ? 1 : INSIDE ? 1 : 2)
  result.layout = await phaseLayout(assets, sampler, SMOKE ? 1 : 3)
  const cpus = INSIDE ? Number(process.env.SPIKE_CPUS || 1) : os.cpus().length
  result.concurrency = await phaseConcurrency(assets, sampler, SMOKE ? [2] : INSIDE ? (cpus >= 2 ? [1, 2, 4] : [1, 2]) : [1, 2, 4])
  sampler.stop()
  return result
}

function dockerRun(config) {
  const outDir = join(ROOT, 'out', 'docker')
  mkdirSync(outDir, { recursive: true })
  const name = `spike88-s3-measure-${config.cpus}cpu-${process.pid}`
  const file = `${config.cpus}cpu${SMOKE ? '-smoke' : ''}.json`
  const dockerArgs = [
    'run', '--rm', '--name', name,
    '--network', 'none',
    `--cpus=${config.cpus}`, `--memory=${config.memoryMiB}m`, `--memory-swap=${config.memoryMiB}m`, '--shm-size=256m', '--pids-limit=512',
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '10001:10001',
    '-e', 'HOME=/tmp', '-e', `SPIKE_CPUS=${config.cpus}`, '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '-v', `${ROOT}:/spike:ro`, '-v', `${outDir}:/out:rw`,
    '-w', '/spike', IMAGE,
    'node', '/spike/measure.mjs', '--inside-docker', '--out', `/out/${file}`, ...(SMOKE ? ['--smoke'] : []),
  ]
  log('docker', config.cpus, 'cpu', config.memoryMiB, 'MiB: start')
  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('exit', (code) => {
      const path = join(outDir, file)
      resolve({ config, code, result: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null })
    })
  })
}

// ------------------------------------------------------------------ tables
function tables(results) {
  const lines = []
  // The first pass warms caches: with two passes or more it is left out of the medians.
  const steady = (records) => { const last = Math.max(...records.map((r) => r.iteration)); return records.filter((r) => last < 2 || r.iteration > 1) }
  const warmRows = (warm) => {
    const keep = steady(warm.records)
    const rows = []
    for (const name of frames) for (const width of WIDTHS) {
      const rs = keep.filter((r) => r.frame === name && r.width === width)
      if (!rs.length) continue
      const m = (f) => median(rs.map(f))
      const kb = (b) => (b === null ? '' : `${Math.round(b / 1024)}`)
      rows.push(`| ${name} | ${width} | ${m((r) => r.docH)} | ${m((r) => r.t.load)} | ${m((r) => r.t.settle)} | ${m((r) => r.t.scroll)} | ${m((r) => r.t.map)} | ${m((r) => r.t.png)} / ${kb(m((r) => r.sizes.png))} | ${m((r) => r.t.pdf)} / ${kb(m((r) => r.sizes.pdf))} / ${m((r) => r.sizes.pdfPages)} | ${m((r) => r.t.thumb)} / ${kb(m((r) => r.sizes.thumb))} | ${m((r) => r.t.thumbTop)} / ${kb(m((r) => r.sizes.thumbTop))} | ${kb(m((r) => r.sizes.thumbWebp))} | ${m((r) => r.t.strips)} / ${kb(m((r) => r.sizes.strips))} | ${m((r) => r.t.total)} | ${m((r) => r.memory.mb)}${rs[0].memory.cgroup !== null ? ` / ${m((r) => r.memory.cgroup)}` : ''} |`)
    }
    return ['| Frame | Width | Height px | Load ms | Settle ms | Scroll ms | Map ms | PNG ms / KiB | PDF ms / KiB / pages | Thumb ms / KiB | Thumb top ms / KiB | Thumb WebP KiB | Strips ms / KiB | Total ms | Peak MB |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows]
  }
  const coldRow = (cold, where) => {
    const rs = cold.records
    return `| ${where} | ${rs.length} | ${median(rs.map((r) => r.launchMs))} | ${median(rs.map((r) => r.t.total))} | ${median(rs.map((r) => r.closeMs))} | ${median(rs.map((r) => r.wallMs))} | ${pct(rs.map((r) => r.wallMs), 0.95)} | ${median(rs.map((r) => r.memory.mb))} / ${Math.max(...rs.map((r) => r.memory.mb || 0))} |`
  }
  const warmSummary = (warm, where) => {
    const rs = steady(warm.records)
    return `| ${where} | ${rs.length} | ${warm.launchMs} | ${median(rs.map((r) => r.t.total))} | ${pct(rs.map((r) => r.t.total), 0.95)} | ${warm.idleMb} | ${median(rs.map((r) => r.memory.mb))} / ${Math.max(...rs.map((r) => r.memory.mb || 0))} |`
  }
  const layoutRows = (layout, where) => frames.filter((f) => layout.records.some((r) => r.frame === f)).map((f) => {
    const rs = layout.records.filter((r) => r.frame === f)
    return `| ${where} | ${f} | ${median(rs.map((r) => r.sequentialMs))} | ${median(rs.map((r) => r.parallelMs))} | ${median(rs.map((r) => r.parMemory.mb))} | ${rs[0].reportChars} | ${rs[0].problems} |`
  })
  const concRows = (conc, where) => conc.map((c) => `| ${where} | ${c.k} | ${c.renders} | ${c.wallMs} | ${c.perSecond} | ${c.p50} | ${c.p95} | ${c.memory.mb}${c.memory.cgroup !== null ? ` / ${c.memory.cgroup}` : ''} | ${c.errors.length} |`)

  lines.push(`\n### Warm, host (median over passes${ITER >= 2 ? ' 2…' + ITER : ''})\n`, ...warmRows(results.host.warm))
  lines.push('\n### Warm and cold, summary\n', '| Where | Renders | Launch ms | Render ms (p50) | Render ms (p95) | Idle MB | Peak MB p50 / max |', '| --- | --- | --- | --- | --- | --- | --- |', warmSummary(results.host.warm, 'host warm'))
  for (const d of results.docker || []) if (d.result) lines.push(warmSummary(d.result.warm, `docker ${d.config.cpus} CPU warm`))
  lines.push('', '| Where | Renders | Launch ms | Render ms | Close ms | Wall ms p50 | Wall ms p95 | Peak MB p50 / max |', '| --- | --- | --- | --- | --- | --- | --- | --- |', coldRow(results.host.cold, 'host cold'))
  for (const d of results.docker || []) if (d.result) lines.push(coldRow(d.result.cold, `docker ${d.config.cpus} CPU cold`))
  lines.push('\n### artifact_layout: map of 1440 and 390, no pictures\n', '| Where | Frame | Sequential ms | Parallel ms | Peak MB | Report chars | Problems |', '| --- | --- | --- | --- | --- | --- | --- |', ...layoutRows(results.host.layout, 'host'))
  for (const d of results.docker || []) if (d.result) lines.push(...layoutRows(d.result.layout, `docker ${d.config.cpus} CPU`))
  lines.push('\n### Parallel renders in one browser (all outputs)\n', '| Where | K | Renders | Wall ms | Renders/s | p50 ms | p95 ms | Peak MB | Errors |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...concRows(results.host.concurrency, 'host'))
  for (const d of results.docker || []) if (d.result) lines.push(...concRows(d.result.concurrency, `docker ${d.config.cpus} CPU`))
  for (const d of results.docker || []) if (d.result) lines.push(`\n### Warm, docker ${d.config.cpus} CPU, ${d.config.memoryMiB} MiB\n`, ...warmRows(d.result.warm))
  return lines.join('\n')
}

// ------------------------------------------------------------------ main
if (INSIDE) {
  const started = { at: new Date().toISOString(), load: loadOf() }
  const result = await runAll()
  const out = value('--out', '/out/result.json')
  let peak = null
  try { peak = Math.round(Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8')) / 1048576) } catch {}
  writeFileSync(out, JSON.stringify({ started, ended: { at: new Date().toISOString(), load: loadOf() }, cgroupPeakMiB: peak, node: process.version, memoryKind, ...result }))
  process.exit(0)
}

const meta = {
  label: value('--label', SMOKE ? 'smoke (предварительно)' : 'full'),
  started: { at: new Date().toISOString(), uptime: uptime(), load: loadOf() },
  machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, model: os.cpus()[0] && os.cpus()[0].model, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
  node: process.version, limits: LIMITS, thresholds: THRESHOLDS, iterations: ITER, memoryKind,
  versions: { 'playwright-core': JSON.parse(readFileSync(join(ROOT, 'node_modules/playwright-core/package.json'), 'utf8')).version },
}
{
  const { browser, server } = await launch(chromium)
  meta.chromium = browser.version()
  await browser.close(); await server.close()
}
log('start', meta.label, 'load', meta.started.load.join(' '))
const results = { meta, host: await runAll(), docker: [] }
if (!flag('--no-docker')) {
  const configs = SMOKE ? [{ cpus: 1, memoryMiB: 1536 }] : [{ cpus: 1, memoryMiB: 1536 }, { cpus: 2, memoryMiB: 1536 }]
  for (const config of configs) results.docker.push(await dockerRun(config))
}
meta.ended = { at: new Date().toISOString(), uptime: uptime(), load: loadOf() }
const file = join(ROOT, SMOKE ? 'results-smoke.json' : 'results.json')
writeFileSync(file, JSON.stringify(results, null, 1))
const md = tables(results)
writeFileSync(join(ROOT, SMOKE ? 'results-smoke.md' : 'results.md'), `# Spike s3 — ${meta.label}\n\nStarted ${meta.started.at} (${meta.started.uptime}); ended ${meta.ended.at} (${meta.ended.uptime}). Chromium ${meta.chromium}, Node ${meta.node}. Memory: host — ${memoryKind}.\n${md}\n`)
console.log(`# Spike s3 — ${meta.label}\n\nStarted: ${meta.started.uptime}\nEnded: ${meta.ended.uptime}\nChromium ${meta.chromium}\n${md}`)
