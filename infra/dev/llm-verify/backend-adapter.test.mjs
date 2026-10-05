/* global Headers, TextDecoder, TextEncoder, queueMicrotask */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createCodexAdapter } from './backend-adapter.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const decode = (value) => JSON.parse(new TextDecoder().decode(value))
const jwt = (claims) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
function credential(expires = Math.floor(Date.now() / 1000) + 3600) {
  return {
    v: '1',
    kind: 'chatgpt_oauth',
    accessToken: jwt({ iat: expires - 3600, exp: expires }),
    refreshToken: 'synthetic-refresh',
    idToken: jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-account',
        chatgpt_plan_type: 'plus',
      },
    }),
    chatgptAccountId: 'synthetic-account',
    accessExpiresAt: new Date(expires * 1000).toISOString(),
    refreshedAt: new Date((expires - 3600) * 1000).toISOString(),
  }
}
const base = { model: 'synthetic-codex', stream: true, store: false, input: 'Synthetic probe' }
const emptyHeaders = () => new Headers()
// Inside its own window: the adapter treats a reset further ahead than the window is long as a
// broken report.
const probeReset = Math.floor(Date.now() / 1000) + 3600
const probeBody = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_at: probeReset },
  },
  credits: { balance: '0' },
}

function fakeRequest({
  status = 200,
  headers = {},
  body = encode(probeBody),
  chunks,
  error,
  abort = false,
  stall = false,
} = {}) {
  const calls = []
  const request = (url, options, callback) => {
    const call = {
      url,
      options,
      requestDestroyed: false,
      responseDestroyed: false,
      body: undefined,
    }
    calls.push(call)
    const client = new EventEmitter()
    client.destroy = () => {
      call.requestDestroyed = true
    }
    client.end = (payload) => {
      call.body = payload
      queueMicrotask(() => {
        if (error) {
          client.emit('error', new Error('synthetic-private-transport-error'))
          return
        }
        const incoming = stall ? new Readable({ read() {} }) : Readable.from(chunks ?? [body])
        incoming.statusCode = status
        incoming.headers = headers
        const originalDestroy = incoming.destroy.bind(incoming)
        incoming.destroy = (...args) => {
          call.responseDestroyed = true
          return originalDestroy(...args)
        }
        callback(incoming)
        if (abort) incoming.emit('aborted')
      })
    }
    return client
  }
  return { request, calls }
}

test('real B7 normalization and upstream are used, with stable cache and account identity', () => {
  const adapter = createCodexAdapter({ model: base.model })
  const original = {
    ...base,
    service_tier: 'priority',
    client_metadata: { discarded: 'private' },
    prompt_cache_key: 'shared-by-attacker',
  }
  const source = credential()
  const headers = new Headers({
    authorization: 'Bearer temporary-key',
    'x-codex-installation-id': 'untrusted-client-id',
    'x-codex-turn-metadata': 'private-path',
    'user-agent': 'synthetic-codex',
  })
  const first = adapter.prepare({ body: encode(original), headers, credential: source })
  const second = adapter.prepare({ body: encode(original), headers, credential: source })
  assert.equal(first.url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(first.method, 'POST')
  assert.equal(first.headers.get('authorization'), `Bearer ${source.accessToken}`)
  assert.equal(first.headers.get('chatgpt-account-id'), source.chatgptAccountId)
  assert.equal(first.headers.get('x-codex-turn-metadata'), null)
  assert.equal(first.headers.get('accept-encoding'), 'identity')
  assert.equal(
    first.headers.get('x-codex-installation-id'),
    second.headers.get('x-codex-installation-id'),
  )
  assert.notEqual(first.headers.get('x-codex-installation-id'), 'untrusted-client-id')
  const normalized = decode(first.body)
  assert.equal(normalized.service_tier, undefined)
  assert.equal(normalized.client_metadata, undefined)
  assert.equal(normalized.max_output_tokens, undefined)
  assert.deepEqual(normalized.reasoning, { effort: 'low' })
  assert.match(normalized.prompt_cache_key, /^rdt_[a-f0-9]{32}$/)
  assert.equal(normalized.prompt_cache_key, decode(second.body).prompt_cache_key)
  assert.ok(Number.isSafeInteger(first.normalized.estInputTokens))
  assert.notEqual(first.meter, second.meter)
})

test('separate live-test runs never share the cache key or installation identity', () => {
  const prepare = () =>
    createCodexAdapter({ model: base.model }).prepare({
      body: encode(base),
      headers: emptyHeaders(),
      credential: credential(),
    })
  const first = prepare(),
    second = prepare()
  assert.notEqual(decode(first.body).prompt_cache_key, decode(second.body).prompt_cache_key)
  assert.notEqual(
    first.headers.get('x-codex-installation-id'),
    second.headers.get('x-codex-installation-id'),
  )
})

test('body rejections use the real policy and never leak values or perform HTTP', () => {
  let calls = 0
  const adapter = createCodexAdapter({
    model: base.model,
    request: () => {
      calls++
      throw new Error('must never send')
    },
  })
  for (const patch of [
    { max_output_tokens: 1 },
    { model: 'other' },
    { reasoning: { effort: 'high' } },
    { 'synthetic-secret@example.invalid': 'synthetic-value' },
  ]) {
    assert.throws(
      () =>
        adapter.prepare({
          body: encode({ ...base, ...patch }),
          headers: emptyHeaders(),
          credential: credential(),
        }),
      (error) => {
        assert.equal(error.code, 'ADAPTER_REQUEST_REJECTED')
        assert.doesNotMatch(
          JSON.stringify(error),
          /synthetic-value|synthetic-secret|must never send/,
        )
        assert.ok(error.policy?.path.length <= 64)
        return true
      },
    )
  }
  assert.equal(calls, 0)
})

test('credential validation and expiry run for every preparation and probe', () => {
  const adapter = createCodexAdapter({ model: base.model })
  const expired = credential(Math.floor(Date.now() / 1000) - 1)
  for (const [value, code] of [
    [expired, 'AUTH_EXPIRED'],
    [{ secret: 'synthetic-private-token' }, 'ADAPTER_CREDENTIAL_INVALID'],
  ]) {
    for (const run of [
      () => adapter.prepare({ body: encode(base), headers: emptyHeaders(), credential: value }),
      () => adapter.probe({ credential: value }),
    ])
      assert.throws(
        run,
        (error) =>
          error.code === code && !JSON.stringify(error).includes('synthetic-private-token'),
      )
  }
  assert.throws(() => createCodexAdapter({ model: '../unsafe' }), {
    code: 'ADAPTER_REQUEST_REJECTED',
  })
})

test('real incremental meter retains terminal usage when the transport closes later', () => {
  const prepared = createCodexAdapter({ model: base.model }).prepare({
    body: encode(base),
    headers: emptyHeaders(),
    credential: credential(),
  })
  const stream = Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
  )
  for (const byte of stream) prepared.meter.push(new Uint8Array([byte]))
  const result = prepared.meter.end()
  assert.deepEqual(result, {
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    outcome: 'completed',
    signal: null,
    usageIssue: null,
    deltaTextBytes: 2,
  })
  assert.deepEqual(prepared.meter.end(), result)
})

test('real B7 probe sends only a bounded content-free GET through the supplied agent', async () => {
  const { request, calls } = fakeRequest()
  const adapter = createCodexAdapter({ model: base.model, request })
  const source = credential()
  const prepared = adapter.prepare({
    body: encode(base),
    headers: emptyHeaders(),
    credential: source,
  })
  const agent = { syntheticAgent: true }
  const result = await adapter.probe({ credential: source, agent })
  assert.deepEqual(result, {
    status: 'ok',
    plan: 'plus',
    creditsBalance: '0',
    windows: [{ name: '5h', usedPct: 1, resetsAt: new Date(probeReset * 1000) }],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].body, undefined)
  assert.equal(calls[0].options.agent, agent)
  assert.equal(calls[0].options.headers.authorization, `Bearer ${source.accessToken}`)
  assert.equal(
    calls[0].options.headers['x-codex-installation-id'],
    prepared.headers.get('x-codex-installation-id'),
  )
  assert.ok(calls[0].options.signal)
})

for (const [label, settings] of [
  ['redirect', { status: 302, headers: { location: 'https://auth.openai.com/oauth/token' } }],
  ['oversized declared body', { headers: { 'content-length': '65537' } }],
  [
    'oversized streamed body',
    { chunks: [Buffer.alloc(32_768), Buffer.alloc(32_768), Buffer.from('!')] },
  ],
  ['unexpected compression', { headers: { 'content-encoding': 'gzip' } }],
  ['transport failure', { error: true }],
  ['aborted response', { abort: true }],
])
  test(`probe rejects ${label} without retries or exposed transport text`, async () => {
    const { request, calls } = fakeRequest(settings)
    // No answer about the account is a failed probe, never an `unknown` capacity result.
    await assert.rejects(
      createCodexAdapter({ model: base.model, request }).probe({ credential: credential() }),
      (error) => error.code === 'USAGE_PROBE_FAILED' && error.message === 'USAGE_PROBE_FAILED',
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].requestDestroyed, true)
  })

test('probe authentication failures do not refresh, log in, or revoke credentials', async () => {
  const { request, calls } = fakeRequest({
    status: 401,
    body: encode({ error: { code: 'invalid_token' } }),
  })
  const result = await createCodexAdapter({ model: base.model, request }).probe({
    credential: credential(),
  })
  assert.equal(result.status, 'auth')
  assert.equal(calls.length, 1)
  assert.ok(calls.every((call) => call.url.endsWith('/wham/usage')))
})

test('the B7 deadline aborts an unfinished probe body and closes transport resources', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { request, calls } = fakeRequest({ stall: true })
  const pending = createCodexAdapter({ model: base.model, request }).probe({
    credential: credential(),
  })
  // controlRequest defers transport creation by one microtask; the fake supplies headers next.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  t.mock.timers.tick(20_000)
  await assert.rejects(pending, (error) => error.code === 'USAGE_PROBE_FAILED')
  assert.equal(calls[0].options.signal.aborted, true)
  assert.equal(calls[0].requestDestroyed, true)
  assert.equal(calls[0].responseDestroyed, true)
})

test('classify and window parsing exercise the real B7 implementations', () => {
  const adapter = createCodexAdapter({ model: base.model })
  assert.deepEqual(
    adapter.classify(403, emptyHeaders(), {
      error: { code: 'unsupported_country_region_territory' },
    }),
    { kind: 'region' },
  )
  assert.deepEqual(
    adapter.windowsFromHeaders(
      new Headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
      }),
    ),
    { windows: [{ name: '5h', usedPct: 100, resetsAt: null }], creditsBalance: null },
  )
})
