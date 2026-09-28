import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createEgressProxy } from '../../egress/llm-egress.mjs'
import {
  ORIGINS,
  createRecordProxy,
  egressAgent,
  inspectCodexAuth,
  scrub,
} from './record-proxy.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'raditi-record-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// Synthetic tokens shaped like a Codex login; nothing here was ever a real credential.
const jwt = (payload) =>
  [{ alg: 'RS256' }, payload, 'c2lnbmF0dXJlLXN5bnRoZXRpYw']
    .map((part) =>
      typeof part === 'string' ? part : Buffer.from(JSON.stringify(part)).toString('base64url'),
    )
    .join('.')
const ACCOUNT = 'acc-5ynth371c-0000-4000-8000-000000000001'
const EMAIL = 'owner@example.test'
const auth = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: 'sk-synthetic-exchanged-api-key-0001',
  tokens: {
    id_token: jwt({
      email: EMAIL,
      iat: 1_790_000_000,
      exp: 1_790_003_600,
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: ACCOUNT },
    }),
    access_token: jwt({
      iat: 1_790_000_000,
      exp: 1_790_864_000,
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    }),
    refresh_token: 'rt_synthetic-refresh-token-0001',
    account_id: ACCOUNT,
  },
  last_refresh: '2026-09-28T10:00:00Z',
}
const authFile = join(tmp, 'auth.json')
writeFileSync(authFile, JSON.stringify(auth))
const kimiKeyFile = join(tmp, 'kimi-key')
writeFileSync(kimiKeyFile, 'sk-kimi-synthetic-console-key-0001\n')
const LOCAL = 'rdt-spike-0123456789abcdef0123456789abcdef'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const close = (server) => new Promise((resolve) => server.close(resolve))

/** A fake of both providers: records what arrives and answers like them; HTTPS with `tls`. */
async function fakeProviders(tls) {
  const received = []
  const handler = (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      })
      if (req.url === '/backend-api/codex/responses') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'set-cookie': `session=${auth.tokens.access_token}`,
          'x-codex-primary-used-percent': '12',
          'x-codex-turn-state': 'turn-state-1',
        })
        res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
        res.write(
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'x'.repeat(500) } })}\n\n`,
        )
        res.end(
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 120, output_tokens: 7 } } })}\n\n`,
        )
      } else if (req.url === '/backend-api/wham/usage') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ email: EMAIL, account_id: ACCOUNT, plan_type: 'plus' }))
      } else if (req.url === '/coding/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"ок"}}]}\n\n')
        res.write('data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":3}}\n\n')
        res.end('data: [DONE]\n\n')
      } else if (req.url.startsWith('/backend-api/codex/models')) {
        res.writeHead(302, { location: 'https://chatgpt.com/auth/login' })
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  }
  const server = tls ? createTlsServer(tls, handler) : createServer(handler)
  await listen(server)
  return { server, received, origin: `http://127.0.0.1:${server.address().port}` }
}

async function start(options = {}, fake) {
  fake ??= await fakeProviders()
  const printed = []
  const recordFile = join(tmp, `exchanges-${Math.random().toString(16).slice(2)}.jsonl`)
  const proxy = createRecordProxy({
    localKey: LOCAL,
    codexAuthFile: authFile,
    kimiKeyFile,
    recordFile,
    origins: { codex: fake.origin, kimi: fake.origin },
    print: (line) => printed.push(line),
    ...options,
  })
  await listen(proxy)
  return {
    port: proxy.address().port,
    fake,
    printed,
    records: () =>
      readFileSync(recordFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    raw: () => readFileSync(recordFile, 'utf8'),
    recordFile,
    async close() {
      await close(proxy)
      await close(fake.server)
    },
  }
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${LOCAL}`, ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const codexBody = JSON.stringify({
  model: 'gpt-6-sol',
  store: false,
  stream: true,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic' }] }],
  client_metadata: { installation: 'x' },
  service_tier: 'priority',
  prompt_cache_key: 'thread-1',
})
const codexHeaders = {
  'content-type': 'application/json',
  'user-agent': 'codex_exec/0.158.0',
  originator: 'codex_exec',
  'session-id': 'session-1',
  'x-codex-installation-id': 'install-1',
  'x-codex-turn-metadata': '{"cwd":"/work"}',
  'x-codex-window-id': 'window-1',
  cookie: 'must-not-pass=1',
}

test('Codex: the subscription token goes in, stripped headers and fields stay out, the record has no secrets', async () => {
  const proxy = await start()
  try {
    const answer = await call(proxy.port, 'POST', '/codex/responses', {
      headers: codexHeaders,
      body: codexBody,
    })
    assert.equal(answer.status, 200)
    assert.match(answer.body, /response\.completed/)
    assert.equal(answer.headers['x-codex-turn-state'], 'turn-state-1')
    assert.equal(answer.headers['x-codex-primary-used-percent'], undefined)
    assert.equal(answer.headers['set-cookie'], undefined)

    const [sent] = proxy.fake.received
    assert.equal(sent.url, '/backend-api/codex/responses')
    assert.equal(sent.headers.authorization, `Bearer ${auth.tokens.access_token}`)
    assert.equal(sent.headers['chatgpt-account-id'], ACCOUNT)
    assert.equal(sent.headers.accept, 'text/event-stream')
    assert.equal(sent.headers['accept-encoding'], 'identity')
    assert.equal(sent.headers['user-agent'], 'codex_exec/0.158.0')
    assert.equal(sent.headers['x-codex-installation-id'], 'install-1')
    for (const name of ['x-codex-turn-metadata', 'x-codex-window-id', 'cookie'])
      assert.equal(sent.headers[name], undefined, name)
    const body = JSON.parse(sent.body)
    assert.equal(body.client_metadata, undefined)
    assert.equal(body.service_tier, undefined)
    assert.equal(body.prompt_cache_key, 'thread-1')

    const [record] = proxy.records()
    assert.deepEqual(record.request.stripped, ['client_metadata', 'service_tier'])
    assert.equal(record.request.headers['x-codex-turn-metadata'], '{"cwd":"/work"}')
    assert.equal(record.request.headers.authorization, '[local key]')
    assert.equal(record.request.sent.authorization, '[subscription]')
    assert.equal(record.response.headers['x-codex-primary-used-percent'], '12')
    assert.deepEqual(
      record.response.events.map((event) => event.event),
      ['response.created', 'response.output_item.done', 'response.completed'],
    )
    assert.equal(
      record.response.events[1].data.item.encrypted_content,
      '[encrypted_content: 500 chars]',
    )
    assert.match(proxy.printed[0], /POST \/codex\/responses → 200 .*"input_tokens":120/)

    await call(proxy.port, 'GET', '/wham/usage')
    const raw = proxy.raw() + proxy.printed.join('\n')
    for (const secret of [
      auth.tokens.access_token,
      auth.tokens.id_token,
      auth.tokens.refresh_token,
      auth.OPENAI_API_KEY,
      ACCOUNT,
      EMAIL,
      LOCAL,
    ])
      assert.ok(!raw.includes(secret), secret.slice(0, 12))
    assert.equal(statSync(proxy.recordFile).mode & 0o077, 0)
  } finally {
    await proxy.close()
  }
})

test('RECORD_KEEP lets one stripped header or field through', async () => {
  const proxy = await start({ keep: ['x-codex-turn-metadata', 'client_metadata'] })
  try {
    await call(proxy.port, 'POST', '/codex/responses', { headers: codexHeaders, body: codexBody })
    const [sent] = proxy.fake.received
    assert.equal(sent.headers['x-codex-turn-metadata'], '{"cwd":"/work"}')
    assert.equal(sent.headers['x-codex-window-id'], undefined)
    const body = JSON.parse(sent.body)
    assert.deepEqual(body.client_metadata, { installation: 'x' })
    assert.equal(body.service_tier, undefined)
  } finally {
    await proxy.close()
  }
  assert.throws(() => createRecordProxy({ localKey: LOCAL, keep: ['cookie'] }), /RECORD_KEEP/)
})

test('without the local key, off the route table or with a foreign Host nothing leaves', async () => {
  const proxy = await start()
  try {
    assert.equal(
      (
        await call(proxy.port, 'POST', '/codex/responses', {
          headers: { authorization: 'Bearer wrong' },
          body: '{}',
        })
      ).status,
      401,
    )
    assert.equal(
      (
        await call(proxy.port, 'POST', '/codex/responses', {
          headers: { authorization: '' },
          body: '{}',
        })
      ).status,
      401,
    )
    for (const [method, path] of [
      ['POST', '/codex/responses/compact'],
      ['GET', '/disabled/backend-api/me'],
      ['POST', '/kimi/v1/search'],
      ['GET', '/codex/responses'],
      ['POST', 'http://chatgpt.com/backend-api/codex/responses'],
      ['POST', '/codex/responses?x=1'],
    ])
      assert.equal(
        (await call(proxy.port, method, path, method === 'POST' ? { body: '{}' } : {})).status,
        403,
        path,
      )
    const foreign = await call(proxy.port, 'POST', '/codex/responses', {
      headers: { host: 'attacker.test' },
      body: '{}',
    })
    assert.equal(foreign.status, 403)
    assert.deepEqual(proxy.fake.received, [])
    const records = proxy.records()
    assert.equal(records.length, 9)
    assert.equal(records[2].path, '/codex/responses/compact')
    assert.equal(records[2].refused, '403 path not allowed')
    assert.deepEqual(records[2].request.body, {})
  } finally {
    await proxy.close()
  }
})

test('Kimi: the console key goes in, the client identity headers pass unchanged', async () => {
  const proxy = await start()
  try {
    const answer = await call(proxy.port, 'POST', '/kimi/v1/chat/completions', {
      headers: {
        'content-type': 'application/json',
        'user-agent': 'kimi-code-cli/2.1.1',
        'x-msh-platform': 'kimi_code_cli',
        'x-msh-device-id': 'device-1',
        'x-msh-long': 'x'.repeat(300),
      },
      body: JSON.stringify({ model: 'k3-256k', stream: true, messages: [] }),
    })
    assert.equal(answer.status, 200)
    const [sent] = proxy.fake.received
    assert.equal(sent.url, '/coding/v1/chat/completions')
    assert.equal(sent.headers.authorization, 'Bearer sk-kimi-synthetic-console-key-0001')
    assert.equal(sent.headers['user-agent'], 'kimi-code-cli/2.1.1')
    assert.equal(sent.headers['x-msh-device-id'], 'device-1')
    assert.equal(sent.headers['x-msh-long'], undefined)
    assert.equal(sent.headers['chatgpt-account-id'], undefined)
    const [record] = proxy.records()
    assert.equal(record.response.events.at(-1).data, '[DONE]')
    assert.match(proxy.printed[0], /"completion_tokens":3/)
    assert.ok(!proxy.raw().includes('sk-kimi-synthetic-console-key-0001'))
  } finally {
    await proxy.close()
  }
})

test('a redirect is not followed and a missing login answers 503', async () => {
  const proxy = await start()
  const bare = await start({ codexAuthFile: undefined, kimiKeyFile: undefined })
  try {
    const redirected = await call(proxy.port, 'GET', '/codex/models?client_version=0.158.0')
    assert.equal(redirected.status, 502)
    assert.equal(proxy.fake.received[0].url, '/backend-api/codex/models?client_version=0.158.0')
    const [record] = proxy.records()
    assert.equal(record.error, 'redirect')
    assert.equal(record.response.status, 302)
    assert.equal((await call(bare.port, 'POST', '/codex/responses', { body: '{}' })).status, 503)
    assert.equal((await call(bare.port, 'GET', '/kimi/v1/usages')).status, 503)
    assert.deepEqual(bare.fake.received, [])
  } finally {
    await proxy.close()
    await bare.close()
  }
})

test('inspect shows token lifetimes and the plan, never tokens, ids or emails', () => {
  const report = inspectCodexAuth(authFile)
  assert.equal(report.access_token.lifetime_hours, 240)
  assert.equal(report.access_token.plan_type, 'plus')
  assert.equal(report.id_token.plan_type, 'plus')
  assert.equal(report.has_refresh_token, true)
  const text = JSON.stringify(report)
  for (const secret of [auth.tokens.access_token, auth.tokens.refresh_token, ACCOUNT, EMAIL])
    assert.ok(!text.includes(secret))

  const broken = join(tmp, 'broken.json')
  writeFileSync(broken, 'rt_synthetic-not-json')
  const script = fileURLToPath(new URL('./record-proxy.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, 'inspect'], {
    env: { PATH: process.env.PATH, RECORD_CODEX_AUTH: broken },
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.doesNotMatch(run.stderr, /rt_synthetic/)
})

test('scrub removes known secrets, JWTs and emails', () => {
  assert.equal(
    scrub(
      'a secret-value-123 b eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2ln c x.y+z@mail.example.ru',
      ['secret-value-123', 'short'],
    ),
    'a [secret] b [jwt] c [email]',
  )
})

test(
  'through egress-1: CONNECT inside mutual TLS, the provider TLS inside the tunnel',
  {
    skip: spawnSync('openssl', ['version']).status !== 0 && 'openssl is not installed',
  },
  async () => {
    const dir = join(tmp, 'ca')
    const script = fileURLToPath(new URL('../../egress/make-ca.sh', import.meta.url))
    const make = (...args) => execFileSync('sh', [script, ...args], { stdio: 'pipe' })
    make('ca', dir)
    make('server', dir, 'egress-1.raditi.internal')
    make('server', dir, 'chatgpt.com')
    make('client', dir, 'op-1', '3')
    const read = (path) => readFileSync(join(dir, path))
    const fake = await fakeProviders({
      cert: read('server/chatgpt.com.pem'),
      key: read('server/chatgpt.com-key.pem'),
    })
    const logs = []
    const egress = createEgressProxy({
      tls: {
        cert: read('server/egress-1.raditi.internal.pem'),
        key: read('server/egress-1.raditi.internal-key.pem'),
        root: read('root.pem'),
        clientCa: read('client-ca.pem'),
      },
      allow: new Set(['chatgpt.com:443']),
      clientCns: new Set(['op-1']),
      lookup: async () => ['104.18.32.47'],
      dial: () => connect(fake.server.address().port, '127.0.0.1'),
      log: (entry) => logs.push(entry),
    })
    await listen(egress)
    const agent = egressAgent(
      {
        address: '127.0.0.1',
        port: egress.address().port,
        ca: read('root.pem'),
        cert: read('clients/op-1.pem'),
        key: read('clients/op-1-key.pem'),
      },
      read('root.pem'),
    )
    const proxy = await start({ origins: ORIGINS, agent }, fake)
    try {
      const answer = await call(proxy.port, 'POST', '/codex/responses', {
        headers: codexHeaders,
        body: codexBody,
      })
      assert.equal(answer.status, 200)
      assert.match(answer.body, /response\.completed/)
      assert.equal(fake.received[0].headers.authorization, `Bearer ${auth.tokens.access_token}`)
      assert.equal(fake.received[0].headers.host, 'chatgpt.com')
      const refused = await call(proxy.port, 'GET', '/kimi/v1/usages')
      assert.equal(refused.status, 502)
      assert.equal(proxy.records()[1].error, 'EGRESS_403')
      agent.destroy()
      const tunnels = await new Promise((resolve) => {
        const check = () => {
          const found = logs.filter((log) => log.event === 'connect')
          if (found.length === 2) resolve(found)
          else setTimeout(check, 20)
        }
        check()
      })
      assert.deepEqual(
        tunnels
          .map(({ cn, host, result }) => ({ cn, host, result }))
          .sort((a, b) => a.result.localeCompare(b.result)),
        [
          { cn: 'op-1', host: null, result: 'forbidden_host' },
          { cn: 'op-1', host: 'chatgpt.com:443', result: 'ok' },
        ],
      )
    } finally {
      await proxy.close()
      await new Promise((resolve) => egress.close(resolve))
    }
  },
)
