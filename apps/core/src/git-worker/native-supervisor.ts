/**
 * Runs in its own Node process: the deadline and process-group cleanup survive a crashed
 * or paused caller. IPC disconnection kills the native command without waiting for expiry.
 * A literal program avoids loading a mutable task file or needing a copied build asset.
 */
export const nativeSupervisor = String.raw`
import { spawn } from 'node:child_process'
let child
let timer
let finished = false
let stopped = false
const send = (message, done) => {
  if (process.connected) process.send(message, () => { if (done) done() })
  else if (done) done()
}
const disconnect = () => { if (process.connected) process.disconnect() }
const killGroup = () => {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}
const stop = () => {
  if (finished || stopped) return
  stopped = true
  killGroup()
  if (!child) finish(null)
}
const finish = (code) => {
  if (finished) return
  // The leader can exit while a same-group descendant has closed all inherited pipes.
  // Reap that entire group on success too; otherwise the deadline would be cleared early.
  killGroup()
  finished = true
  clearTimeout(timer)
  process.stdin.destroy()
  send(stopped || code === null ? { type: 'failed' } : { type: 'complete', code }, disconnect)
}
process.on('disconnect', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('error', stop)
process.stdout.on('error', stop)
process.stderr.on('error', stop)
process.once('message', (spec) => {
  if (finished || stopped || !process.connected) return stop()
  try {
    const remaining = Math.min(spec.timeoutMs, Number((BigInt(spec.deadlineNs) - process.hrtime.bigint()) / 1000000n))
    if (!Number.isSafeInteger(remaining) || remaining <= 0) { stopped = true; finish(null); return }
    timer = setTimeout(stop, remaining)
    child = spawn(spec.binary, spec.argv, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.once('error', () => { stopped = true; finish(null) })
    child.once('close', finish)
    child.stdin.on('error', stop)
    // Attach before any asynchronous operation: fast native commands must not lose their tail.
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
    process.stdin.pipe(child.stdin)
  } catch { stopped = true; finish(null) }
})
`
