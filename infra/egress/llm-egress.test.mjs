import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { Socket, connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connect as tlsConnect, createServer as createTlsServer } from 'node:tls'
import { fileURLToPath } from 'node:url'

import {
  PROBE_LIMIT,
  createEgressProxy,
  isPublicIPv4,
  parseAllow,
  parseClientCns,
  parseProbeMax,
} from './llm-egress.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const SERVER_NAME = 'egress-1.raditi.internal'

// A synthetic PKI from make-ca.sh itself, so the tests also check what the owner issues.
const openssl = spawnSync('openssl', ['version']).status === 0
const skip = !openssl && 'openssl is not installed'
const tmp = mkdtempSync(join(tmpdir(), 'raditi-egress-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const make = (...args) => execFileSync('sh', [here('make-ca.sh'), ...args], { stdio: 'pipe' })
if (openssl) {
  make('ca', join(tmp, 'ca'))
  make('server', join(tmp, 'ca'), SERVER_NAME)
  for (const cn of ['app-1', 'op-2']) make('client', join(tmp, 'ca'), cn)
  make('client', join(tmp, 'ca'), 'op-1', '14')
  make('ca', join(tmp, 'rogue'))
  make('client', join(tmp, 'rogue'), 'app-1')
}
const read = (path) => readFileSync(join(tmp, path))
const client = (cn, ca = 'ca') => ({
  cert: read(`${ca}/clients/${cn}.pem`),
  key: read(`${ca}/clients/${cn}-key.pem`),
})
const serverIdentity = () => ({
  cert: read(`ca/server/${SERVER_NAME}.pem`),
  key: read(`ca/server/${SERVER_NAME}-key.pem`),
})

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
async function until(check, ms = 3000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await delay(20)) {
    const value = check()
    if (value) return value
  }
  assert.fail('timed out')
}

const ADDRESSES = {
  'chatgpt.com': ['104.18.32.47'],
  'api.kimi.ai': ['104.18.0.1'],
  'private.test': ['10.0.0.5'],
  'metadata.test': ['169.254.169.254'],
  'loopback.test': ['104.18.32.47', '127.0.0.1'],
  'cgnat.test': ['100.64.1.1'],
  'v6.test': ['2606:4700::6812:1'],
}

/** The proxy with the synthetic PKI; every dial goes to a local TCP echo instead of the net. */
async function start(options = {}) {
  const logs = []
  const dialled = []
  const echo = createTcpServer((socket) => socket.pipe(socket))
  await listen(echo)
  const proxy = createEgressProxy({
    tls: { ...serverIdentity(), root: read('ca/root.pem'), clientCa: read('ca/client-ca.pem') },
    allow: new Set([...Object.keys(ADDRESSES), 'broken.test'].map((host) => `${host}:443`)),
    clientCns: new Set(['app-1', 'op-1']),
    lookup: async (host) => {
      if (!ADDRESSES[host]) throw new Error('ENOTFOUND')
      return ADDRESSES[host]
    },
    dial: ({ address, port }) => {
      dialled.push(`${address}:${port}`)
      return connect(echo.address().port, '127.0.0.1')
    },
    log: (entry) => logs.push(entry),
    ...options,
  })
  const sockets = new Set()
  proxy.on('connection', (socket) => sockets.add(socket))
  await listen(proxy)
  return {
    port: proxy.address().port,
    logs,
    dialled,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => proxy.close(resolve))
      echo.close()
    },
  }
}

/** Opens a TLS connection to the proxy and sends CONNECT; `status` is null if TLS refused. */
function tunnel(port, target, identity = client('app-1'), extra = '') {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: SERVER_NAME,
      ca: read('ca/root.pem'),
      ...identity,
    })
    let head = Buffer.alloc(0)
    socket.once('secureConnect', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n${extra}`),
    )
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      socket.pause()
      const status = Number(/^HTTP\/1\.1 (\d{3}) /.exec(head.toString())?.[1])
      resolve({ status, socket, rest: head.subarray(end + 4) })
    }
    socket.on('data', onData)
    socket.once('error', (error) => resolve({ status: null, error, socket }))
    socket.once('close', () => resolve({ status: null, socket }))
  })
}

/** Reads from an open tunnel until `text` arrived. */
function receive(socket, text, rest = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let data = rest
    const check = () => {
      if (!data.toString().includes(text)) return
      socket.off('data', onData)
      resolve()
    }
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      check()
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.resume()
    check()
  })
}

function get(port, path, { method = 'GET', identity = client('op-1') } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        servername: SERVER_NAME,
        ca: read('ca/root.pem'),
        agent: false,
        ...identity,
      },
      (res) => {
        let bytes = 0
        res.on('data', (chunk) => (bytes += chunk.length))
        res.on('end', () => resolve({ status: res.statusCode, bytes, headers: res.headers }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test(
  'CONNECT to an allowlisted host tunnels to its public address and logs no client address',
  {
    skip,
  },
  async () => {
    const proxy = await start()
    try {
      const opened = await tunnel(proxy.port, 'chatgpt.com:443', client('app-1'), 'hello ')
      assert.equal(opened.status, 200)
      opened.socket.write('ping')
      await receive(opened.socket, 'hello ping', opened.rest)
      opened.socket.end()
      const entry = await until(() => proxy.logs.find((log) => log.event === 'connect'))
      assert.deepEqual(proxy.dialled, ['104.18.32.47:443'])
      assert.equal(entry.cn, 'app-1')
      assert.equal(entry.host, 'chatgpt.com:443')
      assert.equal(entry.result, 'ok')
      assert.equal(entry.up, 10)
      assert.equal(entry.down, 10)
      assert.ok(Number.isInteger(entry.ms))

      const upper = await tunnel(proxy.port, 'API.KIMI.AI:443', client('op-1'))
      assert.equal(upper.status, 200)
      upper.socket.destroy()
      await until(() => proxy.logs.filter((log) => log.event === 'connect').length === 2)
      assert.doesNotMatch(JSON.stringify(proxy.logs), /127\.0\.0\.1/)
    } finally {
      await proxy.close()
    }
  },
)

test(
  'CONNECT outside the allowlist or to a non-public address is refused before any dial',
  {
    skip,
  },
  async () => {
    const proxy = await start()
    try {
      for (const target of [
        'example.com:443',
        'chatgpt.com:8443',
        'chatgpt.com:80',
        '104.18.32.47:443',
        'chatgpt.com.:443',
        'sub.chatgpt.com:443',
      ]) {
        const refused = await tunnel(proxy.port, target)
        assert.equal(refused.status, 403, target)
        refused.socket.destroy()
      }
      for (const host of ['private', 'metadata', 'loopback', 'cgnat', 'v6']) {
        const refused = await tunnel(proxy.port, `${host}.test:443`)
        assert.equal(refused.status, 403, host)
        refused.socket.destroy()
      }
      const unresolved = await tunnel(proxy.port, 'broken.test:443')
      assert.equal(unresolved.status, 502)
      unresolved.socket.destroy()
      assert.deepEqual(proxy.dialled, [])
      await until(() => proxy.logs.length === 12)
      const results = proxy.logs.map((log) => log.result)
      assert.equal(results.filter((result) => result === 'forbidden_host').length, 6)
      assert.equal(results.filter((result) => result === 'forbidden_address').length, 5)
      assert.ok(results.includes('resolve'))
      // A refused target never reaches the log as the client wrote it.
      assert.doesNotMatch(JSON.stringify(proxy.logs), /example\.com|8443|104\.18/)
    } finally {
      await proxy.close()
    }
  },
)

test(
  'only a certificate of the client CA with an allowed CN opens a tunnel',
  { skip },
  async () => {
    const proxy = await start({ clientCns: new Set(['app-1', 'op-1', SERVER_NAME]) })
    try {
      const anonymous = await tunnel(proxy.port, 'chatgpt.com:443', {})
      assert.equal(anonymous.status, null)
      const rogue = await tunnel(proxy.port, 'chatgpt.com:443', client('app-1', 'rogue'))
      assert.equal(rogue.status, null)
      // The proxy's own certificate: issued by the server CA for serverAuth only.
      const server = await tunnel(proxy.port, 'chatgpt.com:443', serverIdentity())
      assert.equal(server.status, null)
      const unlisted = await tunnel(proxy.port, 'chatgpt.com:443', client('op-2'))
      assert.equal(unlisted.status, 403)
      unlisted.socket.destroy()
      assert.deepEqual(proxy.dialled, [])
      await until(() => proxy.logs.some((log) => log.result === 'forbidden_client'))
      const refusals = await until(() => {
        const found = proxy.logs.filter((log) => log.event === 'tls').map((log) => log.code)
        return found.length === 3 && found
      })
      assert.deepEqual(refusals.sort(), [
        'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
        'INVALID_PURPOSE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ])
    } finally {
      await proxy.close()
    }
  },
)

test('a client certificate never passes as the proxy certificate', { skip }, async () => {
  const connectTo = (identity) =>
    new Promise((resolve) => {
      const fake = createTlsServer({ ...identity, minVersion: 'TLSv1.3' }, (socket) => socket.end())
      fake.listen(0, '127.0.0.1', () => {
        const socket = tlsConnect({
          host: '127.0.0.1',
          port: fake.address().port,
          servername: SERVER_NAME,
          ca: read('ca/root.pem'),
          // The name is not the point here: only the chain and the key usage are checked.
          checkServerIdentity: () => undefined,
        })
        const done = (result) => {
          socket.destroy()
          fake.close()
          resolve(result)
        }
        socket.once('secureConnect', () => done('ok'))
        socket.once('error', (error) => done(error.code))
      })
    })
  assert.equal(await connectTo(serverIdentity()), 'ok')
  assert.equal(await connectTo(client('op-1')), 'INVALID_PURPOSE')
})

test(
  '/probe returns exactly N random bytes up to the limit; other requests are refused',
  {
    skip,
  },
  async () => {
    const proxy = await start({ probeMaxBytes: 100_000 })
    try {
      const probe = await get(proxy.port, '/probe?bytes=70000')
      assert.equal(probe.status, 200)
      assert.equal(probe.bytes, 70_000)
      assert.equal(probe.headers['cache-control'], 'no-store')
      assert.equal((await get(proxy.port, '/probe?bytes=100000')).bytes, 100_000)
      for (const path of [
        '/probe?bytes=100001',
        '/probe?bytes=0',
        '/probe?bytes=012',
        '/probe',
        '/probe?bytes=10&x=1',
      ])
        assert.equal((await get(proxy.port, path)).status, 400, path)
      for (const path of ['/', '/probex', 'http://chatgpt.com/', '/metrics'])
        assert.equal((await get(proxy.port, path)).status, 403, path)
      assert.equal((await get(proxy.port, '/probe?bytes=10', { method: 'POST' })).status, 405)
      const unlisted = await get(proxy.port, '/probe?bytes=10', { identity: client('op-2') })
      assert.equal(unlisted.status, 403)
      const probes = await until(() => {
        const found = proxy.logs.filter((log) => log.event === 'probe')
        return found.length === 2 && found
      })
      assert.deepEqual(
        probes.map(({ cn, result, bytes }) => ({ cn, result, bytes })),
        [
          { cn: 'op-1', result: 'ok', bytes: 70_000 },
          { cn: 'op-1', result: 'ok', bytes: 100_000 },
        ],
      )
      assert.doesNotMatch(JSON.stringify(proxy.logs), /127\.0\.0\.1|chatgpt|metrics/)
    } finally {
      await proxy.close()
    }
  },
)

test('tunnels are limited in number and closed when idle', { skip }, async () => {
  const proxy = await start({ maxTunnels: 1, idleMs: 300 })
  try {
    const first = await tunnel(proxy.port, 'chatgpt.com:443')
    assert.equal(first.status, 200)
    const second = await tunnel(proxy.port, 'chatgpt.com:443')
    assert.equal(second.status, 503)
    second.socket.destroy()
    first.socket.resume()
    await new Promise((resolve) => first.socket.once('close', resolve))
    await until(() => proxy.logs.some((log) => log.result === 'idle'))
    const third = await tunnel(proxy.port, 'chatgpt.com:443')
    assert.equal(third.status, 200)
    third.socket.destroy()
  } finally {
    await proxy.close()
  }
})

test('a failed dial answers 502 and a dial that hangs answers 504', { skip }, async () => {
  const closed = createTcpServer()
  await listen(closed)
  const port = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const failing = await start({ dial: () => connect(port, '127.0.0.1') })
  const hanging = await start({ dial: () => new Socket(), connectTimeoutMs: 100 })
  try {
    const refused = await tunnel(failing.port, 'chatgpt.com:443')
    assert.equal(refused.status, 502)
    const slow = await tunnel(hanging.port, 'chatgpt.com:443')
    assert.equal(slow.status, 504)
    await until(() => failing.logs.some((log) => log.result === 'connect_error'))
    await until(() => hanging.logs.some((log) => log.result === 'connect_timeout'))
  } finally {
    await failing.close()
    await hanging.close()
  }
})

test(
  'the CONNECT deadline bounds DNS, frees capacity and ignores late resolution',
  { skip },
  async () => {
    let resolveFirst
    let lookups = 0
    const proxy = await start({
      maxTunnels: 1,
      connectTimeoutMs: 100,
      lookup: () => {
        lookups += 1
        return lookups === 1
          ? new Promise((resolve) => (resolveFirst = resolve))
          : Promise.resolve(ADDRESSES['chatgpt.com'])
      },
    })
    try {
      const pending = tunnel(proxy.port, 'chatgpt.com:443')
      await until(() => resolveFirst)
      const busy = await tunnel(proxy.port, 'chatgpt.com:443')
      assert.equal(busy.status, 503)
      busy.socket.destroy()

      const expired = await Promise.race([
        pending,
        delay(2000, undefined, { ref: false }).then(() =>
          assert.fail('DNS setup deadline did not expire'),
        ),
      ])
      assert.equal(expired.status, 504)
      await until(() => proxy.logs.some((log) => log.result === 'connect_timeout'))
      assert.deepEqual(proxy.dialled, [])

      const next = await tunnel(proxy.port, 'chatgpt.com:443')
      assert.equal(next.status, 200)
      resolveFirst(ADDRESSES['chatgpt.com'])
      // A late DNS answer must not dial, and an established tunnel outlives its setup deadline.
      await delay(150)
      next.socket.write('still open')
      await receive(next.socket, 'still open', next.rest)
      assert.deepEqual(proxy.dialled, ['104.18.32.47:443'])
      assert.equal(proxy.logs.filter((log) => log.result === 'connect_timeout').length, 1)
      next.socket.destroy()
    } finally {
      resolveFirst?.(ADDRESSES['chatgpt.com'])
      await proxy.close()
    }
  },
)

test(
  'the service reads its files from EGRESS_TLS_DIR and refuses a bad configuration',
  {
    skip,
  },
  async () => {
    const dir = join(tmp, 'credentials')
    mkdirSync(dir)
    copyFileSync(join(tmp, `ca/server/${SERVER_NAME}.pem`), join(dir, 'server.pem'))
    copyFileSync(join(tmp, `ca/server/${SERVER_NAME}-key.pem`), join(dir, 'server-key.pem'))
    for (const name of ['root.pem', 'client-ca.pem'])
      copyFileSync(join(tmp, 'ca', name), join(dir, name))
    const env = {
      PATH: process.env.PATH,
      EGRESS_TLS_DIR: dir,
      EGRESS_LISTEN_HOST: '127.0.0.1',
      EGRESS_LISTEN_PORT: '0',
      LLM_EGRESS_ALLOW: 'chatgpt.com:443',
      EGRESS_CLIENT_CN_ALLOW: 'op-1',
    }
    const service = spawn(process.execPath, [here('llm-egress.mjs')], { env })
    try {
      const port = await new Promise((resolve, reject) => {
        service.stdout.once('data', (chunk) => resolve(JSON.parse(chunk.toString()).port))
        service.once('exit', () => reject(new Error('the service exited')))
      })
      assert.equal((await get(port, '/probe?bytes=20000')).bytes, 20_000)
    } finally {
      service.kill()
    }
    const bad = spawnSync(process.execPath, [here('llm-egress.mjs')], {
      env: { ...env, LLM_EGRESS_ALLOW: '*.openai.com:443' },
      encoding: 'utf8',
    })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /LLM_EGRESS_ALLOW/)
  },
)

test('configuration parsers accept only exact names, CNs and a probe of at most 1 MiB', () => {
  assert.deepEqual(
    [...parseAllow(' chatgpt.com:443, auth.openai.com:443,api.kimi.ai:443 ')],
    ['chatgpt.com:443', 'auth.openai.com:443', 'api.kimi.ai:443'],
  )
  for (const value of [
    '',
    'chatgpt.com',
    '*.openai.com:443',
    'Chatgpt.com:443',
    '1.2.3.4:443',
    'localhost:443',
    'chatgpt.com:0',
    'chatgpt.com:65536',
  ])
    assert.throws(() => parseAllow(value), /LLM_EGRESS_ALLOW/, value)
  assert.deepEqual([...parseClientCns('app-1,op-1')], ['app-1', 'op-1'])
  for (const value of ['', 'Op-1', 'op 1', 'ivan.petrov@example.com'])
    assert.throws(() => parseClientCns(value), /EGRESS_CLIENT_CN_ALLOW/, value)
  assert.equal(parseProbeMax(undefined), PROBE_LIMIT)
  assert.equal(parseProbeMax('65536'), 65_536)
  for (const value of ['0', '-1', '1048577', '1e6', 'abc'])
    assert.throws(() => parseProbeMax(value), /EGRESS_PROBE_MAX_BYTES/, value)
  for (const address of ['104.18.32.47', '8.8.8.8']) assert.ok(isPublicIPv4(address), address)
  for (const address of [
    '10.1.2.3',
    '172.31.0.1',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '2606:4700::6812:1',
    'chatgpt.com',
  ])
    assert.ok(!isPublicIPv4(address), address)
})

test(
  'make-ca.sh issues the CA once and leaves every key readable by the owner only',
  {
    skip,
  },
  () => {
    assert.throws(() => make('ca', join(tmp, 'ca')), /issued once/)
    assert.throws(() => make('client', join(tmp, 'ca'), 'Ivan Petrov'), /CN must be/)
    for (const key of [
      'ca/root-key.pem',
      'ca/server-ca-key.pem',
      'ca/client-ca-key.pem',
      `ca/server/${SERVER_NAME}-key.pem`,
      'ca/clients/op-1-key.pem',
    ])
      assert.equal(statSync(join(tmp, key)).mode & 0o077, 0, key)
    const days = (path) => {
      const end = execFileSync('openssl', ['x509', '-in', join(tmp, path), '-noout', '-enddate'])
      return (Date.parse(end.toString().split('=')[1]) - Date.now()) / 86_400_000
    }
    assert.ok(days('ca/clients/op-1.pem') <= 14)
    assert.ok(days('ca/clients/app-1.pem') > 300)
  },
)

test('the node files: three hosts by default, an unprivileged user and a closed firewall', () => {
  const env = readFileSync(here('env.example'), 'utf8')
  assert.equal(
    /^LLM_EGRESS_ALLOW=(.*)$/m.exec(env)?.[1],
    'chatgpt.com:443,auth.openai.com:443,api.kimi.ai:443',
  )
  assert.doesNotMatch(env, /KEY|TOKEN|PASSWORD|SECRET/)
  const unit = readFileSync(here('raditi-egress.service'), 'utf8')
  for (const line of [
    'User=raditi-egress',
    'Environment=EGRESS_TLS_DIR=/etc/raditi/egress',
    'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
    'AmbientCapabilities=CAP_NET_BIND_SERVICE',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'Requires=nftables.service',
  ])
    assert.ok(unit.split('\n').includes(line), line)
  const nft = readFileSync(here('nftables.conf'), 'utf8')
  assert.match(nft, /^flush ruleset$/m)
  for (const hook of ['input', 'forward', 'output'])
    assert.match(nft, new RegExp(`type filter hook ${hook} priority filter; policy drop;`), hook)
})
