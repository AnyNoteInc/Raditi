// A command the scripted model runs through the CLI's `bash` tool (added by the review of G1): does the
// running CLI listen anywhere a command of the model can reach, and does what listens give a credential away?
//   node listeners.mjs llm=<sha256 of the turn key> mcp=<sha256 of the MCP token>
// Looked at: LISTEN rows of /proc/net/tcp and tcp6, bound unix sockets, and every loopback port by connecting
// to it. A port counts as open only when a second connection succeeds too: a scan of the ephemeral range
// now and then connects a socket to itself. Whatever is open gets a few GETs; a body is searched for the
// credentials by shape and hash, as in toolcheck.mjs. Nothing but facts is printed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'

const known = new Map(
  process.argv
    .slice(2)
    .map((pair) => [pair.slice(pair.indexOf('=') + 1), pair.slice(0, pair.indexOf('='))]),
)
const SHAPES = /sk-rdt-[A-Za-z0-9_-]{43}|mcp_[0-9a-f]{64}/g
const holds = (text) => [
  ...new Set(
    [...text.matchAll(SHAPES)]
      .map((match) => known.get(createHash('sha256').update(match[0]).digest('hex')))
      .filter(Boolean),
  ),
]
const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return { error: error.code }
  }
}
/** `0B00007F:ADC5` of /proc/net/tcp as `127.0.0.11:44485`; an IPv6 row stays as it is. */
function listenAddress(field) {
  const [address, port] = field.split(':')
  if (address.length !== 8) return field
  const bytes = address.match(/../g).map((byte) => parseInt(byte, 16))
  return `${bytes.reverse().join('.')}:${parseInt(port, 16)}`
}
const out = { procNet: {}, unixSockets: null, scanHits: {}, open: {}, answers: [] }
for (const name of ['tcp', 'tcp6']) {
  const text = read(`/proc/net/${name}`)
  out.procNet[name] =
    typeof text === 'string'
      ? text
          .split('\n')
          .slice(1)
          .map((line) => line.trim().split(/\s+/))
          .filter((fields) => fields[3] === '0A')
          .map((fields) => listenAddress(fields[1]))
      : text
}
const unix = read('/proc/net/unix')
out.unixSockets =
  typeof unix === 'string'
    ? unix
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[7])
        .filter(Boolean)
    : unix

function scan(host) {
  return new Promise((done) => {
    const open = []
    let port = 1
    let pending = 0
    const next = () => {
      if (port > 65535 && pending === 0) return done(open)
      while (pending < 200 && port <= 65535) {
        const candidate = port
        port += 1
        pending += 1
        const socket = net.connect({ host, port: candidate })
        let settled = false
        const settle = (answered) => {
          if (settled) return
          settled = true
          if (answered) open.push(candidate)
          socket.destroy()
          pending -= 1
          next()
        }
        socket.setTimeout(500, () => settle(false))
        socket.once('connect', () => settle(true))
        socket.once('error', () => settle(false))
      }
    }
    next()
  })
}
const connects = (host, port) =>
  new Promise((done) => {
    const socket = net.connect({ host, port })
    const settle = (answered) => {
      socket.destroy()
      done(answered)
    }
    socket.setTimeout(1000, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
for (const host of ['127.0.0.1', '::1']) {
  const hits = await scan(host)
  out.scanHits[host] = hits.length
  out.open[host] = []
  for (const port of hits) if (await connects(host, port)) out.open[host].push(port)
}

for (const [host, ports] of Object.entries(out.open))
  for (const port of ports.slice(0, 8))
    for (const path of [
      '/',
      '/config',
      '/config/providers',
      '/provider',
      '/mcp',
      '/doc',
      '/session',
    ]) {
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`
      try {
        const answer = await fetch(url, { signal: AbortSignal.timeout(3000) })
        const body = await answer.text()
        out.answers.push({
          port,
          path,
          status: answer.status,
          bytes: body.length,
          holds: holds(body),
        })
      } catch (error) {
        out.answers.push({ port, path, error: error.cause?.code ?? error.name })
      }
    }
console.log(JSON.stringify(out))
