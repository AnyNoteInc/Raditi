// A forward proxy for the browsers of spike s8: the synthetic hosts resolve nowhere, so every
// browser goes through it. CONNECT host:443 is tunnelled to Traefik's https port, a plain
// `GET http://host/…` to its http port (origin-form, path and query only). It records every
// request line it sees: the fragment must not reach it either.
import http from 'node:http'
import net from 'node:net'

export function startProxy({ hosts, ports, upstreamHost = '127.0.0.1' }) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ kind: 'http', line: `${req.method} ${req.url}` })
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (!hosts.includes(target.hostname)) {
      res.writeHead(403).end()
      return
    }
    const upstream = http.request(
      { host: upstreamHost, port: ports.http, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('connect', (req, client, head) => {
    seen.push({ kind: 'connect', line: `CONNECT ${req.url}` })
    const [host, port] = req.url.split(':')
    if (!hosts.includes(host) || !['443', '80'].includes(port)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = net.connect({ host: upstreamHost, port: port === '443' ? ports.https : ports.http }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => server.close() }))
  })
}

/**
 * A raw recorder: the first line of every request it gets, as sent, then a short text answer.
 * Used twice — as the origin of `http://127.0.0.1:<port>/…` and as an HTTP proxy.
 */
export function startRecorder() {
  const seen = []
  const server = net.createServer((socket) => {
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (!data.includes('\r\n\r\n')) return
      seen.push(data.split('\r\n')[0])
      const body = 'recorded\n'
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => server.close() }))
  })
}
