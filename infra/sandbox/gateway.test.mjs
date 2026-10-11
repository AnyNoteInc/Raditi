import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Agent, createServer, request } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import {
  createGateway,
  gatewayLimits,
  llmPaths,
  llmRequestHeaders,
  llmResponseHeaders,
} from './gateway.mjs'

// Captured before any test mocks the clock: waits for real socket events.
const realSetTimeout = globalThis.setTimeout
const realDelay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const tooLargeBody = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 'raditi_body',
    message: 'Request body is too large',
  },
})

const clientHeaders = { 'user-agent': 'synthetic-cli/1.0' }
const mcpHeaders = {
  'mcp-session-id': 'synthetic-mcp-session',
  'mcp-protocol-version': '2025-06-18',
  'last-event-id': 'synthetic-event',
}
const sharedHeaders = {
  authorization: 'Bearer synthetic-turn-key',
  'content-type': 'application/json',
  accept: 'text/event-stream',
}
const privateHeaders = {
  cookie: 'must-not-forward=1',
  'x-forwarded-host': 'evil.test',
  'x-forwarded-for': '203.0.113.1',
  // What a CLI may add to identify itself or its session: none of it is declared by a backend.
  originator: 'must-not-forward',
  'session-id': 'must-not-forward',
  'x-client-request-id': 'must-not-forward',
  'x-session-id': 'must-not-forward',
  'x-installation-id': 'must-not-forward',
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })

async function fixture(t, handler, options = {}) {
  const upstream = createServer(handler)
  await listen(upstream)
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const gateway = createGateway({
    listenHost: '127.0.0.1',
    clientIp: '127.0.0.1',
    routes: ['llm', 'mcp'],
    llmUpstream: origin,
    mcpUpstream: origin,
    ...options,
  })
  await listen(gateway)
  t.after(async () => {
    await close(gateway)
    await close(upstream)
  })
  return { port: gateway.address().port, upstreamHost: new URL(origin).host, gateway }
}

function call(port, path, { method = 'POST', headers = {}, body = '{"input":"synthetic"}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { host: 'sandbox-gw:8080', 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function rawCall(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const chunks = []
    socket.on('error', reject)
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('connect', () => socket.end(raw))
  })
}

const expectAbsent = (headers, names) => {
  for (const name of names) assert.equal(headers[name], undefined, name)
}

const expectPreserved = (actual, expected) => {
  for (const [name, value] of Object.entries(expected)) assert.equal(actual[name], value, name)
}

test('the LLM path and its headers are exported as data, the exact path of the CLI wire format', () => {
  // The contract test of the role llm compares the three lists with what its backends declare.
  assert.deepEqual(llmPaths, ['/zai/v4/chat/completions'])
  assert.deepEqual(llmRequestHeaders, ['authorization', 'content-type', 'accept', 'user-agent'])
  assert.deepEqual(llmResponseHeaders, ['content-type', 'retry-after'])
  for (const list of [llmPaths, llmRequestHeaders, llmResponseHeaders]) {
    assert.ok(Object.isFrozen(list))
    assert.deepEqual(list, [...new Set(list)])
  }
  for (const path of llmPaths) assert.match(path, /^\/[a-z0-9]+(?:\/[a-z0-9]+)+$/)
  for (const name of [...llmRequestHeaders, ...llmResponseHeaders])
    assert.equal(name, name.toLowerCase())
  for (const name of ['cookie', 'host', 'x-session-id', 'x-session-affinity'])
    assert.ok(!llmRequestHeaders.includes(name), name)
})

test('the session headers of the OpenCode CLI stop at the gateway', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    received.push(req.headers)
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'acw_tc=1' })
    res.end('data: [DONE]\n\n')
  })
  const session = {
    'x-opencode-session-id': 'ses_synthetic',
    'x-session-affinity': 'ses_synthetic',
    'x-session-id': 'ses_synthetic',
  }
  const result = await call(port, '/zai/v4/chat/completions', {
    headers: {
      ...sharedHeaders,
      'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      'accept-encoding': 'gzip, deflate, br, zstd',
      ...session,
    },
  })
  assert.equal(result.status, 200)
  expectAbsent(result.headers, ['set-cookie'])
  expectPreserved(received[0], {
    ...sharedHeaders,
    'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  })
  expectAbsent(received[0], [...Object.keys(session), 'accept-encoding'])
})

test('LLM routes preserve client identity while stripping platform, MCP and private headers', async (t) => {
  const received = []
  const { port, upstreamHost } = await fixture(t, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      })
      res.writeHead(429, {
        'content-type': 'text/event-stream',
        'retry-after': '42',
        'mcp-session-id': 'must-not-forward',
        'mcp-protocol-version': 'must-not-forward',
        'x-provider-turn-state': 'must-not-forward',
        'x-ratelimit-remaining': '1',
        'set-cookie': 'must-not-forward=1',
        'x-private': 'must-not-forward',
      })
      res.end('data: {"synthetic":true}\n\n')
    })
  })
  for (const path of llmPaths) {
    const result = await call(port, path, {
      headers: { ...sharedHeaders, ...clientHeaders, ...mcpHeaders, ...privateHeaders },
    })
    assert.equal(result.status, 429)
    assert.equal(result.body, 'data: {"synthetic":true}\n\n')
    expectPreserved(result.headers, {
      'content-type': 'text/event-stream',
      'retry-after': '42',
    })
    expectAbsent(result.headers, [
      'mcp-session-id',
      'mcp-protocol-version',
      'x-provider-turn-state',
      'x-ratelimit-remaining',
      'set-cookie',
      'x-private',
    ])
    const actual = received.at(-1)
    assert.equal(actual.url, path)
    assert.equal(actual.method, 'POST')
    assert.equal(actual.body, '{"input":"synthetic"}')
    assert.equal(actual.headers.host, upstreamHost)
    expectPreserved(actual.headers, { ...sharedHeaders, ...clientHeaders })
    expectAbsent(actual.headers, Object.keys({ ...mcpHeaders, ...privateHeaders }))
  }
})

test('MCP retains its own methods and headers without accepting LLM identity headers', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    received.push({ url: req.url, method: req.method, headers: req.headers })
    req.resume()
    res.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'returned-mcp-session',
      'mcp-protocol-version': '2025-06-18',
      'retry-after': '42',
      'set-cookie': 'must-not-forward=1',
    })
    res.end('{"ok":true}')
  })
  const llmOnly = clientHeaders
  for (const method of ['GET', 'POST', 'DELETE']) {
    const result = await call(port, '/mcp', {
      method,
      body: method === 'POST' ? '{"input":"synthetic"}' : '',
      headers: { ...sharedHeaders, ...mcpHeaders, ...llmOnly, ...privateHeaders },
    })
    assert.equal(result.status, 200)
    expectPreserved(result.headers, {
      'content-type': 'application/json',
      'mcp-session-id': 'returned-mcp-session',
      'mcp-protocol-version': '2025-06-18',
    })
    expectAbsent(result.headers, ['retry-after', 'set-cookie'])
    const actual = received.at(-1)
    assert.equal(actual.url, '/mcp')
    assert.equal(actual.method, method)
    expectPreserved(actual.headers, { ...sharedHeaders, ...mcpHeaders })
    expectAbsent(actual.headers, Object.keys({ ...llmOnly, ...privateHeaders }))
  }
})

test('MCP GET and DELETE bodies remain a single framed request upstream', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() })
      res.end('received one framed request')
    })
  })
  const body = 'POST /unexpected HTTP/1.1\r\nHost: local.test\r\nContent-Length: 0\r\n\r\n'
  for (const method of ['GET', 'DELETE']) {
    const result = await call(port, '/mcp', {
      method,
      body,
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body, 'received one framed request')
    assert.deepEqual(received.at(-1), { url: '/mcp', method, body })
  }
  assert.equal(received.length, 2)
})

test('only literal allowlisted paths and methods reach upstream', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    received.push(req.url)
    req.resume()
    res.end('unexpected')
  })
  const deniedPaths = [
    '/v1/responses',
    '/v1/chat/completions',
    '/zai/v4/chat/completions?x=1',
    '/zai/v4/chat/completions/',
    '/zai/v4/chat/%63ompletions',
    '/zai/v4//chat/completions',
    '//zai/v4/chat/completions',
    '/zai/v4/../v4/chat/completions',
    '/zai/v4/chat/completions#fragment',
    '/zai/v4/models',
    '/zai/v4/embeddings',
    '/zai/chat/completions',
    '/api/coding/paas/v4/chat/completions',
    '/api/monitor/usage/quota/limit',
    '/mcp?x=1',
    'http://example.test/zai/v4/chat/completions',
  ]
  for (const path of deniedPaths) assert.equal((await call(port, path)).status, 403, path)
  for (const path of llmPaths)
    for (const method of ['GET', 'DELETE', 'PUT', 'HEAD', 'OPTIONS'])
      assert.equal((await call(port, path, { method })).status, 403, `${method} ${path}`)
  for (const method of ['PUT', 'HEAD', 'OPTIONS'])
    assert.equal((await call(port, '/mcp', { method })).status, 403, `${method} /mcp`)
  assert.equal(received.length, 0)
})

test('route groups remain isolated even when both origins are configured', async (t) => {
  for (const routes of [[], ['llm'], ['mcp']]) {
    await t.test(`routes=${routes.join(',') || 'none'}`, async (subtest) => {
      const received = []
      const { port } = await fixture(
        subtest,
        (req, res) => {
          received.push(req.url)
          req.resume()
          res.end('allowed')
        },
        { routes },
      )
      for (const path of [...llmPaths, '/mcp']) {
        const enabled = routes.includes(path === '/mcp' ? 'mcp' : 'llm')
        assert.equal((await call(port, path)).status, enabled ? 200 : 403, path)
      }
      assert.deepEqual(
        received,
        [...llmPaths, '/mcp'].filter((path) => routes.includes(path === '/mcp' ? 'mcp' : 'llm')),
      )
    })
  }
})

test('source address and Host remain checked before any upstream connection', async (t) => {
  let received = 0
  const handler = (req, res) => {
    received += 1
    req.resume()
    res.end('unexpected')
  }
  const normal = await fixture(t, handler)
  for (const host of ['evil.test', 'sandbox-gw:9999', 'sandbox-gw.evil.test'])
    assert.equal((await call(normal.port, llmPaths[0], { headers: { host } })).status, 403)
  const wrongSource = await fixture(t, handler, { clientIp: '127.0.0.2' })
  assert.equal((await call(wrongSource.port, llmPaths[0])).status, 403)
  assert.equal(received, 0)
})

test('duplicate forwarded request headers are refused even when Node would discard one value', async (t) => {
  let received = 0
  const { port } = await fixture(t, (req, res) => {
    received += 1
    req.resume()
    res.end('unexpected')
  })
  for (const [path, name, value] of [
    [llmPaths[0], 'Host', 'sandbox-gw'],
    [llmPaths[0], 'Authorization', 'Bearer synthetic'],
    [llmPaths[0], 'Content-Type', 'application/json'],
    [llmPaths[0], 'Accept', 'text/event-stream'],
    [llmPaths[0], 'User-Agent', 'synthetic-cli/1.0'],
    ['/mcp', 'Mcp-Session-Id', 'synthetic-session'],
    ['/mcp', 'Mcp-Protocol-Version', '2025-06-18'],
  ]) {
    const host = name === 'Host' ? '' : 'Host: sandbox-gw\r\n'
    const raw = `POST ${path} HTTP/1.1\r\n${host}${name}: ${value}\r\n${name.toLowerCase()}: ${value}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    assert.match(await rawCall(port, raw), /^HTTP\/1\.1 403 /, name)
  }
  assert.equal(received, 0)
})

test('Connection-nominated request and response headers are removed across both groups', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    received.push(req.headers)
    req.resume()
    res.writeHead(200, {
      'content-type': 'application/json',
      connection: ' RETRY-AFTER , Mcp-Session-Id ',
      'retry-after': '42',
      'mcp-session-id': 'must-not-forward',
      'mcp-protocol-version': '2025-06-18',
    })
    res.end('{"ok":true}')
  })
  for (const path of [...llmPaths, '/mcp']) {
    const result = await call(port, path, {
      headers: {
        ...sharedHeaders,
        ...clientHeaders,
        ...mcpHeaders,
        connection: ' AUTHORIZATION , User-Agent , MCP-Session-ID ',
      },
    })
    assert.equal(result.status, 200)
    expectAbsent(received.at(-1), ['authorization', 'user-agent', 'mcp-session-id'])
    expectPreserved(received.at(-1), {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    })
    expectAbsent(result.headers, ['retry-after', 'mcp-session-id'])
    assert.equal(result.headers['content-type'], 'application/json')
    if (path === '/mcp') assert.equal(result.headers['mcp-protocol-version'], '2025-06-18')
  }
})

test('duplicate allowed upstream response headers produce a generic failure', async (t) => {
  const duplicates = ['content-type', 'retry-after', 'mcp-session-id']
  let index = 0
  const { port } = await fixture(t, (req, res) => {
    req.resume()
    const name = duplicates[index++]
    res.writeHead(200, [name, 'synthetic-first', name.toUpperCase(), 'synthetic-second'])
    res.end('must-not-forward')
  })
  for (const path of [llmPaths[0], llmPaths[0], '/mcp']) {
    const result = await call(port, path)
    assert.equal(result.status, 502)
    assert.equal(result.body, 'Gateway request failed\n')
    expectAbsent(result.headers, ['retry-after', 'mcp-session-id'])
  }
  assert.equal(index, duplicates.length)
})

test('upstream redirects are refused for LLM and MCP without following Location', async (t) => {
  const received = []
  const { port } = await fixture(t, (req, res) => {
    received.push(req.url)
    req.resume()
    res.writeHead(307, { location: 'http://127.0.0.1:1/never', 'retry-after': '42' })
    res.end('redirect must not escape')
  })
  for (const path of [...llmPaths, '/mcp']) {
    const result = await call(port, path)
    assert.equal(result.status, 502)
    expectAbsent(result.headers, ['location', 'retry-after'])
    assert.equal(result.body, 'Gateway request failed\n')
  }
  assert.deepEqual(received, [...llmPaths, '/mcp'])
})

test(
  'an unexpected upstream protocol upgrade is refused immediately',
  { timeout: 5000 },
  async (t) => {
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      res.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' })
      res.flushHeaders()
    })
    const result = await call(port, llmPaths[0])
    assert.equal(result.status, 502)
    assert.equal(result.body, 'Gateway request failed\n')
    assert.equal(result.headers.upgrade, undefined)
  },
)

test(
  'SSE chunks arrive before upstream finishes and are preserved byte for byte',
  { timeout: 5000 },
  async (t) => {
    const first = 'data: {"delta":"first"}\n\n'
    const last = 'data: [DONE]\n\n'
    const started = deferred()
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(first)
      started.resolve(res)
    })
    const firstChunk = deferred()
    const ended = deferred()
    const chunks = []
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: llmPaths[0],
        method: 'POST',
        agent: false,
        headers: { host: 'sandbox-gw' },
      },
      (res) => {
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], 'text/event-stream')
        res.on('data', (chunk) => {
          chunks.push(chunk)
          firstChunk.resolve()
        })
        res.on('error', ended.reject)
        res.on('end', ended.resolve)
      },
    )
    req.on('error', ended.reject)
    req.end('{"synthetic":true}')
    t.after(() => req.destroy())
    const upstreamResponse = await started.promise
    await firstChunk.promise
    assert.equal(upstreamResponse.writableEnded, false)
    assert.equal(Buffer.concat(chunks).toString(), first)
    upstreamResponse.end(last)
    await ended.promise
    assert.equal(Buffer.concat(chunks).toString(), first + last)
  },
)

test(
  'a paused client applies backpressure to a large upstream stream',
  { timeout: 10000 },
  async (t) => {
    const total = 32 * 1024 * 1024
    const chunk = Buffer.alloc(64 * 1024, 's')
    const started = deferred()
    let sent = 0
    let completed = false
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      void (async () => {
        while (sent < total) {
          sent += chunk.length
          if (!res.write(chunk)) await once(res, 'drain')
        }
        completed = true
        res.end()
      })().catch(() => res.destroy())
    })
    const ended = deferred()
    let received = 0
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: llmPaths[0],
        method: 'POST',
        agent: false,
        headers: { host: 'sandbox-gw' },
      },
      (res) => {
        res.pause()
        started.resolve(res)
        res.on('data', (bytes) => {
          received += bytes.length
        })
        res.on('error', ended.reject)
        res.on('end', ended.resolve)
      },
    )
    req.on('error', ended.reject)
    req.end('{"synthetic":true}')
    t.after(() => req.destroy())
    const response = await started.promise
    await delay(50)
    assert.equal(completed, false)
    assert.ok(sent < total, `upstream already emitted ${sent} bytes`)
    response.resume()
    await ended.promise
    assert.equal(received, total)
    assert.equal(completed, true)
  },
)

test(
  'client disconnect closes the unfinished upstream SSE response',
  { timeout: 5000 },
  async (t) => {
    const disconnected = deferred()
    let ended = false
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      res.on('close', () => {
        ended = res.writableEnded
        disconnected.resolve()
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"synthetic":true}\n\n')
    })
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: llmPaths[0],
        method: 'POST',
        agent: false,
        headers: { host: 'sandbox-gw' },
      },
      (res) => {
        res.on('error', () => {})
        res.once('data', () => res.destroy())
      },
    )
    req.on('error', () => {})
    req.end('{"synthetic":true}')
    t.after(() => req.destroy())
    await disconnected.promise
    assert.equal(ended, false)
  },
)

test(
  'an early upstream reply completes before the unfinished upload is cancelled',
  { timeout: 5000 },
  async (t) => {
    const uploadCancelled = deferred()
    const { port } = await fixture(t, (req, res) => {
      let early = false
      req.once('data', (chunk) => {
        early = chunk.toString() === 'early'
        if (early) res.end('complete early response')
      })
      req.socket.on('close', () => {
        if (early) uploadCancelled.resolve(req.complete)
      })
      req.on('end', () => {
        if (!early) res.end('normal response')
      })
    })
    const completed = deferred()
    const client = request(
      {
        hostname: '127.0.0.1',
        port,
        path: llmPaths[0],
        method: 'POST',
        agent: false,
        headers: { host: 'sandbox-gw', 'content-length': '128' },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', completed.reject)
        res.on('end', () =>
          completed.resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    client.on('error', completed.reject)
    client.write('early')
    t.after(() => client.destroy())
    assert.deepEqual(await completed.promise, { status: 200, body: 'complete early response' })
    assert.equal(await uploadCancelled.promise, false)
    const normal = await call(port, llmPaths[0])
    assert.equal(normal.status, 200)
    assert.equal(normal.body, 'normal response')
  },
)

test(
  'the LLM backstop expires at eleven minutes and MCP remains live until twenty',
  { timeout: 5000 },
  async (t) => {
    const started = deferred()
    const closed = []
    let received = 0
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      res.on('close', () => closed.push(req.url))
      received += 1
      if (received === 2) started.resolve()
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const llm = call(port, llmPaths[0])
      const mcp = call(port, '/mcp')
      await started.promise
      t.mock.timers.tick(11 * 60 * 1000 - 1)
      // Real time: an abort needs socket events to reach the upstream side.
      await realDelay(100)
      assert.deepEqual(closed, [])
      t.mock.timers.tick(1)
      assert.equal((await llm).status, 502)
      assert.ok(!closed.includes('/mcp'))
      t.mock.timers.tick(9 * 60 * 1000 - 1)
      await realDelay(100)
      assert.ok(!closed.includes('/mcp'))
      t.mock.timers.tick(1)
      assert.equal((await mcp).status, 502)
    } finally {
      t.mock.timers.reset()
    }
  },
)

test(
  'the role llm limit fires before the sandbox-gw backstop, so the role never sees its own deadline as a client abort',
  { timeout: 5000 },
  async (t) => {
    const roleLimitMs = 10 * 60 * 1000
    const armed = deferred()
    const outcome = deferred()
    const { port } = await fixture(t, (req, res) => {
      req.resume()
      // The role arms its limit when the request reaches it: later than sandbox-gw does.
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        res.destroy()
      }, roleLimitMs + 3)
      res.on('close', () => {
        clearTimeout(timer)
        outcome.resolve(expired ? 'aborted_platform' : 'aborted_client')
      })
      armed.resolve()
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const result = call(port, llmPaths[0])
      await armed.promise
      t.mock.timers.tick(roleLimitMs)
      // A gateway that gives up here closes the upstream socket before the role limit fires.
      assert.equal(await Promise.race([outcome.promise, realDelay(300)]), undefined)
      t.mock.timers.tick(3)
      assert.equal(await outcome.promise, 'aborted_platform')
      assert.equal((await result).status, 502)
    } finally {
      t.mock.timers.reset()
    }
  },
)

test('the LLM backstop stays above the request limit of the role llm', async () => {
  const role = await readFile(
    new URL('../../apps/orchestrator/src/llm-gateway/server.ts', import.meta.url),
    'utf8',
  )
  const limit = /\brequestMs:\s*([\d_]+)/.exec(role)
  assert.ok(limit, 'The role llm request limit moved: update this check')
  const roleLimitMs = Number(limit[1].replaceAll('_', ''))
  // The role must classify and journal its own deadline before the backstop closes the socket.
  assert.ok(gatewayLimits.llmMs >= roleLimitMs + 30_000)
  assert.ok(gatewayLimits.mcpMs > gatewayLimits.llmMs)
})

test(
  'the upstream request starts before the client sends its body',
  { timeout: 5000 },
  async (t) => {
    const reached = deferred()
    const { port } = await fixture(t, (req, res) => {
      reached.resolve()
      req.resume()
      req.on('end', () => res.end('complete'))
    })
    const done = deferred()
    const client = request(
      {
        hostname: '127.0.0.1',
        port,
        path: llmPaths[0],
        method: 'POST',
        agent: false,
        headers: { host: 'sandbox-gw', 'content-length': '2' },
      },
      (res) => {
        res.resume()
        res.on('end', () => done.resolve(res.statusCode))
      },
    )
    client.on('error', done.reject)
    client.flushHeaders()
    t.after(() => client.destroy())
    // The role starts its own clock here, not when the sandbox finally uploads the body.
    await reached.promise
    client.end('{}')
    assert.equal(await done.promise, 200)
  },
)

test(
  'a declared body above 16 MiB gets a final 400 once it has been read, with no upstream connection',
  { timeout: 20000 },
  async (t) => {
    const received = []
    const served = await fixture(t, (req, res) => {
      received.push(req.url)
      req.resume()
      res.end('allowed')
    })
    let connections = 0
    served.gateway.on('connection', () => {
      connections += 1
    })
    const body = Buffer.alloc(gatewayLimits.requestBytes + 1, 'x')
    for (const path of [...llmPaths, '/mcp']) {
      // One connection for both requests, as the HTTP client of a CLI keeps it.
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      t.after(() => agent.destroy())
      const post = (payload) =>
        new Promise((resolve, reject) => {
          const client = request(
            {
              hostname: '127.0.0.1',
              port: served.port,
              path,
              method: 'POST',
              agent,
              headers: {
                host: 'sandbox-gw',
                'content-type': 'application/json',
                'content-length': String(payload.length),
              },
            },
            (res) => {
              const chunks = []
              res.on('data', (chunk) => chunks.push(chunk))
              res.on('error', reject)
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString(),
                }),
              )
            },
          )
          client.on('error', reject)
          client.end(payload)
        })
      const before = connections
      const result = await post(body)
      assert.equal(result.status, 400, path)
      assert.equal(result.headers['content-type'], 'application/json')
      assert.equal(result.headers['retry-after'], undefined)
      assert.equal(result.body, tooLargeBody)
      // Read to its end, the request left the connection in order: the next one is answered
      // on it. A connection ended here would only race the next request of a client that
      // had already taken it back.
      assert.notEqual(result.headers.connection, 'close')
      for (const next of [await post(Buffer.from('{}')), await post(Buffer.from('{}'))])
        assert.deepEqual({ status: next.status, body: next.body }, { status: 200, body: 'allowed' })
      assert.equal(connections - before, 1, path)
    }
    // Nothing of a refused body went upstream: two small requests a path did.
    assert.deepEqual(
      received,
      [...llmPaths, '/mcp'].flatMap((path) => [path, path]),
    )
  },
)

/** A raw client on a connection of its own, with the socket the gateway serves it on. */
async function rawClient(t, { port, gateway }) {
  const accepted = once(gateway, 'connection')
  // Half-open: the end of what the gateway sends does not end what this client sends.
  const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true })
  t.after(() => socket.destroy())
  const client = { socket, response: '', errors: [], length: gatewayLimits.requestBytes + 1 }
  socket.on('data', (bytes) => {
    client.response += bytes.toString()
  })
  socket.on('error', (error) => client.errors.push(error.code))
  await once(socket, 'connect')
  ;[client.served] = await accepted
  return client
}

/** Writes the bytes of a body in pieces of 1 MiB, each framed by `frame` when it is given. */
async function writeBody(socket, bytes, frame = (part) => [part]) {
  const chunk = Buffer.alloc(1024 * 1024, 'x')
  for (let left = bytes; left > 0; left -= chunk.length)
    for (const piece of frame(left >= chunk.length ? chunk : chunk.subarray(0, left)))
      if (!socket.write(piece)) await once(socket, 'drain')
}

/** A raw client that has sent the head of an oversized upload and a part of its body. */
async function startedUpload(t, served) {
  const upload = await rawClient(t, served)
  upload.sent = 'partial'
  upload.socket.write(
    `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Type: application/json\r\nContent-Length: ${upload.length}\r\n\r\n${upload.sent}`,
  )
  // The gateway has the head of the request: what it decides by the declared length is decided.
  while (upload.served.bytesRead === 0) await realDelay(5)
  return upload
}

test(
  'a refused upload is answered only when it has been read to its end, and its connection serves the next request',
  { timeout: 20000 },
  async (t) => {
    const received = []
    const served = await fixture(t, (req, res) => {
      received.push(req.url)
      req.resume()
      res.end('allowed')
    })
    const upload = await startedUpload(t, served)
    // No answer while the body is still coming: the runtime of the pinned CLI stops uploading
    // when an answer comes early, keeps the connection, and sends its next request into what
    // the gateway still reads as this body.
    await realDelay(200)
    assert.equal(upload.response, '')
    await writeBody(upload.socket, upload.length - upload.sent.length)
    while (!upload.response.includes(tooLargeBody)) await realDelay(5)
    const [head, body] = upload.response.split('\r\n\r\n')
    assert.match(head, /^HTTP\/1\.1 400 /)
    assert.doesNotMatch(head, /\r\nconnection: close/i)
    assert.equal(body, tooLargeBody)
    assert.deepEqual(received, [])
    // The same connection, in order: the next request on it reaches upstream and is answered.
    upload.response = ''
    upload.socket.write(
      `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Length: 2\r\n\r\n{}`,
    )
    while (!upload.response.includes('allowed')) await realDelay(5)
    assert.match(upload.response, /^HTTP\/1\.1 200 /)
    assert.deepEqual(received, [llmPaths[0]])
    assert.deepEqual(upload.errors, [])
    assert.equal(upload.served.destroyed, false)
  },
)

test(
  'a streamed upload beyond the limit is answered only when it has ended, and its connection serves the next request',
  { timeout: 20000 },
  async (t) => {
    const received = []
    const served = await fixture(t, (req, res) => {
      received.push(req.url)
      req.resume()
      req.on('error', () => {})
      req.on('end', () => res.end('allowed'))
    })
    const upload = await rawClient(t, served)
    upload.socket.write(
      `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
    )
    await writeBody(upload.socket, upload.length, (part) => [
      `${part.length.toString(16)}\r\n`,
      part,
      '\r\n',
    ])
    // The limit is crossed and the upload has not ended: no byte of an answer, as with a
    // declared length. Nothing tells the gateway beforehand how long such a body is.
    await realDelay(200)
    assert.equal(upload.response, '')
    upload.socket.write('0\r\n\r\n')
    while (!upload.response.includes(tooLargeBody)) await realDelay(5)
    const [head, body] = upload.response.split('\r\n\r\n')
    assert.match(head, /^HTTP\/1\.1 400 /)
    assert.doesNotMatch(head, /\r\nconnection: close/i)
    assert.equal(body, tooLargeBody)
    upload.response = ''
    upload.socket.write(
      `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Length: 2\r\n\r\n{}`,
    )
    while (!upload.response.includes('allowed')) await realDelay(5)
    assert.match(upload.response, /^HTTP\/1\.1 200 /)
    assert.equal(received.at(-1), llmPaths[0])
    assert.deepEqual(upload.errors, [])
    assert.equal(upload.served.destroyed, false)
  },
)

test(
  'refused uploads on one connection leave no listener on its socket',
  { timeout: 30000 },
  async (t) => {
    const served = await fixture(t, (req, res) => {
      req.resume()
      res.end('unexpected')
    })
    const upload = await rawClient(t, served)
    const before = upload.served.listenerCount('close')
    // The connection outlives each refusal; what a refusal leaves on it would pile up. Twelve
    // is beyond the ten listeners of one event at which Node warns of a leak.
    for (let round = 0; round < 12; round += 1) {
      upload.response = ''
      upload.socket.write(
        `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Length: ${upload.length}\r\n\r\n`,
      )
      await writeBody(upload.socket, upload.length)
      while (!upload.response.includes(tooLargeBody)) await realDelay(2)
    }
    assert.equal(upload.served.listenerCount('close'), before)
    assert.deepEqual(upload.errors, [])
  },
)

test(
  'an oversized upload that does not end is answered after a short linger, with the end of the connection',
  { timeout: 5000 },
  async (t) => {
    const served = await fixture(t, (req, res) => {
      req.resume()
      res.end('unexpected')
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const upload = await startedUpload(t, served)
      const ended = once(upload.socket, 'end')
      t.mock.timers.tick(gatewayLimits.lingerMs - 1)
      await realDelay(100)
      assert.equal(upload.response, '')
      t.mock.timers.tick(1)
      // The whole answer by its length, and behind it the end of what the gateway sends: the
      // rest of the body will not be read, so nothing more may come on this connection.
      await ended
      const [head, body] = upload.response.split('\r\n\r\n')
      assert.match(head, /^HTTP\/1\.1 400 /)
      assert.match(head, /\r\nconnection: close(\r\n|$)/i)
      assert.match(
        head,
        new RegExp(`\\r\\ncontent-length: ${Buffer.byteLength(tooLargeBody)}(\\r\\n|$)`, 'i'),
      )
      assert.equal(body, tooLargeBody)
      // The socket itself goes one more linger later: a reset under a client that is still
      // uploading could cost it the answer it has not read yet.
      t.mock.timers.tick(gatewayLimits.lingerMs - 1)
      await realDelay(100)
      assert.equal(upload.served.destroyed, false)
      t.mock.timers.tick(1)
      if (!upload.served.destroyed) await once(upload.served, 'close')
    } finally {
      t.mock.timers.reset()
    }
  },
)

test(
  'an upload that ends after the late answer ends its connection at once, and the gateway goes on',
  { timeout: 20000 },
  async (t) => {
    const served = await fixture(t, (req, res) => {
      req.resume()
      res.end('allowed')
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const upload = await startedUpload(t, served)
      t.mock.timers.tick(gatewayLimits.lingerMs)
      while (!upload.response.includes(tooLargeBody)) await realDelay(5)
      // The rest of the body arrives after all. The answer has gone: a second one would be an
      // error thrown inside the gateway process, which nothing in it catches.
      const closed = once(upload.served, 'close')
      // The gateway may drop the connection under the last write: a reset is not a failure here.
      await Promise.race([
        writeBody(upload.socket, upload.length - upload.sent.length).catch(() => {}),
        new Promise((resolve) => upload.socket.once('close', resolve)),
      ])
      await closed
      assert.equal(upload.response.split('HTTP/1.1 ').length - 1, 1)
    } finally {
      t.mock.timers.reset()
    }
    const next = await rawClient(t, served)
    next.socket.write(
      `POST ${llmPaths[0]} HTTP/1.1\r\nHost: sandbox-gw\r\nContent-Length: 2\r\n\r\n{}`,
    )
    while (!next.response.includes('allowed')) await realDelay(5)
    assert.match(next.response, /^HTTP\/1\.1 200 /)
  },
)

test(
  'a streamed body is forwarded at exactly 16 MiB and gets a final 400 instead of a retryable 502 beyond it',
  { timeout: 20000 },
  async (t) => {
    const received = []
    const { port } = await fixture(t, (req, res) => {
      let bytes = 0
      req.on('data', (chunk) => {
        bytes += chunk.length
      })
      req.on('close', () => received.push({ bytes, complete: req.complete }))
      req.on('end', () => res.end('accepted'))
    })
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    t.after(() => agent.destroy())
    const upload = (bytes) =>
      new Promise((resolve, reject) => {
        const client = request(
          {
            hostname: '127.0.0.1',
            port,
            path: llmPaths[0],
            method: 'POST',
            agent,
            headers: { host: 'sandbox-gw', 'content-type': 'application/json' },
          },
          (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString(),
                closing: res.headers.connection === 'close',
              })
              // Like the HTTP client of a CLI: a final answer ends an unfinished upload.
              if (!client.writableEnded) client.destroy()
            })
          },
        )
        client.on('error', reject)
        const chunk = Buffer.alloc(1024 * 1024, 'x')
        // One listener for the whole upload, not one per chunk.
        const closed = new Promise((resolve) => client.once('close', resolve))
        void (async () => {
          for (let left = bytes; left > 0 && !client.destroyed; left -= chunk.length) {
            const part = left >= chunk.length ? chunk : chunk.subarray(0, left)
            if (!client.write(part))
              await Promise.race([new Promise((resolve) => client.once('drain', resolve)), closed])
          }
          if (!client.destroyed) client.end()
        })().catch(reject)
      })
    assert.deepEqual(await upload(gatewayLimits.requestBytes), {
      status: 200,
      body: 'accepted',
      closing: false,
    })
    while (received.length < 1) await realDelay(5)
    assert.deepEqual(received, [{ bytes: gatewayLimits.requestBytes, complete: true }])
    for (const bytes of [gatewayLimits.requestBytes + 1, 24 * 1024 * 1024]) {
      // Answered when the upload has ended: the connection is kept, and serves the next one.
      assert.deepEqual(
        await upload(bytes),
        { status: 400, body: tooLargeBody, closing: false },
        String(bytes),
      )
      while (received.length < 2) await realDelay(5)
      const aborted = received.pop()
      assert.equal(aborted.complete, false)
      assert.ok(aborted.bytes <= gatewayLimits.requestBytes)
    }
    // The refused uploads released their slot.
    assert.deepEqual(await upload(64), { status: 200, body: 'accepted', closing: false })
  },
)

test(
  'CONNECT and HTTP upgrades close the socket without reaching upstream',
  { timeout: 5000 },
  async (t) => {
    let received = 0
    const { port } = await fixture(t, (req, res) => {
      received += 1
      req.resume()
      res.end('unexpected')
    })
    for (const raw of [
      'CONNECT example.test:443 HTTP/1.1\r\nHost: sandbox-gw\r\n\r\n',
      'GET /zai/v4/chat/completions HTTP/1.1\r\nHost: sandbox-gw\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    ]) {
      const socket = connect({ host: '127.0.0.1', port })
      t.after(() => socket.destroy())
      let response = ''
      socket.on('data', (bytes) => {
        response += bytes.toString()
      })
      const closed = once(socket, 'close')
      await once(socket, 'connect')
      socket.end(raw)
      await closed
      assert.equal(response, '')
    }
    assert.equal(received, 0)
  },
)
