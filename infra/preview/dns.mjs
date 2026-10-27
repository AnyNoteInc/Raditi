/* global console, process, setTimeout, clearTimeout */
import dgram from 'node:dgram'
import { writeFileSync } from 'node:fs'
import net from 'node:net'

// The names of a preview in one container (docs/plan/58-preview-single-container.md, §10).
// Docker gives a container on a user-defined network /etc/resolv.conf with `nameserver
// 127.0.0.11`, its embedded DNS — which gVisor's own network stack never reaches, and which a
// read-only root file system does not let anyone replace. This forwarder listens there, inside the
// container, and passes each query as it is to the servers of PREVIEW_DNS_SERVERS. It parses
// nothing but the length of a TCP message; under runc Docker's DNAT takes 127.0.0.11:53 to its own
// resolver first, and this one waits unused.
//
//   node dns.mjs <IPv4>[,<IPv4>…]   (1–3 servers; RADITI_DNS_SERVERS)

export const LISTEN = Object.freeze({ host: '127.0.0.11', port: 53 })
export const READY_FILE = '/run/raditi-forward/dns.ready'
export const dnsLimits = Object.freeze({
  /** Queries on their way at once, UDP and TCP together. */
  inFlight: 256,
  /** One server's time for an answer before the next one is asked. */
  timeoutMs: 2_000,
  /** A UDP answer as large as a datagram gets; TCP messages are length-prefixed, up to 64 KiB. */
  udpBytes: 65_535,
  /** An idle TCP connection of a client. */
  idleMs: 10_000,
})

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** `77.88.8.8,77.88.8.1` → the servers; null for anything but one to three IPv4 literals. */
export function parseServers(text) {
  if (typeof text !== 'string' || text === '') return null
  const servers = text.split(',')
  if (servers.length > 3 || servers.some((server) => !IPV4.test(server))) return null
  return servers
}

/**
 * Starts the forwarder: `servers` — IPv4 literals, `upstreamPort` 53 (another one in tests).
 * Resolves once both sockets listen; `close()` ends them.
 */
export async function startDns({
  servers,
  host = LISTEN.host,
  port = LISTEN.port,
  upstreamPort = 53,
  limits = dnsLimits,
}) {
  let inFlight = 0
  let next = 0
  /** The servers in turn, starting with the next one: a slow one is not asked first every time. */
  const order = () => {
    const start = next
    next = (next + 1) % servers.length
    return servers.map((_, index) => servers[(start + index) % servers.length])
  }

  /** One query over UDP to the servers in turn; the first answer, or null. */
  const askUdp = (query) =>
    new Promise((resolve) => {
      const socket = dgram.createSocket('udp4')
      const queue = order()
      let timer = null
      let done = false
      const finish = (answer) => {
        if (done) return
        done = true
        clearTimeout(timer)
        socket.close()
        resolve(answer)
      }
      const ask = () => {
        const server = queue.shift()
        if (server === undefined) return finish(null)
        timer = setTimeout(ask, limits.timeoutMs)
        socket.send(query, upstreamPort, server, (error) => {
          if (error) {
            clearTimeout(timer)
            ask()
          }
        })
      }
      socket.on('message', (answer, from) => {
        // An answer of the server asked, for this query's id.
        if (!servers.includes(from.address) || from.port !== upstreamPort) return
        if (answer.length < 2 || answer.readUInt16BE(0) !== query.readUInt16BE(0)) return
        finish(answer)
      })
      socket.on('error', () => finish(null))
      ask()
    })

  const udp = dgram.createSocket('udp4')
  udp.on('message', (query, client) => {
    if (query.length < 12 || inFlight >= limits.inFlight) return
    inFlight += 1
    void askUdp(query).then((answer) => {
      inFlight -= 1
      if (answer) udp.send(answer, client.port, client.address)
    })
  })

  /** A TCP connection of a client: each length-prefixed query to a server over TCP, in turn. */
  const tcp = net.createServer((client) => {
    client.setTimeout(limits.idleMs, () => client.destroy())
    let buffered = Buffer.alloc(0)
    let busy = false
    const pump = () => {
      if (busy || buffered.length < 2) return
      const size = buffered.readUInt16BE(0)
      if (buffered.length < 2 + size) return
      const message = buffered.subarray(0, 2 + size)
      buffered = buffered.subarray(2 + size)
      if (size < 12 || inFlight >= limits.inFlight) return client.destroy()
      busy = true
      inFlight += 1
      void askTcp(message).then((answer) => {
        inFlight -= 1
        busy = false
        if (!answer) return client.destroy()
        client.write(answer)
        pump()
      })
    }
    client.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 2 + 65_535) return client.destroy()
      pump()
    })
    client.on('error', () => client.destroy())
  })

  const askTcp = async (message) => {
    for (const server of order()) {
      const answer = await new Promise((resolve) => {
        const socket = net.connect({ host: server, port: upstreamPort })
        let received = Buffer.alloc(0)
        const timer = setTimeout(() => {
          socket.destroy()
          resolve(null)
        }, limits.timeoutMs)
        socket.on('connect', () => socket.write(message))
        socket.on('data', (chunk) => {
          received = Buffer.concat([received, chunk])
          if (received.length >= 2 && received.length >= 2 + received.readUInt16BE(0)) {
            clearTimeout(timer)
            socket.destroy()
            resolve(received.subarray(0, 2 + received.readUInt16BE(0)))
          }
        })
        socket.on('error', () => {
          clearTimeout(timer)
          resolve(null)
        })
      })
      if (answer) return answer
    }
    return null
  }

  await new Promise((resolve, reject) => {
    udp.once('error', reject)
    udp.bind(port, host, () => {
      udp.off('error', reject)
      resolve()
    })
  })
  const udpPort = udp.address().port
  await new Promise((resolve, reject) => {
    tcp.once('error', reject)
    tcp.listen(udpPort, host, () => {
      tcp.off('error', reject)
      resolve()
    })
  })
  return {
    port: udpPort,
    close: () =>
      new Promise((resolve) => {
        udp.close()
        tcp.close(() => resolve())
      }),
  }
}

if (process.argv[1]?.endsWith('/dns.mjs')) {
  const servers = parseServers(process.argv[2])
  if (!servers) {
    console.error('Usage: dns.mjs <IPv4>[,<IPv4>…] (one to three)')
    process.exit(64)
  }
  try {
    await startDns({ servers })
    writeFileSync(READY_FILE, '')
  } catch {
    console.error('The forwarder of names could not listen')
    process.exit(1)
  }
}
