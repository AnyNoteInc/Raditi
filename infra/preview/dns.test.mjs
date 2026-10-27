import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import { test } from 'node:test'

import { parseServers, startDns } from './dns.mjs'

/** A DNS query of `id` (header and one question; the forwarder reads only the id and the size). */
const query = (id) => {
  const message = Buffer.alloc(17)
  message.writeUInt16BE(id, 0)
  message.writeUInt16BE(0x0100, 2)
  message.writeUInt16BE(1, 4)
  Buffer.from([1, 0x61, 0, 0, 1, 0, 1]).copy(message, 12)
  return message
}

/** A server of names on 127.0.0.1 that answers a query with its id and `answer`, UDP and TCP. */
async function fakeServer({ wrongIdFirst = false } = {}) {
  const seen = []
  const udp = dgram.createSocket('udp4')
  udp.on('message', (message, from) => {
    seen.push(message.readUInt16BE(0))
    const reply = Buffer.concat([message.subarray(0, 2), Buffer.from('answer')])
    if (wrongIdFirst) {
      const wrong = Buffer.from(reply)
      wrong.writeUInt16BE((message.readUInt16BE(0) + 1) & 0xffff, 0)
      udp.send(wrong, from.port, from.address)
    }
    udp.send(reply, from.port, from.address)
  })
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve))
  const port = udp.address().port
  const tcp = net.createServer((socket) => {
    socket.on('data', (data) => {
      const body = Buffer.concat([data.subarray(2, 4), Buffer.from('tcp-answer')])
      const head = Buffer.alloc(2)
      head.writeUInt16BE(body.length)
      socket.end(Buffer.concat([head, body]))
    })
  })
  await new Promise((resolve) => tcp.listen(port, '127.0.0.1', resolve))
  return { port, seen, close: () => (udp.close(), new Promise((resolve) => tcp.close(resolve))) }
}

const askUdp = (port, message) =>
  new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (answer) => {
      socket.close()
      resolve(answer)
    })
    socket.send(message, port, '127.0.0.1')
  })

test('servers: one to three IPv4 literals, comma-separated', () => {
  assert.deepEqual(parseServers('77.88.8.8'), ['77.88.8.8'])
  assert.deepEqual(parseServers('77.88.8.8,77.88.8.1,1.1.1.1'), [
    '77.88.8.8',
    '77.88.8.1',
    '1.1.1.1',
  ])
  for (const text of [
    '',
    undefined,
    '77.88.8.8,77.88.8.1,1.1.1.1,8.8.8.8',
    '77.88.8.8 77.88.8.1',
    '256.1.1.1',
    '01.2.3.4',
    'dns.example',
    '::1',
    '77.88.8.8,',
  ])
    assert.equal(parseServers(text), null, String(text))
})

test('a UDP query goes to the server as it is and its answer back; another id is not taken', async () => {
  const server = await fakeServer({ wrongIdFirst: true })
  const dns = await startDns({
    servers: ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    upstreamPort: server.port,
  })
  try {
    const answer = await askUdp(dns.port, query(0x1234))
    assert.equal(answer.readUInt16BE(0), 0x1234)
    assert.equal(answer.subarray(2).toString(), 'answer')
    assert.deepEqual(server.seen, [0x1234])
  } finally {
    await dns.close()
    await server.close()
  }
})

test('a server that does not answer gives way to the next', async () => {
  const server = await fakeServer()
  const dns = await startDns({
    // TEST-NET: nothing answers there.
    servers: ['192.0.2.1', '127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    upstreamPort: server.port,
    limits: { inFlight: 8, timeoutMs: 300, udpBytes: 65_535, idleMs: 2_000 },
  })
  try {
    const answer = await askUdp(dns.port, query(7))
    assert.equal(answer.readUInt16BE(0), 7)
  } finally {
    await dns.close()
    await server.close()
  }
})

test('a TCP query is length-prefixed both ways', async () => {
  const server = await fakeServer()
  const dns = await startDns({
    servers: ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    upstreamPort: server.port,
  })
  try {
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: dns.port })
      let received = Buffer.alloc(0)
      socket.on('connect', () => {
        const body = query(0x0abc)
        const head = Buffer.alloc(2)
        head.writeUInt16BE(body.length)
        socket.write(Buffer.concat([head, body]))
      })
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk])
        if (received.length >= 2 && received.length >= 2 + received.readUInt16BE(0)) {
          socket.destroy()
          resolve(received)
        }
      })
      socket.on('error', reject)
    })
    assert.equal(answer.readUInt16BE(0), answer.length - 2)
    assert.equal(answer.readUInt16BE(2), 0x0abc)
    assert.equal(answer.subarray(4).toString(), 'tcp-answer')
  } finally {
    await dns.close()
    await server.close()
  }
})

test('a datagram shorter than a DNS header is dropped', async () => {
  const server = await fakeServer()
  const dns = await startDns({
    servers: ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    upstreamPort: server.port,
  })
  try {
    const socket = dgram.createSocket('udp4')
    await new Promise((resolve) =>
      socket.send(Buffer.from('short'), dns.port, '127.0.0.1', resolve),
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    socket.close()
    assert.deepEqual(server.seen, [])
  } finally {
    await dns.close()
    await server.close()
  }
})
