// What every part of the release stand shares at run time: bounded child processes, Docker,
// polling, HTTP with the stand's CA, a customer of web with a session cookie, the PASS lines
// and the numbers of the final table. One instance per run (`createRuntime`).
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import { run as boundedRun } from '../db-verify/command.mjs'
import { cookieHeader, trpcOutcome, trpcQueryUrl } from '../billing-verify/stand.mjs'

export class CheckFailed extends Error {}

/** Only what Docker, git, rsync and pnpm need of the caller's environment. */
export const callerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME'].includes(key) || key.startsWith('DOCKER_'),
  ),
)

export function createRuntime({ root }) {
  const controller = new AbortController()
  const secrets = new Set()
  let stage = 'preflight'
  let scenario = null
  const rows = []
  const redact = (text) => {
    let out = String(text)
    for (const value of secrets) if (value) out = out.replaceAll(value, '[redacted]')
    return out
  }

  const rt = {
    root,
    controller,
    signal: controller.signal,
    get stage() {
      return stage
    },
    setStage(text) {
      stage = text
    },
    /** A value the output, the logs kept aside and a failure must never show. */
    secret(value) {
      if (typeof value === 'string' && value.length >= 6) secrets.add(value)
      return value
    },
    secrets: () => [...secrets],
    redact,
    /** A bounded child process; its combined output is captured, never printed unless it fails. */
    run(
      program,
      args,
      { cwd = root, env = callerEnv, input, timeoutMs = 120_000, allowFailure, cleanup } = {},
    ) {
      return boundedRun(program, args, {
        cwd,
        env,
        input,
        stage,
        timeoutMs,
        allowFailure,
        signal: cleanup ? undefined : controller.signal,
        redact,
      })
    },
    docker(args, options = {}) {
      return rt.run('docker', args, options)
    },
    async pause(ms) {
      await sleep(ms, undefined, { signal: controller.signal })
    },
    /** Polls until `probe` answers something truthy; names what it waited for when it does not. */
    async until(what, probe, { timeoutMs = 60_000, intervalMs = 500, service } = {}) {
      const deadline = Date.now() + timeoutMs
      let last
      for (;;) {
        try {
          const answer = await probe()
          if (answer) return answer
        } catch (error) {
          // A check that failed fails now; anything else may be a startup race.
          if (error instanceof CheckFailed) throw error
          last = error
        }
        if (service && !service.running())
          throw new Error(`${service.name} exited while the stand waited for: ${what}`)
        if (Date.now() > deadline)
          throw new Error(
            `Waited ${Math.round(timeoutMs / 1000)} s for: ${what}${last ? ` (last error: ${redact(last.message).slice(0, 300)})` : ''}`,
          )
        await rt.pause(intervalMs)
      }
    },
    /** Starts a scenario: its PASS lines are counted in its row of the final table. */
    begin(id, title) {
      scenario = { id, title, checks: 0, notes: 0, ok: false }
      rows.push(scenario)
      rt.setStage(`${id}: ${title}`)
      console.log(`--- ${id} ${title}`)
    },
    end() {
      if (scenario) scenario.ok = true
      scenario = null
    },
    passed(text) {
      if (scenario) scenario.checks += 1
      console.log(`PASS ${redact(text)}`)
    },
    /** A line that is no check: a precondition of the stand, or what it cannot prove here. */
    note(text) {
      if (scenario) scenario.notes += 1
      console.log(`NOTE ${redact(text)}`)
    },
    check(condition, text, detail) {
      if (!condition)
        throw new CheckFailed(
          `${text}${detail === undefined ? '' : `: ${redact(JSON.stringify(detail)).slice(0, 600)}`}`,
        )
      rt.passed(text)
    },
    rows,
  }
  return rt
}

export async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

/**
 * One HTTP(S) request; the body is read whole (at most 16 MiB). Never follows a redirect.
 * `ca` — the stand's CA for https. `host` — the Host header (a preview by its own name).
 */
export function exchange(
  url,
  { method = 'GET', headers = {}, body, ca, timeoutMs = 30_000, signal } = {},
) {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((done, reject) => {
    const req = send(
      {
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        ca,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 16 * 1024 * 1024) response.destroy(new Error('too large'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const bytes = Buffer.concat(chunks)
          const text = bytes.toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            // Only a caller that reads JSON looks at it.
          }
          done({ status: response.statusCode, headers: response.headers, bytes, text, json })
        })
      },
    )
    req.once('error', reject)
    req.end(body)
  })
}

/**
 * A customer of web: a session cookie and tRPC over HTTP, as the browser sends it (superjson's
 * `{ json }`). Every customer comes from an address of its own, as a proxy in front of web
 * reports it (the sign-up limit of better-auth is per address).
 */
export function customerOf(rt, { webUrl, address }) {
  let cookie = ''
  const request = async (path, init = {}) => {
    const response = await fetch(path.startsWith('http') ? path : `${webUrl}${path}`, {
      ...init,
      headers: {
        'x-forwarded-for': address,
        origin: webUrl,
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
      redirect: 'manual',
      signal: AbortSignal.any([rt.signal, AbortSignal.timeout(60_000)]),
    })
    cookie = cookieHeader(response.headers.getSetCookie(), cookie)
    return response
  }
  const call = async (type, path, input) => {
    const response =
      type === 'query'
        ? await request(trpcQueryUrl(webUrl, path, input))
        : await request(`/api/trpc/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ json: input ?? {} }),
          })
    return trpcOutcome(response.status, await response.json().catch(() => null))
  }
  const data = async (type, path, input) => {
    const outcome = await call(type, path, input)
    if (!outcome.ok) throw new CheckFailed(`${path} was refused: ${JSON.stringify(outcome)}`)
    return outcome.data
  }
  return {
    request,
    cookie: () => cookie,
    call,
    query: (path, input) => data('query', path, input),
    mutate: (path, input) => data('mutation', path, input),
  }
}

/**
 * A process of the stand (web, a role of the orchestrator): its output goes to a file of the
 * run directory and stays in memory; SIGTERM stops it as a deployment does, SIGKILL when it
 * does not leave in 20 seconds.
 */
export function startProcess(rt, name, args, { cwd, env, logFile }) {
  const file = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const capture = (chunk) => {
    const text = chunk.toString('utf8')
    if (log.length < 64 * 1024 * 1024) log += text
    file.write(chunk)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise((done) => {
    child.once('error', () => done(null))
    child.once('close', (code) => done(code))
  })
  return {
    name,
    pid: child.pid,
    log: () => log,
    mark: () => log.length,
    since: (mark) => log.slice(mark),
    running: () => child.exitCode === null && child.signalCode === null,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const overdue = setTimeout(() => child.kill('SIGKILL'), 20_000)
        await exited
        clearTimeout(overdue)
      }
      await new Promise((done) => file.end(done))
    },
  }
}

/** The text of a page without its markup, whitespace collapsed: what the scenarios read. */
export const pageText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&laquo;|&#171;/g, '«')
    .replace(/&raquo;|&#187;/g, '»')
    .replace(/\s+/g, ' ')
    .trim()
