/* global AbortSignal, fetch, setTimeout */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, before, test } from 'node:test'

import {
  bridgeGatewayAddress,
  freePort,
  roleEnvironment,
  startContentObservers,
  startObservingProxy,
  startRegularRole,
} from './verify-agent-content-role.mjs'

const settings = {
  path: '/usr/bin',
  home: '/private/stand/mcp-role-home',
  port: 18082,
  allowedHosts: ['host.docker.internal'],
  databaseUrl: 'postgresql://raditi:synthetic@127.0.0.1:5432/raditi',
  vault: { address: 'http://127.0.0.1:8200', roleId: 'role', secretId: 'secret' },
  s3: {
    endpoint: 'http://127.0.0.1:8333',
    region: 'us-east-1',
    accessKey: 'access',
    secretKey: 'secret-key',
    buckets: { artifacts: 'raditi-test-artifacts' },
  },
}

test('the role gets the environment of one regular role and nothing of the launcher', () => {
  const env = roleEnvironment(settings)
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/private/stand/mcp-role-home',
    // load-env.ts opens the repository .env unless NODE_ENV is production.
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    ORCHESTRATOR_ROLES: 'mcp',
    MCP_PORT: '18082',
    MCP_ALLOWED_HOSTS: 'host.docker.internal',
    MCP_CONTENT_PROFILE: 'local',
    DATABASE_URL: 'postgresql://raditi:synthetic@127.0.0.1:5432/raditi',
    VAULT_ADDR: 'http://127.0.0.1:8200',
    VAULT_ROLE_ID: 'role',
    VAULT_SECRET_ID: 'secret',
    S3_ENDPOINT: 'http://127.0.0.1:8333',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    S3_BUCKET_ARTIFACTS: 'raditi-test-artifacts',
  })
  // No operator token, no bucket of another role, no listen address.
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /ROOT|TOKEN|SESSIONS|BACKUPS|LISTEN/)
})

test('on a native Linux engine the observer listens on the bridge gateway, never everywhere', () => {
  assert.equal(bridgeGatewayAddress('172.17.0.1\n'), '172.17.0.1')
  assert.equal(bridgeGatewayAddress('192.168.65.1'), '192.168.65.1')
  for (const value of ['', '0.0.0.0', '127.0.0.1', '8.8.8.8', '172.32.0.1', 'fd00::1', 'a.b.c.d'])
    assert.throws(() => bridgeGatewayAddress(value), /private IPv4/)
})

let directory, upstream, seen
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'raditi-role-test-'))
  seen = []
  upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      })
      const status = req.url.includes('refuse') ? 400 : 200
      const answer = () => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-upstream': 'yes' })
        res.end(JSON.stringify({ echoed: req.url }))
      }
      if (req.url.includes('slow')) setTimeout(answer, 400)
      else answer()
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
})
after(async () => {
  await new Promise((resolve) => upstream.close(resolve))
  await rm(directory, { recursive: true, force: true })
})
const upstreamOrigin = () => `http://127.0.0.1:${upstream.address().port}`

test('the observing proxy forwards a request as it came and reports the status', async (t) => {
  const observed = []
  const proxy = await startObservingProxy({
    upstream: upstreamOrigin(),
    observe: ({ method, path, body }) => {
      observed.push([method, path, body.toString()])
      return (status) => observed.push(status)
    },
  })
  t.after(() => proxy.close())
  seen.length = 0
  const response = await fetch(`${proxy.origin}/mcp?x=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    body: '{"a":1}',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-upstream'), 'yes')
  assert.deepEqual(await response.json(), { echoed: '/mcp?x=1' })
  assert.deepEqual(seen, [
    {
      method: 'POST',
      url: '/mcp?x=1',
      // A reverse proxy in front of the site names the site, not itself.
      host: `127.0.0.1:${upstream.address().port}`,
      authorization: 'Bearer synthetic',
      body: '{"a":1}',
    },
  ])
  assert.deepEqual(observed, [['POST', '/mcp?x=1', '{"a":1}'], 200])
  assert.equal((await fetch(`${proxy.origin}/refuse`)).status, 400)
})

test('a refusal of the observer answers 502 and forwards nothing', async (t) => {
  const proxy = await startObservingProxy({
    upstream: upstreamOrigin(),
    observe: async () => {
      throw new Error('synthetic')
    },
  })
  t.after(() => proxy.close())
  seen.length = 0
  const response = await fetch(`${proxy.origin}/anything`, { method: 'POST', body: 'x' })
  assert.equal(response.status, 502)
  assert.equal(await response.text(), '')
  assert.deepEqual(seen, [])
})

test('a request its client abandoned is not recorded as an answer of the upstream', async (t) => {
  const statuses = []
  const proxy = await startObservingProxy({
    upstream: upstreamOrigin(),
    observe: () => (status) => statuses.push(status),
  })
  t.after(() => proxy.close())
  // A CLI that exits right after its last notification: the request is cut before the answer.
  await assert.rejects(fetch(`${proxy.origin}/slow`, { signal: AbortSignal.timeout(100) }))
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(statuses, [])
  // An upstream that is not there is an answer the client did get: 502 from this hop.
  const dead = await startObservingProxy({
    upstream: `http://127.0.0.1:${await freePort()}`,
    observe: () => (status) => statuses.push(status),
  })
  t.after(() => dead.close())
  assert.equal((await fetch(`${dead.origin}/mcp`)).status, 502)
  assert.deepEqual(statuses, [502])
})

test('the observers count MCP requests by protocol name and site requests by route', async (t) => {
  const writes = []
  const port = await freePort()
  const observers = await startContentObservers({
    mcp: { listenHost: '127.0.0.1', port, upstream: upstreamOrigin() },
    site: { upstream: upstreamOrigin() },
    beforeSiteWrite: async (request) => {
      writes.push(request.callId)
      if (request.callId === 'early') throw new Error('synthetic')
    },
  })
  t.after(() => observers.close())
  seen.length = 0
  const mcp = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
  await mcp(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', clientInfo: { name: 'never kept' } },
    }),
  )
  // After initialize a client names the version it took from the answer in a header.
  await mcp(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wp_rest', arguments: { secret: 'never kept' } },
    }),
    { 'mcp-protocol-version': '2025-11-25', authorization: 'Bearer never kept' },
  )
  await mcp('not json')
  await (await fetch(`http://127.0.0.1:${port}/refuse`)).arrayBuffer()
  // The role checks the Host sandbox-gw rewrote: the MCP hop passes it on unchanged.
  assert.equal(seen[0].host, `127.0.0.1:${port}`)
  const call = '0196abcd-0000-7000-8000-000000000001'
  const site = (route, init) =>
    fetch(`${observers.siteOrigin}/?rest_route=${encodeURIComponent(route)}`, init)
  const post = (body) => ({ method: 'POST', body: JSON.stringify(body) })
  assert.equal((await site('/raditi/v1/content/42')).status, 200)
  assert.equal((await site('/raditi/v1/content/42', post({ callId: 'in-order' }))).status, 200)
  assert.equal((await site(`/raditi/v1/operations/${call}`)).status, 200)
  assert.equal((await site(`/raditi/v1/operations/${call}/reconcile`, post({}))).status, 200)
  assert.equal((await site(`/raditi/v1/operations/${call}/forget`, post({}))).status, 200)
  const before = seen.length
  // A write the stand's own check refuses and a route outside the plugin never reach the site.
  assert.equal((await site('/raditi/v1/content/42', post({ callId: 'early' }))).status, 502)
  assert.equal((await site('/wp/v2/users')).status, 502)
  assert.equal((await site('/raditi/v1/content/42', { method: 'DELETE' })).status, 502)
  assert.equal(seen.length, before)
  assert.deepEqual(writes, ['in-order', 'early'])
  const stats = observers.stats()
  assert.deepEqual(stats, {
    http: [
      { method: 'POST', rpc: 'initialize', tool: null, protocol: '2025-11-25', status: 200 },
      { method: 'POST', rpc: 'tools/call', tool: 'wp_rest', protocol: '2025-11-25', status: 200 },
      { method: 'POST', rpc: null, tool: null, protocol: null, status: 200 },
      { method: 'GET', rpc: null, tool: null, protocol: null, status: 400 },
    ],
    site: { reads: 1, writes: 2, operations: 1, reconciles: 1, forgets: 1 },
    snapshotBeforeWrite: 1,
    cancelledUnchanged: 0,
    violations: [
      'A write left for the site before its snapshot was stored and admitted',
      'A request outside the companion plugin routes was sent to the site',
      'A request outside the companion plugin routes was sent to the site',
    ],
  })
  // A copy: the stand compares two of them.
  stats.site.reads = 99
  assert.equal(observers.stats().site.reads, 1)
  assert.doesNotMatch(JSON.stringify(observers.stats()), /never kept/)
})

test('what a notifications/cancelled changes is looked at before the role sees it and after its answer', async (t) => {
  const port = await freePort()
  const looks = []
  let kept = 'journal-1'
  const observers = await startContentObservers({
    mcp: { listenHost: '127.0.0.1', port, upstream: upstreamOrigin() },
    site: { upstream: upstreamOrigin() },
    beforeSiteWrite: async () => {},
    aroundCancelled: async () => {
      const before = kept
      looks.push(`before ${seen.length}`)
      return async () => {
        // Not at once: the stand waits for a check that is still running.
        await new Promise((resolve) => setTimeout(resolve, 150))
        looks.push(`after ${seen.length}`)
        assert.equal(kept, before)
      }
    },
  })
  t.after(() => observers.close())
  seen.length = 0
  const mcp = (method) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).then((response) => response.arrayBuffer())
  // Any other request is not looked at.
  await mcp('notifications/initialized')
  assert.deepEqual(looks, [])
  await mcp('notifications/cancelled')
  await observers.settled()
  // The first look was taken before the role got the request, the second after it answered.
  assert.deepEqual(looks, ['before 1', 'after 2'])
  assert.equal(observers.stats().cancelledUnchanged, 1)
  assert.deepEqual(observers.stats().violations, [])
  // A CLI may send several at once as it ends: a check that begins while another is waited
  // for is waited for as well, so every answered notification has been compared.
  await mcp('notifications/cancelled')
  const waiting = observers.settled()
  await mcp('notifications/cancelled')
  await waiting
  assert.equal(observers.stats().http.length, 4)
  assert.equal(observers.stats().cancelledUnchanged, 3)
  // Something the platform keeps changed between the two looks: a violation, not a count.
  const second = mcp('notifications/cancelled')
  await second
  kept = 'journal-2'
  await observers.settled()
  assert.equal(observers.stats().cancelledUnchanged, 3)
  assert.deepEqual(observers.stats().violations, [
    'A notifications/cancelled changed what the platform keeps',
  ])
  assert.deepEqual(
    observers.stats().http.map((entry) => [entry.rpc, entry.status]),
    [
      ['notifications/initialized', 200],
      ['notifications/cancelled', 200],
      ['notifications/cancelled', 200],
      ['notifications/cancelled', 200],
      ['notifications/cancelled', 200],
    ],
  )
})

test('a look that fails is a violation, and the notification still reaches the role', async (t) => {
  const port = await freePort()
  const observers = await startContentObservers({
    mcp: { listenHost: '127.0.0.1', port, upstream: upstreamOrigin() },
    site: { upstream: upstreamOrigin() },
    beforeSiteWrite: async () => {},
    aroundCancelled: async () => {
      throw new Error('synthetic')
    },
  })
  t.after(() => observers.close())
  seen.length = 0
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
  })
  // The stand's own failure is not the role's answer: the CLI gets what the role said.
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1)
  await observers.settled()
  const stats = observers.stats()
  assert.equal(stats.cancelledUnchanged, 0)
  assert.deepEqual(stats.violations, ['A notifications/cancelled could not be looked at'])
  assert.deepEqual(
    stats.http.map((entry) => [entry.rpc, entry.status]),
    [['notifications/cancelled', 200]],
  )
})

const fixtureRole = `
import { createServer } from 'node:http'
const mode = process.env.MODE
if (mode === 'exit') {
  process.stdout.write('MCP_PORT: required\\n')
  process.exit(1)
}
const server = createServer((req, res) => res.writeHead(mode === 'degraded' ? 503 : 200).end('{}'))
server.listen(Number(process.env.MCP_PORT), '127.0.0.1', () => process.stdout.write('listening\\n'))
process.on('SIGTERM', () => {
  if (mode === 'deaf') return
  process.stdout.write('stopping\\n')
  server.close(() => process.exit(0))
})
`

test('the role is started from its entry point, waited for by /health and stopped by SIGTERM', async () => {
  const entry = join(directory, 'role.mjs')
  await writeFile(entry, fixtureRole)
  const start = async (mode, options = {}) => {
    const port = await freePort()
    return startRegularRole({
      env: { PATH: process.env.PATH, MCP_PORT: String(port), MODE: mode },
      port,
      entry: [entry],
      cwd: directory,
      ...options,
    })
  }
  const role = await start('ready')
  assert.match(role.logs.join(''), /listening/)
  assert.deepEqual(await role.close(), { code: 0, signal: null, spawned: true })
  assert.match(role.logs.join(''), /stopping/)
  // Closing twice asks nothing twice.
  assert.deepEqual(await role.close(), { code: 0, signal: null, spawned: true })
  // A role that exits at startup is reported with what it printed: names of settings, no values.
  await assert.rejects(start('exit'), /exited at startup:\nMCP_PORT: required/)
  await assert.rejects(start('degraded', { startupTimeoutMs: 600 }), /did not answer \/health/)
  // A role that ignores SIGTERM is killed, and the cleanup of the stand fails for it.
  const deaf = await start('deaf', { shutdownTimeoutMs: 300 })
  await assert.rejects(deaf.close(), /did not stop on SIGTERM/)
  assert.equal((await deaf.exited).signal, 'SIGKILL')
})
