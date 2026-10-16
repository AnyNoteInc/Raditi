import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

import { repository } from './stack.mjs'

// The role mcp is not a worker: the agent-content stand starts the regular role from the build
// (apps/orchestrator/scripts/verify-agent-content-role.mjs).
const WORKERS = Object.freeze({
  core: 'verify-core-worker.mjs',
  llm: 'verify-llm-worker.mjs',
})

const ENV_FILE = /^--env-file(?:-if-exists)?(=|$)/

/**
 * The Node arguments of this process without its env files, in both spellings (`--env-file=x`
 * and `--env-file x`). A worker gets its environment from the stand, by name: a stand started
 * with `node --env-file=…` must not hand the whole file — the plan key of a live run with it —
 * to every process it forks.
 */
function withoutEnvFiles(execArgv) {
  const kept = []
  for (let index = 0; index < execArgv.length; index++) {
    const [, value] = ENV_FILE.exec(execArgv[index]) ?? []
    if (value === undefined) kept.push(execArgv[index])
    // The file of the two-argument spelling is the next argument.
    else if (value === '') index += 1
  }
  return kept
}

/**
 * Private IPC carries test capabilities; neither command arguments nor logs contain them.
 * `imports` are modules the worker loads before its own script (`--import`): a live run names
 * its request guard here (live.mjs, guardImport), whose address holds no secret. The Node
 * arguments of the worker are always named here, never left to fork's default, which copies
 * those of this process whole.
 */
export async function startWorker(
  role,
  config,
  {
    forkChild = fork,
    startupTimeoutMs = 30_000,
    shutdownTimeoutMs = 15_000,
    imports = [],
    execArgv = process.execArgv,
  } = {},
) {
  if (!Object.hasOwn(WORKERS, role)) throw new Error('Invalid verification role')
  const child = forkChild(join(repository, 'apps/orchestrator/scripts', WORKERS[role]), [], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [...withoutEnvFiles(execArgv), ...imports.flatMap((url) => ['--import', url])],
  })
  const logs = [],
    streams = [],
    pending = new Map(),
    captures = []
  let size = 0,
    terminated = false,
    closing,
    startupFinish,
    resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  const failPending = () => {
    for (const finish of pending.values()) finish(new Error('Verification worker exited'))
  }
  const onError = () => {
    startupFinish?.(new Error(`Verification ${role} worker initialization failed`))
    failPending()
    // Spawn failures have no process to kill. IPC errors may leave a live child behind.
    if (child.pid) child.kill('SIGKILL')
  }
  const onExit = () => {
    startupFinish?.(new Error(`Verification ${role} worker exited at startup`))
    failPending()
  }
  const onClose = (code, signal) => {
    terminated = true
    onExit()
    child.off('error', onError)
    child.off('exit', onExit)
    for (const [stream, capture] of captures) stream.off('data', capture)
    resolveExit({ code, signal })
  }
  // Failed spawn emits error + close, without exit. Handle both before sending any IPC.
  child.on('error', onError)
  child.once('exit', onExit)
  child.once('close', onClose)
  for (const stream of [child.stdout, child.stderr]) {
    // Each pipe also by itself: a read ends anywhere, and a chunk of the other pipe may come
    // between two chunks of one text. Whoever looks for a value joins the chunks of one pipe.
    const own = []
    streams.push(own)
    const capture = (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) return child.kill('SIGKILL')
      const text = chunk.toString()
      logs.push(text)
      own.push(text)
    }
    captures.push([stream, capture])
    stream.on('data', capture)
  }
  const call = (operation, input = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (terminated || !child.connected)
        return reject(new Error('Verification worker disconnected'))
      const id = randomUUID()
      let done = false
      const finish = (error, result) => {
        if (done) return
        done = true
        clearTimeout(timer)
        pending.delete(id)
        child.off('message', received)
        if (error) reject(error)
        else resolve(result)
      }
      const received = (reply) => {
        if (reply?.id !== id) return
        finish(
          reply.ok
            ? null
            : Object.assign(new Error('Verification operation failed'), {
                code: reply.error?.code,
              }),
          reply.result,
        )
      }
      const timer = setTimeout(
        () => finish(new Error('Verification worker response timeout')),
        timeoutMs,
      )
      pending.set(id, finish)
      child.on('message', received)
      try {
        child.send({ id, operation, ...input }, (error) => {
          if (error) finish(new Error('Verification worker disconnected'))
        })
      } catch {
        finish(new Error('Verification worker disconnected'))
      }
    })
  const waitForExit = (timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Verification worker shutdown timed out')),
        timeoutMs,
      )
      exited.then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  const kill = async () => {
    if (!terminated) child.kill('SIGKILL')
    await waitForExit(5000)
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Verification worker startup timed out')),
        startupTimeoutMs,
      )
      let done = false
      const finish = (error, message) => {
        if (done) return
        done = true
        clearTimeout(timer)
        child.off('message', receive)
        startupFinish = undefined
        if (error) reject(error)
        else resolve(message)
      }
      const receive = (reply) => {
        if (!['ready', 'error'].includes(reply?.type)) return
        finish(
          reply.type === 'ready'
            ? null
            : new Error(`Verification ${role} worker initialization failed`),
          reply,
        )
      }
      startupFinish = finish
      child.on('message', receive)
      try {
        child.send({ type: 'init', config }, (error) => {
          if (error) finish(new Error('Verification worker disconnected at startup'))
        })
      } catch {
        finish(new Error('Verification worker disconnected at startup'))
      }
    })
    return {
      child,
      ready,
      logs,
      streams,
      call,
      exited,
      close: () =>
        (closing ??= (async () => {
          if (terminated) return
          try {
            await call('close', {}, shutdownTimeoutMs)
            await waitForExit(shutdownTimeoutMs)
          } catch {
            await kill()
          }
        })()),
    }
  } catch (error) {
    await kill()
    throw error
  }
}
