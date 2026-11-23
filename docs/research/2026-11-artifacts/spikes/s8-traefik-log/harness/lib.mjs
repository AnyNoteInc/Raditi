// Shared helpers of spike s8: Docker, raw requests, markers.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const WHOAMI =
  'ghcr.io/traefik/whoami@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44'
export const NET = 'spike88-s8-net'

/** The stand's self-signed certificate is the only CA the clients trust (prepare.mjs makes it). */
let trusted
export function trustCa(pem) {
  trusted = pem
}

export async function docker(args, { allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await run('docker', args, { maxBuffer: 256 * 1024 * 1024 })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    if (!allowFail) throw new Error(`docker ${args.join(' ')}: ${error.stderr || error.message}`)
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
  }
}

/** stdout and stderr of a container, kept apart. */
export async function logsOf(name) {
  const { stdout, stderr } = await docker(['logs', name], { allowFail: true })
  return { stdout, stderr }
}

export async function publishedPort(name, port) {
  const { stdout } = await docker(['port', name, `${port}/tcp`])
  const line = stdout.split('\n').find((l) => l.startsWith('127.0.0.1:'))
  if (!line) throw new Error(`${name} publishes no ${port} on 127.0.0.1: ${stdout}`)
  return Number(line.split(':')[1])
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A unique alphanumeric marker: it survives any escaping the log may do. */
export const marker = (kind, id) => `S8${kind}${id}x${randomBytes(6).toString('hex')}`

/**
 * One raw HTTP/1.1 exchange over TLS (or plain TCP): the bytes are sent as given, so any request
 * target can be tried. Returns the status line and the first bytes of the answer.
 */
export function rawExchange({ port, servername, request, plain = false, readBytes = 64 * 1024, abortAfterBytes }) {
  return new Promise((resolve) => {
    const socket = plain
      ? net.connect({ host: '127.0.0.1', port })
      : tls.connect({ host: '127.0.0.1', port, servername, ca: trusted, ALPNProtocols: ['http/1.1'] })
    let data = Buffer.alloc(0)
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      socket.destroy()
      const text = data.toString('latin1')
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(text)?.[1] ?? null
      resolve({ status: status && Number(status), head: text.slice(0, 600), bytes: data.length, why })
    }
    socket.setTimeout(8000, () => finish('timeout'))
    socket.on(plain ? 'connect' : 'secureConnect', () => {
      for (const part of Array.isArray(request) ? request : [request]) socket.write(part)
    })
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (abortAfterBytes && data.length >= abortAfterBytes) finish('aborted by client')
      else if (data.length >= readBytes) finish('enough')
    })
    socket.on('end', () => finish('end'))
    socket.on('close', () => finish('close'))
    socket.on('error', (error) => finish(`error: ${error.code ?? error.message}`))
  })
}

/** One HTTP/2 request with the given pseudo-headers; the client is closed after it. */
export function h2Exchange({ port, servername, headers }) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { client.close() } catch {}
      resolve(value)
    }
    const client = http2.connect(`https://${servername}`, {
      createConnection: () =>
        tls.connect({ host: '127.0.0.1', port, servername, ca: trusted, ALPNProtocols: ['h2'] }),
    })
    client.on('error', (error) => done({ status: null, why: `error: ${error.code ?? error.message}` }))
    let request
    try {
      request = client.request(headers)
    } catch (error) {
      done({ status: null, why: `client refused: ${error.code ?? error.message}` })
      return
    }
    let body = ''
    let status = null
    request.on('response', (h) => { status = h[':status'] })
    request.setEncoding('utf8')
    request.on('data', (chunk) => { if (body.length < 4000) body += chunk })
    request.on('end', () => done({ status, head: body.slice(0, 600), why: 'end' }))
    request.on('error', (error) => done({ status, why: `error: ${error.code ?? error.message}` }))
    request.setTimeout(8000, () => done({ status, why: 'timeout' }))
    request.end()
  })
}

/** Every JSON line of a log text, parsed; other lines as { raw }. */
export function lines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    })
}
