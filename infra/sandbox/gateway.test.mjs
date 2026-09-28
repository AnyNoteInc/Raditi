import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'

import { createGateway } from './gateway.mjs'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const close = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
const call = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
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
    req.end('{"input":"synthetic"}')
  })

test('gateway uses fixed origins, forwards only intended headers and refuses redirects/raw alternate paths', async () => {
  const received = []
  const upstream = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers })
    req.resume()
    if (req.url === '/mcp') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/never' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'must-not-forward=1',
      'x-private': 'hidden',
    })
    res.end('{"ok":true}')
  })
  await listen(upstream)
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const gateway = createGateway({
    listenHost: '127.0.0.1',
    clientIp: '127.0.0.1',
    routes: ['llm', 'mcp'],
    llmUpstream: origin,
    mcpUpstream: origin,
  })
  await listen(gateway)
  try {
    const port = gateway.address().port
    const accepted = await call(port, '/v1/responses', {
      authorization: 'Bearer synthetic',
      cookie: 'must-not-forward',
      'x-forwarded-host': 'evil',
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body, '{"ok":true}')
    assert.equal(accepted.headers['set-cookie'], undefined)
    assert.equal(accepted.headers['x-private'], undefined)
    assert.equal(received[0].headers.host, `127.0.0.1:${upstream.address().port}`)
    assert.equal(received[0].headers.authorization, 'Bearer synthetic')
    assert.equal(received[0].headers.cookie, undefined)
    assert.equal(received[0].headers['x-forwarded-host'], undefined)
    assert.equal((await call(port, '/mcp')).status, 502)
    for (const path of [
      'http://example.test/v1/responses',
      '//v1/responses',
      '/v1/%72esponses',
      '/v1/responses?x=1',
    ])
      assert.equal((await call(port, path)).status, 403)
    assert.equal(received.length, 2)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})
