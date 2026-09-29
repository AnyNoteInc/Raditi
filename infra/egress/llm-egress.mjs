/* global console, process */
import { X509Certificate, randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { BlockList, connect, isIPv4 } from 'node:net'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'

// The egress proxy on egress-1 (README.md, spec §19): the llm role's only way to the model
// providers. An HTTPS proxy with mutual TLS: CONNECT to an exact host:port allowlist, and
// GET /probe for the channel check. The tunnel carries the llm role's own TLS to the provider,
// so bodies and tokens are never decrypted here. The log has the CN, host, result, duration and
// bytes, and never the client's address or any content.

const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'
export const PROBE_LIMIT = 1024 * 1024

// Never dialled: private, loopback, link-local (cloud metadata), CGNAT, documentation,
// benchmarking, multicast and reserved ranges. Only IPv4 is dialled at all: a provider must
// always see the node's one fixed address.
const BLOCKED = new BlockList()
for (const [network, prefix] of [
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
])
  BLOCKED.addSubnet(network, prefix, 'ipv4')

export const isPublicIPv4 = (address) => isIPv4(address) && !BLOCKED.check(address, 'ipv4')

const HOST_PORT =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+):([1-9][0-9]{0,4})$/
const CN = /^[a-z0-9][a-z0-9-]{0,62}$/

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/** `LLM_EGRESS_ALLOW`: exact lowercase host:port pairs of DNS names; no wildcards, no addresses. */
export function parseAllow(value) {
  const pairs = list(value)
  for (const pair of pairs) {
    const match = HOST_PORT.exec(pair)
    if (!match || /^[0-9.]+$/.test(match[1]) || Number(match[5]) > 65535)
      throw new Error(`LLM_EGRESS_ALLOW: ${pair} is not a host:port pair`)
  }
  if (pairs.length === 0) throw new Error('LLM_EGRESS_ALLOW is empty')
  return new Set(pairs)
}

/** `EGRESS_CLIENT_CN_ALLOW`: CNs of client certificates, such as app-1 and op-1. */
export function parseClientCns(value) {
  const cns = list(value)
  for (const cn of cns)
    if (!CN.test(cn)) throw new Error(`EGRESS_CLIENT_CN_ALLOW: ${cn} is not a CN`)
  if (cns.length === 0) throw new Error('EGRESS_CLIENT_CN_ALLOW is empty')
  return new Set(cns)
}

/** `EGRESS_PROBE_MAX_BYTES`: at most 1 MiB; it may only lower the limit. */
export function parseProbeMax(value) {
  if (value === undefined || value === '') return PROBE_LIMIT
  const bytes = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || bytes > PROBE_LIMIT)
    throw new Error(`EGRESS_PROBE_MAX_BYTES must be from 1 to ${PROBE_LIMIT}`)
  return bytes
}

const resolve4 = async (host) =>
  (await dnsLookup(host, { all: true, family: 4 })).map((entry) => entry.address)
const dialTcp = ({ address, port }) => connect({ host: address, port, family: 4 })
const logJson = (entry) => console.log(JSON.stringify(entry))

/**
 * `tls`: the server chain and key, the root, and the client CA. A client presents its certificate
 * with the client CA; OpenSSL checks the chain to the root and `clientAuth` on both, and the
 * proxy then requires the client CA as the issuer, so no certificate of the server CA ever
 * passes. `lookup` and `dial` are replaced only by tests.
 */
export function createEgressProxy({
  tls,
  allow,
  clientCns,
  probeMaxBytes = PROBE_LIMIT,
  maxTunnels = 64,
  idleMs = 11 * 60 * 1000,
  connectTimeoutMs = 10_000,
  lookup = resolve4,
  dial = dialTcp,
  log = logJson,
}) {
  let tunnels = 0
  const clientCa = new X509Certificate(tls.clientCa)
  if (!clientCa.ca || !clientCa.checkIssued(new X509Certificate(tls.root)))
    throw new Error('The client CA is not issued by the root')

  /** The client's CN when its certificate may use the proxy, otherwise null. */
  const identify = (socket) => {
    if (!socket.authorized) return null
    const peer = socket.getPeerX509Certificate()
    const cn = socket.getPeerCertificate()?.subject?.CN
    if (!peer || typeof cn !== 'string' || !clientCns.has(cn)) return null
    if (!peer.checkIssued(clientCa) || !peer.verify(clientCa.publicKey)) return null
    return peer.keyUsage?.includes(CLIENT_AUTH) ? cn : null
  }

  const refuse = (socket, status, reason) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`)
  }

  const server = createServer(
    {
      cert: tls.cert,
      key: tls.key,
      ca: tls.root,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      handshakeTimeout: 10_000,
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      maxHeaderSize: 8192,
    },
    (req, res) => {
      const started = Date.now()
      const cn = identify(req.socket)
      const answer = (status, result) => {
        res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' })
        res.end(`${result}\n`)
        log({ event: 'request', cn, result, ms: Date.now() - started })
      }
      if (!cn) return answer(403, 'forbidden_client')
      if (req.method !== 'GET') return answer(405, 'method')
      if (!/^\/probe(\?|$)/.test(req.url)) return answer(403, 'forbidden_path')
      const bytes = Number(/^\/probe\?bytes=([1-9][0-9]{0,7})$/.exec(req.url)?.[1])
      if (!(bytes <= probeMaxBytes)) return answer(400, 'probe_size')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes,
        'cache-control': 'no-store',
      })
      // Random bytes: nothing on the way can compress or cache them.
      let left = bytes
      const write = () => {
        while (left > 0) {
          const chunk = randomBytes(Math.min(left, 64 * 1024))
          left -= chunk.length
          if (!res.write(chunk)) return void res.once('drain', write)
        }
        res.end()
      }
      res.on('close', () =>
        log({
          event: 'probe',
          cn,
          result: res.writableFinished ? 'ok' : 'aborted',
          ms: Date.now() - started,
          bytes: bytes - left,
        }),
      )
      write()
    },
  )

  server.on('connect', async (req, socket, head) => {
    const started = Date.now()
    const cn = identify(socket)
    const target = req.url.toLowerCase()
    // Only an allowlisted value reaches the log, never what the client wrote.
    const entry = { event: 'connect', cn, host: allow.has(target) ? target : null }
    const done = (result, bytes) =>
      log({ ...entry, result, ms: Date.now() - started, ...(bytes ?? {}) })
    const deny = (status, reason, result) => {
      refuse(socket, status, reason)
      done(result)
    }
    if (!cn) return deny(403, 'Forbidden', 'forbidden_client')
    if (!entry.host) return deny(403, 'Forbidden', 'forbidden_host')
    if (tunnels >= maxTunnels) return deny(503, 'Service Unavailable', 'busy')

    const host = target.slice(0, target.lastIndexOf(':'))
    const port = Number(target.slice(target.lastIndexOf(':') + 1))
    tunnels += 1
    let upstream
    let open = false
    let finished = false
    let closing = false
    let connectDeadline
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(connectDeadline)
      tunnels -= 1
      socket.destroy()
      upstream?.destroy()
      done(result, upstream && { up: upstream.bytesWritten, down: upstream.bytesRead })
    }
    // The client's close ends the tunnel. The provider's end reaches the client through the pipe
    // below, which ends the client socket once the last bytes are written.
    socket.on('close', () => finish(open ? 'ok' : 'client_closed'))
    socket.on('error', () => finish('client_error'))
    const fail = (status, reason, result) => {
      if (finished || closing) return
      closing = true
      clearTimeout(connectDeadline)
      socket.once('finish', () => finish(result))
      refuse(socket, status, reason)
      upstream?.destroy()
    }

    // One deadline covers DNS and TCP together. Socket timeouts start too late to bound DNS.
    connectDeadline = setTimeout(
      () => fail(504, 'Gateway Timeout', 'connect_timeout'),
      connectTimeoutMs,
    )
    connectDeadline.unref()
    let addresses = null
    try {
      addresses = await lookup(host)
    } catch {
      // Reported below as a failed resolution.
    }
    if (finished || closing) return
    if (!addresses?.length) return fail(502, 'Bad Gateway', 'resolve')
    if (!addresses.every(isPublicIPv4)) return fail(403, 'Forbidden', 'forbidden_address')

    try {
      upstream = dial({ address: addresses[0], port })
    } catch {
      return fail(502, 'Bad Gateway', 'connect_error')
    }
    const onError = () => fail(502, 'Bad Gateway', 'connect_error')
    upstream.once('error', onError)
    upstream.once('connect', () => {
      upstream.removeListener('error', onError)
      if (finished || closing) return
      clearTimeout(connectDeadline)
      open = true
      upstream.on('error', () => finish('upstream_error'))
      const idle = () => finish('idle')
      upstream.setTimeout(idleMs, idle)
      socket.setTimeout(idleMs, idle)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  // An untrusted certificate is refused after the handshake: its reason is on the socket.
  server.on('tlsClientError', (error, socket) =>
    log({ event: 'tls', result: 'refused', code: socket?.authorizationError ?? error.code }),
  )
  server.maxHeadersCount = 32
  // A probe that stalls, as on a channel cut after 16 KB, does not hold its socket for ever.
  server.timeout = 120_000
  // Tunnels plus a few handshakes and probes; beyond that new connections are dropped.
  server.maxConnections = maxTunnels + 16
  return server
}

if (process.argv[1]?.endsWith('/llm-egress.mjs')) {
  try {
    // /etc/raditi/egress on the node (raditi-egress.service); a local run names any folder.
    const dir = process.env.EGRESS_TLS_DIR
    if (!dir) throw new Error('EGRESS_TLS_DIR is not set')
    const proxy = createEgressProxy({
      tls: {
        cert: readFileSync(join(dir, 'server.pem')),
        key: readFileSync(join(dir, 'server-key.pem')),
        root: readFileSync(join(dir, 'root.pem')),
        clientCa: readFileSync(join(dir, 'client-ca.pem')),
      },
      allow: parseAllow(process.env.LLM_EGRESS_ALLOW),
      clientCns: parseClientCns(process.env.EGRESS_CLIENT_CN_ALLOW),
      probeMaxBytes: parseProbeMax(process.env.EGRESS_PROBE_MAX_BYTES),
    })
    const host = process.env.EGRESS_LISTEN_HOST || '0.0.0.0'
    const port = Number(process.env.EGRESS_LISTEN_PORT || 443)
    proxy.listen(port, host, () => logJson({ event: 'listening', port: proxy.address().port }))
    proxy.on('error', (error) => {
      console.error(`Egress proxy listener failed: ${error.code ?? 'error'}`)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(`Egress proxy configuration failed: ${error.message}`)
    process.exitCode = 1
  }
}
