// Prototype of the wrapper the OpenCode driver will run (decision 4 of the plan): the turn key and the
// MCP token reach the CLI once, through named pipes, and exist nowhere else in the sandbox.
//   node wrapper.mjs [--secrets fifo|plain|env] [--report <file>] [--mcp-check <url>] [--timeout <s>]
//                    [--group kill|keep] [--env NAME=VALUE]... -- <command> [arguments...]
// The host has put the two values into /run/raditi/secrets/{llm,mcp} (tmpfs). The wrapper reads and removes
// both files, makes named pipes in their place and starts the CLI, whose configuration names the pipes as
// `{file:…}`. A pipe gets its value when a reader has opened it — once; then the pipe is removed and the
// buffer zeroed. When the CLI ends without having read a pipe, the wrapper ends with it: nothing blocks.
//   plain: ordinary files left in place (control: what the one-shot delivery is compared with)
//   env:   no files, RADITI_LLM_KEY and RADITI_MCP_TOKEN in the CLI's environment (control)
// The CLI gets exactly the environment given by --env plus PATH; stdin, stdout and stderr pass through.
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import os from 'node:os'
import process from 'node:process'

const SECRETS = '/run/raditi/secrets'
const started = Date.now()
const options = { secrets: 'fifo', env: {}, timeout: 600 }
const argv = process.argv.slice(2)
while (argv.length && argv[0] !== '--') {
  const flag = argv.shift()
  const value = argv.shift()
  if (flag === '--env')
    options.env[value.slice(0, value.indexOf('='))] = value.slice(value.indexOf('=') + 1)
  else if (['--secrets', '--report', '--mcp-check'].includes(flag)) options[flag.slice(2)] = value
  else if (flag === '--timeout') options.timeout = Number(value)
  else if (flag === '--group') options.group = value
  else throw new Error(`unknown option ${flag}`)
}
argv.shift()
if (!argv.length) throw new Error('no command after --')

const report = {
  mode: options.secrets,
  delivered: {},
  deliveredMs: {},
  attempts: {},
  mcpCheck: undefined,
}
const values = {}
for (const name of ['llm', 'mcp']) {
  values[name] = readFileSync(`${SECRETS}/${name}`)
  rmSync(`${SECRETS}/${name}`)
}

// The MCP role must answer before the turn is worth starting; the wrapper's own `initialize`.
if (options['mcp-check']) {
  try {
    const answer = await fetch(options['mcp-check'], {
      method: 'POST',
      headers: {
        authorization: `Bearer ${values.mcp.toString()}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raditi-wrapper', version: '0' },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    report.mcpCheck = {
      status: answer.status,
      ok: answer.ok && Boolean((await answer.json()).result),
    }
  } catch (error) {
    report.mcpCheck = { ok: false, error: `${error?.name}: ${error?.message}` }
  }
}

const env = { PATH: process.env.PATH, ...options.env }
if (options.secrets === 'env') {
  env.RADITI_LLM_KEY = values.llm.toString()
  env.RADITI_MCP_TOKEN = values.mcp.toString()
} else if (options.secrets === 'plain') {
  for (const name of ['llm', 'mcp'])
    writeFileSync(`${SECRETS}/${name}`, values[name], { mode: 0o600 })
} else {
  for (const name of ['llm', 'mcp']) execFileSync('mkfifo', ['-m', '600', `${SECRETS}/${name}`])
}

const child = spawn(argv[0], argv.slice(1), { env, stdio: 'inherit', detached: true })
report.pid = child.pid

// A named pipe opens for writing without blocking only when a reader holds it: ENXIO until then.
const feeders = new Map()
if (options.secrets === 'fifo')
  for (const name of ['llm', 'mcp']) {
    report.attempts[name] = 0
    feeders.set(
      name,
      setInterval(() => {
        report.attempts[name] += 1
        let fd
        try {
          fd = openSync(`${SECRETS}/${name}`, constants.O_WRONLY | constants.O_NONBLOCK)
        } catch (error) {
          if (error.code === 'ENXIO') return
          throw error
        }
        writeSync(fd, values[name])
        closeSync(fd)
        rmSync(`${SECRETS}/${name}`)
        values[name].fill(0)
        report.delivered[name] = true
        report.deliveredMs[name] = Date.now() - started
        clearInterval(feeders.get(name))
        feeders.delete(name)
      }, 5),
    )
  }
if (options.secrets !== 'fifo') for (const name of ['llm', 'mcp']) values[name].fill(0)

const killGroup = (signal) => {
  try {
    process.kill(-child.pid, signal)
  } catch {
    /* already gone */
  }
}
const timer = setTimeout(() => {
  report.timedOut = true
  killGroup('SIGTERM')
  setTimeout(() => killGroup('SIGKILL'), 5_000).unref()
}, options.timeout * 1000)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => killGroup(signal))

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  for (const [name, feeder] of feeders) {
    clearInterval(feeder)
    report.delivered[name] = false
    values[name].fill(0)
    if (existsSync(`${SECRETS}/${name}`)) rmSync(`${SECRETS}/${name}`)
  }
  // Whatever the CLI started and left behind goes with it (`--group keep` is the control without this).
  if (options.group !== 'keep') killGroup('SIGKILL')
  report.exit = code
  report.signal = signal
  report.elapsedMs = Date.now() - started
  if (options.report) writeFileSync(options.report, `${JSON.stringify(report)}\n`)
  process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0))
})
