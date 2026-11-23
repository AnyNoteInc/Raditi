// Memory of the Chromium process tree while it renders (spike s3 of plan 88).
// macOS: `ps` RSS summed over the tree (shared pages counted in every process — an upper bound).
// Linux (the Docker run): PSS from /proc/<pid>/smaps_rollup summed over the tree, plus the
// container's own cgroup (memory.current), which is what a memory limit counts.
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const LINUX = process.platform === 'linux'
const CGROUP = '/sys/fs/cgroup/memory.current'

function psTree() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      resolve(stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)))
    })
  })
}

function procTree() {
  const rows = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      let kb = 0
      try {
        const roll = readFileSync(`/proc/${name}/smaps_rollup`, 'utf8')
        const m = /^Pss:\s+(\d+)/m.exec(roll)
        kb = m ? Number(m[1]) : 0
      } catch {
        const st = readFileSync(`/proc/${name}/status`, 'utf8')
        const m = /^VmRSS:\s+(\d+)/m.exec(st)
        kb = m ? Number(m[1]) : 0
      }
      rows.push([Number(name), ppid, kb])
    } catch {
      // the process ended meanwhile
    }
  }
  return rows
}

const descendantsKb = (rows, root) => {
  const children = new Map()
  for (const [pid, ppid] of rows) { if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid) }
  const kb = new Map(rows.map(([pid, , k]) => [pid, k]))
  let total = 0
  let count = 0
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()
    if (kb.has(pid)) { total += kb.get(pid); count++ }
    for (const c of children.get(pid) || []) stack.push(c)
  }
  return { mb: Math.round(total / 1024), processes: count }
}

/** Samples the tree of `rootPid` every `everyMs`; `peak(from, to)` reads the samples in between. */
export class MemorySampler {
  constructor(everyMs = LINUX ? 50 : 120) {
    this.everyMs = everyMs
    this.samples = []
    this.roots = new Set()
    this.timer = null
    this.busy = false
  }
  watch(pid) { this.roots.add(pid) }
  unwatch(pid) { this.roots.delete(pid) }
  start() {
    this.timer = setInterval(() => this.#tick(), this.everyMs)
    return this
  }
  async #tick() {
    if (this.busy || !this.roots.size) return
    this.busy = true
    try {
      const rows = LINUX ? procTree() : await psTree()
      let mb = 0
      let processes = 0
      for (const root of this.roots) { const d = descendantsKb(rows, root); mb += d.mb; processes += d.processes }
      let cgroup = null
      if (LINUX && existsSync(CGROUP)) cgroup = Math.round(Number(readFileSync(CGROUP, 'utf8')) / 1048576)
      this.samples.push({ at: performance.now(), mb, processes, cgroup })
      if (this.samples.length > 20000) this.samples.splice(0, 10000)
    } finally {
      this.busy = false
    }
  }
  peak(from, to = performance.now()) {
    const inside = this.samples.filter((s) => s.at >= from && s.at <= to)
    if (!inside.length) return { mb: null, cgroup: null, processes: null, samples: 0 }
    return {
      mb: Math.max(...inside.map((s) => s.mb)),
      cgroup: inside.some((s) => s.cgroup !== null) ? Math.max(...inside.map((s) => s.cgroup || 0)) : null,
      processes: Math.max(...inside.map((s) => s.processes)),
      samples: inside.length,
    }
  }
  stop() { clearInterval(this.timer) }
}

export const memoryKind = LINUX ? 'PSS of the tree (smaps_rollup) and the container cgroup' : 'RSS of the tree (ps), shared pages counted per process'
