import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync, zstdCompressSync } from 'node:zlib'

import { createEgressProxy } from '../../egress/llm-egress.mjs'
import { createCodexAdapter } from './backend-adapter.mjs'
import {
  ORIGINS,
  createRecordProxy,
  egressAgent,
  inspectCodexAuth,
  recordDirectory,
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

function adapterOptions() {
  const issued = Math.floor(Date.now() / 1000) - 60
  const expiry = issued + 3600
  const access = jwt({ iat: issued, exp: expiry })
  const credential = {
    v: '1',
    kind: 'chatgpt_oauth',
    accessToken: access,
    refreshToken: auth.tokens.refresh_token,
    idToken: auth.tokens.id_token,
    chatgptAccountId: ACCOUNT,
    accessExpiresAt: new Date(expiry * 1000).toISOString(),
    refreshedAt: new Date(issued * 1000).toISOString(),
  }
  return {
    codexAdapter: createCodexAdapter({ model: 'gpt-6-sol' }),
    codexAuth: {
      token: access,
      accountId: ACCOUNT,
      secrets: [access, credential.refreshToken, credential.idToken, ACCOUNT],
      credential,
    },
    // A valid memory snapshot must take precedence over any on-disk credential file.
    codexAuthFile: join(tmp, 'never-created-owner-auth.json'),
  }
}

test('the recording pass also preserves the exact Responses Lite opt-in', async () => {
  const proxy = await start()
  try {
    for (const value of ['true', 'false', 'synthetic-untrusted-value']) {
      const answer = await call(proxy.port, 'POST', '/codex/responses', {
        headers: { ...codexHeaders, 'x-openai-internal-codex-responses-lite': value },
        body: codexBody,
      })
      assert.equal(answer.status, 200)
      assert.equal(
        proxy.fake.received.at(-1).headers['x-openai-internal-codex-responses-lite'],
        value === 'true' ? 'true' : undefined,
      )
    }
  } finally {
    await proxy.close()
  }
})

test('B7 hook: actual policy, upstream headers and usage meter run on the synthetic exchange', async () => {
  const options = adapterOptions()
  const proxy = await start(options)
  try {
    const answer = await call(proxy.port, 'POST', '/codex/responses', {
      headers: codexHeaders,
      body: codexBody,
    })
    assert.equal(answer.status, 200)
    const [sent] = proxy.fake.received
    const body = JSON.parse(sent.body)
    assert.equal(sent.url, '/backend-api/codex/responses')
    assert.equal(sent.method, 'POST')
    assert.equal(sent.headers.authorization, `Bearer ${options.codexAuth.token}`)
    assert.equal(sent.headers['chatgpt-account-id'], ACCOUNT)
    assert.match(sent.headers['x-codex-installation-id'], /^[a-f0-9-]{36}$/)
    assert.notEqual(sent.headers['x-codex-installation-id'], 'install-1')
    assert.equal(sent.headers['user-agent'], codexHeaders['user-agent'])
    assert.equal(sent.headers['accept-encoding'], 'identity')
    for (const name of ['cookie', 'x-codex-window-id', 'x-codex-turn-metadata'])
      assert.equal(sent.headers[name], undefined)
    assert.equal(body.model, 'gpt-6-sol')
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    assert.equal(body.service_tier, undefined)
    assert.equal(body.client_metadata, undefined)
    assert.equal(body.max_output_tokens, undefined)
    assert.deepEqual(body.reasoning, { effort: 'low' })
    assert.match(body.prompt_cache_key, /^rdt_[a-f0-9]{32}$/)
    assert.notEqual(body.prompt_cache_key, 'thread-1')
    const [record] = proxy.records()
    assert.equal(record.adapter.normalized, true)
    assert.deepEqual(record.adapter.signal, { kind: 'ok' })
    assert.deepEqual(record.adapter.meter, {
      usage: { input: 120, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      outcome: 'completed',
      signal: null,
      usageIssue: null,
      deltaTextBytes: 0,
    })
    assert.equal(record.response.terminal_event, 'response.completed')
    for (const secret of options.codexAuth.secrets) assert.ok(!proxy.raw().includes(secret))
    assert.equal(answer.headers['x-codex-primary-used-percent'], undefined)
  } finally {
    await proxy.close()
  }
})

test('B7 hook: malformed JSON and forbidden body fields never reach the provider', async () => {
  const proxy = await start(adapterOptions())
  try {
    for (const body of [
      '{invalid-json',
      '[]',
      JSON.stringify({ ...JSON.parse(codexBody), max_output_tokens: 100 }),
      JSON.stringify({ ...JSON.parse(codexBody), model: 'wrong-model' }),
    ]) {
      const answer = await call(proxy.port, 'POST', '/codex/responses', {
        headers: codexHeaders,
        body,
      })
      assert.equal(answer.status, 400)
    }
    assert.equal(proxy.fake.received.length, 0)
    assert.ok(proxy.records().every((record) => record.adapter.normalized === false))
    assert.ok(
      proxy.records().every((record) => record.adapter.error === 'ADAPTER_REQUEST_REJECTED'),
    )
  } finally {
    await proxy.close()
  }
})

test('B7 hook: CLI cannot reach control, discovery or other backend routes', async () => {
  const proxy = await start(adapterOptions())
  try {
    for (const [method, path] of [
      ['GET', '/wham/usage'],
      ['GET', '/codex/models'],
      ['GET', '/codex/responses'],
      ['POST', '/kimi/v1/chat/completions'],
      ['POST', '/codex/responses?redirect=other'],
    ]) {
      const answer = await call(proxy.port, method, path, {
        headers: codexHeaders,
        ...(method === 'POST' ? { body: codexBody } : {}),
      })
      assert.equal(answer.status, 403)
    }
    assert.equal(proxy.fake.received.length, 0)
  } finally {
    await proxy.close()
  }
})

test('B7 hook: a changed adapter destination is rejected before transport', async () => {
  const options = adapterOptions()
  const original = options.codexAdapter.prepare
  options.codexAdapter.prepare = (input) => ({
    ...original(input),
    url: 'https://attacker.invalid/token',
  })
  const proxy = await start(options)
  try {
    assert.equal(
      (
        await call(proxy.port, 'POST', '/codex/responses', {
          headers: codexHeaders,
          body: codexBody,
        })
      ).status,
      400,
    )
    assert.equal(proxy.fake.received.length, 0)
    assert.equal(proxy.records()[0].adapter.error, 'ADAPTER_REQUEST_REJECTED')
  } finally {
    await proxy.close()
  }
})

test('B7 hook: compressed upstream content fails before any provider bytes reach the CLI', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      res.end(
        gzipSync(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        ),
      )
    })
  })
  await listen(server)
  const proxy = await start(adapterOptions(), {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  })
  try {
    const answer = await call(proxy.port, 'POST', '/codex/responses', {
      headers: codexHeaders,
      body: codexBody,
    })
    assert.equal(answer.status, 502)
    assert.doesNotMatch(answer.body, /response.completed/)
    const [record] = proxy.records()
    assert.equal(record.error, 'ADAPTER_RESPONSE_ENCODING')
    assert.equal(record.adapter.meter.outcome, 'incomplete')
    assert.equal(record.adapter.meter.usageIssue, 'no_usage')
  } finally {
    await proxy.close()
  }
})

test('B7 hook: malformed SSE is contained without an uncaught event-listener exception', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(Buffer.from([0xff, 10, 10]))
    })
  })
  await listen(server)
  const proxy = await start(adapterOptions(), {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  })
  try {
    await assert.rejects(
      call(proxy.port, 'POST', '/codex/responses', { headers: codexHeaders, body: codexBody }),
    )
    const [record] = proxy.records()
    assert.equal(record.error, 'ADAPTER_STREAM_INVALID')
    assert.equal(record.adapter.meter.outcome, 'incomplete')
    // The same process still accepts requests after rejecting the invalid stream.
    assert.equal((await call(proxy.port, 'GET', '/wham/usage')).status, 403)
  } finally {
    await proxy.close()
  }
})

test('B7 hook: recording exceptions cannot weaken the actual adapter policy', () => {
  assert.throws(
    () =>
      createRecordProxy({
        localKey: LOCAL,
        codexAdapter: createCodexAdapter({ model: 'gpt-6-sol' }),
        keep: ['service_tier'],
      }),
    /cannot use RECORD_KEEP/,
  )
})

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
    // Only the name: the real value carries the turn id, workspace paths and git remotes.
    assert.equal(record.request.headers['x-codex-turn-metadata'], '[value]')
    assert.equal(record.request.headers.authorization, '[local key]')
    assert.equal(record.request.headers.cookie, '[redacted]')
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

test('compressed Codex requests strip metadata before forwarding and bound decoded size', async () => {
  const proxy = await start()
  try {
    for (const [encoding, compress] of [
      ['gzip', gzipSync],
      ['zstd', zstdCompressSync],
    ]) {
      const answer = await call(proxy.port, 'POST', '/codex/responses', {
        headers: { ...codexHeaders, 'content-encoding': encoding },
        body: compress(Buffer.from(codexBody)),
      })
      assert.equal(answer.status, 200)
      const sent = proxy.fake.received.at(-1)
      assert.equal(sent.headers['content-encoding'], undefined)
      const body = JSON.parse(sent.body)
      assert.equal(body.client_metadata, undefined)
      assert.equal(body.service_tier, undefined)
      assert.equal(body.model, 'gpt-6-sol')
      assert.deepEqual(proxy.records().at(-1).request.stripped, ['client_metadata', 'service_tier'])
    }
    for (const [encoding, body, status] of [
      ['gzip', Buffer.from('not gzip'), 400],
      ['unknown', Buffer.from('{}'), 415],
      ['gzip', gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32)), 413],
    ]) {
      assert.equal(
        (
          await call(proxy.port, 'POST', '/codex/responses', {
            headers: { ...codexHeaders, 'content-encoding': encoding },
            body,
          })
        ).status,
        status,
      )
    }
    assert.equal(proxy.fake.received.length, 2)
  } finally {
    await proxy.close()
  }
})

test('headerless streaming routes record SSE; explicit JSON and headerless HTTP errors stay JSON', async () => {
  const server = createServer((req, res) => {
    req.resume()
    if (req.headers['user-agent'] === 'explicit-json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } else if (req.headers['user-agent'] === 'http-error') {
      res.writeHead(429)
      res.end('{"error":{"code":"usage_limit_reached"}}')
    } else if (req.url.endsWith('/chat/completions')) {
      res.end('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
    } else {
      res.end(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4}}}\n\n',
      )
    }
  })
  await listen(server)
  const proxy = await start({}, { server, origin: `http://127.0.0.1:${server.address().port}` })
  try {
    for (const path of ['/codex/responses', '/kimi/v1/chat/completions'])
      await call(proxy.port, 'POST', path, { headers: codexHeaders, body: codexBody })
    await call(proxy.port, 'POST', '/codex/responses', {
      headers: { ...codexHeaders, 'user-agent': 'explicit-json' },
      body: codexBody,
    })
    await call(proxy.port, 'POST', '/codex/responses', {
      headers: { ...codexHeaders, 'user-agent': 'http-error' },
      body: codexBody,
    })
    const records = proxy.records()
    assert.equal(records[0].response.headers['content-type'], undefined)
    assert.equal(records[0].response.terminal_event, 'response.completed')
    assert.deepEqual(records[0].response.usage, { input_tokens: 11, output_tokens: 4 })
    assert.equal(records[0].response.transport_end, 'end')
    assert.equal(records[0].response.outcome, 'completed')
    assert.equal(records[1].response.terminal_event, '[DONE]')
    assert.deepEqual(records[1].response.usage, { prompt_tokens: 5, completion_tokens: 2 })
    assert.deepEqual(records[2].response.body, { ok: true })
    assert.deepEqual(records[3].response.body, { error: { code: 'usage_limit_reached' } })
    assert.equal(records[3].response.events, undefined)
  } finally {
    await proxy.close()
  }
})

test(
  'client close retains received terminal usage and distinguishes abandonment from provider completion',
  { timeout: 5000 },
  async () => {
    for (const terminal of [
      'response.completed',
      'response.failed',
      'response.incomplete',
      null,
      'partial',
    ]) {
      let recordWritten
      const recorded = new Promise((resolve) => {
        recordWritten = resolve
      })
      let providerClosed
      const closed = new Promise((resolve) => {
        providerClosed = resolve
      })
      const initial = 'event: response.created\ndata: {"type":"response.created"}\n\n'
      const terminalFrame = terminal
        ? `event: ${terminal === 'partial' ? 'response.completed' : terminal}\ndata: ${JSON.stringify({ type: terminal === 'partial' ? 'response.completed' : terminal, response: { usage: { input_tokens: 20, output_tokens: 3 } } })}${terminal === 'partial' ? '' : '\n\n'}`
        : ''
      const body = initial + terminalFrame
      const server = createServer((req, res) => {
        req.resume()
        res.on('close', providerClosed)
        // Deliberately omit Content-Type and never end the upstream HTTP stream.
        res.write(body)
      })
      await listen(server)
      const proxy = await start(
        { print: recordWritten },
        { server, origin: `http://127.0.0.1:${server.address().port}` },
      )
      try {
        await new Promise((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: proxy.port,
              method: 'POST',
              path: '/codex/responses',
              headers: { ...codexHeaders, authorization: `Bearer ${LOCAL}` },
            },
            (res) => {
              let received = ''
              res.on('data', (chunk) => {
                received += chunk.toString()
                if (received.length >= body.length) res.destroy()
              })
              res.on('error', reject)
              res.on('close', resolve)
            },
          )
          req.on('error', reject)
          req.end(codexBody)
        })
        const line = await recorded
        await closed
        const records = proxy.records()
        assert.equal(records.length, 1)
        const [record] = records
        assert.equal(record.response.transport_end, 'client_close')
        assert.equal(record.response.bytes, Buffer.byteLength(body))
        if (terminal && terminal !== 'partial') {
          assert.equal(record.response.terminal_event, terminal)
          assert.equal(record.response.outcome, terminal.slice('response.'.length))
          assert.equal(record.error, undefined)
          assert.equal(record.response.events.length, 2)
          if (terminal === 'response.completed') {
            assert.deepEqual(record.response.usage, { input_tokens: 20, output_tokens: 3 })
            assert.match(line, /"input_tokens":20/)
          }
        } else {
          assert.equal(record.response.outcome, 'client_aborted')
          assert.equal(record.response.terminal_event, null)
          assert.equal(record.response.usage, null)
          assert.equal(record.error, 'ABORT_ERR')
          assert.deepEqual(
            record.response.events.map(({ data }) => data.type),
            ['response.created'],
          )
        }
      } finally {
        await proxy.close()
      }
    }
  },
)

test(
  'upstream interruption preserves received events without inventing a terminal',
  { timeout: 3000 },
  async () => {
    let recordWritten
    const recorded = new Promise((resolve) => {
      recordWritten = resolve
    })
    let interrupt
    const server = createServer((req, res) => {
      req.resume()
      interrupt = () => res.destroy()
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
    })
    await listen(server)
    const proxy = await start(
      { print: recordWritten },
      { server, origin: `http://127.0.0.1:${server.address().port}` },
    )
    try {
      await new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: proxy.port,
            method: 'POST',
            path: '/codex/responses',
            headers: { ...codexHeaders, authorization: `Bearer ${LOCAL}` },
          },
          (res) => {
            res.once('data', () => interrupt())
            res.on('error', () => {})
            res.once('close', resolve)
          },
        )
        req.on('error', reject)
        req.end(codexBody)
      })
      await recorded
      const [record] = proxy.records()
      assert.equal(record.response.outcome, 'upstream_error')
      assert.notEqual(record.response.transport_end, 'client_close')
      assert.equal(record.response.terminal_event, null)
      assert.equal(record.response.usage, null)
      assert.deepEqual(
        record.response.events.map(({ data }) => data.type),
        ['response.created'],
      )
      assert.equal(record.error, 'UPSTREAM_ABORTED')
    } finally {
      await proxy.close()
    }
  },
)

test('a truncated recording retains complete prefix events and cannot claim a terminal beyond the limit', async () => {
  const prefix = 'data: {"type":"response.created"}\n\n'
  const body = Buffer.concat([
    Buffer.from(prefix + 'data: '),
    Buffer.alloc(32 * 1024 * 1024, 32),
    Buffer.from(
      '\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":99}}}\n\n',
    ),
  ])
  const server = createServer((req, res) => {
    req.resume()
    res.end(body)
  })
  await listen(server)
  const proxy = await start({}, { server, origin: `http://127.0.0.1:${server.address().port}` })
  try {
    await call(proxy.port, 'POST', '/codex/responses', { headers: codexHeaders, body: codexBody })
    const [record] = proxy.records()
    assert.equal(record.response.bytes, body.length)
    assert.equal(record.response.truncated, true)
    assert.equal(record.response.terminal_event, null)
    assert.equal(record.response.usage, null)
    assert.equal(record.response.outcome, 'missing_terminal')
    assert.deepEqual(
      record.response.events.map(({ data }) => data.type),
      ['response.created'],
    )
    assert.ok(statSync(proxy.recordFile).size < 10_000)
  } finally {
    await proxy.close()
  }
})

test('refused exchanges scrub both configured credentials and structural secret fields', async () => {
  const proxy = await start()
  try {
    const body = JSON.stringify({
      echo: [auth.tokens.refresh_token, ACCOUNT, 'sk-kimi-synthetic-console-key-0001'],
      nested: {
        refresh_token: 'unknown-synthetic-refresh',
        account_id: 'unknown-synthetic-account',
      },
    })
    const refused = await call(proxy.port, 'POST', '/codex/unknown', {
      headers: { 'content-encoding': 'gzip', 'chatgpt-account-id': ACCOUNT },
      body: gzipSync(Buffer.from(body)),
    })
    assert.equal(refused.status, 403)
    assert.equal(
      (
        await call(proxy.port, 'GET', '/wham/usage', {
          headers: {
            authorization: 'Bearer incorrect-local-key',
            'chatgpt-account-id': 'unconfigured-synthetic-account',
            cookie: 'unconfigured-synthetic-cookie',
          },
        })
      ).status,
      401,
    )
    for (const secret of [
      auth.tokens.refresh_token,
      ACCOUNT,
      'sk-kimi-synthetic-console-key-0001',
      'unknown-synthetic-refresh',
      'unknown-synthetic-account',
      'unconfigured-synthetic-account',
      'unconfigured-synthetic-cookie',
    ]) {
      assert.ok(!(proxy.raw() + proxy.printed.join('\n')).includes(secret))
    }
    assert.deepEqual(proxy.fake.received, [])
    assert.equal(proxy.records()[0].request.body.nested.refresh_token, '[secret]')
    assert.equal(proxy.records()[1].request.headers['chatgpt-account-id'], '[redacted]')
  } finally {
    await proxy.close()
  }
})

test('malformed and oversized compressed replies are recorded safely and the proxy keeps serving', async () => {
  const replies = [
    Buffer.from('not gzip'),
    gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)),
    gzipSync(Buffer.from('{"healthy":true}')),
  ]
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(replies.shift())
  })
  await listen(server)
  const proxy = await start({}, { server, origin: `http://127.0.0.1:${server.address().port}` })
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await call(proxy.port, 'GET', '/wham/usage')).status, 200)
    const records = proxy.records()
    assert.equal(records[0].response.decode_error, 'Z_DATA_ERROR')
    assert.equal(records[1].response.decode_error, 'ERR_BUFFER_TOO_LARGE')
    assert.deepEqual(records[2].response.body, { healthy: true })
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

test('the record keeps provider and client identifiers out: only field and header names survive', async () => {
  // Shapes a provider may plausibly send; every value here is a synthetic private marker.
  const marker = (name) => `synthetic-private-${name}-0001`
  const received = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      received.push(req.url)
      const headers = {
        'x-codex-primary-used-percent': '12',
        'x-codex-credits-has-credits': 'false',
        'x-codex-plan-label': marker('header-plan'),
        'x-oai-request-id': marker('request-header'),
        'openai-organization': marker('org-header'),
        'x-user-id': marker('user-header'),
        'x-codex-turn-state': marker('turn-state'),
      }
      if (req.url === '/backend-api/wham/usage') {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(
          JSON.stringify({
            plan_type: 'plus',
            user_id: marker('user-id'),
            id: marker('id'),
            account: { id: marker('account-id'), name: marker('account-name') },
            organization_id: marker('org-id'),
            orgs: [{ id: marker('org-list-id'), title: marker('org-title') }],
            workspace_ids: [marker('workspace-id')],
            user: { name: marker('user-name'), handle: marker('user-handle') },
            contact_email: marker('email'),
            rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } },
          }),
        )
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: marker('response-id'), user: marker('response-user') } })}\n\n`,
        )
        res.end('data: [DONE]\n\n')
      }
    })
  })
  await listen(server)
  const proxy = await start(
    {},
    { server, received, origin: `http://127.0.0.1:${server.address().port}` },
  )
  try {
    assert.equal((await call(proxy.port, 'GET', '/wham/usage')).status, 200)
    assert.equal(
      (
        await call(proxy.port, 'POST', '/codex/responses', {
          headers: { ...codexHeaders, 'x-codex-installation-id': marker('installation') },
          body: codexBody,
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await call(proxy.port, 'POST', '/kimi/v1/chat/completions', {
          headers: {
            'content-type': 'application/json',
            'user-agent': 'kimi-code-cli/2.1.1',
            'x-msh-platform': 'kimi_code_cli',
            'x-msh-device-id': marker('device-id'),
            'x-msh-device-name': marker('device-name'),
          },
          body: JSON.stringify({ model: 'k3-256k', stream: true, messages: [] }),
        })
      ).status,
      200,
    )
    const raw = proxy.raw() + proxy.printed.join('\n')
    assert.doesNotMatch(raw, /synthetic-private-/)
    const [usage, codex, kimi] = proxy.records()
    // The shape stays readable for P3.0: names, plan, numeric quota fields and headers.
    assert.equal(usage.response.body.plan_type, 'plus')
    assert.equal(usage.response.body.rate_limit.primary_window.used_percent, 3)
    assert.equal(usage.response.body.user_id, '[id]')
    assert.equal(usage.response.body.account.name, '[id]')
    assert.deepEqual(usage.response.body.workspace_ids, ['[id]'])
    assert.equal(usage.response.headers['x-codex-primary-used-percent'], '12')
    assert.equal(usage.response.headers['x-codex-credits-has-credits'], 'false')
    assert.equal(usage.response.headers['content-type'], 'application/json')
    for (const name of [
      'x-oai-request-id',
      'openai-organization',
      'x-user-id',
      'x-codex-turn-state',
    ])
      assert.equal(usage.response.headers[name], '[value]', name)
    assert.equal(codex.request.headers['x-codex-installation-id'], '[id]')
    assert.equal(codex.request.sent['x-codex-installation-id'], '[id]')
    assert.equal(codex.request.headers['user-agent'], 'codex_exec/0.158.0')
    assert.equal(codex.response.events[0].data.response.id, '[id]')
    assert.equal(kimi.request.headers['x-msh-device-id'], '[id]')
    assert.equal(kimi.request.sent['x-msh-device-name'], '[id]')
    assert.equal(kimi.request.sent['x-msh-platform'], 'kimi_code_cli')
  } finally {
    await proxy.close()
  }
})

test('installation, thread, turn-metadata and safety identifiers never reach the record', async () => {
  // What the real Codex CLI sends on every call, and what a provider may echo: all synthetic.
  const INSTALL = '11111111-2222-4333-8444-555555555555'
  const THREAD = '99999999-8888-4777-8666-555555555555'
  const SAFETY = 'user-SYNTHETICuserIdentifier123'
  const ORG = 'org-SYNTHETICorgIdentifier456'
  const PAYER = 'acct_SYNTHETICpayer789'
  const PREVIOUS = 'resp_synthetic0123456789abcdef'
  const TRACE = 'req_synthetic0123456789abcdef'
  const WORKSPACE = '/Users/synthetic-owner/sites/synthetic-shop'
  const REMOTE = 'https://git.example.test/synthetic-owner/shop.git'
  const TURN = JSON.stringify({
    turn_id: 'turn-synthetic-0001',
    installation: INSTALL,
    workspaces: { [WORKSPACE]: { associated_remote_urls: { origin: REMOTE } } },
  })
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            safety_identifier: SAFETY,
            prompt_cache_key: THREAD,
            previous: PREVIOUS,
            billing: { payer: PAYER, owner: ORG },
            trace: TRACE,
            metadata: { 'x-codex-installation-id': INSTALL, source: `thread ${THREAD}` },
            output: [
              { type: 'message', content: [{ type: 'output_text', text: `rollout ${THREAD}.` }] },
            ],
            usage: { input_tokens: 120, output_tokens: 7 },
          },
        })}\n\n`,
      )
    })
  })
  await listen(server)
  const proxy = await start(
    { keep: ['x-codex-turn-metadata'] },
    { server, received, origin: `http://127.0.0.1:${server.address().port}` },
  )
  try {
    const answer = await call(proxy.port, 'POST', '/codex/responses', {
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex_exec/0.158.0',
        originator: 'codex_exec',
        'session-id': THREAD,
        'x-codex-installation-id': INSTALL,
        'x-codex-turn-metadata': TURN,
        'x-openai-internal-codex-responses-lite': 'true',
        'x-synthetic-unknown': ORG,
      },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        store: false,
        stream: true,
        input: [],
        prompt_cache_key: THREAD,
        client_metadata: { 'x-codex-installation-id': INSTALL, 'x-codex-turn-metadata': TURN },
      }),
    })
    assert.equal(answer.status, 200)
    // A refused side call: the id sits in the path and in a body that is not JSON.
    const refused = await call(proxy.port, 'POST', `/disabled/accounts/${INSTALL}/settings`, {
      headers: { 'content-type': 'text/plain' },
      body: `thread=${THREAD}`,
    })
    assert.equal(refused.status, 403)
    // The provider still gets what the gateway would forward: only the record is masked.
    assert.equal(JSON.parse(received[0].body).prompt_cache_key, THREAD)
    assert.equal(received[0].headers['x-codex-turn-metadata'], TURN)

    const raw = proxy.raw() + proxy.printed.join('\n')
    for (const [name, value] of Object.entries({
      INSTALL,
      THREAD,
      SAFETY,
      ORG,
      PAYER,
      PREVIOUS,
      TRACE,
      WORKSPACE,
      REMOTE,
      turn: 'turn-synthetic-0001',
    }))
      assert.ok(!raw.includes(value), `${name} is in the record`)

    // The protocol shape stays readable: every name survives, and so do protocol values.
    const [record, side] = proxy.records()
    assert.equal(side.path, '/disabled/accounts/[id]/settings')
    assert.equal(side.request.body, 'thread=[id]')
    assert.match(proxy.printed[1], /POST \/disabled\/accounts\/\[id\]\/settings → 403/)
    const { headers, sent, body } = record.request
    for (const recorded of [headers, sent]) {
      assert.equal(recorded['x-codex-turn-metadata'], '[value]')
      assert.equal(recorded['x-codex-installation-id'], '[id]')
      assert.equal(recorded['session-id'], '[id]')
      assert.equal(recorded['user-agent'], 'codex_exec/0.158.0')
      assert.equal(recorded.originator, 'codex_exec')
      assert.equal(recorded['content-type'], 'application/json')
      assert.equal(recorded['x-openai-internal-codex-responses-lite'], 'true')
    }
    assert.equal(headers['x-synthetic-unknown'], '[value]')
    assert.equal(headers.authorization, '[local key]')
    assert.equal(sent.authorization, '[subscription]')
    assert.equal(body.model, 'gpt-6-sol')
    assert.equal(body.prompt_cache_key, '[id]')
    assert.deepEqual(body.client_metadata, {
      'x-codex-installation-id': '[id]',
      'x-codex-turn-metadata': '[id]',
    })
    const { response } = record.response.events[0].data
    assert.equal(response.status, 'completed')
    assert.equal(response.safety_identifier, '[id]')
    assert.equal(response.prompt_cache_key, '[id]')
    assert.equal(response.previous, '[id]')
    assert.deepEqual(response.billing, { payer: '[id]', owner: '[id]' })
    assert.equal(response.trace, '[id]')
    assert.deepEqual(response.metadata, { 'x-codex-installation-id': '[id]', source: '[id]' })
    assert.equal(response.output[0].content[0].text, 'rollout [id].')
    assert.deepEqual(response.usage, { input_tokens: 120, output_tokens: 7 })
    assert.deepEqual(record.response.usage, { input_tokens: 120, output_tokens: 7 })
  } finally {
    await proxy.close()
  }
})

test('provider ids inside messages, paths and streams, and camelCase id fields, never reach the record', async () => {
  // An id is not always a whole JSON value under a snake_case name: providers quote the
  // organisation in an error message, and Kimi names its fields in camelCase. All synthetic.
  const ORG = 'org-SYNTHETICorg0123456789abcd'
  const USER = 'user-SYNTHETICuser0123456789ab'
  const TRACE = 'req_0123456789abcdef0123456789abcdef'
  const RESPONSE = 'resp_0123456789abcdef0123456789abcdef'
  const camel = (name) => `synthetic-camel-${name}-0001`
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/coding/v1/usages') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            userId: camel('user'),
            deviceId: camel('device'),
            sessionIds: [camel('session')],
            accountID: camel('account'),
            deviceIdentifier: camel('identifier'),
            boosterWallet: { walletId: camel('wallet'), balance: 3 },
            usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-10-03T12:00:00+00:00' } },
            // Names that only end like an id are protocol fields, not identities.
            valid: true,
            paid: 'yes',
            grid: 'user_instructions and a user-agent are plain words',
          }),
        )
        return
      }
      res.writeHead(429, { 'content-type': 'text/event-stream' })
      // A data line that is not JSON, then a failure whose message quotes the account's ids.
      res.write(`data: stream of ${USER} interrupted\n\n`)
      res.end(
        `event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_exceeded',
              message: `Rate limit reached for gpt-6-sol in organization ${ORG} on tokens per min. Request ${TRACE} of ${USER}.`,
            },
          },
        })}\n\n`,
      )
    })
  })
  await listen(server)
  const proxy = await start(
    {},
    { server, received: [], origin: `http://127.0.0.1:${server.address().port}` },
  )
  try {
    assert.equal((await call(proxy.port, 'GET', '/kimi/v1/usages')).status, 200)
    assert.equal(
      (await call(proxy.port, 'POST', '/codex/responses', { headers: codexHeaders, body: '{}' }))
        .status,
      429,
    )
    // A refused side call with the object id in its path and in a body that is not JSON.
    const refused = await call(proxy.port, 'POST', `/codex/responses/${RESPONSE}/cancel`, {
      headers: { 'content-type': 'text/plain' },
      body: `previous=${RESPONSE}&org=${ORG}`,
    })
    assert.equal(refused.status, 403)

    const raw = proxy.raw() + proxy.printed.join('\n')
    for (const [name, value] of Object.entries({ ORG, USER, TRACE, RESPONSE }))
      assert.ok(!raw.includes(value), `${name} is in the record`)
    assert.doesNotMatch(raw, /synthetic-camel-/)

    const [usage, failed, side] = proxy.records()
    const { body } = usage.response
    for (const name of ['userId', 'deviceId', 'accountID', 'deviceIdentifier'])
      assert.equal(body[name], '[id]', name)
    assert.deepEqual(body.sessionIds, ['[id]'])
    assert.deepEqual(body.boosterWallet, { walletId: '[id]', balance: 3 })
    // The protocol shape and plain words survive.
    assert.equal(body.usages.limit_5h.used_ratio, 0.25)
    assert.equal(body.valid, true)
    assert.equal(body.paid, 'yes')
    assert.equal(body.grid, 'user_instructions and a user-agent are plain words')
    assert.equal(failed.response.events[0].data, 'stream of [id] interrupted')
    const { error } = failed.response.events[1].data.response
    assert.equal(error.code, 'rate_limit_exceeded')
    assert.equal(
      error.message,
      'Rate limit reached for gpt-6-sol in organization [id] on tokens per min. Request [id] of [id].',
    )
    assert.equal(side.path, '/codex/responses/[id]/cancel')
    assert.equal(side.request.body, 'previous=[id]&org=[id]')
    assert.match(proxy.printed[2], /POST \/codex\/responses\/\[id\]\/cancel → 403/)
  } finally {
    await proxy.close()
  }
})

test(
  'without RECORD_DIR the record goes to a fresh private directory outside the working copy',
  { timeout: 20_000 },
  async () => {
    const script = fileURLToPath(new URL('./record-proxy.mjs', import.meta.url))
    const cwd = mkdtempSync(join(tmp, 'checkout-'))
    const temporary = mkdtempSync(join(tmp, 'tmpdir-'))
    // A synthetic HOME and no login file: the proxy starts and records nothing here.
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: temporary, RECORD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let output = ''
      const directory = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', () => reject(new Error(`record-proxy exited: ${output}`)))
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk) => {
            output += chunk
            const [, found] = /records in (\S+)\n/.exec(output) ?? []
            if (found) resolve(found)
          })
      })
      assert.deepEqual(readdirSync(cwd), [], 'nothing is created in the working directory')
      assert.equal(realpathSync(dirname(directory)), realpathSync(temporary))
      assert.match(basename(directory), /^raditi-spike-records-/)
      assert.equal(statSync(directory).mode & 0o777, 0o700)
    } finally {
      child.removeAllListeners('exit')
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('close', resolve))
    }
    // An unreviewed live record left in a working copy must not be staged by `git add -A`.
    const ignored = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8')
    assert.match(ignored, /^spike-records\/$/m)
  },
)

test('a record directory inside a working copy is refused before anything is created', () => {
  // An unreviewed live record may not sit next to sources (rule 1): `.gitignore` covers only the
  // old default name, so any other directory of a checkout would be staged by `git add -A`.
  const checkout = mkdtempSync(join(tmp, 'working-copy-'))
  mkdirSync(join(checkout, '.git'))
  mkdirSync(join(checkout, 'infra/dev'), { recursive: true })
  // A linked worktree and a submodule mark their root with a `.git` file.
  const worktree = mkdtempSync(join(tmp, 'worktree-'))
  writeFileSync(join(worktree, '.git'), 'gitdir: /synthetic/.git/worktrees/x\n')
  // A path that only leads into the checkout.
  const link = join(tmp, `link-${process.pid}`)
  symlinkSync(join(checkout, 'infra'), link)
  for (const inside of [
    checkout,
    join(checkout, 'spike-records'),
    join(checkout, 'infra/dev/not-yet/created'),
    join(worktree, 'records'),
    join(link, 'dev/records'),
  ]) {
    assert.throws(() => recordDirectory(inside), /RECORD_DIR is inside a git working copy/)
    assert.ok(inside === checkout || !existsSync(inside), `${inside} was created`)
  }

  // The default is held to the same rule: a temporary directory inside a checkout is no refuge.
  const previous = process.env.TMPDIR
  process.env.TMPDIR = join(checkout, 'infra')
  try {
    assert.throws(() => recordDirectory(undefined), /temporary directory is inside a git working/)
    assert.deepEqual(readdirSync(join(checkout, 'infra')), ['dev'])
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }

  // Outside any working copy the directory is created private, parents included.
  const outside = join(mkdtempSync(join(tmp, 'outside-')), 'spike/records')
  assert.equal(recordDirectory(outside), realpathSync(outside))
  assert.equal(statSync(outside).mode & 0o777, 0o700)
  // An existing directory is taken as it is.
  assert.equal(recordDirectory(outside), realpathSync(outside))
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

test('scrub removes known secrets, JWTs, emails and UUIDs', () => {
  assert.equal(
    scrub(
      'a secret-value-123 b eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2ln c x.y+z@mail.example.ru' +
        ' d 0199A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      ['secret-value-123', 'short'],
    ),
    'a [secret] b [jwt] c [email] d [id]',
  )
  // A provider id quoted inside a text is recognised by its generated tail; words are not ids.
  assert.equal(
    scrub(
      'organization org-AbCd1234EfGh5678, user-0a1b2c3d4e5f (req_0123456789abcdef):' +
        ' user_instructions, user-agent, req_headers, org-wide and resp_format stay',
      [],
    ),
    'organization [id], [id] ([id]):' +
      ' user_instructions, user-agent, req_headers, org-wide and resp_format stay',
  )
})

test(
  'egress client bounds connection setup and reports an early peer close',
  { timeout: 3000 },
  async () => {
    for (const earlyClose of [false, true]) {
      const sockets = new Set()
      const server = createTcpServer((socket) => {
        sockets.add(socket)
        socket.resume()
        if (earlyClose) socket.end()
      })
      await listen(server)
      const agent = egressAgent({
        address: '127.0.0.1',
        port: server.address().port,
        connectTimeoutMs: 50,
      })
      try {
        const error = await new Promise((resolve) =>
          agent.createConnection({ host: 'chatgpt.com', port: 443 }, (error) => resolve(error)),
        )
        assert.ok(error)
        if (!earlyClose) assert.equal(error.code, 'EGRESS_TIMEOUT')
      } finally {
        agent.destroy()
        for (const socket of sockets) socket.destroy()
        await close(server)
      }
    }
  },
)

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
