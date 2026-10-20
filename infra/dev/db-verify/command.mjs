// Bounded child processes of verify-db.mjs: a time limit, an output cap, every process below
// the child killed on either, and the end of the child's output in every failure but an
// interrupt.
import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'

const OUTPUT_LIMIT = 8 * 1024 * 1024
const TAIL = 16_000
const TEST_TIMEOUT_MS = 15 * 60_000
const GRACE_MS = 5_000

/**
 * The limit of one test suite. The core suite runs its files one by one against the
 * database and grows with every step: a laptop needs minutes, a shared runner several times
 * more. VERIFY_DB_TEST_TIMEOUT_MS overrides the default of 15 minutes.
 */
export function testTimeoutMs(env) {
  const raw = env.VERIFY_DB_TEST_TIMEOUT_MS
  if (raw === undefined || raw === '') return TEST_TIMEOUT_MS
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!(value >= 60_000 && value <= 60 * 60_000)) {
    throw new Error(
      'VERIFY_DB_TEST_TIMEOUT_MS must be a whole number of milliseconds from 60000 to 3600000',
    )
  }
  return value
}

/** pid, parent and process group of every process; empty where `ps` cannot be asked. */
function processTable() {
  for (const ps of ['ps', '/bin/ps']) {
    try {
      return execFileSync(ps, ['-axo', 'pid=,ppid=,pgid='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
    } catch {
      // Not on PATH (a test fixture) or not a POSIX ps: try the next one.
    }
  }
  return []
}

/**
 * The process group of `pid`, which leads one, and of everything below it. pnpm starts its
 * scripts in groups of their own: the group of the spawned pnpm alone does not reach the test
 * processes. They are looked up before the kill, while they still have their parents.
 */
function groupsBelow(pid) {
  const groups = new Set([pid])
  const table = processTable()
  const own = table.find(([id]) => id === process.pid)?.[2]
  const seen = new Set([pid])
  const pending = [pid]
  while (pending.length > 0) {
    const parent = pending.pop()
    for (const [id, ppid, group] of table) {
      if (ppid !== parent || seen.has(id)) continue
      seen.add(id)
      pending.push(id)
      if (group > 1 && group !== own) groups.add(group)
    }
  }
  return groups
}

/**
 * Resolves with the exit code and the trimmed output of both streams. Rejects when the child
 * fails (unless `allowFailure`), outlives `timeoutMs`, prints more than 8 MiB or `signal`
 * aborts. `redact` is applied to everything that leaves this function. A killed child is
 * waited for `graceMs` only: a process that escaped the kill may keep its output open.
 */
export function run(
  program,
  args,
  {
    cwd,
    env,
    input,
    stage,
    timeoutMs,
    signal,
    allowFailure = false,
    redact = (text) => text,
    graceMs = GRACE_MS,
  },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    const chunks = []
    let size = 0
    let exceeded
    let cancelled = false
    let settled = false
    let grace
    const done = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', cancel)
      return true
    }
    const settle = (code) => {
      if (!done()) return
      const output = redact(Buffer.concat(chunks).toString('utf8'))
      if (signal?.aborted) {
        reject(new Error(`Command interrupted at ${stage}`))
      } else if (exceeded) {
        // Without the output nobody can tell a slow suite from a hung one, or which test it was.
        reject(
          new Error(`${program} ${exceeded} at ${stage}; its last output:\n${output.slice(-TAIL)}`),
        )
      } else if (code !== 0 && !allowFailure) {
        reject(new Error(`${program} failed at ${stage}:\n${output.slice(-TAIL)}`))
      } else resolve({ code, output: output.trim() })
    }
    const cancel = () => {
      // Output keeps arriving after the kill.
      if (cancelled || settled) return
      cancelled = true
      if (process.platform === 'win32' || !child.pid) child.kill('SIGKILL')
      else {
        for (const group of groupsBelow(child.pid)) {
          try {
            process.kill(-group, 'SIGKILL')
          } catch (error) {
            // A group of exited processes answers EPERM on macOS.
            if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error
          }
        }
      }
      grace = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        settle(null)
      }, graceMs)
    }
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    }
    const timer = setTimeout(() => {
      exceeded = `exceeded its ${timeoutMs / 1000} s limit`
      cancel()
    }, timeoutMs)
    const capture = (chunk) => {
      size += chunk.length
      if (size > OUTPUT_LIMIT) {
        exceeded ??= 'printed more than 8 MiB'
        cancel()
      } else chunks.push(chunk)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', () => {
      if (done()) reject(new Error(`Could not start ${program}`))
    })
    child.once('close', settle)
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
