import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { startFakeSubscriptions, SYNTHETIC_MCP_MARKER } from './fake-subscriptions.mjs'
import { SYNTHETIC_ZAI_KEY, ZAI_PATHS } from './fake-zai.mjs'

// The process of a stand that hosts the synthetic provider and the synthetic MCP server. What
// the provider itself answers is fake-zai.test.mjs; here: the MCP side, the control port and
// the process.
const temp = mkdtempSync(join(tmpdir(), 'raditi-fake-subscriptions-'))
after(() => rmSync(temp, { recursive: true, force: true }))
const makeCa = fileURLToPath(new URL('../../egress/make-ca.sh', import.meta.url))
execFileSync('sh', [makeCa, 'ca', temp], { stdio: 'pipe' })
execFileSync('sh', [makeCa, 'server', temp, 'fake.raditi.internal'], { stdio: 'pipe' })
const key = readFileSync(join(temp, 'server/fake.raditi.internal-key.pem'))
const cert = readFileSync(join(temp, 'server/fake.raditi.internal.pem'))
const ca = readFileSync(join(temp, 'root.pem'))
const chatBody = {
  model: 'glm-5.3',
  max_tokens: 32_000,
  messages: [{ role: 'user', content: 'Synthetic request.' }],
  stream: true,
  stream_options: { include_usage: true },
}

async function start(t, options = {}) {
  const fake = await startFakeSubscriptions({ key, cert, ...options })
  t.after(() => fake.close())
  return fake
}
/** A request to the TLS port of the provider, with the plan key the synthetic provider takes. */
function call(port, path, { method = 'POST', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        servername: 'fake.raditi.internal',
        ca,
        path,
        method,
        agent: false,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_ZAI_KEY}`,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

test('the synthetic MCP server answers only the registered turn token and lists given tools', async (t) => {
  const fake = await start(t, { mcpPort: 0 })
  const token = `mcp_${'a'.repeat(64)}`
  const tools = [
    {
      name: 'site_info',
      description: 'Read the site.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
  const control = (path, body) =>
    fetch(`${fake.controlAddress.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rpc = (body, auth = token, method = 'POST') =>
    fetch(`${fake.mcpAddress.url}/mcp`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
  // Nothing registered yet: every request is refused.
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401)
  for (const invalid of [{ token: 'mcp_short', tools }, { token, tools: 'none' }, {}])
    assert.equal((await control('/mcp', invalid)).status, 400)
  const registered = await control('/mcp', { token, tools })
  assert.equal(registered.status, 200)
  assert.equal(JSON.stringify(await registered.json()).includes(token), false)
  assert.equal(
    (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, `mcp_${'b'.repeat(64)}`)).status,
    401,
  )
  const init = await (
    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    })
  ).json()
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.deepEqual(
    (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result,
    { tools },
  )
  const called = await (
    await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'site_info', arguments: {} },
    })
  ).json()
  assert.equal(called.result.isError, false)
  assert.match(called.result.content[0].text, new RegExp(SYNTHETIC_MCP_MARKER))
  const unknown = await (
    await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'other', arguments: {} },
    })
  ).json()
  assert.equal(unknown.error.code, -32602)
  assert.equal((await rpc(undefined, token, 'GET')).status, 405)
  assert.equal((await rpc(undefined, token, 'DELETE')).status, 204)
  const state = await (await fetch(`${fake.controlAddress.url}/state`)).json()
  assert.deepEqual(
    state.mcp.requests.map(({ method, rpc: name, tool, authorized }) => [
      method,
      name,
      tool,
      authorized,
    ]),
    [
      ['POST', null, null, false],
      ['POST', null, null, false],
      ['POST', 'initialize', null, true],
      ['POST', 'notifications/initialized', null, true],
      ['POST', 'tools/list', null, true],
      ['POST', 'tools/call', 'site_info', true],
      ['POST', 'tools/call', 'other', true],
      ['GET', null, null, true],
      ['DELETE', null, null, true],
    ],
  )
  assert.equal(JSON.stringify(state).includes(token), false)
})

test('the control API is separate from the provider, and its reset drops both sides', async (t) => {
  const fake = await start(t, { mcpPort: 0 })
  const control = (path, init) => fetch(`${fake.controlAddress.url}${path}`, init)
  const post = (path, body) =>
    control(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  assert.equal((await call(fake.address.port, ZAI_PATHS.chat, { body: chatBody })).status, 200)
  // The port of the provider knows nothing of the control API: an unknown path of the provider.
  const foreign = await call(fake.address.port, '/state', { method: 'GET' })
  assert.deepEqual(JSON.parse(foreign.text), { code: 500, msg: '404 NOT_FOUND', success: false })
  const token = `mcp_${'c'.repeat(64)}`
  assert.equal((await post('/mcp', { token, tools: [] })).status, 200)
  const rpc = () =>
    fetch(`${fake.mcpAddress.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
  assert.equal((await rpc()).status, 200)
  const state = await (await control('/state')).json()
  assert.deepEqual(Object.keys(state), ['mcp', 'zai'])
  assert.equal(state.zai.counters.chat, 1)
  assert.equal(state.mcp.requests.length, 1)
  // Neither the plan key nor the turn token is in what the control port tells.
  for (const secret of [SYNTHETIC_ZAI_KEY, token])
    assert.equal(JSON.stringify(state).includes(secret), false)
  const reset = await (await post('/reset', {})).json()
  assert.equal(reset.zai.counters.chat, 0)
  assert.deepEqual(reset.mcp.requests, [])
  // The registration of the turn is gone with the rest.
  assert.equal((await rpc()).status, 401)
  assert.equal((await post('/mcp', '{')).status, 400)
  for (const path of ['/tokens', '/scenario', '/unknown'])
    assert.equal((await post(path, {})).status, 404, path)
})

test(
  'standalone prints only readiness and shutdown cancels a two-minute stream delay',
  { timeout: 3000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./fake-subscriptions.mjs', import.meta.url)),
        '--tls-key',
        join(temp, 'server/fake.raditi.internal-key.pem'),
        '--tls-cert',
        join(temp, 'server/fake.raditi.internal.pem'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    t.after(() => child.kill('SIGKILL'))
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    for (let i = 0; i < 100 && !output.includes('\n'); i++) await delay(10)
    const ready = JSON.parse(output.trim())
    assert.deepEqual(Object.keys(ready).sort(), ['controlPort', 'port', 'ready'])
    const control = `http://127.0.0.1:${ready.controlPort}`
    const held = await fetch(`${control}/zai`, {
      method: 'POST',
      body: JSON.stringify({ scenario: { scenario: 'text', delayMs: 120_000 } }),
    })
    assert.equal(held.status, 200)
    const pending = call(ready.port, ZAI_PATHS.chat, { body: chatBody }).catch((error) => error)
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(`${control}/state`)).json()).zai.counters.chat) break
      await delay(5)
    }
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.ok((await pending) instanceof Error)
    assert.deepEqual(JSON.parse(output.trim()), ready)
    assert.equal(errors, '')
  },
)
