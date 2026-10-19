/* global Buffer, console, process, setTimeout, clearTimeout */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { connect, createServer, isIPv4 } from 'node:net'

// Trusted TCP forwarder of a preview (docs/plan/53-chat-preview-release.md, Р18, Р21). Each route
// is one listening address and one fixed target: the entry forwarder publishes the PHP container
// to the host, the browser relay carries the browser's proxy traffic to the preview gateway and
// the control port of the browser to the host loopback. No target is ever taken from a
// connection, and nothing but the target name is resolved.
//
// The entry forwarder (`--http-host=<hostname>`) reads one thing more: the head of the first
// request of a connection, which comes from the platform (the gateway, the mcp role), never from
// the preview. Its published port lives only as long as this container, and Docker gives it to
// another preview once it stops; a caller that still holds the old port must not get another
// client's site. So a request for any other host is answered 421 and never reaches PHP, and a
// request that passes goes on with `Connection: close`: the next request of a pooled connection
// comes on a new connection and is checked again. What PHP answers is never parsed: bytes only.

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const PORT = /^[1-9]\d{0,4}$/
export const READY_FILE = '/run/raditi-forward/ready'
export const forwardLimits = Object.freeze({
  routes: 4,
  /** Per route: a page opens a few dozen connections, a browser a few more. */
  connections: 256,
  connectMs: 10_000,
  /** A connection silent this long is dropped; a long poll of WordPress stays below it. */
  idleMs: 10 * 60_000,
  /** The head of a request, as the gateway sends it (its own server takes 16 KiB of headers). */
  headBytes: 64 * 1024,
  headMs: 30_000,
})

const port = (text) => {
  const value = PORT.test(text ?? '') ? Number(text) : 0
  return value >= 1 && value <= 65_535 ? value : null
}

/** `<listen IPv4>:<port>=<target host>:<port>`; null for anything else. */
export function parseRoute(text) {
  if (typeof text !== 'string' || text.length > 300) return null
  const split = text.indexOf('=')
  if (split < 0) return null
  const listen = text.slice(0, split)
  const target = text.slice(split + 1)
  const listenAt = listen.lastIndexOf(':')
  const targetAt = target.lastIndexOf(':')
  if (listenAt < 0 || targetAt < 0) return null
  const listenHost = listen.slice(0, listenAt)
  const targetHost = target.slice(0, targetAt)
  const listenPort = port(listen.slice(listenAt + 1))
  const targetPort = port(target.slice(targetAt + 1))
  if (!isIPv4(listenHost) || !listenPort || !targetPort) return null
  if (!isIPv4(targetHost) && !HOST.test(targetHost)) return null
  return { listenHost, listenPort, targetHost, targetPort }
}

export function parseRoutes(args) {
  const routes = args.map(parseRoute)
  if (
    routes.length < 1 ||
    routes.length > forwardLimits.routes ||
    routes.some((route) => route === null)
  )
    return null
  const listeners = new Set(routes.map((route) => `${route.listenHost}:${route.listenPort}`))
  return listeners.size === routes.length ? routes : null
}

/** `[--http-host=<hostname>] <route>...`; null for anything else. */
export function parseArgs(args) {
  const [first, ...rest] = args
  if (typeof first === 'string' && first.startsWith('--http-host=')) {
    const httpHost = first.slice('--http-host='.length)
    if (!HOST.test(httpHost)) return null
    const routes = parseRoutes(rest)
    return routes ? { routes, httpHost } : null
  }
  const routes = parseRoutes(args)
  return routes ? { routes, httpHost: null } : null
}

// --- The head of a request (from the platform's side only) ----------------------------------

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection'])
const tokensOf = (value) =>
  value
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())

/**
 * The verdict on the head of a request (without its final empty line): `{ head }` to send on —
 * as it came for an upgrade, else with `Connection: close` in place of the hop-by-hop headers —
 * or `{ status }` to answer: 400 for a head that is not a plain HTTP/1.x request in origin form,
 * 421 for one with any other host than `httpHost` (the port is the public one, not checked).
 */
export function guardRequest(text, httpHost) {
  if (/[^\t\x20-\x7e\x80-\xff\r\n]/.test(text)) return { status: 400 }
  const lines = text.split('\r\n')
  if (lines.some((line) => /[\r\n]/.test(line))) return { status: 400 }
  const [requestLine, ...fields] = lines
  const request = /^(\S+) (\/\S*|\*) HTTP\/1\.[01]$/.exec(requestLine ?? '')
  if (!request || !TOKEN.test(request[1]) || (request[2] === '*' && request[1] !== 'OPTIONS'))
    return { status: 400 }
  const headers = []
  for (const line of fields) {
    // An obsolete folded line, a field without a colon or with a space before it.
    const field = /^([^:\s]+):[\t ]*(.*?)[\t ]*$/.exec(line)
    if (!field || !TOKEN.test(field[1])) return { status: 400 }
    headers.push({ name: field[1].toLowerCase(), line })
  }
  const hosts = headers.filter((header) => header.name === 'host')
  if (hosts.length !== 1) return { status: 400 }
  const host = /^host:[\t ]*([a-z0-9.-]+)(?::\d{1,5})?[\t ]*$/i.exec(hosts[0].line)
  if (!host) return { status: 400 }
  if (host[1].toLowerCase() !== httpHost) return { status: 421 }
  const valueOf = (name) =>
    headers
      .filter((header) => header.name === name)
      .map((header) => header.line.slice(header.line.indexOf(':') + 1))
      .join(',')
  const upgrade =
    headers.some((header) => header.name === 'upgrade') &&
    tokensOf(valueOf('connection')).includes('upgrade')
  if (upgrade) return { head: `${text}\r\n\r\n` }
  return {
    head: `${[
      requestLine,
      ...headers.filter((header) => !HOP_BY_HOP.has(header.name)).map((header) => header.line),
      'Connection: close',
    ].join('\r\n')}\r\n\r\n`,
  }
}

const refusal = (status) => {
  const body = Buffer.from(
    'Предпросмотр по этому адресу сейчас недоступен. Обновите страницу через несколько секунд.\n',
  )
  const reason = status === 421 ? 'Misdirected Request' : 'Bad Request'
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`,
    ),
    body,
  ])
}

/** Reads up to the end of the first head; resolves `{ head, rest }`, or null when it never ends. */
function readHead(client, limits) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    const done = (value) => {
      clearTimeout(timer)
      client.off('data', onData)
      client.off('end', onEnd)
      client.pause()
      resolve(value)
    }
    const onEnd = () => done(null)
    const onData = (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      const bytes = Buffer.concat(chunks)
      const end = bytes.indexOf('\r\n\r\n')
      if (end >= 0 && end + 4 <= limits.headBytes)
        done({ head: bytes.subarray(0, end).toString('latin1'), rest: bytes.subarray(end + 4) })
      else if (size >= limits.headBytes) done(null)
    }
    const timer = setTimeout(() => done(null), limits.headMs)
    client.on('data', onData)
    client.once('end', onEnd)
    client.resume()
  })
}

/**
 * Starts every route; resolves once all of them listen. `connectTo` is the outgoing side,
 * injected by tests; `httpHost` makes every route the entry of that one host.
 */
export async function forward(
  routes,
  { connectTo = connect, limits = forwardLimits, httpHost = null } = {},
) {
  const servers = routes.map((route) => {
    let open = 0
    // Half-open both ways: a side that finished sending still gets the other side's answer.
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (client) => {
      if (open >= limits.connections) {
        client.destroy()
        return
      }
      open++
      let closed = false
      let upstream = null
      let timer = null
      const close = () => {
        if (closed) return
        closed = true
        open--
        clearTimeout(timer)
        client.destroy()
        upstream?.destroy()
      }
      client.setTimeout(limits.idleMs, close)
      client.once('error', close)
      client.once('close', close)
      const relay = (prefix) => {
        if (closed) return
        upstream = connectTo({
          host: route.targetHost,
          port: route.targetPort,
          allowHalfOpen: true,
        })
        timer = setTimeout(() => upstream.destroy(), limits.connectMs)
        upstream.setTimeout(limits.idleMs, close)
        upstream.once('error', close)
        upstream.once('close', close)
        upstream.once('connect', () => {
          clearTimeout(timer)
          if (prefix.length) upstream.write(prefix)
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
        })
      }
      if (!httpHost) {
        relay(Buffer.alloc(0))
        return
      }
      void readHead(client, limits).then((read) => {
        if (closed) return
        if (!read) {
          close()
          return
        }
        const verdict = guardRequest(read.head, httpHost)
        if (verdict.status) {
          // Whatever else the client sends is dropped; it closes on the answer.
          client.resume()
          client.end(refusal(verdict.status))
          return
        }
        relay(Buffer.concat([Buffer.from(verdict.head, 'latin1'), read.rest]))
      })
    })
    server.maxConnections = limits.connections
    return { route, server }
  })
  await Promise.all(
    servers.map(
      ({ route, server }) =>
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(route.listenPort, route.listenHost, resolve)
        }),
    ),
  )
  return {
    addresses: servers.map(({ server }) => server.address()),
    close: () =>
      Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))),
  }
}

if (process.argv[1]?.endsWith('/forward.mjs')) {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed) {
    console.error(
      'Usage: forward.mjs [--http-host=<hostname>] <listen IPv4>:<port>=<target host>:<port> ...',
    )
    process.exit(2)
  }
  forward(parsed.routes, { httpHost: parsed.httpHost }).then(
    (running) => {
      mkdirSync('/run/raditi-forward', { recursive: true, mode: 0o700 })
      writeFileSync(`${READY_FILE}.tmp`, 'ready\n', { mode: 0o600 })
      renameSync(`${READY_FILE}.tmp`, READY_FILE)
      const stop = () => void running.close().finally(() => process.exit(0))
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    },
    () => {
      console.error('Preview forwarder could not listen')
      process.exit(1)
    },
  )
}
