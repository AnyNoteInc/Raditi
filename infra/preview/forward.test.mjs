import assert from 'node:assert/strict'
import { connect, createServer } from 'node:net'
import { test } from 'node:test'

import { forward, guardRequest, parseArgs, parseRoute, parseRoutes } from './forward.mjs'

test('routes: an IPv4 to listen on, a fixed target, each listener once', () => {
  assert.deepEqual(parseRoute('0.0.0.0:8080=172.23.0.2:8080'), {
    listenHost: '0.0.0.0',
    listenPort: 8080,
    targetHost: '172.23.0.2',
    targetPort: 8080,
  })
  assert.equal(
    parseRoute('172.25.0.2:3128=host.docker.internal:8090').targetHost,
    'host.docker.internal',
  )
  for (const route of [
    'localhost:8080=web:8080',
    '0.0.0.0:0=web:8080',
    '0.0.0.0:8080=web:70000',
    '0.0.0.0:8080=Web:8080',
    '0.0.0.0:8080=web',
    '0.0.0.0:8080',
    '[::]:8080=web:8080',
    '0.0.0.0:8080=web:8080;rm',
  ])
    assert.equal(parseRoute(route), null, route)
  assert.equal(parseRoutes([]), null)
  assert.equal(parseRoutes(['0.0.0.0:1=a:1', '0.0.0.0:1=b:1']), null)
  assert.equal(
    parseRoutes([
      '0.0.0.0:1=a:1',
      '0.0.0.0:2=b:1',
      '0.0.0.0:3=c:1',
      '0.0.0.0:4=d:1',
      '0.0.0.0:5=e:1',
    ]),
    null,
  )
})

async function echo() {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = []
    socket.on('data', (chunk) => chunks.push(chunk))
    // Answers only after the client finished sending: a half-closed client still gets it.
    socket.on('end', () => socket.end(`echo:${Buffer.concat(chunks)}`))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const exchange = (port, message) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    const chunks = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('error', reject)
    socket.end(message)
  })

test('bytes go to the fixed target and back, half-closed both ways', async () => {
  const target = await echo()
  const running = await forward([
    {
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: target.address().port,
    },
  ])
  try {
    assert.equal(
      await exchange(running.addresses[0].port, 'GET / HTTP/1.1\r\n\r\n'),
      'echo:GET / HTTP/1.1\r\n\r\n',
    )
  } finally {
    await running.close()
    target.close()
  }
})

test('a connection over the limit, or to a target that is down, is closed', async () => {
  const target = await echo()
  const running = await forward(
    [
      {
        listenHost: '127.0.0.1',
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: target.address().port,
      },
    ],
    { limits: { routes: 1, connections: 0, connectMs: 1000, idleMs: 1000 } },
  )
  const down = await forward([
    { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 1 },
  ])
  try {
    assert.equal(await exchange(running.addresses[0].port, 'x').catch(() => ''), '')
    assert.equal(await exchange(down.addresses[0].port, 'x').catch(() => ''), '')
  } finally {
    await running.close()
    await down.close()
    target.close()
  }
})

test('arguments: an optional host of the entry, then the routes', () => {
  assert.deepEqual(parseArgs(['0.0.0.0:8080=172.23.0.2:8080']), {
    routes: [parseRoute('0.0.0.0:8080=172.23.0.2:8080')],
    httpHost: null,
  })
  assert.equal(
    parseArgs(['--http-host=site-0f3a9c1b-chat-a1b2c3.localhost', '0.0.0.0:8080=web:8080'])
      .httpHost,
    'site-0f3a9c1b-chat-a1b2c3.localhost',
  )
  for (const args of [
    ['--http-host=', '0.0.0.0:8080=web:8080'],
    ['--http-host=Site.localhost', '0.0.0.0:8080=web:8080'],
    ['--http-host=a.localhost'],
    ['0.0.0.0:8080=web:8080', '--http-host=a.localhost'],
  ])
    assert.equal(parseArgs(args), null, args.join(' '))
})

const host = 'site-0f3a9c1b-chat-a1b2c3.localhost'

test('the head of a request: its own host only, one request per connection', () => {
  assert.deepEqual(
    guardRequest(
      `GET /wp-admin/?a=1 HTTP/1.1\r\nHost: ${host}:8090\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nX-Forwarded-Host: ${host}:8090`,
      host,
    ),
    {
      head: `GET /wp-admin/?a=1 HTTP/1.1\r\nHost: ${host}:8090\r\nX-Forwarded-Host: ${host}:8090\r\nConnection: close\r\n\r\n`,
    },
  )
  // A tunnel stays one: the upgrade keeps its Connection header.
  const upgrade = `GET /ws HTTP/1.1\r\nhost: ${host.toUpperCase()}\r\nConnection: Upgrade\r\nUpgrade: websocket`
  assert.deepEqual(guardRequest(upgrade, host), { head: `${upgrade}\r\n\r\n` })
  for (const [head, status] of [
    ['GET / HTTP/1.1\r\nHost: site-ffffffff-chat-a1b2c3.localhost:8090', 421],
    ['GET / HTTP/1.1\r\nHost: 127.0.0.1:41234', 421],
    [`GET / HTTP/1.1\r\nHost: ${host}.evil.example`, 421],
    ['GET / HTTP/1.1', 400],
    [`GET / HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}`, 400],
    [`GET http://${host}/ HTTP/1.1\r\nHost: ${host}`, 400],
    [`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}`, 400],
    [`GET * HTTP/1.1\r\nHost: ${host}`, 400],
    [`GET / HTTP/2.0\r\nHost: ${host}`, 400],
    [`GET / HTTP/1.1\r\nHost: ${host}\r\n folded`, 400],
    [`GET / HTTP/1.1\r\nHost : ${host}`, 400],
    [`GET / HTTP/1.1\r\nHost: ${host}\nX: y`, 400],
    [`GET / HTTP/1.1\r\nHost: ${host}\r\nX: a\u0000b`, 400],
    [`GET / HTTP/1.1\r\nHost: [::1]:8080`, 400],
  ])
    assert.deepEqual(guardRequest(head, host), { status }, head)
  assert.ok(guardRequest(`OPTIONS * HTTP/1.1\r\nHost: ${host}`, host).head)
})

/** A server that answers one request and closes, as Apache does with `Connection: close`. */
async function oneRequestServer() {
  const seen = []
  const server = createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      seen.push(text)
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen }
}

test('the entry forwarder answers 421 for another host and never reaches its target', async () => {
  const target = await oneRequestServer()
  const running = await forward(
    [
      {
        listenHost: '127.0.0.1',
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: target.server.address().port,
      },
    ],
    { httpHost: host },
  )
  const listen = running.addresses[0].port
  try {
    const own = await exchange(listen, `GET / HTTP/1.1\r\nHost: ${host}:8090\r\n\r\n`)
    assert.match(own, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok$/)
    assert.deepEqual(target.seen, [
      `GET / HTTP/1.1\r\nHost: ${host}:8090\r\nConnection: close\r\n\r\n`,
    ])
    const other = await exchange(
      listen,
      'GET /wp-admin/ HTTP/1.1\r\nHost: site-ffffffff-chat-a1b2c3.localhost:8090\r\n\r\n',
    )
    assert.match(other, /^HTTP\/1\.1 421 Misdirected Request\r\n/)
    assert.match(other, /\r\nConnection: close\r\n/)
    const malformed = await exchange(listen, 'GET / HTTP/1.1\r\n\r\n')
    assert.match(malformed, /^HTTP\/1\.1 400 Bad Request\r\n/)
    // A head that never ends is dropped, not passed on.
    assert.equal(await exchange(listen, 'GET / HTTP/1.1\r\nHost: x'), '')
    assert.equal(target.seen.length, 1)
  } finally {
    await running.close()
    target.server.close()
  }
})
