// The command the scripted model runs through the CLI's `bash` tool: what can a command of the model learn
// about the turn key and the MCP token? It knows only their SHA-256 and prints no value, only facts.
//   node toolcheck.mjs llm=<sha256 of the turn key> mcp=<sha256 of the MCP token> [<label>=<sha256>]...
// Looked at: its own environment, /proc/<pid>/environ and /proc/<pid>/mem of every process, the secrets
// directory. Candidates are found by shape (`sk-rdt-…`, `mcp_…`) and confirmed by hash.
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'

const known = new Map(
  process.argv
    .slice(2)
    .map((pair) => [pair.slice(pair.indexOf('=') + 1), pair.slice(0, pair.indexOf('='))]),
)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const SHAPES = /sk-rdt-[A-Za-z0-9_-]{43}|mcp_[0-9a-f]{64}/g
const labelOf = (candidate) => known.get(sha256(candidate))
/** Labels of the credentials a text holds. */
function credentialsIn(text) {
  const found = new Set()
  for (const match of text.matchAll(SHAPES)) {
    const label = labelOf(match[0])
    if (label) found.add(label)
  }
  return [...found].sort()
}
const tryRead = (path) => {
  try {
    return readFileSync(path)
  } catch (error) {
    return error.code ?? String(error.message)
  }
}

const out = { own: {}, processes: [], secretsDir: [], budget: {} }
out.own.envNames = Object.keys(process.env)
  .filter((name) => /RADITI|KEY|TOKEN|SECRET|OPENCODE|ZHIPU|ZAI/i.test(name))
  .sort()
out.own.envHolds = credentialsIn(Object.values(process.env).join('\n'))

// Per process: enough for the CLI's heap, bounded so that the command ends well inside the tool's timeout.
const SCAN_LIMIT = 2048 * 1024 * 1024
let scannedTotal = 0
function scanMemory(pid) {
  const result = { readable: false, holds: [], regions: 0, mib: 0 }
  const deadline = Date.now() + 15_000
  let scanned = 0
  let maps = tryRead(`/proc/${pid}/smaps`)
  let hasRss = true
  if (!Buffer.isBuffer(maps)) {
    maps = tryRead(`/proc/${pid}/maps`)
    hasRss = false
  }
  if (!Buffer.isBuffer(maps)) return { ...result, error: `maps: ${maps}` }
  const regions = []
  let current
  for (const line of maps.toString('latin1').split('\n')) {
    const head = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (head) {
      current = {
        start: parseInt(head[1], 16),
        end: parseInt(head[2], 16),
        perms: head[3],
        name: head[4],
        rss: hasRss ? 0 : -1,
      }
      regions.push(current)
    } else if (current && line.startsWith('Rss:')) current.rss = Number(/(\d+)/.exec(line)[1])
  }
  let fd
  try {
    fd = openSync(`/proc/${pid}/mem`, constants.O_RDONLY)
  } catch (error) {
    return { ...result, error: `open: ${error.code}` }
  }
  const found = new Set()
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  const OVERLAP = 96
  try {
    for (const region of regions) {
      // Writable private memory that is actually there: heaps and stacks.
      if (
        !region.perms.startsWith('rw') ||
        region.rss === 0 ||
        /^\[(vvar|vsyscall|vdso)/.test(region.name)
      )
        continue
      let offset = region.start
      let tail = ''
      let any = false
      while (offset < region.end) {
        if (scanned > SCAN_LIMIT || Date.now() > deadline) {
          result.truncated = true
          break
        }
        const want = Math.min(chunk.length, region.end - offset)
        let got
        try {
          got = readSync(fd, chunk, 0, want, offset)
        } catch (error) {
          result.readError ??= error.code
          break
        }
        if (got <= 0) break
        any = true
        result.readable = true
        scanned += got
        scannedTotal += got
        const text = tail + chunk.latin1Slice(0, got)
        for (const label of credentialsIn(text)) found.add(label)
        // UTF-16 strings of the JavaScript engine: every other byte is zero.
        if (text.includes('s\0k\0-\0r\0d\0t\0-\0') || text.includes('m\0c\0p\0_\0'))
          for (const label of credentialsIn(text.replaceAll('\0', ''))) found.add(`${label}:utf16`)
        tail = text.slice(-OVERLAP)
        offset += got
      }
      if (any) {
        result.regions += 1
        result.mib += Math.round((offset - region.start) / 1048576)
      }
    }
  } finally {
    closeSync(fd)
  }
  result.holds = [...found].sort()
  return result
}

let threads = 0
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue
  const pid = Number(entry)
  const status = tryRead(`/proc/${pid}/status`)
  if (!Buffer.isBuffer(status)) continue
  const field = (name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status.toString())?.[1]
  const item = {
    pid,
    self: pid === process.pid,
    comm: field('Name'),
    ppid: Number(field('PPid')),
    uid: Number(field('Uid')?.split(/\s+/)[0]),
    threads: Number(field('Threads')),
    rssKb: Number(/\d+/.exec(field('VmRSS') ?? '')?.[0]),
    peakKb: Number(/\d+/.exec(field('VmHWM') ?? '')?.[0]),
  }
  threads += item.threads || 0
  const cmdline = tryRead(`/proc/${pid}/cmdline`)
  item.argv0 = Buffer.isBuffer(cmdline)
    ? cmdline.toString().split('\0').slice(0, 3).join(' ').slice(0, 120)
    : cmdline
  item.cmdlineHolds = Buffer.isBuffer(cmdline) ? credentialsIn(cmdline.toString('latin1')) : []
  const environ = tryRead(`/proc/${pid}/environ`)
  item.environ = Buffer.isBuffer(environ)
    ? {
        readable: true,
        names: environ
          .toString('latin1')
          .split('\0')
          .map((pair) => pair.split('=')[0])
          .filter((name) => /RADITI|KEY|TOKEN|SECRET|ZHIPU|ZAI/i.test(name))
          .sort(),
        holds: credentialsIn(environ.toString('latin1')),
      }
    : { readable: false, error: environ }
  if (pid !== process.pid) item.memory = scanMemory(pid)
  out.processes.push(item)
}
out.budget.threadsTotal = threads
out.budget.processes = out.processes.length
out.budget.scannedMiB = Math.round(scannedTotal / 1048576)

try {
  for (const name of readdirSync('/run/raditi/secrets')) {
    const path = `/run/raditi/secrets/${name}`
    const stat = statSync(path)
    const item = {
      name,
      type: stat.isFIFO() ? 'fifo' : stat.isFile() ? 'file' : 'other',
      mode: (stat.mode & 0o777).toString(8),
    }
    try {
      // Never blocks: a pipe without a writer reads as empty.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
      const buffer = Buffer.alloc(4096)
      let got = 0
      try {
        got = readSync(fd, buffer, 0, buffer.length, null)
      } catch (error) {
        item.readError = error.code
      }
      closeSync(fd)
      item.bytes = got
      item.holds = credentialsIn(buffer.latin1Slice(0, got))
    } catch (error) {
      item.openError = error.code
    }
    out.secretsDir.push(item)
  }
} catch (error) {
  out.secretsDirError = error.code
}
const ptraceScope = tryRead('/proc/sys/kernel/yama/ptrace_scope')
out.ptraceScope = Buffer.isBuffer(ptraceScope)
  ? ptraceScope.toString().trim()
  : `absent (${ptraceScope})`
out.kernel = tryRead('/proc/version').toString().slice(0, 60)
console.log(JSON.stringify(out))
