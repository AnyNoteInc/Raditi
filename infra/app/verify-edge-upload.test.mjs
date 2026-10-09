// The upload helper of the edge stand against a local server that refuses a body early, as the
// edge does: the answer must be read before more of the body is written.
import assert from 'node:assert/strict'
import http from 'node:http'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { upload } from './verify-edge-upload.mjs'

const PIECE = 64 * 1024
const REFUSAL = 'Request Entity Too Large'
const refusal = `HTTP/1.1 413 Request Entity Too Large\r\ncontent-length: ${REFUSAL.length}\r\nconnection: close\r\n\r\n${REFUSAL}`

/** A raw HTTP server: `serve(socket, state)` decides what each connection gets. */
async function listen(serve) {
  const connections = []
  const server = createServer((socket) => {
    const state = { received: 0, head: null, afterAnswer: 0, answered: false }
    connections.push(state)
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      state.received += chunk.length
      if (state.answered) state.afterAnswer += chunk.length
      if (state.head === null) {
        const end = chunk.indexOf('\r\n\r\n')
        if (end === -1) return
        state.head = chunk.subarray(0, end).toString()
        state.received = chunk.length - end - 4
      }
      serve(socket, state, connections.length)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    connections,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const post = (port, body, chunked = false) =>
  upload('http://edge.test/api/upload', {
    host: '127.0.0.1',
    port,
    body,
    chunked,
    request: http.request,
  })

for (const chunked of [false, true]) {
  test(`an early refusal is read before more of the body is written (chunked: ${chunked})`, async () => {
    // The server refuses once the first piece has arrived and then listens for what the client
    // still writes: a client that goes on would be answered with a reset by a real edge.
    const server = await listen((socket, state) => {
      if (state.answered || state.received < PIECE) return
      state.answered = true
      socket.write(refusal)
      setTimeout(() => socket.end(), 300)
    })
    try {
      const answer = await post(server.port, Buffer.alloc(8 * 1024 * 1024, 0x61), chunked)
      assert.equal(answer.status, 413)
      assert.equal(answer.body, REFUSAL)
      await sleep(350)
      const [connection] = server.connections
      assert.equal(server.connections.length, 1)
      // One piece may already be on its way when the answer arrives; chunk framing adds a little.
      assert.ok(
        connection.afterAnswer <= PIECE + 1024,
        `${connection.afterAnswer} bytes were written after the server had answered`,
      )
    } finally {
      await server.close()
    }
  })
}

test('an answer lost to a closed connection is asked for again', async () => {
  const server = await listen((socket, state, number) => {
    if (state.answered) return
    state.answered = true
    if (number === 1) return socket.destroy()
    socket.end(refusal)
  })
  try {
    const answer = await post(server.port, Buffer.alloc(4 * PIECE, 0x61))
    assert.equal(answer.status, 413)
    assert.equal(server.connections.length, 2)
  } finally {
    await server.close()
  }
})

for (const chunked of [false, true]) {
  test(`a body the server takes arrives whole (chunked: ${chunked})`, async () => {
    const size = 5 * PIECE + 123
    let body = 0
    const server = await listen((socket, state) => {
      body = state.received
      const whole = chunked ? state.received >= size + 5 : state.received >= size
      if (state.answered || !whole) return
      state.answered = true
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')
    })
    try {
      const answer = await post(server.port, Buffer.alloc(size, 0x62), chunked)
      assert.equal(answer.status, 200)
      assert.equal(answer.body, 'ok')
      assert.ok(body >= size, `${body} of ${size} bytes arrived`)
    } finally {
      await server.close()
    }
  })
}
