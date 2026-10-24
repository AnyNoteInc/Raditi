/* global console, process */
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createServer, request as httpRequest } from 'node:http'
import { BlockList, connect, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { clearTimeout, setTimeout } from 'node:timers'

// The client egress proxy (docs/plan/53-chat-preview-release.md, Р13): the only way from the
// agent's shell commands (a listener of its own on sandbox-gw) and from a preview's PHP (its own
// container, PREVIEW_EGRESS_IMAGE) to the hosts the client's variables lead to. Plain HTTP on an
// internal network, CONNECT only: the client's own TLS goes through the tunnel untouched, and a
// request in plain HTTP is never forwarded. A CONNECT target must be one `host:port` of the list,
// a DNS name. The name is resolved at every connection, here; one address that is not public —
// private, loopback, link-local and the metadata service, CGNAT, ULA, multicast, this network,
// the platform's own subnets and those of this container's interfaces, the Docker bridge
// included — refuses the connection, and the tunnel goes to an address that was checked, never
// to a name resolved a second time. A tunnel carries TLS whose ClientHello names that very host
// (SNI): the listed name, not merely its address — a host on a shared front end (a CDN, shared
// hosting) shares its addresses with any other site there, so a tunnel without SNI, with another
// name, with an encrypted ClientHello (ECH) or with anything but TLS is closed before a byte of it
// reaches the far side. The log has the listed host, the result, the duration and the bytes:
// never what a client wrote, never a path, a value or a name it sent.
//
// One exception, outside production only: the browser of a task (docs/plan/57-browser-tasks.md,
// Б11) on a disposable local site of a stand. LOCAL_HTTP_ROUTES maps the exact `host:port` of
// such a site's plain-http origin to a fixed `host:port` it is served at; a request in absolute
// form for that very `host:port` (and a Host header naming it) is forwarded there as it came,
// its Host kept, the name never resolved nor checked — the target is the operator's, not the
// page's. A CONNECT to that very `host:port` is a tunnel to the same target: Playwright's request
// API (the trusted read of a task's browser) tunnels plain HTTP too; its first request must be
// whole plain HTTP of that site before a byte of it goes on. Everything else is as above. The option is refused unless RADITI_EGRESS_LOCAL_ROUTES=1
// is set next to it, and always when APP_ENV is `production`: whoever starts this proxy with it
// says on purpose that it serves a stand.

export const clientEgressLimits = Object.freeze({
  /** `host:port` of one proxy (a preview's take up to 256, PreviewRuntimeSpec.egress). */
  hosts: 256,
  /** Tunnels (and forwarded local requests) at once; MAX_TUNNELS sets 1 to `maxTunnels`. */
  tunnels: 32,
  maxTunnels: 256,
  /** LOCAL_HTTP_ROUTES of one proxy. */
  localRoutes: 16,
  connectMs: 10_000,
  /** From the 200 to the whole ClientHello. */
  helloMs: 10_000,
  idleMs: 5 * 60_000,
  closeGraceMs: 5_000,
})

/** The largest ClientHello read: post-quantum key shares make it ~2 KiB, nothing needs 64. */
const HELLO_MAX_BYTES = 64 * 1024
/** What a tunnel buffers waiting for its whole ClientHello, record headers included. */
const HELLO_BUFFER_BYTES = 4 * HELLO_MAX_BYTES
/** A TLS record carries at most 2^14 bytes of plaintext, a little more on the wire. */
const RECORD_MAX_BYTES = 16_384 + 2_048
const TLS_HANDSHAKE = 22
const CLIENT_HELLO = 1
const EXTENSION_SERVER_NAME = 0x0000
/** encrypted_client_hello (RFC 9849) and the draft ESNI: the real name would be hidden. */
const EXTENSIONS_HIDING_NAME = new Set([0xfe0d, 0xffce])
const SNI_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The server name of the TLS ClientHello at the start of `bytes`, the handshake reassembled from
 * as many records as it took: `{state: 'more'}` while it is not whole yet, `{state: 'name', name}`
 * (lower case), or `{state: 'refused'}` — not TLS, not a ClientHello, no server name, two of them,
 * a name hidden by ECH, or anything malformed or too large.
 */
export function clientHelloServerName(bytes) {
  const refused = { state: 'refused' }
  const fragments = []
  let length = 0
  let needed = null
  for (let offset = 0; ;) {
    if (bytes.length < offset + 5) return { state: 'more' }
    const [type, major, minor] = [bytes[offset], bytes[offset + 1], bytes[offset + 2]]
    const size = bytes.readUInt16BE(offset + 3)
    if (type !== TLS_HANDSHAKE || major !== 3 || minor > 4 || size === 0) return refused
    if (size > RECORD_MAX_BYTES) return refused
    if (bytes.length < offset + 5 + size) return { state: 'more' }
    fragments.push(bytes.subarray(offset + 5, offset + 5 + size))
    length += size
    offset += 5 + size
    if (needed === null && length >= 4) {
      const head = Buffer.concat(fragments)
      if (head[0] !== CLIENT_HELLO) return refused
      needed = 4 + head.readUIntBE(1, 3)
      if (needed > HELLO_MAX_BYTES) return refused
    }
    if (needed !== null && length >= needed) break
    if (length > HELLO_MAX_BYTES) return refused
  }
  const hello = Buffer.concat(fragments).subarray(4, needed)
  return serverNameOf(hello) ?? refused
}

/** The name of a ClientHello body; null when it has none it may be let through with. */
function serverNameOf(body) {
  let at = 2 + 32
  const skip = (lengthBytes, check = () => true) => {
    if (body.length < at + lengthBytes) return false
    const size = body.readUIntBE(at, lengthBytes)
    if (!check(size) || body.length < at + lengthBytes + size) return false
    at += lengthBytes + size
    return true
  }
  if (body.length < at) return null
  if (!skip(1, (size) => size <= 32)) return null
  if (!skip(2, (size) => size >= 2 && size % 2 === 0)) return null
  if (!skip(1, (size) => size >= 1)) return null
  if (body.length < at + 2) return null
  const end = at + 2 + body.readUInt16BE(at)
  if (end !== body.length) return null
  at += 2
  let name = null
  const types = new Set()
  while (at < end) {
    if (end < at + 4) return null
    const type = body.readUInt16BE(at)
    const size = body.readUInt16BE(at + 2)
    const data = body.subarray(at + 4, at + 4 + size)
    if (data.length !== size || types.has(type)) return null
    types.add(type)
    at += 4 + size
    if (EXTENSIONS_HIDING_NAME.has(type)) return null
    if (type !== EXTENSION_SERVER_NAME) continue
    // ServerNameList: one host_name, nothing else.
    if (size < 5 || data.readUInt16BE(0) !== size - 2 || data[2] !== 0) return null
    const nameLength = data.readUInt16BE(3)
    if (nameLength !== size - 5 || nameLength === 0 || nameLength > 253) return null
    name = data.subarray(5).toString('latin1').toLowerCase()
    if (!SNI_NAME.test(name)) return null
  }
  return name === null ? null : { state: 'name', name }
}

// The rule of the platform's site addresses with nothing local allowed (@repo/domain,
// isEgressAddressAllowed), and the documentation and relay ranges no service lives in, as on the
// LLM egress node (infra/egress/llm-egress.mjs). A test holds the two to the domain's rule.
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
// Global unicast is 2000::/3 without Teredo, documentation and 6to4, which carry or stand for
// another address. Everything else of IPv6 — loopback, `::`, ULA, link-local, multicast,
// IPv4-mapped, NAT64 — is outside it.
const PUBLIC_IPV6 = [['2000::', 3]]
const BLOCKED_IPV6 = [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
]

const NAME =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+):([1-9][0-9]{0,4})$/
/** `127.1`, `0x7f.1`, `2130706433`: the forms a resolver may read as an address. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/
/** Zones that never leave a local network, or never resolve. */
const LOCAL_ZONE = /(?:^|\.)(?:localhost|local|internal|test|lan|home|invalid|onion)$/

/** A `host:port` of the list: a public DNS name in lower case and a port; null for anything else. */
export function parseTarget(text) {
  const match = NAME.exec(text)
  if (!match) return null
  const [, host, port] = match
  const labels = host.split('.')
  if (
    host.length > 253 ||
    Number(port) > 65_535 ||
    labels.every((label) => NUMERIC_LABEL.test(label)) ||
    !/[a-z]/.test(labels.at(-1)) ||
    LOCAL_ZONE.test(host)
  )
    return null
  return { host, port: Number(port) }
}

/**
 * ALLOWED_HOSTS: a JSON array of `host:port`, each once. Empty only with `empty` — a proxy of a
 * stand whose browser goes to its local sites alone.
 */
export function parseAllowedHosts(json, { empty = false } = {}) {
  let list
  try {
    list = JSON.parse(json ?? '')
  } catch {
    throw new Error('ALLOWED_HOSTS is not a JSON array')
  }
  if (
    !Array.isArray(list) ||
    (list.length === 0 && !empty) ||
    list.length > clientEgressLimits.hosts
  )
    throw new Error(`ALLOWED_HOSTS must list 1 to ${clientEgressLimits.hosts} hosts`)
  for (const item of list)
    if (typeof item !== 'string' || parseTarget(item) === null)
      throw new Error('ALLOWED_HOSTS holds an entry that is not a public host:port')
  const allow = new Set(list)
  if (allow.size !== list.length) throw new Error('ALLOWED_HOSTS repeats a host')
  return allow
}

const LOCAL_KEY =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*):([1-9][0-9]{0,4})$/
const LOCAL_TARGET = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):([1-9][0-9]{0,4})$/

/**
 * LOCAL_HTTP_ROUTES: a JSON object of 1 to 16 entries, the exact `host:port` of a local site
 * (a name, never an address; lower case, the port always written) → the fixed `host:port` it is
 * served at (an IPv4 address or a name this container resolves, `host.docker.internal`, say).
 * A Map of the key to `{ host, port }`; throws on anything else.
 */
export function parseLocalRoutes(json) {
  let routes
  try {
    routes = JSON.parse(json ?? '')
  } catch {
    throw new Error('LOCAL_HTTP_ROUTES is not a JSON object')
  }
  if (typeof routes !== 'object' || routes === null || Array.isArray(routes))
    throw new Error('LOCAL_HTTP_ROUTES is not a JSON object')
  const entries = Object.entries(routes)
  if (entries.length === 0 || entries.length > clientEgressLimits.localRoutes)
    throw new Error(`LOCAL_HTTP_ROUTES must hold 1 to ${clientEgressLimits.localRoutes} routes`)
  const map = new Map()
  for (const [key, value] of entries) {
    const site = LOCAL_KEY.exec(key)
    const target = typeof value === 'string' ? LOCAL_TARGET.exec(value) : null
    if (
      !site ||
      !/[a-z]/.test(site[1].split('.').at(-1)) ||
      Number(site[2]) > 65_535 ||
      !target ||
      Number(target[2]) > 65_535 ||
      (!isIP(target[1]) && !/[a-z]/.test(target[1].split('.').at(-1)))
    )
      throw new Error('LOCAL_HTTP_ROUTES holds an entry that is not a local name and a target')
    map.set(key, { host: target[1], port: Number(target[2]) })
  }
  return map
}

/** REFUSED_SUBNETS: the platform's own subnets, comma-separated CIDR; empty — none. */
export function parseSubnets(text) {
  const subnets = []
  for (const item of (text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address, prefix, ...rest] = item.split('/')
    const family = isIP(address ?? '')
    const bits = Number(prefix)
    if (
      rest.length ||
      !family ||
      !/^(?:0|[1-9]\d{0,2})$/.test(prefix ?? '') ||
      bits > (family === 4 ? 32 : 128)
    )
      throw new Error('REFUSED_SUBNETS holds an entry that is not a CIDR subnet')
    subnets.push({ address, prefix: bits, family })
  }
  return subnets
}

/** The subnets of this container's own interfaces: the Docker bridge and the internal network. */
export function interfaceSubnets(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((entry) => entry && typeof entry.cidr === 'string')
    .map((entry) => {
      const [address, prefix] = entry.cidr.split('/')
      return { address, prefix: Number(prefix), family: isIP(address) }
    })
    .filter((subnet) => subnet.family !== 0)
}

/**
 * Whether the proxy may connect to a resolved address: public unicast and in none of `refused`
 * (the platform's subnets and those of this container's interfaces).
 */
export function addressCheck(refused = []) {
  const blocked = new BlockList()
  for (const [network, prefix] of BLOCKED_IPV4) blocked.addSubnet(network, prefix, 'ipv4')
  for (const [network, prefix] of BLOCKED_IPV6) blocked.addSubnet(network, prefix, 'ipv6')
  for (const subnet of refused)
    blocked.addSubnet(subnet.address, subnet.prefix, subnet.family === 4 ? 'ipv4' : 'ipv6')
  const public6 = new BlockList()
  for (const [network, prefix] of PUBLIC_IPV6) public6.addSubnet(network, prefix, 'ipv6')
  return (address) => {
    const family = isIP(address)
    if (family === 4) return !blocked.check(address, 'ipv4')
    if (family === 6) return public6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
    return false
  }
}

/** Methods a page of a local site sends in plain HTTP; anything else is answered 405. */
const LOCAL_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
/** Of one connection or of the proxy: never passed on (RFC 9110, 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
])

/** The headers to pass on: hop-by-hop ones and those `Connection` names left out. */
function endToEnd(headers, drop = []) {
  const named = String(headers.connection ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !HOP_BY_HOP.has(name) && !named.includes(name) && !drop.includes(name),
    ),
  )
}

/**
 * The local route of a plain-http request: its URL in absolute form names the exact `host:port`
 * of a route (port 80 when none is written). null for anything else — origin form, another
 * scheme, credentials, another method.
 */
function localRequestOf(req, routes) {
  if (!LOCAL_METHODS.has(req.method)) return null
  const raw = String(req.url ?? '')
  if (!raw.startsWith('http://')) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  const key = `${url.hostname}:${url.port === '' ? 80 : url.port}`
  const target = routes.get(key)
  return target ? { key, target, path: `${url.pathname}${url.search}` } : null
}

/** `host:port` a Host header names, port 80 when none is written; null when malformed. */
function hostKeyOf(header) {
  const match = /^([a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/.exec(String(header ?? '').toLowerCase())
  return match ? `${match[1]}:${match[2] ?? 80}` : null
}

/** The head of the first request in a local tunnel is read up to this size. */
const LOCAL_HEAD_BYTES = 16 * 1024

/**
 * Whether the head of the first request in a local tunnel (up to its blank line) is plain HTTP of
 * that very site: a method of LOCAL_METHODS, an origin-form path and one Host naming the route.
 */
export function localTunnelHeadAllowed(head, key) {
  const [line, ...fields] = head.toString('latin1').split('\r\n')
  const request = /^([A-Z]+) (\/\S*) HTTP\/1\.[01]$/.exec(line ?? '')
  if (!request || !LOCAL_METHODS.has(request[1])) return false
  const hosts = fields.filter((field) => /^host:/i.test(field))
  return hosts.length === 1 && hostKeyOf(hosts[0].slice(5).trim()) === key
}

const resolveAll = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address)
const dialTcp = ({ address, port }) => connect({ host: address, port, family: isIP(address) })
const logJson = (entry) => console.log(JSON.stringify(entry))

/**
 * `allow` — the `host:port` of the list; `refused` — subnets never connected to besides the
 * non-public ones; `clientIp` — the only address a request is taken from (sandbox-gw: the
 * sandbox's), or null on a network only the preview's own containers share; `localRoutes` — the
 * plain-http routes of local sites (parseLocalRoutes; a stand's only, the caller checked that).
 * `lookup` and `dial` are replaced only by tests.
 */
export function createClientEgressProxy({
  allow,
  refused = [],
  clientIp = null,
  localRoutes = new Map(),
  maxTunnels = clientEgressLimits.tunnels,
  connectTimeoutMs = clientEgressLimits.connectMs,
  helloMs = clientEgressLimits.helloMs,
  idleMs = clientEgressLimits.idleMs,
  closeGraceMs = clientEgressLimits.closeGraceMs,
  lookup = resolveAll,
  dial = dialTcp,
  log = logJson,
}) {
  const allowed = addressCheck(refused)
  let tunnels = 0

  const refuse = (socket, status, reason, result) => {
    if (!socket.destroyed)
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\nraditi-egress: ${result}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
      )
  }

  /** A plain-http request of a local site, to its fixed target; the log has the route only. */
  const forwardLocal = (req, res, local) => {
    const started = Date.now()
    const done = (result, status) =>
      log({
        event: 'request',
        host: local.key,
        result,
        ms: Date.now() - started,
        ...(status ? { status } : {}),
      })
    const deny = (status, result) => {
      res.writeHead(status, { connection: 'close', 'content-length': 0, 'raditi-egress': result })
      res.end()
      done(result)
    }
    if (clientIp !== null && req.socket.remoteAddress !== clientIp)
      return deny(403, 'forbidden_client')
    // The page names one site in its URL and its Host alike: never another behind a route.
    if (hostKeyOf(req.headers.host) !== local.key) return deny(403, 'forbidden_host')
    if (tunnels >= maxTunnels) return deny(503, 'busy')

    tunnels += 1
    let finished = false
    const finish = (result, status) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      tunnels -= 1
      upstream.destroy()
      done(result, status)
    }
    const fail = (status, result) => {
      if (finished) return
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(status, { connection: 'close', 'content-length': 0, 'raditi-egress': result })
        res.end()
      }
      finish(result)
    }
    const upstream = httpRequest({
      host: local.target.host,
      port: local.target.port,
      method: req.method,
      path: local.path,
      // The Host of the page: the local site serves its own name.
      headers: endToEnd(req.headers),
      setHost: false,
      agent: false,
    })
    const deadline = setTimeout(() => fail(504, 'connect_timeout'), connectTimeoutMs)
    deadline.unref()
    upstream.once('socket', (socket) => socket.once('connect', () => clearTimeout(deadline)))
    upstream.setTimeout(idleMs, () => fail(504, 'idle'))
    upstream.on('error', () => fail(502, 'connect_error'))
    upstream.once('response', (answer) => {
      // One request a connection: nothing of a route lingers between the page's requests.
      res.writeHead(answer.statusCode ?? 502, {
        ...endToEnd(answer.headers, ['transfer-encoding']),
        connection: 'close',
      })
      answer.on('error', () => fail(502, 'upstream_error'))
      res.once('finish', () => finish('ok', answer.statusCode))
      answer.pipe(res)
    })
    res.once('close', () => finish(res.writableFinished ? 'ok' : 'client_closed'))
    req.on('error', () => finish('client_error'))
    req.pipe(upstream)
  }

  /**
   * A CONNECT to a local route: a tunnel to its fixed target, the name never resolved nor checked.
   * Its first request must be whole plain HTTP of that site (`localTunnelHeadAllowed`) before a
   * byte of it reaches the target; the target being the operator's, nothing after it is read.
   */
  const tunnelLocal = (socket, head, local, done) => {
    tunnels += 1
    let upstream = null
    let open = false
    let finished = false
    let closing = false
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      tunnels -= 1
      socket.destroy()
      upstream?.destroy()
      done(result, upstream && { up: upstream.bytesWritten, down: upstream.bytesRead })
    }
    socket.on('close', () => finish(open ? 'ok' : 'client_closed'))
    socket.on('error', () => finish('client_error'))
    socket.once('end', () => {
      if (!open) finish('client_closed')
    })
    const fail = (status, reason, result) => {
      if (finished || closing) return
      closing = true
      clearTimeout(deadline)
      socket.once('finish', () => finish(result))
      refuse(socket, status, reason, result)
      upstream?.destroy()
    }
    const deadline = setTimeout(
      () => fail(504, 'Gateway Timeout', 'connect_timeout'),
      connectTimeoutMs,
    )
    deadline.unref()
    try {
      upstream = dial({ address: local.host, port: local.port })
    } catch {
      return fail(502, 'Bad Gateway', 'connect_error')
    }
    const onError = () => fail(502, 'Bad Gateway', 'connect_error')
    upstream.once('error', onError)
    upstream.once('connect', () => {
      upstream.removeListener('error', onError)
      if (finished || closing) return upstream.destroy()
      clearTimeout(deadline)
      upstream.on('error', () => finish('upstream_error'))
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      let first = Buffer.from(head)
      const headDeadline = setTimeout(() => finish('forbidden_request'), helloMs)
      headDeadline.unref()
      const onData = (chunk) => {
        first = Buffer.concat([first, chunk])
        check()
      }
      const check = () => {
        const end = first.indexOf('\r\n\r\n')
        if (end < 0 && first.length <= LOCAL_HEAD_BYTES) return false
        socket.pause()
        socket.removeListener('data', onData)
        clearTimeout(headDeadline)
        if (end < 0 || !localTunnelHeadAllowed(first.subarray(0, end), local.key)) {
          finish('forbidden_request')
          return true
        }
        open = true
        const idle = () => finish('idle')
        upstream.setTimeout(idleMs, idle)
        socket.setTimeout(idleMs, idle)
        upstream.write(first)
        socket.pipe(upstream)
        upstream.pipe(socket)
        return true
      }
      if (!check()) socket.on('data', onData)
    })
  }

  // Nothing but CONNECT: a request in plain HTTP would carry the client's data in the clear and
  // let a page of the preview reach whatever its URL names. A local site of a stand alone is
  // the exception (LOCAL_HTTP_ROUTES).
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const local = localRoutes.size > 0 ? localRequestOf(req, localRoutes) : null
    if (local) return forwardLocal(req, res, local)
    res.writeHead(405, {
      'content-type': 'text/plain',
      connection: 'close',
      'raditi-egress': 'method',
    })
    res.end('Only HTTPS through CONNECT\n')
    log({ event: 'request', result: 'method' })
  })

  server.on('connect', async (req, socket, head) => {
    // Node takes the HTTP server's own error handler off a CONNECT socket: a client that resets
    // mid-answer must not end the process (on sandbox-gw, the LLM and MCP gateway with it).
    socket.on('error', () => socket.destroy())
    const started = Date.now()
    const target = String(req.url ?? '').toLowerCase()
    const local = localRoutes.get(target)
    // Only a listed value reaches the log, never what the client wrote.
    const entry = { event: 'connect', host: allow.has(target) || local ? target : null }
    const done = (result, bytes) =>
      log({ ...entry, result, ms: Date.now() - started, ...(bytes ?? {}) })
    const deny = (status, reason, result) => {
      refuse(socket, status, reason, result)
      done(result)
    }
    if (clientIp !== null && socket.remoteAddress !== clientIp)
      return deny(403, 'Forbidden', 'forbidden_client')
    if (local) {
      if (tunnels >= maxTunnels) return deny(503, 'Service Unavailable', 'busy')
      return tunnelLocal(socket, head, { key: target, ...local }, done)
    }
    const parsed = entry.host === null ? null : parseTarget(entry.host)
    if (parsed === null) return deny(403, 'Forbidden', 'forbidden_host')
    if (tunnels >= maxTunnels) return deny(503, 'Service Unavailable', 'busy')

    tunnels += 1
    let upstream
    let open = false
    let finished = false
    let closing = false
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      tunnels -= 1
      socket.destroy()
      upstream?.destroy()
      done(result, upstream && { up: upstream.bytesWritten, down: upstream.bytesRead })
    }
    socket.on('close', () => finish(open ? 'ok' : 'client_closed'))
    socket.on('error', () => finish('client_error'))
    // The server keeps a half-open socket: a client that ends before its tunnel is open (before
    // the name resolved, while its hello is awaited) has nothing more to come.
    socket.once('end', () => {
      if (!open) finish('client_closed')
    })
    const fail = (status, reason, result) => {
      if (finished || closing) return
      closing = true
      clearTimeout(deadline)
      socket.once('finish', () => finish(result))
      refuse(socket, status, reason, result)
      upstream?.destroy()
    }
    // One deadline for the name and every address tried: socket timeouts start too late.
    const deadline = setTimeout(
      () => fail(504, 'Gateway Timeout', 'connect_timeout'),
      connectTimeoutMs,
    )
    deadline.unref()

    let addresses = null
    try {
      addresses = await lookup(parsed.host)
    } catch {
      // Reported below as a failed resolution.
    }
    if (finished || closing) return
    if (!Array.isArray(addresses) || addresses.length === 0)
      return fail(502, 'Bad Gateway', 'resolve')
    // Any address that is not public refuses the name: a resolver that answers with a public and
    // a private one at once must not get the choice.
    if (!addresses.every((address) => allowed(address)))
      return fail(403, 'Forbidden', 'forbidden_address')
    // IPv4 first: the containers of the platform have no IPv6 route.
    const candidates = [
      ...addresses.filter((address) => isIP(address) === 4),
      ...addresses.filter((address) => isIP(address) === 6),
    ]

    const attempt = (index) => {
      if (finished || closing) return
      if (index >= candidates.length) return fail(502, 'Bad Gateway', 'connect_error')
      let candidate
      try {
        // The checked address itself: no second resolution between the check and the connection.
        candidate = dial({ address: candidates[index], port: parsed.port })
      } catch {
        return attempt(index + 1)
      }
      upstream = candidate
      const onError = () => {
        candidate.destroy()
        attempt(index + 1)
      }
      candidate.once('error', onError)
      candidate.once('connect', () => {
        candidate.removeListener('error', onError)
        if (finished || closing) return candidate.destroy()
        clearTimeout(deadline)
        candidate.on('error', () => finish('upstream_error'))
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        // Nothing reaches the far side before the ClientHello is whole and names the listed
        // host: on a shared front end the address alone would let any of its sites through.
        let hello = Buffer.from(head)
        const helloDeadline = setTimeout(() => finish('forbidden_sni'), helloMs)
        helloDeadline.unref()
        const onHello = (chunk) => {
          hello = Buffer.concat([hello, chunk])
          checkHello()
        }
        const checkHello = () => {
          const seen = clientHelloServerName(hello)
          // Records of a byte or two would make a whole hello large: past this it is refused.
          if (seen.state === 'more' && hello.length <= HELLO_BUFFER_BYTES) return false
          socket.pause()
          socket.removeListener('data', onHello)
          clearTimeout(helloDeadline)
          if (seen.state !== 'name' || seen.name !== parsed.host) {
            finish('forbidden_sni')
            return true
          }
          tunnel(hello)
          return true
        }
        if (!checkHello()) socket.on('data', onHello)
      })
    }
    const tunnel = (hello) => {
      const candidate = upstream
      if (finished || closing) return
      // The far side went away while the client was still sending its hello.
      if (candidate.destroyed) return finish('upstream_error')
      open = true
      const idle = () => finish('idle')
      candidate.setTimeout(idleMs, idle)
      socket.setTimeout(idleMs, idle)
      candidate.write(hello)
      socket.pipe(candidate)
      candidate.pipe(socket)
      // The far side closed first: what the client still sends has nowhere to go and is read
      // away, so its close is seen; a client that never closes is cut after a short grace,
      // counted from the moment the whole answer has left the proxy.
      candidate.once('close', () => {
        if (finished) return
        socket.resume()
        let grace
        const arm = () => {
          if (finished) return
          grace = setTimeout(() => finish('client_lingered'), closeGraceMs)
          grace.unref()
        }
        if (socket.writableFinished) arm()
        else socket.once('finish', arm)
        socket.once('close', () => clearTimeout(grace))
      })
    }
    attempt(0)
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.maxHeadersCount = 32
  // Tunnels plus a few requests on their way; beyond that new connections are dropped.
  server.maxConnections = maxTunnels + 8
  return server
}

/**
 * LOCAL_HTTP_ROUTES as the environment allows it: only with RADITI_EGRESS_LOCAL_ROUTES=1 and
 * never with APP_ENV=production; none when it is unset.
 */
function localRoutesOf(env) {
  if (!env.LOCAL_HTTP_ROUTES) return new Map()
  if (env.RADITI_EGRESS_LOCAL_ROUTES !== '1')
    throw new Error('LOCAL_HTTP_ROUTES needs RADITI_EGRESS_LOCAL_ROUTES=1')
  if (env.APP_ENV === 'production') throw new Error('LOCAL_HTTP_ROUTES is refused in production')
  return parseLocalRoutes(env.LOCAL_HTTP_ROUTES)
}

/** MAX_TUNNELS: 1 to 256; unset — 32. */
function maxTunnelsOf(text) {
  if (text === undefined || text === '') return clientEgressLimits.tunnels
  const value = /^[1-9]\d{0,2}$/.test(text) ? Number(text) : 0
  if (value < 1 || value > clientEgressLimits.maxTunnels)
    throw new Error(`MAX_TUNNELS must be 1 to ${clientEgressLimits.maxTunnels}`)
  return value
}

/**
 * The proxy as an environment describes it: LISTEN_HOST (an IPv4 address), LISTEN_PORT,
 * ALLOWED_HOSTS, REFUSED_SUBNETS, CLIENT_IPV4 and MAX_TUNNELS (optional), LOCAL_HTTP_ROUTES
 * (optional, outside production, with RADITI_EGRESS_LOCAL_ROUTES=1; ALLOWED_HOSTS may then be
 * `[]`). Throws on anything else.
 */
export function clientEgressConfig(env) {
  const listenHost = env.LISTEN_HOST ?? ''
  const listenPort = Number(env.LISTEN_PORT)
  if (isIP(listenHost) !== 4) throw new Error('LISTEN_HOST must be an IPv4 address')
  if (!/^[1-9]\d{0,4}$/.test(env.LISTEN_PORT ?? '') || listenPort > 65_535)
    throw new Error('LISTEN_PORT must be a port')
  const clientIp = env.CLIENT_IPV4 ? env.CLIENT_IPV4 : null
  if (clientIp !== null && isIP(clientIp) !== 4)
    throw new Error('CLIENT_IPV4 must be an IPv4 address')
  const localRoutes = localRoutesOf(env)
  return {
    listenHost,
    listenPort,
    allow: parseAllowedHosts(env.ALLOWED_HOSTS, { empty: localRoutes.size > 0 }),
    refused: [...parseSubnets(env.REFUSED_SUBNETS), ...interfaceSubnets()],
    clientIp,
    maxTunnels: maxTunnelsOf(env.MAX_TUNNELS),
    localRoutes,
  }
}

/** Starts the proxy of a configuration; resolves once it listens. */
export function listenClientEgress(config, options = {}) {
  const server = createClientEgressProxy({
    allow: config.allow,
    refused: config.refused,
    clientIp: config.clientIp,
    maxTunnels: config.maxTunnels ?? clientEgressLimits.tunnels,
    localRoutes: config.localRoutes ?? new Map(),
    ...options,
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listenPort, config.listenHost, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

if (process.argv[1]?.endsWith('/client-egress.mjs')) {
  try {
    const config = clientEgressConfig(process.env)
    const server = await listenClientEgress(config)
    logJson({
      event: 'listening',
      port: server.address().port,
      hosts: config.allow.size,
      ...(config.localRoutes.size ? { localRoutes: config.localRoutes.size } : {}),
    })
    server.on('error', () => {
      console.error('Client egress listener failed')
      process.exitCode = 1
    })
  } catch {
    console.error('Client egress configuration failed')
    process.exitCode = 1
  }
}
