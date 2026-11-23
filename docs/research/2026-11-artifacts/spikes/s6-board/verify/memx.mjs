// Cross-check of the memory numbers: the spike's board at the overview after load, memory read two ways —
// the spike's memory-infra sum (for reference) and the macOS `footprint` tool over every process of the
// browser's own tree (main process and its children). One snapshot per row, no timing.
//   node memx.mjs
import { execFileSync } from 'node:child_process'
import { startServers } from '../server.mjs'
import { launchChromium, LAPTOP, boardUrl, openBoard, memoryDump, summarizeMemory, processes, sleep } from '../lib.mjs'

const here = new URL('../', import.meta.url).pathname
const s = await startServers({ dist: here + 'dist', thumbs: here + 'thumbs' })
const ps = () => execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }))
const mains = () => new Set(ps().filter((p) => /Google Chrome for Testing( --|$)/.test(p.cmd) && !/--type=/.test(p.cmd)).map((p) => p.pid))
function footprintMB(pids) {
  const out = execFileSync('footprint', pids.map(String), { encoding: 'utf8', maxBuffer: 64 << 20 })
  let total = 0
  for (const m of out.matchAll(/\[(\d+)\]: 64-bit\s+Footprint: ([\d.]+) (KB|MB|GB)/g)) total += Number(m[2]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[3]])
  return Math.round(total)
}
const rows = []
for (const c of [
  { name: 'CSS, 0 живых, свой процесс', q: { live: 0 } },
  { name: 'CSS, 20 живых, свой процесс', q: { live: 20 } },
  { name: 'CSS, 20 живых, процесс кабинета', q: { live: 20 }, opts: { disable: ['IsolateSandboxedIframes'] } },
]) {
  const before = mains()
  const browser = await launchChromium(c.opts ?? {})
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', pe: 'shield', frames: s.origins.sameSite, ...c.q }), { timeout: 300000 })
  await sleep(2000)
  const bs = await browser.newBrowserCDPSession()
  const mi = summarizeMemory(await memoryDump(bs), await processes(bs))
  const main = [...mains()].filter((p) => !before.has(p))
  const tree = ps().filter((p) => main.includes(p.pid) || main.includes(p.ppid)).map((p) => p.pid)
  const fp = footprintMB(tree)
  const gpu = ps().filter((p) => main.includes(p.ppid) && /--type=gpu-process/.test(p.cmd)).map((p) => p.pid)
  const row = { case: c.name, memoryInfraTotalMB: Math.round(mi.total), memoryInfraGpuMB: Math.round(mi.gpu), osFootprintTreeMB: fp, osFootprintGpuMB: footprintMB(gpu), processes: tree.length }
  rows.push(row); console.log(JSON.stringify(row))
  await browser.close()
}
await s.close()
