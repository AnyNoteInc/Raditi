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
  LINUX_WEBKIT_FRAME,
  cabinetPage,
  frameEnginesOn,
  frameRowProblems,
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

test('P5 signs in with WebKit on Docker Desktop only; on Linux and in a VM it notes why (О2б)', () => {
  assert.deepEqual(frameEnginesOn('desktop'), { signIn: ['chromium', 'webkit'], noted: [] })
  for (const kind of ['linux', 'vm'])
    assert.deepEqual(frameEnginesOn(kind), {
      signIn: ['chromium'],
      noted: [{ engine: 'webkit', reason: LINUX_WEBKIT_FRAME }],
    })
  // The reason names the cause and where the check is made instead: no silent hole.
  assert.match(LINUX_WEBKIT_FRAME, /third-party cookies/)
  assert.match(LINUX_WEBKIT_FRAME, /Partitioned/)
  assert.match(LINUX_WEBKIT_FRAME, /Docker Desktop/)
  assert.match(LINUX_WEBKIT_FRAME, /Т69/)
  assert.throws(() => frameEnginesOn('mac'), /No kind of host mac/)
  assert.throws(() => frameEnginesOn(undefined), /No kind of host/)
})

test('the rows of P5 match the host: WebKit rows on Docker Desktop, its note elsewhere', () => {
  const runs = [
    { build: { archive: 'joomla-5.4.10' }, groups: ['import', 'preview', 'release'] },
    { build: { archive: 'joomla-6.2.0' }, groups: ['import'] },
  ]
  const row = (engine, ok = true) => ({ id: `P5 joomla-5.4.10 ${engine}`, ok })
  // Docker Desktop: a row of each engine; a failed one is still a row (its failure fails the run).
  assert.deepEqual(
    frameRowProblems(runs, [row('chromium'), row('webkit', false)], [], 'desktop'),
    [],
  )
  // The kind of the call wrong on Docker Desktop: the WebKit row is missing.
  assert.deepEqual(frameRowProblems(runs, [row('chromium')], [], 'desktop'), [
    'no row P5 joomla-5.4.10 webkit',
  ])
  for (const kind of ['linux', 'vm']) {
    const noted = ['P5 joomla-5.4.10 webkit']
    assert.deepEqual(frameRowProblems(runs, [row('chromium')], noted, kind), [], kind)
    // A WebKit row on Linux, its note missing, Chromium missing: each is named.
    assert.deepEqual(frameRowProblems(runs, [row('chromium'), row('webkit')], noted, kind), [
      `a row P5 joomla-5.4.10 webkit on a ${kind} host`,
    ])
    assert.deepEqual(frameRowProblems(runs, [row('chromium')], [], kind), [
      'no note of P5 joomla-5.4.10 webkit',
    ])
    assert.deepEqual(frameRowProblems(runs, [], noted, kind), ['no row P5 joomla-5.4.10 chromium'])
  }
  // A build without the group `preview` needs no row of P5.
  assert.deepEqual(frameRowProblems([runs[1]], [], [], 'desktop'), [])
  assert.throws(() => frameRowProblems(runs, [], [], undefined), /No kind of host/)
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
