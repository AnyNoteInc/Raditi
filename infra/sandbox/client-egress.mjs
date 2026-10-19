/* global console, process */
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createServer } from 'node:http'
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

export const clientEgressLimits = Object.freeze({
  /** `host:port` of one proxy (a preview's take up to 256, PreviewRuntimeSpec.egress). */
  hosts: 256,
  tunnels: 32,
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

/** ALLOWED_HOSTS: a JSON array of `host:port`, each once. */
export function parseAllowedHosts(json) {
  let list
  try {
    list = JSON.parse(json ?? '')
  } catch {
    throw new Error('ALLOWED_HOSTS is not a JSON array')
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > clientEgressLimits.hosts)
    throw new Error(`ALLOWED_HOSTS must list 1 to ${clientEgressLimits.hosts} hosts`)
  for (const item of list)
    if (typeof item !== 'string' || parseTarget(item) === null)
      throw new Error('ALLOWED_HOSTS holds an entry that is not a public host:port')
  const allow = new Set(list)
  if (allow.size !== list.length) throw new Error('ALLOWED_HOSTS repeats a host')
  return allow
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

const resolveAll = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address)
const dialTcp = ({ address, port }) => connect({ host: address, port, family: isIP(address) })
const logJson = (entry) => console.log(JSON.stringify(entry))

/**
 * `allow` — the `host:port` of the list; `refused` — subnets never connected to besides the
 * non-public ones; `clientIp` — the only address a request is taken from (sandbox-gw: the
 * sandbox's), or null on a network only the preview's own containers share. `lookup` and `dial`
 * are replaced only by tests.
 */
export function createClientEgressProxy({
  allow,
  refused = [],
  clientIp = null,
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

  // Nothing but CONNECT: a request in plain HTTP would carry the client's data in the clear and
  // let a page of the preview reach whatever its URL names.
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
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
    // Only a listed value reaches the log, never what the client wrote.
    const entry = { event: 'connect', host: allow.has(target) ? target : null }
    const done = (result, bytes) =>
      log({ ...entry, result, ms: Date.now() - started, ...(bytes ?? {}) })
    const deny = (status, reason, result) => {
      refuse(socket, status, reason, result)
      done(result)
    }
    if (clientIp !== null && socket.remoteAddress !== clientIp)
      return deny(403, 'Forbidden', 'forbidden_client')
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
 * The proxy as an environment describes it: LISTEN_HOST (an IPv4 address), LISTEN_PORT,
 * ALLOWED_HOSTS, REFUSED_SUBNETS and CLIENT_IPV4 (optional). Throws on anything else.
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
  return {
    listenHost,
    listenPort,
    allow: parseAllowedHosts(env.ALLOWED_HOSTS),
    refused: [...parseSubnets(env.REFUSED_SUBNETS), ...interfaceSubnets()],
    clientIp,
  }
}

/** Starts the proxy of a configuration; resolves once it listens. */
export function listenClientEgress(config, options = {}) {
  const server = createClientEgressProxy({
    allow: config.allow,
    refused: config.refused,
    clientIp: config.clientIp,
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
    logJson({ event: 'listening', port: server.address().port, hosts: config.allow.size })
    server.on('error', () => {
      console.error('Client egress listener failed')
      process.exitCode = 1
    })
  } catch {
    console.error('Client egress configuration failed')
    process.exitCode = 1
  }
}
