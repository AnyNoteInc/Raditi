import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chromiumArgs, parseArgs, proxyOption, readSecret, WS_PATH } from './browser-server.mjs'

test('arguments: the browser address, its port and the relay as an HTTP proxy, each once', () => {
  assert.deepEqual(
    parseArgs(['--host=172.25.0.3', '--port=9333', '--proxy=http://172.25.0.2:3128']),
    { host: '172.25.0.3', port: 9333, proxy: 'http://172.25.0.2:3128' },
  )
  for (const argv of [
    ['--host=0.0.0.0'],
    ['--host=172.25.0.3', '--port=9333', '--proxy=socks5://172.25.0.2:3128'],
    ['--host=172.25.0.3', '--port=9333', '--proxy=http://relay:3128'],
    ['--host=172.25.0.3', '--port=99999', '--proxy=http://172.25.0.2:3128'],
    ['--host=172.25.0.3', '--host=172.25.0.4', '--port=9333', '--proxy=http://172.25.0.2:3128'],
    [
      '--host=172.25.0.3',
      '--port=9333',
      '--proxy=http://172.25.0.2:3128',
      '--remote-debugging-port=9222',
    ],
  ])
    assert.equal(parseArgs(argv), null, argv.join(' '))
})

test('Chromium: every request through the relay, loopback names too, no WebRTC around it', () => {
  // Playwright turns the option into `--proxy-server=<relay>` and, for exactly this bypass,
  // `--proxy-bypass-list=<-loopback>`; its request API sends through the relay too.
  assert.deepEqual(proxyOption('http://172.25.0.2:3128'), {
    server: 'http://172.25.0.2:3128',
    bypass: '<-loopback>',
  })
  const args = chromiumArgs()
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'))
  // The proxy only through the option: a second flag would leave the request API around it.
  assert.ok(!args.some((arg) => arg.startsWith('--proxy-')))
  assert.ok(!args.some((arg) => arg.startsWith('--remote-debugging-port')))
})

test('the secret path: a regular file of the runtime, never a link, never a short path', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'raditi-browser-'))
  try {
    const secret = `/${'a'.repeat(43)}`
    assert.match(secret, WS_PATH)
    await writeFile(join(folder, 'ws-path'), `${secret}\n`)
    assert.equal(await readSecret(join(folder, 'ws-path')), secret)
    await symlink(join(folder, 'ws-path'), join(folder, 'link'))
    await assert.rejects(readSecret(join(folder, 'link')))
    await writeFile(join(folder, 'short'), '/abc')
    await assert.rejects(readSecret(join(folder, 'short')), /Invalid browser secret/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
