// Immutable sandbox helper. Bake into /usr/local/lib/raditi/runtime.mjs; never copy from a task.
import { constants } from 'node:fs'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const PROTOCOL = 1
const ROOT = '/run/raditi/exec'
const CONTROL = '/run/raditi/control/keepalive.json'
const ROOTS = ['/workspace', '/agent-home', '/tmp', '/run/raditi/secrets']
const MAX_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 10000
const CHUNK = 64 * 1024
const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | noFollow
const fail = () => {
  throw new Error('Invalid sandbox helper operation')
}
const idPath = (id) => (/^[a-f0-9]{32}$/.test(id ?? '') ? `${ROOT}/${id}` : fail())
const number = (value, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : fail()
}
const writeJson = async (path, value) => {
  const tmp = `${path}.${randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  await fs.rename(tmp, path)
}
// gVisor opens a symlink to a directory even with O_DIRECTORY | O_NOFOLLOW (Linux refuses it),
// so a handle counts only if the name itself is that directory: same inode, not a link.
const openDirectory = async (path) => {
  const handle = await fs.open(path, directoryFlags)
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(path)])
    if (!named.isDirectory() || opened.ino !== named.ino || opened.dev !== named.dev) fail()
    return handle
  } catch (e) {
    await handle.close()
    throw e
  }
}
const readJson = async (path, max = CHUNK) => {
  const h = await fs.open(path, constants.O_RDONLY | noFollow)
  try {
    const stat = await h.stat()
    if (!stat.isFile() || stat.size > max) fail()
    return JSON.parse(await h.readFile('utf8'))
  } finally {
    await h.close()
  }
}
const maybeJson = async (path) => {
  try {
    return await readJson(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const input = async (limit) => {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > limit) fail()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

function segments(path, allowRoot = false) {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 1024 || /[\0\r\n\\]/.test(path)) fail()
  const root = ROOTS.find((candidate) => path === candidate || path.startsWith(`${candidate}/`))
  if (!root) fail()
  const rest = path.slice(root.length)
  if (!rest) {
    if (allowRoot) return { root, names: [] }
    fail()
  }
  const names = rest.slice(1).split('/')
  if (names.length > 32 || names.some((part) => !part || part === '.' || part === '..')) fail()
  return { root, names }
}

// Keep each parent open while resolving descendants, so a rename/symlink race cannot redirect
// a later path operation. /proc/self/fd references our own already-open directory descriptors.
async function parent(path, create = false, allowRoot = false) {
  const { root, names } = segments(path, allowRoot)
  const handles = [await openDirectory(root)]
  try {
    for (const part of names.slice(0, -1)) {
      const next = `/proc/self/fd/${handles.at(-1).fd}/${part}`
      if (create)
        await fs.mkdir(next, { mode: 0o700 }).catch((e) => {
          if (e.code !== 'EEXIST') throw e
        })
      handles.push(await openDirectory(next))
    }
    const base = `/proc/self/fd/${handles.at(-1).fd}`
    return {
      path: names.length ? `${base}/${names.at(-1)}` : `${base}/.`,
      close: async () => {
        for (const h of handles.reverse()) await h.close()
      },
    }
  } catch (e) {
    for (const h of handles.reverse()) await h.close()
    throw e
  }
}

async function fileOperation(operation, path, option, length) {
  const p = await parent(path, operation === 'write', operation === 'list')
  try {
    if (operation === 'read') {
      const max = option === undefined ? MAX_BYTES : number(option, MAX_BYTES)
      const h = await fs.open(p.path, constants.O_RDONLY | noFollow)
      try {
        const stat = await h.stat()
        if (!stat.isFile() || stat.size > max) fail()
        let position = 0
        while (true) {
          const buffer = Buffer.alloc(Math.min(CHUNK, max - position + 1))
          const { bytesRead } = await h.read(buffer, 0, buffer.length, position)
          if (!bytesRead) break
          position += bytesRead
          if (position > max) fail()
          if (!process.stdout.write(buffer.subarray(0, bytesRead)))
            await new Promise((resolve) => process.stdout.once('drain', resolve))
        }
      } finally {
        await h.close()
      }
    } else if (operation === 'write') {
      const mode = option === undefined ? 0o600 : number(option, 0o777)
      // Required: a host timeout closes stdin like a normal EOF, so the size proves completion.
      const expected = number(length, MAX_BYTES)
      const old = await fs.lstat(p.path).catch((e) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      if (old && !old.isFile()) fail()
      const temp = `${p.path}.${randomUUID()}`
      const h = await fs.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        mode,
      )
      try {
        let bytes = 0
        for await (const chunk of process.stdin) {
          bytes += chunk.length
          if (bytes > MAX_BYTES) fail()
          await h.writeFile(chunk)
        }
        if (bytes !== expected) fail()
        await h.chmod(mode)
        await h.close()
        await fs.rename(temp, p.path)
      } catch (e) {
        await h.close().catch(() => {})
        await fs.unlink(temp).catch(() => {})
        throw e
      }
    } else if (operation === 'list') {
      const { recursive = false, maxEntries = 1000 } = JSON.parse(option ?? '{}')
      number(maxEntries, MAX_ENTRIES)
      if (typeof recursive !== 'boolean') fail()
      const entries = []
      const visit = async (physical, logical, depth) => {
        if (depth > 32) fail()
        const dir = await openDirectory(physical)
        try {
          for (const name of await fs.readdir(`/proc/self/fd/${dir.fd}`)) {
            const child = `/proc/self/fd/${dir.fd}/${name}`
            const stat = await fs.lstat(child)
            const type = stat.isSymbolicLink()
              ? 'symlink'
              : stat.isDirectory()
                ? 'dir'
                : stat.isFile()
                  ? 'file'
                  : fail()
            entries.push({ path: `${logical}/${name}`, type, size: stat.size })
            if (entries.length > maxEntries) fail()
            if (recursive && type === 'dir') await visit(child, `${logical}/${name}`, depth + 1)
          }
        } finally {
          await dir.close()
        }
      }
      await visit(p.path, path, 0)
      process.stdout.write(JSON.stringify(entries))
    } else if (operation === 'remove') {
      const recursive = option === 'true'
      if (option !== 'true' && option !== 'false') fail()
      let entries = 0
      const remove = async (physical, depth) => {
        if (++entries > MAX_ENTRIES || depth > 32) fail()
        const stat = await fs.lstat(physical).catch((e) => {
          if (e.code === 'ENOENT') return null
          throw e
        })
        if (!stat) return
        if (stat.isFile()) {
          await fs.unlink(physical)
          return
        }
        if (!stat.isDirectory()) fail()
        const dir = await openDirectory(physical)
        try {
          if (recursive)
            for (const name of await fs.readdir(`/proc/self/fd/${dir.fd}`))
              await remove(`/proc/self/fd/${dir.fd}/${name}`, depth + 1)
        } finally {
          await dir.close()
        }
        await fs.rmdir(physical)
      }
      await remove(p.path, 0)
    } else fail()
  } finally {
    await p.close()
  }
}

async function stage(id) {
  const path = idPath(id)
  const bytes = await input(MAX_BYTES + CHUNK + 4)
  if (bytes.length < 4) fail()
  const length = bytes.readUInt32BE(0)
  if (length > CHUNK || bytes.length < 4 + length || bytes.length - 4 - length > MAX_BYTES) fail()
  const spec = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))
  if (
    !Array.isArray(spec.argv) ||
    !spec.argv.length ||
    spec.argv.some((v) => typeof v !== 'string' || v.includes('\0'))
  )
    fail()
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 1200000)
    fail()
  await fs.mkdir(path, { mode: 0o700 }) // Exclusive logical id; retry must not run twice.
  await fs.writeFile(`${path}/spec.json`, JSON.stringify(spec), { flag: 'wx', mode: 0o600 })
  await fs.writeFile(`${path}/stdin`, bytes.subarray(4 + length), { flag: 'wx', mode: 0o600 })
  await fs.writeFile(`${path}/stdout`, '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(`${path}/stderr`, '', { flag: 'wx', mode: 0o600 })
}

/** State, parent, process group and start time (field 22) of one /proc/<pid>/stat line. */
export function statIdentity(raw) {
  const values = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  return {
    state: values[0],
    ppid: Number(values[1]),
    group: Number(values[2]),
    started: values[19],
  }
}
/**
 * The start time is only compared, as the pid's generation. Linux counts it in ticks since boot;
 * gVisor subtracts its boot time from the task's start on the realtime clock, so a process started
 * right after the sandbox booted gets a negative value when the host clock steps back in between
 * (a VM's time sync does). That value is as stable as a positive one; after such a step it may
 * repeat for another process, which is harmless for the keepalive: its death ends the container.
 */
export const isProcessStart = (value) => typeof value === 'string' && /^-?\d+$/.test(value)
/** The keepalive identity bootstrap records and quiesce trusts: one check for both sides. */
export const isKeepaliveRecord = (record) =>
  typeof record === 'object' &&
  record !== null &&
  Number.isSafeInteger(record.pid) &&
  record.pid > 1 &&
  isProcessStart(record.started)
async function processIdentity(pid) {
  return statIdentity(await fs.readFile(`/proc/${pid}/stat`, 'utf8'))
}
async function signalGroup(path, signal, reason) {
  const meta = await maybeJson(`${path}/process.json`)
  if (!meta) return false
  const pid = number(meta.pid)
  if (pid <= 1 || !['SIGTERM', 'SIGKILL'].includes(signal)) fail()
  const current = await processIdentity(pid).catch(() => null)
  if (!current || current.started !== meta.started || current.group !== pid) return false
  if (reason) await writeJson(`${path}/cancel.json`, { reason })
  try {
    process.kill(-pid, signal)
  } catch (e) {
    if (e.code !== 'ESRCH') throw e
  }
  return true
}

async function run(id, deadlineValue) {
  const path = idPath(id)
  const lock = await fs.open(`${path}/started`, 'wx', 0o600)
  await lock.close()
  const spec = await readJson(`${path}/spec.json`)
  // The deadline is also retained in immutable Docker exec arguments for host recovery.
  const remaining = number(deadlineValue) - Date.now()
  if (remaining <= 0) {
    await writeJson(`${path}/exit.json`, { code: null, reason: 'timeout' })
    process.exitCode = 125
    return
  }
  if (remaining > 1200000) fail()
  const stdin = await fs.open(`${path}/stdin`, constants.O_RDONLY | noFollow)
  const out = await fs.open(`${path}/stdout`, constants.O_WRONLY | constants.O_APPEND | noFollow)
  const err = await fs.open(`${path}/stderr`, constants.O_WRONLY | constants.O_APPEND | noFollow)
  let child
  let timer
  let killer
  let bytes = 0
  let ioFailed = false
  try {
    if (
      !(await stdin.stat()).isFile() ||
      !(await out.stat()).isFile() ||
      !(await err.stat()).isFile()
    )
      fail()
    child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd ?? '/workspace/repo',
      env: { ...process.env, ...spec.env },
      detached: true,
      stdio: [stdin.fd, 'pipe', 'pipe'],
    })
    const exit = new Promise((resolve) => {
      child.once('error', () => resolve({ code: null, reason: 'lost' }))
      child.once('exit', (code) => resolve({ code, reason: 'exited' }))
    })
    const stop = async (reason) => {
      await signalGroup(path, 'SIGTERM', reason).catch(() => {})
      killer = setTimeout(() => {
        void signalGroup(path, 'SIGKILL', reason).catch(() => {})
      }, 300)
    }
    timer = setTimeout(
      () => {
        void stop('timeout')
      },
      Math.min(spec.timeoutMs, remaining),
    )
    const copy = async (stream, file) => {
      try {
        for await (const chunk of stream) {
          bytes += chunk.length
          if (bytes > MAX_BYTES) fail()
          await file.writeFile(chunk)
        }
      } catch {
        ioFailed = true
        await stop('lost')
      }
    }
    const copies = Promise.all([copy(child.stdout, out), copy(child.stderr, err)])
    // Install stdout/stderr consumers and error/exit listeners before the first await.
    // Node flushes pipes of a fast-exiting child even if no consumer has attached yet.
    // Files are tmpfs only and never replayed; drop the input name once the child owns fd 0.
    await fs.unlink(`${path}/stdin`)
    await stdin.close()
    if (child.pid) {
      const identity = await processIdentity(child.pid).catch(() => null)
      if (identity)
        await writeJson(`${path}/process.json`, { pid: child.pid, started: identity.started })
    }
    const result = await exit
    // Bound pipe draining: detached descendants must not keep wait() hanging forever.
    const drainTimer = setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
    }, 1000)
    try {
      await copies
    } finally {
      clearTimeout(drainTimer)
    }
    await out.close()
    await err.close()
    const cancellation = await maybeJson(`${path}/cancel.json`)
    const reason = ioFailed ? 'lost' : (cancellation?.reason ?? result.reason)
    await writeJson(`${path}/exit.json`, { code: result.code, reason })
    process.exitCode = result.code ?? 125
  } finally {
    clearTimeout(timer)
    clearTimeout(killer)
    await stdin.close().catch(() => {})
    await out.close().catch(() => {})
    await err.close().catch(() => {})
  }
}

async function readExec(id, stdoutOffset, stderrOffset) {
  const path = idPath(id)
  const result = { chunks: [], exit: await maybeJson(`${path}/exit.json`) }
  for (const [stream, offsetValue] of [
    ['stdout', stdoutOffset],
    ['stderr', stderrOffset],
  ]) {
    const offset = number(offsetValue)
    const h = await fs.open(`${path}/${stream}`, constants.O_RDONLY | noFollow)
    try {
      const stat = await h.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES || offset > stat.size) fail()
      const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - offset))
      const { bytesRead } = await h.read(buffer, 0, buffer.length, offset)
      if (bytesRead)
        result.chunks.push({
          stream,
          offset,
          data: buffer.subarray(0, bytesRead).toString('base64'),
        })
    } finally {
      await h.close()
    }
  }
  process.stdout.write(JSON.stringify(result))
}

async function bootstrap() {
  // This command runs once as root, before any task data or process enters the sandbox.
  // The separate root-owned mount makes the identity durable and immutable to uid 10001.
  if (process.getuid() !== 0) fail()
  const children = (await fs.readFile('/proc/1/task/1/children', 'utf8')).trim().split(/\s+/)
  const keepalive = number(children[0])
  if (keepalive <= 1) fail()
  const original = await processIdentity(keepalive)
  const record = { pid: keepalive, started: original.started }
  // Never record an identity quiesce refuses: a container that cannot be quiesced fails here.
  if (original.ppid !== 1 || original.state === 'Z' || !isKeepaliveRecord(record)) fail()
  await fs.writeFile(CONTROL, JSON.stringify(record), {
    flag: 'wx',
    mode: 0o444,
  })
}

async function quiesce() {
  const stat = await fs.lstat(CONTROL)
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o444) fail()
  const original = await readJson(CONTROL, 1024)
  if (!isKeepaliveRecord(original)) fail()
  const keepalive = original.pid
  const validKeepalive = async () => {
    const current = await processIdentity(keepalive)
    if (
      current.ppid !== 1 ||
      current.started !== original.started ||
      current.state === 'Z' ||
      (await fs.readlink(`/proc/${keepalive}/exe`)) !== '/usr/bin/sleep'
    )
      fail()
  }
  const processes = async () => {
    await validKeepalive()
    const result = []
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      if (pid <= 1 || pid === process.pid) continue
      const identity = await processIdentity(pid).catch(() => null)
      if (!identity || identity.state === 'Z') continue
      if (pid === keepalive && identity.started === original.started) continue
      result.push(pid)
    }
    return result
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const pids = await processes()
    if (!pids.length) return
    for (const pid of pids) {
      try {
        process.kill(pid, attempt === 0 ? 'SIGTERM' : 'SIGKILL')
      } catch (e) {
        if (e.code !== 'ESRCH') throw e
      }
    }
    await delay(attempt === 0 ? 300 : 50)
  }
  if ((await processes()).length) fail()
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'bootstrap') await bootstrap()
  else if (command === 'ready') {
    for (const path of ['/workspace/repo', '/workspace/inbox', '/workspace/out', ROOT])
      await fs.mkdir(path, { recursive: true, mode: 0o700 })
    process.stdout.write(JSON.stringify({ protocol: PROTOCOL }))
  } else if (command === 'stage') await stage(args[0])
  else if (command === 'run') await run(...args)
  else if (command === 'read-exec') await readExec(...args)
  else if (command === 'signal') {
    if (!['cancelled', 'timeout', 'lost'].includes(args[2])) fail()
    await signalGroup(idPath(args[0]), args[1], args[2])
  } else if (command === 'quiesce') await quiesce()
  else if (command === 'fs') await fileOperation(...args)
  else fail()
}

// A unit test imports the helper for its pure checks only; everywhere else it runs its command.
if (!globalThis.raditiRuntimeUnderTest)
  main().catch(() => {
    process.stderr.write('Sandbox helper failed\n')
    process.exitCode = 125
  })
