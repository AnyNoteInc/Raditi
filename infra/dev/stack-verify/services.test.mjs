// The relays of the stand on Linux and in a VM (services.mjs, `startRelays`; docs/plan/62-slices/
// e3.md, Э3.16): a TCP forwarder on loopback only — no Docker, no other machine (pnpm test:infra).
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect, createServer } from 'node:net'
import { test } from 'node:test'

import { startRelays } from './services.mjs'

/** An echo server on 127.0.0.1 that answers what it gets with a prefix; it tracks its sockets. */
async function echoServer() {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => socket.write(`echo:${chunk}`))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    sockets,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((done) => server.close(() => done()))
    },
  }
}

/** Connects to the relay and reads the first answer to `text`. */
async function ask(host, port, text) {
  const socket = connect({ host, port })
  await once(socket, 'connect')
  socket.write(text)
  const [answer] = await once(socket, 'data')
  return { socket, answer: String(answer) }
}

// The relay listens on the IPv6 loopback and carries to 127.0.0.1 on the same port, as a relay on
// the bridge gateway carries to a role on loopback: two addresses of this machine, one port.
test('a relay carries bytes both ways and close() ends its open connections', async () => {
  const echo = await echoServer()
  const relay = await startRelays([
    { role: 'llm', listen: '::1', port: echo.port, to: '127.0.0.1' },
  ])
  try {
    const { socket, answer } = await ask('::1', echo.port, 'ping')
    assert.equal(answer, 'echo:ping')
    assert.equal(echo.sockets.size, 1, 'the relay opened one connection to the role')
    const closed = once(socket, 'close')
    await relay.close()
    await closed
    // The connection to the role is gone too, and nothing listens on the relay any more.
    for (let tries = 0; echo.sockets.size > 0 && tries < 50; tries += 1)
      await new Promise((done) => setTimeout(done, 20))
    assert.equal(echo.sockets.size, 0)
    const refused = connect({ host: '::1', port: echo.port })
    const [error] = await once(refused, 'error')
    assert.equal(error.code, 'ECONNREFUSED')
  } finally {
    await relay.close()
    await echo.close()
  }
})

test('a relay that cannot listen is refused in words and leaves no relay behind', async () => {
  const echo = await echoServer()
  const busy = createServer()
  busy.listen(0, '::1')
  await once(busy, 'listening')
  const taken = busy.address().port
  try {
    await assert.rejects(
      startRelays([
        { role: 'llm', listen: '::1', port: echo.port, to: '127.0.0.1' },
        { role: 'mcp', listen: '::1', port: taken, to: '127.0.0.1' },
      ]),
      new RegExp(`The relay of mcp cannot listen on ::1:${taken}: .*EADDRINUSE`),
    )
    // The relay of llm that did listen was closed with the refusal.
    const refused = connect({ host: '::1', port: echo.port })
    const [error] = await once(refused, 'error')
    assert.equal(error.code, 'ECONNREFUSED')
  } finally {
    await new Promise((done) => busy.close(() => done()))
    await echo.close()
  }
})
