// The cabinet's frame of the stand of the site stacks (frame.mjs; docs/plan/62-slices/e3.md, Э3.11):
// the page holds the preview in the sandbox of the cabinet, and WebKit's forwarder turns only the
// addresses of the preview into secure ones. Nothing here starts a browser.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:http'
import { test } from 'node:test'

import { PREVIEW_SANDBOX } from '../../../packages/domain/src/preview/hostname.ts'
import {
  FRAME_ENGINES,
  cabinetPage,
  sandboxOf,
  secureText,
  secureUrl,
  startSecureForwarder,
} from './frame.mjs'

const enter = 'http://site-a1b2c3d4-chat-e5f6a7.localhost:18090/__raditi/enter?t=x&to=%2F'

test('the page holds the preview with the sandbox of the cabinet, no referrer', () => {
  const html = cabinetPage(enter)
  assert.equal(sandboxOf(html), PREVIEW_SANDBOX)
  assert.match(html, /referrerpolicy="no-referrer"/)
  assert.ok(
    html.includes(
      'src="http://site-a1b2c3d4-chat-e5f6a7.localhost:18090/__raditi/enter?t=x&amp;to=%2F"',
    ),
  )
  assert.equal(cabinetPage('"><script>').includes('"><script>'), false)
  assert.deepEqual(FRAME_ENGINES, ['chromium', 'webkit'])
})

test('the forwarder makes only the addresses of the preview secure', () => {
  assert.equal(secureUrl(enter), enter.replace('http://', 'https://'))
  assert.throws(() => secureUrl('http://127.0.0.1:3000/'), /Not an address of a preview/)
  assert.throws(() => secureUrl('https://x.localhost/'), /Not an address of a preview/)
  const origin = 'http://site-a-chat-b.localhost:18090'
  assert.equal(
    secureText(
      '<base href="http://site-a-chat-b.localhost:18090/"><a href="http://localhost:18080/x">' +
        '{"root":"http:\\/\\/site-a-chat-b.localhost:18090"}',
      origin,
    ),
    '<base href="https://site-a-chat-b.localhost:18090/"><a href="http://localhost:18080/x">' +
      '{"root":"https:\\/\\/site-a-chat-b.localhost:18090"}',
  )
})

test('the forwarder takes CONNECT only to a preview on the gateway port', async () => {
  // A key of its own: no handshake runs here, the answer to CONNECT comes before one.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const forwarder = await startSecureForwarder({ key, cert: undefined, gatewayPort: 18090 })
  const answer = async (target) => {
    const connect = request({
      host: '127.0.0.1',
      port: new URL(forwarder.server).port,
      method: 'CONNECT',
      path: target,
    })
    connect.end()
    const [response, socket] = await once(connect, 'connect')
    socket.destroy()
    return response.statusCode
  }
  const plain = async (url) => {
    const asked = request({
      host: '127.0.0.1',
      port: new URL(forwarder.server).port,
      path: url,
      headers: { host: new URL(url).host },
    })
    asked.end()
    const [response] = await once(asked, 'response')
    response.resume()
    return [response.statusCode, response.headers.location ?? null]
  }
  try {
    assert.equal(await answer('evil.example:18090'), 403)
    assert.equal(await answer('site-a-chat-b.localhost:443'), 403)
    assert.equal(await answer('site-a-chat-b.localhost:18090'), 200)
    // A plain request of a preview goes to its secure address; anything else is refused.
    assert.deepEqual(await plain('http://site-a-chat-b.localhost:18090/x?y=1'), [
      301,
      'https://site-a-chat-b.localhost:18090/x?y=1',
    ])
    assert.deepEqual(await plain('http://127.0.0.1:3000/'), [403, null])
  } finally {
    await forwarder.close()
  }
})
