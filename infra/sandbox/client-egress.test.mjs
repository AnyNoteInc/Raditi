import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connect as tlsConnect } from 'node:tls'

import {
  isEgressAddressAllowed,
  parseEgressHost,
  parseIpSubnet,
} from '../../packages/domain/src/preview/egress-hosts.ts'
import {
  addressCheck,
  clientEgressConfig,
  clientHelloServerName,
  clientEgressLimits,
  createClientEgressProxy,
  interfaceSubnets,
  localTunnelHeadAllowed,
  parseAllowedHosts,
  parseLocalRoutes,
  parseSubnets,
  parseTarget,
} from './client-egress.mjs'

// What the tunnels lead to: one local server whatever address the proxy dials, so a test sees
// both what the proxy chose to dial and that the bytes went through.
const echo = createTcpServer((socket) => socket.pipe(socket))
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
after(() => echo.close())

const servers = []
after(() => servers.forEach((server) => server.close()))

/** A proxy over a fake resolver; `dialed` records every address and port it connected to. */
async function proxy({ names = {}, allow = ['api.example.ru:443'], ...options } = {}) {
  const lookups = []
  const dialed = []
  const logs = []
  const server = createClientEgressProxy({
    allow: new Set(allow),
    lookup: async (host) => {
      lookups.push(host)
      const answer = names[host]
      if (typeof answer === 'function') return answer(lookups.filter((h) => h === host).length)
      if (answer === undefined) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      return answer
    },
    dial: ({ address, port }) => {
      dialed.push({ address, port })
      return connect({ host: '127.0.0.1', port: echo.address().port })
    },
    log: (entry) => logs.push(entry),
    ...options,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { port: server.address().port, lookups, dialed, logs, server }
}

/** CONNECT through the proxy; the status line and the socket, still open after a 200. */
function tunnel(port, target, { extra = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let head = Buffer.alloc(0)
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.removeListener('data', onData)
      const text = head.subarray(0, end).toString('latin1')
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]),
        refusal: /raditi-egress: (\S+)/.exec(text)?.[1] ?? null,
        socket,
        rest: head.subarray(end + 4),
      })
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`)
  })
}

const u16 = (value) => Buffer.from([value >> 8, value & 255])
const extension = (type, data) => Buffer.concat([u16(type), u16(data.length), data])
const serverNameExtension = (name) => {
  const host = Buffer.from(name, 'latin1')
  const entry = Buffer.concat([Buffer.from([0]), u16(host.length), host])
  return extension(0x0000, Buffer.concat([u16(entry.length), entry]))
}

/**
 * A ClientHello as a TLS client starts a connection with: the server name `name` (null — none),
 * other extensions after it, cut into records of at most `recordBytes` bytes.
 */
function clientHello(name, { extensions = [], recordBytes = 16_384 } = {}) {
  const list = Buffer.concat([...(name === null ? [] : [serverNameExtension(name)]), ...extensions])
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(list.length),
    list,
  ])
  const handshake = Buffer.concat([
    Buffer.from([1, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]),
    body,
  ])
  const records = []
  for (let at = 0; at < handshake.length; at += recordBytes) {
    const fragment = handshake.subarray(at, at + recordBytes)
    records.push(Buffer.concat([Buffer.from([22, 3, 1]), u16(fragment.length), fragment]))
  }
  return Buffer.concat(records)
}

/** The first bytes a real TLS client of this Node writes for `servername`. */
async function realClientHello(servername) {
  const capture = createTcpServer()
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve))
  try {
    const first = new Promise((resolve) =>
      capture.once('connection', (socket) => socket.once('data', (chunk) => resolve(chunk))),
    )
    const client = tlsConnect({ host: '127.0.0.1', port: capture.address().port, servername })
    client.on('error', () => {})
    const bytes = await first
    client.destroy()
    return bytes
  } finally {
    capture.close()
  }
}

/** Writes the ClientHello of the listed host and then `text`; resolves with what came back. */
const roundTrip = (socket, text, name = 'api.example.ru') =>
  new Promise((resolve) => {
    const hello = clientHello(name)
    let received = Buffer.alloc(0)
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length < hello.length + Buffer.byteLength(text)) return
      socket.removeListener('data', onData)
      assert.deepEqual(received.subarray(0, hello.length), hello)
      resolve(received.subarray(hello.length).toString())
    }
    socket.on('data', onData)
    socket.write(Buffer.concat([hello, Buffer.from(text)]))
  })

test('a listed name with only public addresses gets a tunnel to the address it was checked at', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] } })
  const answer = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(answer.status, 200)
  assert.equal(await roundTrip(answer.socket, 'ping'), 'ping')
  answer.socket.destroy()
  assert.deepEqual(p.lookups, ['api.example.ru'])
  // The literal that passed the check, never the name: nothing is resolved a second time.
  assert.deepEqual(p.dialed, [{ address: '93.184.216.34', port: 443 }])
})

test('the target is matched in lower case, exactly, port included', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] } })
  const upper = await tunnel(p.port, 'API.Example.RU:443')
  assert.equal(upper.status, 200)
  upper.socket.destroy()
  for (const target of [
    'api.example.ru:8443',
    'other.example.ru:443',
    'evil.api.example.ru:443',
    'api.example.ru',
    '93.184.216.34:443',
    '[2a00:1450:4010:c05::64]:443',
    'host.docker.internal:443',
    'localhost:443',
    '127.0.0.1:443',
  ]) {
    const answer = await tunnel(p.port, target)
    assert.equal(answer.status, 403, target)
    assert.equal(answer.refusal, 'forbidden_host', target)
  }
  assert.deepEqual(p.lookups, ['api.example.ru'])
  assert.equal(p.dialed.length, 1)
})

test('a name that resolves to any address that is not public is refused before a connection', async () => {
  const cases = {
    'loopback.example.ru': ['127.0.0.1'],
    'private.example.ru': ['10.1.2.3'],
    'rfc1918b.example.ru': ['172.16.5.4'],
    'bridge.example.ru': ['172.17.0.1'],
    'home.example.ru': ['192.168.1.1'],
    'metadata.example.ru': ['169.254.169.254'],
    'cgnat.example.ru': ['100.64.0.1'],
    'zero.example.ru': ['0.0.0.0'],
    'multicast.example.ru': ['224.0.0.1'],
    'broadcast.example.ru': ['255.255.255.255'],
    'ula.example.ru': ['fd12:3456::1'],
    'v6loop.example.ru': ['::1'],
    'linklocal.example.ru': ['fe80::1'],
    'mapped.example.ru': ['::ffff:10.0.0.1'],
    'nat64.example.ru': ['64:ff9b::a00:1'],
    'mixed.example.ru': ['93.184.216.34', '10.0.0.1'],
    'mixed6.example.ru': ['2a00:1450:4010:c05::64', 'fc00::1'],
    'docs.example.ru': ['192.0.2.10'],
  }
  const allow = Object.keys(cases).map((name) => `${name}:443`)
  const p = await proxy({ names: cases, allow })
  for (const name of Object.keys(cases)) {
    const answer = await tunnel(p.port, `${name}:443`)
    assert.equal(answer.status, 403, name)
    assert.equal(answer.refusal, 'forbidden_address', name)
  }
  assert.deepEqual(p.dialed, [])
})

test('every connection resolves anew: a name that turns private is refused the next time', async () => {
  // Rebinding: public at the first lookup, the metadata service at the second. Each tunnel is
  // checked on what its own lookup said and dialed there, so the change cannot slip in between.
  const p = await proxy({
    names: { 'api.example.ru': (n) => (n === 1 ? ['93.184.216.34'] : ['169.254.169.254']) },
  })
  const first = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(first.status, 200)
  first.socket.destroy()
  const second = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(second.status, 403)
  assert.equal(second.refusal, 'forbidden_address')
  assert.deepEqual(p.lookups, ['api.example.ru', 'api.example.ru'])
  assert.deepEqual(p.dialed, [{ address: '93.184.216.34', port: 443 }])
})

test('the platform’s own subnets and those of the proxy’s interfaces are refused', async () => {
  const p = await proxy({
    names: { 'ours.example.ru': ['84.201.130.7'], 'theirs.example.ru': ['84.201.192.7'] },
    allow: ['ours.example.ru:443', 'theirs.example.ru:443'],
    refused: parseSubnets('84.201.128.0/18, 2a02:6b8:c00::/40'),
  })
  const ours = await tunnel(p.port, 'ours.example.ru:443')
  assert.equal(ours.refusal, 'forbidden_address')
  const theirs = await tunnel(p.port, 'theirs.example.ru:443')
  assert.equal(theirs.status, 200)
  theirs.socket.destroy()

  const check = addressCheck(
    interfaceSubnets({
      eth0: [{ address: '84.201.130.7', cidr: '84.201.128.0/18', family: 'IPv4' }],
      eth1: [{ address: '2a02:6b8:c00::5', cidr: '2a02:6b8:c00::/40', family: 'IPv6' }],
    }),
  )
  assert.equal(check('84.201.130.200'), false)
  assert.equal(check('2a02:6b8:c00::9'), false)
  assert.equal(check('84.201.192.7'), true)
})

test('the address rule refuses everything the domain rule refuses, the same corpus', () => {
  const check = addressCheck()
  for (const address of [
    '93.184.216.34',
    '8.8.8.8',
    '2a00:1450:4010:c05::64',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.0.8',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2001::1',
    '2001:db8::1',
    '2002::1',
    'example.ru',
    '',
  ]) {
    if (!isEgressAddressAllowed(address)) assert.equal(check(address), false, address)
    else assert.equal(check(address), true, address)
  }
  // Stricter than the domain only where no service lives: documentation and relay ranges.
  for (const address of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1'])
    assert.equal(check(address), false, address)
  const subnets = ['84.201.128.0/18', '2a02:6b8:c00::/40']
  const proxySide = addressCheck(parseSubnets(subnets.join(',')))
  const domainSide = subnets.map((text) => parseIpSubnet(text))
  for (const address of ['84.201.130.7', '84.201.192.7', '2a02:6b8:c00::1', '2a02:6b8:d00::1'])
    assert.equal(proxySide(address), isEgressAddressAllowed(address, domainSide), address)
})

test('a listed host is a public DNS name with a port, as the domain stores it', () => {
  for (const text of [
    'api.example.ru:443',
    'hooks.example.com:8443',
    'xn--80aswg.xn--p1ai:443',
    'a-b.c-d.example.org:1',
  ]) {
    const domain = parseEgressHost(text)
    assert.deepEqual(parseTarget(text), domain, text)
  }
  for (const text of [
    'api.example.ru',
    'API.example.ru:443',
    '127.0.0.1:443',
    '127.1:443',
    '2130706433:443',
    '0x7f.1:443',
    '[::1]:443',
    'localhost:443',
    'api.localhost:443',
    'host.docker.internal:443',
    'metadata.google.internal:80',
    'printer.local:443',
    'site.test:443',
    'router.lan:443',
    'nas.home:443',
    'intranet:443',
    'secret.onion:443',
    'x.invalid:443',
    'api.example.ru.:443',
    'api.example.ru:0',
    'api.example.ru:65536',
    'api_example.ru:443',
    'user@api.example.ru:443',
  ])
    assert.equal(parseTarget(text), null, text)
  assert.deepEqual(
    [...parseAllowedHosts('["a.example.ru:443","b.example.ru:8443"]')],
    ['a.example.ru:443', 'b.example.ru:8443'],
  )
  for (const json of [
    '',
    '[]',
    '{}',
    '["a.example.ru:443","a.example.ru:443"]',
    '["a.example.ru"]',
    '["127.0.0.1:443"]',
    '[1]',
    JSON.stringify(
      Array.from({ length: clientEgressLimits.hosts + 1 }, (_, i) => `h${i}.example.ru:443`),
    ),
  ])
    assert.throws(() => parseAllowedHosts(json), json)
})

test('plain HTTP is never forwarded', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] } })
  const status = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: p.port })
    socket.once('data', (chunk) => {
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1]))
      socket.destroy()
    })
    socket.write('GET http://api.example.ru:443/ HTTP/1.1\r\nHost: api.example.ru:443\r\n\r\n')
  })
  assert.equal(status, 405)
  assert.deepEqual(p.lookups, [])
  assert.deepEqual(p.dialed, [])
})

test('only the sandbox’s address may open a tunnel on sandbox-gw', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] }, clientIp: '10.9.9.3' })
  const answer = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(answer.status, 403)
  assert.equal(answer.refusal, 'forbidden_client')
  assert.deepEqual(p.lookups, [])
})

test('a name that does not resolve, an address that does not answer and a slow resolver', async () => {
  const p = await proxy({
    names: {
      'gone.example.ru': [],
      'down.example.ru': ['93.184.216.34', '93.184.216.35'],
      'slow.example.ru': () => new Promise(() => {}),
    },
    allow: [
      'gone.example.ru:443',
      'missing.example.ru:443',
      'down.example.ru:443',
      'slow.example.ru:443',
    ],
    connectTimeoutMs: 200,
    dial: ({ address, port }) => {
      p.dialed.push({ address, port })
      // The first address refuses; the second is tried, within the same deadline.
      return address === '93.184.216.34'
        ? connect({ host: '127.0.0.1', port: 1 })
        : connect({ host: '127.0.0.1', port: echo.address().port })
    },
  })
  assert.equal((await tunnel(p.port, 'gone.example.ru:443')).refusal, 'resolve')
  assert.equal((await tunnel(p.port, 'missing.example.ru:443')).refusal, 'resolve')
  const down = await tunnel(p.port, 'down.example.ru:443')
  assert.equal(down.status, 200)
  down.socket.destroy()
  assert.deepEqual(
    p.dialed.map((entry) => entry.address),
    ['93.184.216.34', '93.184.216.35'],
  )
  const slow = await tunnel(p.port, 'slow.example.ru:443')
  assert.equal(slow.status, 504)
  assert.equal(slow.refusal, 'connect_timeout')
})

test('tunnels are counted and bounded; the log names only listed hosts', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] }, maxTunnels: 1 })
  const first = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(first.status, 200)
  assert.equal(await roundTrip(first.socket, 'ping'), 'ping')
  const second = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(second.status, 503)
  first.socket.destroy()
  for (let i = 0; i < 50 && p.logs.filter((e) => e.result === 'ok').length === 0; i++)
    await delay(10)
  const third = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(third.status, 200)
  assert.equal(await roundTrip(third.socket, 'pong'), 'pong')
  third.socket.destroy()
  await tunnel(p.port, 'secret-path.attacker.example:443')
  for (let i = 0; i < 50 && p.logs.length < 5; i++) await delay(10)
  const text = JSON.stringify(p.logs)
  assert.doesNotMatch(text, /attacker/)
  assert.ok(p.logs.some((entry) => entry.host === 'api.example.ru:443' && entry.result === 'ok'))
  assert.ok(p.logs.some((entry) => entry.host === null && entry.result === 'forbidden_host'))
})

test('a tunnel carries only TLS whose ClientHello names the listed host', async () => {
  // What the far side received: on a shared front end the address of the listed host serves any
  // other site as well, so not a byte goes there before the hello names the host.
  const received = []
  const far = createTcpServer((socket) => {
    const bytes = []
    received.push(bytes)
    socket.on('data', (chunk) => bytes.push(chunk))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => far.listen(0, '127.0.0.1', resolve))
  after(() => far.close())
  const p = await proxy({
    names: { 'api.example.ru': ['93.184.216.34'] },
    dial: () => connect({ host: '127.0.0.1', port: far.address().port }),
  })
  const closedAfter = async (bytes) => {
    const answer = await tunnel(p.port, 'api.example.ru:443')
    assert.equal(answer.status, 200)
    const closed = new Promise((resolve) => answer.socket.once('close', resolve))
    answer.socket.on('error', () => {})
    answer.socket.write(bytes)
    await closed
  }
  const refusedHellos = {
    'another site': clientHello('attacker.example'),
    'a subdomain of it': clientHello('evil.api.example.ru'),
    'no server name': clientHello(null),
    'an encrypted ClientHello': clientHello('api.example.ru', {
      extensions: [extension(0xfe0d, Buffer.alloc(40, 1))],
    }),
    'the draft ESNI': clientHello('api.example.ru', {
      extensions: [extension(0xffce, Buffer.alloc(40, 1))],
    }),
    'two server names': clientHello('api.example.ru', {
      extensions: [serverNameExtension('attacker.example')],
    }),
    'plain HTTP': Buffer.from('GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n'),
    'a real client for another site': await realClientHello('attacker.example'),
  }
  for (const [label, bytes] of Object.entries(refusedHellos)) await closedAfter(bytes, label)
  for (let i = 0; i < 50 && p.logs.length < Object.keys(refusedHellos).length; i++) await delay(10)
  assert.equal(
    p.logs.filter((entry) => entry.result === 'forbidden_sni').length,
    Object.keys(refusedHellos).length,
  )
  assert.ok(received.every((bytes) => bytes.length === 0))
  // Nothing the client sent is logged, the name it claimed included.
  assert.doesNotMatch(JSON.stringify(p.logs), /attacker/)

  // The listed host, in a real client's hello and in one cut into tiny records and writes.
  for (const hello of [
    await realClientHello('api.example.ru'),
    clientHello('API.Example.RU', { recordBytes: 7 }),
  ]) {
    const before = received.length
    const answer = await tunnel(p.port, 'api.example.ru:443')
    assert.equal(answer.status, 200)
    for (let at = 0; at < hello.length; at += 5) {
      answer.socket.write(hello.subarray(at, at + 5))
      await delay(1)
    }
    for (let i = 0; i < 100 && Buffer.concat(received[before] ?? []).length < hello.length; i++)
      await delay(10)
    assert.deepEqual(Buffer.concat(received[before]), hello)
    answer.socket.destroy()
  }
})

test('a client that sends no ClientHello loses the tunnel at its deadline', async () => {
  const p = await proxy({ names: { 'api.example.ru': ['93.184.216.34'] }, helloMs: 100 })
  const answer = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(answer.status, 200)
  await new Promise((resolve) => answer.socket.once('close', resolve))
  assert.ok(p.logs.some((entry) => entry.result === 'forbidden_sni'))
})

test('the server name of a ClientHello: whole, partial or refused', () => {
  const hello = clientHello('api.example.ru')
  assert.deepEqual(clientHelloServerName(hello), { state: 'name', name: 'api.example.ru' })
  for (const cut of [0, 3, 5, 40, hello.length - 1])
    assert.deepEqual(clientHelloServerName(hello.subarray(0, cut)), { state: 'more' }, String(cut))
  // Records of one byte each still make one handshake.
  assert.deepEqual(clientHelloServerName(clientHello('a.example.ru', { recordBytes: 1 })), {
    state: 'name',
    name: 'a.example.ru',
  })
  const bad = (bytes, label) =>
    assert.deepEqual(clientHelloServerName(bytes), { state: 'refused' }, label)
  bad(Buffer.from('\x17\x03\x03\x00\x05hello', 'latin1'), 'application data')
  bad(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]), 'a ServerHello')
  bad(Buffer.from([22, 3, 1, 0x50, 0]), 'a record too large')
  bad(Buffer.from([22, 3, 1, 0, 4, 1, 0x7f, 0, 0]), 'a hello too large')
  bad(clientHello('api.example.ru.'), 'a trailing dot')
  bad(clientHello('api_example.ru'), 'not a host name')
  bad(clientHello('localhost'), 'a single label')
})

test('the far side closing ends the tunnel for the client', async () => {
  const closing = createTcpServer((socket) => socket.end('bye'))
  await new Promise((resolve) => closing.listen(0, '127.0.0.1', resolve))
  after(() => closing.close())
  const p = await proxy({
    names: { 'api.example.ru': ['93.184.216.34'] },
    dial: () => connect({ host: '127.0.0.1', port: closing.address().port }),
  })
  const answer = await tunnel(p.port, 'api.example.ru:443')
  assert.equal(answer.status, 200)
  const received = await new Promise((resolve) => {
    let text = answer.rest.toString()
    answer.socket.on('data', (chunk) => (text += chunk.toString()))
    answer.socket.on('end', () => resolve(text))
    answer.socket.write(clientHello('api.example.ru'))
  })
  assert.equal(received, 'bye')
  answer.socket.destroy()
})

test('the configuration comes from the environment and refuses anything else', () => {
  const config = clientEgressConfig({
    LISTEN_HOST: '10.200.0.5',
    LISTEN_PORT: '3128',
    ALLOWED_HOSTS: '["api.example.ru:443"]',
    REFUSED_SUBNETS: '84.201.128.0/18',
  })
  assert.equal(config.listenHost, '10.200.0.5')
  assert.equal(config.listenPort, 3128)
  assert.equal(config.clientIp, null)
  assert.deepEqual([...config.allow], ['api.example.ru:443'])
  assert.deepEqual(config.refused[0], { address: '84.201.128.0', prefix: 18, family: 4 })
  const base = {
    LISTEN_HOST: '10.200.0.5',
    LISTEN_PORT: '3128',
    ALLOWED_HOSTS: '["a.example.ru:443"]',
  }
  for (const bad of [
    { LISTEN_HOST: 'egress' },
    { LISTEN_HOST: '::1' },
    { LISTEN_PORT: '0' },
    { LISTEN_PORT: '70000' },
    { ALLOWED_HOSTS: '[]' },
    { REFUSED_SUBNETS: '10.0.0.0' },
    { REFUSED_SUBNETS: '10.0.0.0/33' },
    { REFUSED_SUBNETS: 'example.ru/8' },
    { CLIENT_IPV4: 'sandbox' },
  ])
    assert.throws(() => clientEgressConfig({ ...base, ...bad }), JSON.stringify(bad))
  assert.equal(clientEgressConfig({ ...base, CLIENT_IPV4: '10.200.0.3' }).clientIp, '10.200.0.3')
})

test('a client that resets its connection in the middle of a refusal or a lookup never stops the proxy', async () => {
  // Whatever the server answers, the client is gone already: a write into a reset socket fails.
  // Node removes the HTTP server's own error handler from a CONNECT socket: without one of the
  // proxy's, that failure would end the process — the LLM and MCP gateway with it on sandbox-gw.
  const p = await proxy({
    names: { 'slow.example.ru': () => delay(50).then(() => ['93.184.216.34']) },
    allow: ['slow.example.ru:443'],
  })
  const reset = (target) =>
    new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: p.port })
      socket.once('connect', () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, () =>
          socket.resetAndDestroy(),
        )
      })
      socket.once('close', resolve)
      socket.once('error', () => {})
    })
  for (let i = 0; i < 20; i++)
    await Promise.all([reset('evil.example.ru:443'), reset('slow.example.ru:443')])
  await delay(200)
  const answer = await tunnel(p.port, 'slow.example.ru:443')
  assert.equal(answer.status, 200)
  answer.socket.destroy()
})

// --- Local sites of a stand (LOCAL_HTTP_ROUTES) ------------------------------------------------

/** A local site: answers what it was asked, and holds requests to `/slow` until released. */
async function localSite() {
  const seen = []
  const held = []
  const site = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers['proxy-authorization'] ?? null,
        body: Buffer.concat(chunks).toString(),
      }
      seen.push(entry)
      const answer = () => {
        res.writeHead(201, { 'content-type': 'text/plain', 'x-site': 'local' })
        res.end(`site ${req.method} ${req.url}`)
      }
      if (req.url === '/slow') held.push(answer)
      else answer()
    })
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  servers.push(site)
  return { port: site.address().port, seen, held }
}

/** A request in absolute form through the proxy, as Chromium sends one to its HTTP proxy. */
const viaProxy = (port, url, { method = 'GET', host, body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: { host: host ?? new URL(url).host, ...headers },
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            refusal: response.headers['raditi-egress'] ?? null,
            connection: response.headers.connection,
            site: response.headers['x-site'] ?? null,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })

test('a local route forwards plain HTTP of its exact host:port to its fixed target, Host kept', async () => {
  const site = await localSite()
  const p = await proxy({
    localRoutes: parseLocalRoutes(
      JSON.stringify({ 'wp.localhost:8080': `127.0.0.1:${site.port}` }),
    ),
  })
  const page = await viaProxy(p.port, 'http://wp.localhost:8080/wp-admin/post-new.php?x=1', {
    headers: {
      'proxy-authorization': 'Basic c2VjcmV0',
      connection: 'keep-alive, x-drop',
      'x-drop': '1',
    },
  })
  assert.equal(page.status, 201)
  assert.equal(page.site, 'local')
  assert.equal(page.connection, 'close')
  assert.equal(page.body, 'site GET /wp-admin/post-new.php?x=1')
  const posted = await viaProxy(p.port, 'http://wp.localhost:8080/wp-json/wp/v2/media', {
    method: 'POST',
    body: 'новость',
  })
  assert.equal(posted.status, 201)
  // The site saw its own name, an origin-form path, the body, and nothing of the proxy's.
  assert.deepEqual(
    site.seen.map(({ method, url, host, authorization, body }) => ({
      method,
      url,
      host,
      authorization,
      body,
    })),
    [
      {
        method: 'GET',
        url: '/wp-admin/post-new.php?x=1',
        host: 'wp.localhost:8080',
        authorization: null,
        body: '',
      },
      {
        method: 'POST',
        url: '/wp-json/wp/v2/media',
        host: 'wp.localhost:8080',
        authorization: null,
        body: 'новость',
      },
    ],
  )
  // No name was resolved and nothing was dialed the way tunnels are.
  assert.deepEqual(p.lookups, [])
  assert.deepEqual(p.dialed, [])
  for (let i = 0; i < 50 && p.logs.length < 2; i++) await delay(10)
  assert.deepEqual(
    p.logs.map(({ event, host, result, status }) => ({ event, host, result, status })),
    [
      { event: 'request', host: 'wp.localhost:8080', result: 'ok', status: 201 },
      { event: 'request', host: 'wp.localhost:8080', result: 'ok', status: 201 },
    ],
  )
  assert.doesNotMatch(JSON.stringify(p.logs), /wp-admin|media|новость/)
})

test('everything but a listed local route stays refused', async () => {
  const site = await localSite()
  const p = await proxy({
    names: { 'api.example.ru': ['93.184.216.34'] },
    localRoutes: parseLocalRoutes(
      JSON.stringify({ 'wp.localhost:8080': `127.0.0.1:${site.port}` }),
    ),
  })
  for (const url of [
    'http://wp.localhost:8081/',
    'http://wp.localhost/',
    'http://other.localhost:8080/',
    'http://host.docker.internal:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/',
    'http://api.example.ru:443/',
  ])
    assert.deepEqual((await viaProxy(p.port, url)).refusal, 'method', url)
  // Another method, credentials in the URL, a Host that names another site behind the route.
  assert.equal(
    (await viaProxy(p.port, 'http://wp.localhost:8080/', { method: 'PATCH' })).status,
    405,
  )
  assert.equal(
    (await viaProxy(p.port, 'http://user:pw@wp.localhost:8080/', { host: 'wp.localhost:8080' }))
      .status,
    405,
  )
  const misdirected = await viaProxy(p.port, 'http://wp.localhost:8080/', {
    host: 'other.localhost:8080',
  })
  assert.equal(misdirected.status, 403)
  assert.equal(misdirected.refusal, 'forbidden_host')
  // A tunnel to another port of the route's name is no route and no listed public host.
  assert.equal((await tunnel(p.port, 'wp.localhost:8081')).refusal, 'forbidden_host')
  assert.deepEqual(site.seen, [])
  assert.deepEqual(p.lookups, [])
})

/** Writes `text` into an open tunnel and reads what comes back until the far side closes. */
const throughTunnel = (open, text) =>
  new Promise((resolve) => {
    const chunks = [open.rest]
    open.socket.on('data', (chunk) => chunks.push(chunk))
    open.socket.once('close', () => resolve(Buffer.concat(chunks).toString()))
    open.socket.write(text)
  })

/** A proxy of one local route whose tunnels really reach the route's target. */
async function localTunnelProxy(site, options = {}) {
  const dialed = []
  const p = await proxy({
    localRoutes: parseLocalRoutes(
      JSON.stringify({ 'wp.localhost:8080': `127.0.0.1:${site.port}` }),
    ),
    dial: ({ address, port }) => {
      dialed.push({ address, port })
      return connect({ host: address, port })
    },
    ...options,
  })
  return { ...p, dialed }
}

test('a CONNECT to a local route tunnels plain HTTP of that site to its fixed target', async () => {
  const site = await localSite()
  const p = await localTunnelProxy(site)
  const open = await tunnel(p.port, 'wp.localhost:8080')
  assert.equal(open.status, 200)
  const answer = await throughTunnel(
    open,
    'GET /wp-json/wp/v2/posts/7?context=edit HTTP/1.1\r\nHost: wp.localhost:8080\r\n' +
      'X-WP-Nonce: n0nce\r\nConnection: close\r\n\r\n',
  )
  assert.match(answer, /^HTTP\/1\.1 201/)
  assert.match(answer, /\r\nsite GET \/wp-json\/wp\/v2\/posts\/7\?context=edit\r\n/)
  assert.deepEqual(
    site.seen.map(({ url, host }) => ({ url, host })),
    [{ url: '/wp-json/wp/v2/posts/7?context=edit', host: 'wp.localhost:8080' }],
  )
  // The route's target was dialed; no name was resolved.
  assert.deepEqual(p.dialed, [{ address: '127.0.0.1', port: site.port }])
  assert.deepEqual(p.lookups, [])
  for (let i = 0; i < 50 && p.logs.length < 1; i++) await delay(10)
  assert.deepEqual(
    p.logs.map(({ event, host, result }) => ({ event, host, result })),
    [{ event: 'connect', host: 'wp.localhost:8080', result: 'ok' }],
  )
  assert.doesNotMatch(JSON.stringify(p.logs), /wp-json|n0nce/)
})

test('a local tunnel carries nothing but plain HTTP of its own site', async () => {
  const site = await localSite()
  const p = await localTunnelProxy(site)
  for (const first of [
    clientHello('wp.localhost'),
    'GET / HTTP/1.1\r\nHost: other.localhost:8080\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: wp.localhost:8080\r\nHost: other.localhost:8080\r\n\r\n',
    'GET / HTTP/1.1\r\n\r\n',
    'GET http://other.localhost:8080/ HTTP/1.1\r\nHost: wp.localhost:8080\r\n\r\n',
    'PATCH / HTTP/1.1\r\nHost: wp.localhost:8080\r\n\r\n',
    `GET / HTTP/1.1\r\nHost: wp.localhost:8080\r\nX-Long: ${'a'.repeat(20_000)}`,
  ]) {
    const open = await tunnel(p.port, 'wp.localhost:8080')
    assert.equal(open.status, 200)
    assert.equal(await throughTunnel(open, first), '')
  }
  assert.deepEqual(site.seen, [])
  for (let i = 0; i < 50 && p.logs.length < 7; i++) await delay(10)
  assert.deepEqual(
    p.logs.map(({ result }) => result),
    Array(7).fill('forbidden_request'),
  )

  // Its target down is a refusal before the tunnel opens; the tunnels count together.
  const closed = createTcpServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const down = { port: closed.address().port }
  await new Promise((resolve) => closed.close(resolve))
  const refused = await localTunnelProxy(down)
  assert.equal((await tunnel(refused.port, 'wp.localhost:8080')).refusal, 'connect_error')
  const one = await localTunnelProxy(site, { maxTunnels: 1 })
  const held = await tunnel(one.port, 'wp.localhost:8080')
  assert.equal((await tunnel(one.port, 'wp.localhost:8080')).refusal, 'busy')
  held.socket.destroy()
  const stranger = await localTunnelProxy(site, { clientIp: '10.9.9.3' })
  assert.equal((await tunnel(stranger.port, 'wp.localhost:8080')).refusal, 'forbidden_client')
  assert.deepEqual(site.seen, [])
})

test('the head of a local tunnel is judged by its request line and its one Host', () => {
  const key = 'wp.localhost:8080'
  const ok = (head) => localTunnelHeadAllowed(Buffer.from(head, 'latin1'), key)
  assert.equal(ok('GET /wp-admin/ HTTP/1.1\r\nHost: wp.localhost:8080'), true)
  assert.equal(ok('HEAD / HTTP/1.0\r\nhost: WP.localhost:8080\r\nAccept: */*'), true)
  assert.equal(ok('GET / HTTP/1.1\r\nHost: wp.localhost'), false)
  assert.equal(ok('GET / HTTP/2\r\nHost: wp.localhost:8080'), false)
  assert.equal(ok('get / HTTP/1.1\r\nHost: wp.localhost:8080'), false)
  assert.equal(ok('GET * HTTP/1.1\r\nHost: wp.localhost:8080'), false)
  assert.equal(ok(''), false)
})

test('local requests are the client’s own and count with the tunnels', async () => {
  const site = await localSite()
  const routes = parseLocalRoutes(JSON.stringify({ 'wp.localhost:8080': `127.0.0.1:${site.port}` }))
  const stranger = await proxy({ localRoutes: routes, clientIp: '10.9.9.3' })
  const refused = await viaProxy(stranger.port, 'http://wp.localhost:8080/')
  assert.equal(refused.status, 403)
  assert.equal(refused.refusal, 'forbidden_client')
  assert.deepEqual(site.seen, [])

  const p = await proxy({ localRoutes: routes, maxTunnels: 1 })
  const slow = viaProxy(p.port, 'http://wp.localhost:8080/slow')
  for (let i = 0; i < 100 && site.held.length === 0; i++) await delay(10)
  const busy = await viaProxy(p.port, 'http://wp.localhost:8080/')
  assert.equal(busy.status, 503)
  assert.equal(busy.refusal, 'busy')
  site.held.shift()()
  assert.equal((await slow).status, 201)
  for (let i = 0; i < 50 && !p.logs.some((entry) => entry.result === 'ok'); i++) await delay(10)
  assert.equal((await viaProxy(p.port, 'http://wp.localhost:8080/')).status, 201)
})

test('a local route whose target does not answer is a refusal of the proxy', async () => {
  const closed = createTcpServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const p = await proxy({
    localRoutes: parseLocalRoutes(JSON.stringify({ 'wp.localhost:8080': `127.0.0.1:${port}` })),
  })
  const answer = await viaProxy(p.port, 'http://wp.localhost:8080/')
  assert.equal(answer.status, 502)
  assert.equal(answer.refusal, 'connect_error')
})

test('LOCAL_HTTP_ROUTES names local sites by name and port, targets by address or name', () => {
  const routes = parseLocalRoutes(
    JSON.stringify({
      'wp.localhost:8080': 'host.docker.internal:18080',
      'wordpress:80': '10.200.0.7:8080',
    }),
  )
  assert.deepEqual(
    [...routes],
    [
      ['wp.localhost:8080', { host: 'host.docker.internal', port: 18_080 }],
      ['wordpress:80', { host: '10.200.0.7', port: 8080 }],
    ],
  )
  for (const json of [
    '',
    'not json',
    '[]',
    '{}',
    '["wp.localhost:8080"]',
    '{"wp.localhost":"127.0.0.1:80"}',
    '{"WP.localhost:8080":"127.0.0.1:80"}',
    '{"127.0.0.1:8080":"127.0.0.1:80"}',
    '{"10.0.0.1:80":"127.0.0.1:80"}',
    '{"wp.localhost:0":"127.0.0.1:80"}',
    '{"wp.localhost:70000":"127.0.0.1:80"}',
    '{"wp.localhost:8080":"127.0.0.1"}',
    '{"wp.localhost:8080":"127.0.0.1:80/path"}',
    '{"wp.localhost:8080":"http://127.0.0.1:80"}',
    '{"wp.localhost:8080":"999.1.1.1:80"}',
    '{"wp.localhost:8080":80}',
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`s${i}.localhost:80`, '127.0.0.1:80']),
      ),
    ),
  ])
    assert.throws(() => parseLocalRoutes(json), json)
})

test('local routes need their guard and never run in production; MAX_TUNNELS is bounded', () => {
  const base = {
    LISTEN_HOST: '10.200.0.2',
    LISTEN_PORT: '3128',
    ALLOWED_HOSTS: '["news.example.ru:443"]',
    CLIENT_IPV4: '10.200.0.3',
  }
  const routes = '{"wp.localhost:8080":"host.docker.internal:18080"}'
  const plain = clientEgressConfig(base)
  assert.equal(plain.maxTunnels, clientEgressLimits.tunnels)
  assert.equal(plain.localRoutes.size, 0)
  assert.throws(() => clientEgressConfig({ ...base, LOCAL_HTTP_ROUTES: routes }), /RADITI_EGRESS/)
  assert.throws(
    () =>
      clientEgressConfig({
        ...base,
        LOCAL_HTTP_ROUTES: routes,
        RADITI_EGRESS_LOCAL_ROUTES: '1',
        APP_ENV: 'production',
      }),
    /production/,
  )
  const local = clientEgressConfig({
    ...base,
    ALLOWED_HOSTS: '[]',
    LOCAL_HTTP_ROUTES: routes,
    RADITI_EGRESS_LOCAL_ROUTES: '1',
    APP_ENV: 'development',
  })
  assert.deepEqual([...local.allow], [])
  assert.deepEqual(local.localRoutes.get('wp.localhost:8080'), {
    host: 'host.docker.internal',
    port: 18_080,
  })
  // An empty list is a stand's with local sites only, never a proxy that goes nowhere.
  assert.throws(() => clientEgressConfig({ ...base, ALLOWED_HOSTS: '[]' }))
  assert.equal(clientEgressConfig({ ...base, MAX_TUNNELS: '64' }).maxTunnels, 64)
  assert.equal(clientEgressConfig({ ...base, MAX_TUNNELS: '256' }).maxTunnels, 256)
  for (const bad of ['0', '257', '1e2', '-1', '32.5', ' 32', 'many'])
    assert.throws(() => clientEgressConfig({ ...base, MAX_TUNNELS: bad }), bad)
})

// ─── The open internet of the agent (ALLOW_PUBLIC, owner's decision of 26.10.2026) ────────────

test('the open internet tunnels TLS to any public name on a TLS port, never to anything else', async () => {
  const p = await proxy({
    allow: [],
    anyPublic: true,
    names: {
      'docs.example.org': ['93.184.216.34'],
      'inside.example.org': ['93.184.216.34', '10.0.0.7'],
    },
  })
  for (const target of ['docs.example.org:443', 'docs.example.org:8443']) {
    const answer = await tunnel(p.port, target)
    assert.equal(answer.status, 200, target)
    assert.equal(await roundTrip(answer.socket, 'ping', 'docs.example.org'), 'ping')
    answer.socket.destroy()
  }
  const refused = {
    'docs.example.org:22': 'forbidden_host',
    'docs.example.org:80': 'forbidden_host',
    '93.184.216.34:443': 'forbidden_host',
    'localhost:443': 'forbidden_host',
    'vault.internal:443': 'forbidden_host',
    'inside.example.org:443': 'forbidden_address',
    'nowhere.example.org:443': 'resolve',
  }
  for (const [target, result] of Object.entries(refused)) {
    const answer = await tunnel(p.port, target)
    assert.equal(answer.refusal, result, target)
    answer.socket.destroy()
  }
  // The log names the public host asked for, never what a refused target said.
  for (let i = 0; i < 50 && p.logs.length < 9; i++) await delay(10)
  assert.ok(p.logs.some((entry) => entry.host === 'docs.example.org:443' && entry.result === 'ok'))
  assert.ok(!JSON.stringify(p.logs).includes('93.184.216.34:443'))
  assert.ok(!JSON.stringify(p.logs).includes('localhost'))
  assert.deepEqual(
    p.dialed.map(({ port }) => port),
    [443, 8443],
  )
})

test('the open internet keeps the SNI of the target and takes ECH with that outer name', async () => {
  const p = await proxy({
    allow: [],
    anyPublic: true,
    names: { 'docs.example.org': ['93.184.216.34'] },
  })
  const ech = extension(0xfe0d, Buffer.alloc(40, 1))
  const answer = await tunnel(p.port, 'docs.example.org:443')
  const hello = clientHello('docs.example.org', { extensions: [ech] })
  const back = new Promise((resolve) => answer.socket.once('data', resolve))
  answer.socket.write(hello)
  assert.deepEqual(await back, hello)
  answer.socket.destroy()
  for (const bytes of [
    clientHello('other.example.org', { extensions: [ech] }),
    clientHello('docs.example.org', { extensions: [extension(0xffce, Buffer.alloc(40, 1))] }),
    clientHello('other.example.org'),
  ]) {
    const refused = await tunnel(p.port, 'docs.example.org:443')
    const closed = new Promise((resolve) => refused.socket.once('close', resolve))
    refused.socket.on('error', () => {})
    refused.socket.write(bytes)
    await closed
  }
  for (let i = 0; i < 50 && p.logs.filter((e) => e.result === 'forbidden_sni').length < 3; i++)
    await delay(10)
  assert.equal(p.logs.filter((entry) => entry.result === 'forbidden_sni').length, 3)
  // The parser itself: ECH gives its outer name only when asked to.
  assert.deepEqual(clientHelloServerName(hello), { state: 'refused' })
  assert.deepEqual(clientHelloServerName(hello, { echOuterName: true }), {
    state: 'name',
    name: 'docs.example.org',
  })
})

// ─── ECH to a listed host (ECH_OUTER_NAME: the browser of a task, owner's decision of 26.10.2026)

test('ECH_OUTER_NAME takes ECH whose outer name is the listed host, and nothing more', async () => {
  const p = await proxy({
    allow: ['site.example.ru:443'],
    echOuterName: true,
    names: { 'site.example.ru': ['93.184.216.34'], 'docs.example.org': ['93.184.216.34'] },
  })
  const ech = extension(0xfe0d, Buffer.alloc(40, 1))
  const answer = await tunnel(p.port, 'site.example.ru:443')
  const hello = clientHello('site.example.ru', { extensions: [ech] })
  const back = new Promise((resolve) => answer.socket.once('data', resolve))
  answer.socket.write(hello)
  assert.deepEqual(await back, hello)
  answer.socket.destroy()
  // Another outer name, the draft ESNI: refused; an unlisted host is still no target.
  for (const bytes of [
    clientHello('other.example.org', { extensions: [ech] }),
    clientHello('site.example.ru', { extensions: [extension(0xffce, Buffer.alloc(40, 1))] }),
  ]) {
    const refused = await tunnel(p.port, 'site.example.ru:443')
    const closed = new Promise((resolve) => refused.socket.once('close', resolve))
    refused.socket.on('error', () => {})
    refused.socket.write(bytes)
    await closed
  }
  for (let i = 0; i < 50 && p.logs.filter((e) => e.result === 'forbidden_sni').length < 2; i++)
    await delay(10)
  assert.equal(p.logs.filter((entry) => entry.result === 'forbidden_sni').length, 2)
  const unlisted = await tunnel(p.port, 'docs.example.org:443')
  assert.equal(unlisted.refusal, 'forbidden_host')
  unlisted.socket.destroy()
  // Plain HTTP of a public origin stays closed: the switch is about ECH only.
  assert.equal((await viaProxy(p.port, 'http://docs.example.org/')).status, 405)
})

test('ECH_OUTER_NAME is a switch of the configuration, on with the open internet', () => {
  const base = {
    LISTEN_HOST: '10.200.0.5',
    LISTEN_PORT: '3128',
    ALLOWED_HOSTS: '["site.example.ru:443"]',
  }
  assert.equal(clientEgressConfig(base).echOuterName, false)
  assert.equal(clientEgressConfig({ ...base, ECH_OUTER_NAME: '1' }).echOuterName, true)
  assert.equal(clientEgressConfig({ ...base, ECH_OUTER_NAME: '1' }).anyPublic, false)
  assert.equal(clientEgressConfig({ ...base, ALLOW_PUBLIC: '1' }).echOuterName, true)
  for (const bad of ['yes', 'true', '2'])
    assert.throws(() => clientEgressConfig({ ...base, ECH_OUTER_NAME: bad }), bad)
})

test('a list without the open internet still refuses an unlisted public host', async () => {
  const p = await proxy({ names: { 'docs.example.org': ['93.184.216.34'] } })
  const answer = await tunnel(p.port, 'docs.example.org:443')
  assert.equal(answer.refusal, 'forbidden_host')
  answer.socket.destroy()
  const page = await viaProxy(p.port, 'http://docs.example.org/')
  assert.equal(page.status, 405)
})

test('the open internet forwards plain HTTP of a public origin to the address it checked', async () => {
  const site = await localSite()
  const p = await proxy({
    allow: [],
    anyPublic: true,
    names: {
      'docs.example.org': ['2606:4700:4700::1111', '93.184.216.34'],
      'inside.example.org': ['10.1.2.3'],
    },
    dial: ({ address, port }) => {
      p.dialed.push({ address, port })
      return connect({ host: '127.0.0.1', port: site.port })
    },
  })
  const page = await viaProxy(p.port, 'http://docs.example.org/guide?x=1', {
    method: 'POST',
    body: 'hello',
    headers: { 'proxy-authorization': 'Basic c2VjcmV0' },
  })
  assert.equal(page.status, 201)
  assert.equal(page.connection, 'close')
  assert.equal(page.body, 'site POST /guide?x=1')
  // The Host of the request, the path in origin form, nothing for the proxy passed on.
  assert.deepEqual(site.seen.at(-1), {
    method: 'POST',
    url: '/guide?x=1',
    host: 'docs.example.org',
    authorization: null,
    body: 'hello',
  })
  // IPv4 first, the checked address itself.
  assert.deepEqual(p.dialed.at(-1), { address: '93.184.216.34', port: 80 })
  assert.equal((await viaProxy(p.port, 'http://docs.example.org:8080/')).status, 201)

  const refusals = [
    [await viaProxy(p.port, 'http://inside.example.org/'), 403, 'forbidden_address'],
    [await viaProxy(p.port, 'http://nowhere.example.org/'), 502, 'resolve'],
    [await viaProxy(p.port, 'http://docs.example.org:8081/'), 405, 'method'],
    [await viaProxy(p.port, 'http://93.184.216.34/'), 405, 'method'],
    [
      await viaProxy(p.port, 'http://docs.example.org/', { host: 'other.example.org' }),
      405,
      'method',
    ],
    [await viaProxy(p.port, 'http://user:pw@docs.example.org/'), 405, 'method'],
    [await viaProxy(p.port, 'http://docs.example.org/', { method: 'TRACE' }), 405, 'method'],
  ]
  for (const [answer, status, refusal] of refusals) {
    assert.equal(answer.status, status, refusal)
    assert.equal(answer.refusal, refusal)
  }
  assert.ok(
    p.logs.some((entry) => entry.event === 'request' && entry.host === 'docs.example.org:80'),
  )
  assert.doesNotMatch(JSON.stringify(p.logs), /guide|hello|c2VjcmV0|other\.example/)
})

test('the open internet over TLS only forwards no plain HTTP and still tunnels TLS', async () => {
  const p = await proxy({
    allow: [],
    anyPublic: true,
    publicHttp: false,
    names: { 'docs.example.org': ['93.184.216.34'] },
  })
  const page = await viaProxy(p.port, 'http://docs.example.org/guide?code=1')
  assert.equal(page.status, 405)
  assert.equal(page.refusal, 'method')
  const answer = await tunnel(p.port, 'docs.example.org:443')
  assert.equal(answer.status, 200)
  answer.socket.destroy()
  assert.deepEqual(
    p.dialed.map(({ port }) => port),
    [443],
  )
  assert.doesNotMatch(JSON.stringify(p.logs), /guide|code=/)
})

test('the open internet is a switch of the configuration, with or without listed hosts', () => {
  const base = { LISTEN_HOST: '10.200.0.5', LISTEN_PORT: '3128' }
  const open = clientEgressConfig({ ...base, ALLOW_PUBLIC: '1' })
  assert.equal(open.anyPublic, true)
  assert.deepEqual([...open.allow], [])
  assert.equal(
    clientEgressConfig({ ...base, ALLOW_PUBLIC: '1', ALLOWED_HOSTS: '["a.example.ru:443"]' }).allow
      .size,
    1,
  )
  assert.equal(
    clientEgressConfig({ ...base, ALLOWED_HOSTS: '["a.example.ru:443"]', ALLOW_PUBLIC: '0' })
      .anyPublic,
    false,
  )
  for (const bad of [{ ALLOW_PUBLIC: 'yes' }, { ALLOW_PUBLIC: 'true' }, { ALLOW_PUBLIC: '0' }])
    assert.throws(() => clientEgressConfig({ ...base, ...bad }), JSON.stringify(bad))
  // Over TLS only: plain HTTP of the open internet stays closed; never without the open internet.
  assert.equal(open.publicHttp, true)
  assert.equal(
    clientEgressConfig({ ...base, ALLOW_PUBLIC: '1', PUBLIC_TLS_ONLY: '1' }).publicHttp,
    false,
  )
  for (const bad of [
    { ALLOWED_HOSTS: '["a.example.ru:443"]', PUBLIC_TLS_ONLY: '1' },
    { ALLOW_PUBLIC: '1', PUBLIC_TLS_ONLY: 'yes' },
  ])
    assert.throws(() => clientEgressConfig({ ...base, ...bad }), JSON.stringify(bad))
})
