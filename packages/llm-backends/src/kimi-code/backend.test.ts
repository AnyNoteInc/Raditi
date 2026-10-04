import {
  DomainError,
  llmEgressOriginSchema,
  probeResultSchema,
  type EgressHttp,
  type EgressRequest,
  type LlmRoute,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'
import { encodeJson } from '../shared.ts'
import { kimiCodeBackend as backend, kimiCredentialSchema } from './backend.ts'

const route = { method: 'POST', path: '/kimi/v1/chat/completions' } as const
const ctx = { model: 'k3-256k', reasoningEffort: 'high', cacheKey: `rdt_${'a'.repeat(32)}` }
const credential = { v: '1', kind: 'kimi_api_key', apiKey: 'synthetic-api-key' }
// A container hostname, the value the CLI itself sends: no operator name in provider headers.
const identity = { deviceId: 'account-device', deviceName: '5e1f0c3a9b2d' }
const minimal = () => ({
  model: ctx.model,
  messages: [{ role: 'user', content: 'Synthetic prompt' }],
})
const normalize = (body: unknown, profile = ctx) =>
  backend.normalizeBody(route, encodeJson(body), profile)
const decode = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))
const clientHeaders = () => new Headers({ 'user-agent': 'kimi-code-cli/2.1.1' })
const quota = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-09-30T20:00:00Z' },
    limit_7d: { used_ratio: '0.75', reset_time: '2026-10-03T20:00:00Z' },
  },
}
const quota5hMessage =
  "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"
const profileMessage =
  'Your current subscription does not have access to k3.  Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: https://www.kimi.com/code?from=server_highspeed_error#pricing'
const riskMessage =
  "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again."
const contentMessage = 'The request was rejected because it was considered high risk'
function responseHttp(body: unknown, status = 200) {
  const request = vi
    .fn<EgressHttp['request']>()
    .mockResolvedValue({ status, headers: new Headers(), body: encodeJson(body) })
  return { request }
}

describe('Kimi request policy', () => {
  it('normalizes an actual CLI-shaped request idempotently with a bounded reasoning profile', () => {
    const body = {
      ...minimal(),
      stream: false,
      stream_options: { include_usage: false },
      prompt_cache_key: 'client-cache',
      messages: [
        {
          role: 'system',
          content: 'Synthetic instruction',
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read',
                parameters: { type: 'object', properties: { file: { type: 'string' } } },
              },
            },
          ],
        },
        {
          role: 'assistant',
          reasoning_content: 'Synthetic thought',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"file":"fixture"}' },
              extras: { signature: 'opaque' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'text', text: 'Synthetic result' }],
        },
      ],
    }
    const normalized = normalize(body)
    expect(decode(normalized.body)).toEqual({
      ...body,
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: ctx.cacheKey,
      thinking: { type: 'enabled', effort: 'high' },
    })
    expect(backend.normalizeBody(route, normalized.body, ctx)).toEqual(normalized)
  })

  it.each(['low', 'high'])('permits effort %s below the key ceiling', (effort) => {
    expect(
      decode(normalize({ ...minimal(), thinking: { type: 'enabled', effort, keep: 'all' } }).body),
    ).toMatchObject({ thinking: { type: 'enabled', effort, keep: 'all' } })
  })

  it('preserves disabled thinking and provider defaults when the profile has no explicit effort', () => {
    expect(decode(normalize({ ...minimal(), thinking: { type: 'disabled' } }).body)).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(
      decode(
        backend.normalizeBody(route, encodeJson(minimal()), { ...ctx, reasoningEffort: null }).body,
      ),
    ).not.toHaveProperty('thinking')
    expect(
      decode(
        backend.normalizeBody(route, encodeJson({ ...minimal(), thinking: { keep: 'all' } }), {
          ...ctx,
          reasoningEffort: null,
        }).body,
      ),
    ).toMatchObject({ thinking: { keep: 'all' } })
    expect(
      decode(
        backend.normalizeBody(route, encodeJson({ ...minimal(), thinking: { type: 'disabled' } }), {
          ...ctx,
          reasoningEffort: null,
        }).body,
      ),
    ).toMatchObject({ thinking: { type: 'disabled' } })
    expect(() =>
      backend.normalizeBody(route, encodeJson({ ...minimal(), thinking: { type: 'enabled' } }), {
        ...ctx,
        reasoningEffort: null,
      }),
    ).toThrow(DomainError)
    expect(() =>
      backend.normalizeBody(route, encodeJson({ ...minimal(), thinking: { effort: 'low' } }), {
        ...ctx,
        reasoningEffort: null,
      }),
    ).toThrow(DomainError)
  })

  it.each([
    { thinking: { effort: 'max' } },
    { thinking: { type: 'enabled', effort: 'medium' } },
    { thinking: { type: 'disabled', effort: 'low' } },
    { thinking: { unknown: true } },
    { model: 'k3' },
    { model: 'kimi-for-coding-highspeed' },
    { max_tokens: 65_537 },
    { max_completion_tokens: 65_537 },
    { max_tokens: 0 },
    { max_tokens: 1.5 },
    { max_completion_tokens: -1 },
    { temperature: 0 },
    { tool_choice: 'auto' },
    { user: 'cross-tenant' },
    { stream_options: { unknown: true } },
    { tools: [{ type: 'builtin_function', function: { name: '$web_search' } }] },
    { tools: [{ type: 'function', function: { name: '$web_search' } }] },
    { messages: [{ role: 'developer', content: 'no' }] },
    { messages: [{ role: 'user', content: 'x', reasoning_content: 'no' }] },
    { messages: [{ role: 'user', content: 'x', secret: 'private' }] },
    {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'a', type: 'builtin_function', function: { name: 'read', arguments: '{}' } },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: 'system',
          content: 'x',
          tools: [{ type: 'builtin_function', function: { name: '$fetch' } }],
        },
      ],
    },
  ])('rejects unknown/expensive request fields: %j', (extra) => {
    expect(() => normalize({ ...minimal(), ...extra })).toThrow(DomainError)
  })

  it('accepts the explicit output ceiling and never inserts one', () => {
    const normal = decode(normalize(minimal()).body)
    expect(normal).not.toHaveProperty('max_tokens')
    expect(normal).not.toHaveProperty('max_completion_tokens')
    expect(
      decode(normalize({ ...minimal(), max_tokens: 65_536, max_completion_tokens: 65_536 }).body),
    ).toMatchObject({ max_tokens: 65_536, max_completion_tokens: 65_536 })
  })

  it('counts accepted images as 2000 tokens without counting their base64 bytes', () => {
    const imageBody = (url: string) => ({
      ...minimal(),
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
    })
    const small = normalize(imageBody('data:image/png;base64,YQ=='))
    const big = normalize(imageBody(`data:image/png;base64,${'YWFh'.repeat(1024)}`))
    expect(big.estInputTokens).toBe(small.estInputTokens)
    expect(small.estInputTokens).toBeGreaterThan(2000)
    const text = normalize({
      ...minimal(),
      messages: [{ role: 'user', content: 'data:image/png;base64,YQ==' }],
    })
    expect(text.estInputTokens).toBeLessThan(2000)
  })

  it.each([
    'https://host/image.png',
    'file:///private.png',
    'data:text/plain;base64,YQ==',
    'data:image/svg+xml;base64,YQ==',
    'data:image/png;base64,',
    'data:image/png;base64,!bad!',
  ])('rejects unapproved image %s', (url) => {
    expect(() =>
      normalize({
        ...minimal(),
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
      }),
    ).toThrow(DomainError)
  })

  it.each(['YQ', 'YQ=', 'Y===', '====', 'YQ==YQ==', 'YW=h', 'YQ== ', 'YW-_'])(
    'rejects non-canonical base64 image body %j',
    (body) => {
      expect(() =>
        normalize({
          ...minimal(),
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${body}` } }],
            },
          ],
        }),
      ).toThrow(DomainError)
    },
  )

  it('accepts an image just under the message limit and refuses a 12 MiB one by size, not by stack overflow', () => {
    const imageBody = (base64Length: number) => ({
      ...minimal(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${'iVBORw0K'.repeat(base64Length / 8)}` },
            },
          ],
        },
      ],
    })
    expect(normalize(imageBody(2 * 1024 * 1024 - 1024)).estInputTokens).toBeGreaterThan(2000)
    let thrown: unknown
    try {
      normalize(imageBody(12 * 1024 * 1024))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DomainError)
    expect((thrown as Error).message).toBe('Kimi messages exceed the size limit')
  })

  it('enforces the provider message byte limit on UTF-8 and rejects malformed bodies without leaking contents', () => {
    expect(() =>
      normalize({ ...minimal(), messages: [{ role: 'user', content: 'я'.repeat(1024 * 1024) }] }),
    ).toThrow(DomainError)
    for (const invalid of [
      '{"secret-leak":',
      '{"__proto__":{"secret":"secret-leak"}}',
      '["secret-leak"]',
    ]) {
      try {
        backend.normalizeBody(route, new TextEncoder().encode(invalid), ctx)
        expect.fail('accepted malformed JSON')
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError)
        expect(String(error)).not.toContain('secret-leak')
      }
    }
    expect(() => backend.normalizeBody(route, Uint8Array.of(0xff), ctx)).toThrow(DomainError)
  })

  it('rejects every route other than the sole configured POST', () => {
    for (const other of [
      { method: 'GET', path: route.path },
      { method: 'POST', path: '/kimi/v1/search' },
      { method: 'POST', path: '/kimi/v1/chat/completions?url=other' },
    ] as LlmRoute[]) {
      expect(() => backend.normalizeBody(other, encodeJson(minimal()), ctx)).toThrow(DomainError)
      expect(() =>
        backend.upstream(other, normalize(minimal()), clientHeaders(), credential, identity),
      ).toThrow(DomainError)
    }
  })
})

describe('Kimi credentials and upstream identity', () => {
  it('accepts only the versioned API key and exposes no guessed identity or expiry', () => {
    expect(kimiCredentialSchema.parse(credential)).toEqual(credential)
    expect(backend.credentialMetadata(credential)).toEqual({
      externalAccountId: null,
      plan: null,
      accessExpiresAt: null,
      accessIssuedAt: null,
    })
    expect(backend).not.toHaveProperty('refresh')
    expect(backend).not.toHaveProperty('login')
    expect(backend).not.toHaveProperty('revoke')
  })
  it.each([
    { ...credential, apiKey: '' },
    { ...credential, apiKey: 'line\nbreak' },
    { ...credential, apiKey: ' leading-space' },
    { ...credential, apiKey: 'x'.repeat(8193) },
    { ...credential, v: 1 },
    { ...credential, v: '2' },
    { ...credential, kind: 'kimi_oauth' },
    { ...credential, unknown: true },
  ])('rejects invalid credentials without echoing secrets', (invalid) => {
    expect(kimiCredentialSchema.safeParse(invalid).success).toBe(false)
    expect(() => backend.credentialMetadata(invalid)).toThrow('Invalid Kimi credential')
  })
  it('uses fixed URL and replaces account headers while only forwarding allowlisted client headers', () => {
    const headers = clientHeaders()
    for (const [key, value] of Object.entries({
      authorization: 'Bearer sandbox-key',
      cookie: 'secret',
      host: 'attacker.invalid',
      'x-msh-device-id': 'sandbox-device',
      'x-msh-device-name': 'sandbox-host',
      'x-msh-platform': 'kimi_code_cli',
      'x-msh-version': '2.1.1',
      'x-msh-extra': 'unknown',
    }))
      headers.set(key, value)
    const request = backend.upstream(route, normalize(minimal()), headers, credential, identity)
    expect(request.url).toBe('https://api.kimi.ai/coding/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(Object.fromEntries(request.headers)).toEqual({
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      authorization: 'Bearer synthetic-api-key',
      'content-type': 'application/json',
      'user-agent': 'kimi-code-cli/2.1.1',
      'x-msh-device-id': identity.deviceId,
      'x-msh-device-name': identity.deviceName,
      'x-msh-platform': 'kimi_code_cli',
      'x-msh-version': '2.1.1',
    })
    expect(headers.get('authorization')).toBe('Bearer sandbox-key')
  })
  it.each([
    '',
    'other-client',
    'kimi-code-cli/2.2.0',
    'prefix kimi-code-cli/2.1.1',
    'kimi-code-cli/2.1.1 suffix',
  ])('rejects unpinned client %s', (ua) => {
    expect(() =>
      backend.upstream(
        route,
        normalize(minimal()),
        new Headers({ 'user-agent': ua }),
        credential,
        identity,
      ),
    ).toThrow(DomainError)
  })
  it.each([
    {},
    { deviceId: 'x' },
    { ...identity, deviceName: 'bad\r\nheader' },
    { ...identity, deviceId: 'x'.repeat(257) },
  ])('requires valid account device identity %j', (invalid) => {
    expect(() =>
      backend.upstream(route, normalize(minimal()), clientHeaders(), credential, invalid),
    ).toThrow(DomainError)
  })
  it('never discovers Kimi quota windows from generation headers', () => {
    expect(
      backend.windowsFromHeaders(new Headers({ 'x-limit-5h': '100', 'x-credit-balance': '999' })),
    ).toBeNull()
  })
})

describe('Kimi structural errors and CLI refusals', () => {
  it.each([
    [401, 'Invalid Authentication', { kind: 'auth' }],
    [
      401,
      'The API Key appears to be invalid or may have expired. Please verify your credentials and try again.',
      { kind: 'auth' },
    ],
    [401, profileMessage, { kind: 'profile', code: 'model_access' }],
    [
      401,
      'Your model id does not exist, recognized as other:unknown-model. Please set model id as `k3-256k`.',
      { kind: 'profile', code: 'model_access' },
    ],
    [403, quota5hMessage, { kind: 'window_exhausted', until: null }],
    [403, riskMessage, { kind: 'account_risk', reason: 'concurrent_request_limit' }],
    [400, contentMessage, { kind: 'policy_flagged', code: 'high_risk' }],
    [402, 'membership', { kind: 'transient', retryAfterMs: 300_000 }],
    [429, 'overloaded', { kind: 'transient', retryAfterMs: 30_000 }],
    [503, 'server', { kind: 'transient', retryAfterMs: 30_000 }],
  ])('maps status %i and an exact message', (status, message, expected) => {
    expect(backend.classify(status as number, new Headers(), { error: { message } })).toEqual(
      expected,
    )
  })
  it.each([
    [429, { type: 'exceeded_current_quota_error' }, { kind: 'window_exhausted', until: null }],
    [429, { code: 'exceeded_current_quota_error' }, { kind: 'window_exhausted', until: null }],
    [
      429,
      { type: 'exceeded_current_quota_error', message: 'any wording' },
      { kind: 'window_exhausted', until: null },
    ],
    [429, { type: 'engine_overloaded_error' }, { kind: 'transient', retryAfterMs: 30_000 }],
    [429, { type: 'rate_limit_reached_error' }, { kind: 'transient', retryAfterMs: 30_000 }],
    [429, { message: 'exceeded_current_quota_error' }, { kind: 'transient', retryAfterMs: 30_000 }],
    [503, { type: 'exceeded_current_quota_error' }, { kind: 'transient', retryAfterMs: 30_000 }],
    [403, { type: 'exceeded_current_quota_error' }, { kind: 'unconfirmed_block' }],
  ])('reads the error type of HTTP %i %j as the pinned CLI does', (status, error, expected) => {
    expect(backend.classify(status, new Headers(), { error })).toEqual(expected)
  })
  it('does not match substrings, body text, unrelated fields or lookalike unknown codes', () => {
    for (const value of [
      quota5hMessage,
      `<html>${quota5hMessage}</html>`,
      { message: quota5hMessage },
      { error: { message: `prefix ${quota5hMessage}` } },
      { error: { message: `${quota5hMessage} suffix` } },
      { error: { type: quota5hMessage } },
      { error: { code: 'account_suspended' } },
    ]) {
      expect(backend.classify(403, new Headers(), value)).toEqual({ kind: 'unconfirmed_block' })
    }
    expect(
      backend.classify(401, new Headers(), { error: { message: `prefix ${profileMessage}` } }),
    ).toEqual({ kind: 'unconfirmed_block' })
    expect(backend.classify(200, new Headers(), { error: { message: riskMessage } })).toEqual({
      kind: 'ok',
    })
    expect(
      backend.classify(400, new Headers(), { error: { message: `prefix ${contentMessage}` } }),
    ).toEqual({ kind: 'request_rejected', code: 'upstream_request' })
  })
  it('reads an unrecognized 4xx as a rejection of this request, not of the model profile', () => {
    for (const status of [400, 404, 413, 422])
      expect(backend.classify(status, new Headers(), { error: { message: 'unlisted' } })).toEqual({
        kind: 'request_rejected',
        code: 'upstream_request',
      })
    // A plan that lacks the model stays a profile failure.
    expect(backend.classify(401, new Headers(), { error: { message: profileMessage } })).toEqual({
      kind: 'profile',
      code: 'model_access',
    })
  })
  it.each([
    ['2.5', 2500],
    ['99', 30_000],
    ['-1', 30_000],
    ['not-a-delay', 30_000],
    ['9'.repeat(400), 30_000],
  ])('bounds provider retry delay %s', (header, expected) => {
    expect(backend.classify(429, new Headers({ 'retry-after': header }), null)).toEqual({
      kind: 'transient',
      retryAfterMs: expected,
    })
  })
  it('declares every request it sends, so the egress can refuse all others', async () => {
    expect(backend.egress).toEqual([
      {
        origin: 'https://api.kimi.ai',
        overrideEnv: 'LLM_BACKEND_URL_KIMI_CODE',
        requests: [
          'POST https://api.kimi.ai/coding/v1/chat/completions',
          'GET https://api.kimi.ai/coding/v1/usages',
        ],
      },
    ])
    for (const entry of backend.egress)
      expect(llmEgressOriginSchema.safeParse(entry).success).toBe(true)
    const http = responseHttp(quota)
    await backend.probe(credential, identity, http)
    const generation = backend.upstream(
      route,
      normalize(minimal()),
      clientHeaders(),
      credential,
      identity,
    )
    const probed = http.request.mock.calls[0]![0]
    expect(
      new Set([`${generation.method} ${generation.url}`, `${probed.method} ${probed.url}`]),
    ).toEqual(new Set(backend.egress.flatMap((entry) => entry.requests)))
  })
  it('declares the client headers the gateway may pass for it, and no response header', () => {
    expect(backend.clientHeaders).toEqual(['user-agent', 'x-msh-platform', 'x-msh-version'])
    expect(backend.responseHeaders).toEqual([])
    const client = new Headers({
      'user-agent': 'kimi-code-cli/2.1.1',
      'x-msh-platform': 'kimi_code_cli',
      'x-msh-version': '2.1.1',
      // Not declared: never forwarded, even if a caller hands it over.
      'x-msh-session-id': 'undeclared',
    })
    const sent = backend.upstream(route, normalize(minimal()), client, credential, identity)
    for (const name of backend.clientHeaders) expect(sent.headers.get(name)).toBe(client.get(name))
    expect(sent.headers.has('x-msh-session-id')).toBe(false)
  })
  it.each(['budget', 'subscription_limit', 'account', 'provider_off', 'egress'] as const)(
    'makes %s terminal for the pinned CLI',
    (kind) => {
      const refusal = backend.refusal(kind, 999_999)
      expect(refusal.status).toBe(429)
      expect(refusal.headers.has('retry-after')).toBe(false)
      expect(decode(refusal.body)).toMatchObject({
        error: { type: 'exceeded_current_quota_error', code: `raditi_${kind}` },
      })
    },
  )
  it.each(['policy', 'policy_flagged', 'profile', 'request_rejected'] as const)(
    'makes %s a scrubbed 400',
    (kind) => {
      const refusal = backend.refusal(kind)
      expect(refusal.status).toBe(400)
      expect(decode(refusal.body)).toMatchObject({
        error: { type: 'invalid_request_error', code: `raditi_${kind}` },
      })
    },
  )
  it.each([
    [1, '1'],
    [1500, '2'],
    [999_999, '30'],
    [-1, '0'],
    [Number.NaN, '30'],
  ])('bounds transient retry delay %i', (delay, expected) => {
    const refusal = backend.refusal('transient', delay as number)
    expect(refusal.status).toBe(503)
    expect(refusal.headers.get('retry-after')).toBe(expected)
  })
})

describe('Kimi bounded usage probe', () => {
  const rawHttp = (status: number, text: string, headers = new Headers()) => ({
    request: vi
      .fn<EgressHttp['request']>()
      .mockResolvedValue({ status, headers, body: new TextEncoder().encode(text) }),
  })
  const probeWindows = async (usages: unknown) =>
    (await backend.probe(credential, identity, responseHttp({ usages }))).windows

  it('requests only the fixed control endpoint via the injected egress and parses known quotas', async () => {
    const http = responseHttp(quota)
    const result = await backend.probe(credential, identity, http)
    expect(result).toEqual({
      status: 'ok',
      plan: null,
      creditsBalance: null,
      windows: [
        { name: '5h', usedPct: 25, resetsAt: new Date('2026-09-30T20:00:00Z') },
        { name: 'week', usedPct: 75, resetsAt: new Date('2026-10-03T20:00:00Z') },
      ],
    })
    expect(probeResultSchema.safeParse(result).success).toBe(true)
    expect(http.request).toHaveBeenCalledOnce()
    const [request, options] = http.request.mock.calls[0]!
    expect(request.url).toBe('https://api.kimi.ai/coding/v1/usages')
    expect(request.method).toBe('GET')
    expect(request.body).toBeUndefined()
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-api-key')
    expect(request.headers.get('x-msh-device-id')).toBe(identity.deviceId)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })
  it('presents the pinned CLI identity and never names the operator or a gateway', async () => {
    const http = responseHttp(quota)
    const neutral = { deviceId: '3f2c8a1e-0b7d-4c55-9a1e-2d6f0c9b7e41', deviceName: 'c0ffee15b00c' }
    await backend.probe(credential, neutral, http)
    const headers = http.request.mock.calls[0]![0].headers
    expect(Object.fromEntries(headers)).toEqual({
      accept: 'application/json',
      'accept-encoding': 'identity',
      authorization: 'Bearer synthetic-api-key',
      'user-agent': 'kimi-code-cli/2.1.1',
      'x-msh-device-id': neutral.deviceId,
      'x-msh-device-name': neutral.deviceName,
      'x-msh-platform': 'kimi_code_cli',
      'x-msh-version': '2.1.1',
    })
    // The same client the gateway admits for generation requests of this account.
    expect(() => backend.validateClientHeaders(headers)).not.toThrow()
    for (const [name, value] of headers)
      expect(`${name}: ${value}`).not.toMatch(/raditi|gateway|proxy/i)
  })
  it('reports the most used month quota with its own reset, so an exhausted one is not cooled until the other resets', async () => {
    const total = { used_ratio: 0.2, reset_time: '2026-11-01T00:00:00Z' }
    const code = { used_ratio: 1, reset_time: '2026-10-15T00:00:00Z' }
    expect(await probeWindows({ limit_month_total: total, limit_month_code: code })).toEqual([
      { name: 'month', usedPct: 100, resetsAt: new Date('2026-10-15T00:00:00Z') },
    ])
    expect(
      await probeWindows({
        limit_month_total: { ...total, used_ratio: 0.9 },
        limit_month_code: { ...code, used_ratio: 0.3 },
      }),
    ).toEqual([{ name: 'month', usedPct: 90, resetsAt: new Date('2026-11-01T00:00:00Z') }])
    // Equally used: the later reset, so a pause never ends before both quotas allow it.
    expect(
      await probeWindows({
        limit_month_total: { ...total, used_ratio: 1 },
        limit_month_code: code,
      }),
    ).toEqual([{ name: 'month', usedPct: 100, resetsAt: new Date('2026-11-01T00:00:00Z') }])
    expect(
      await probeWindows({ limit_month_total: total, limit_month_code: { used_ratio: 1 } }),
    ).toEqual([{ name: 'month', usedPct: 100, resetsAt: null }])
    // An unknown reset of the less used quota does not hide the binding one.
    expect(
      await probeWindows({ limit_month_total: { used_ratio: 0.2 }, limit_month_code: code }),
    ).toEqual([{ name: 'month', usedPct: 100, resetsAt: new Date('2026-10-15T00:00:00Z') }])
  })
  it('reads windows a plan does not have as not reported, and a used-up ratio past 1 as exhausted', async () => {
    expect(
      await probeWindows({
        limit_5h: { used_ratio: 0.25, reset_time: '2026-09-30T20:00:00Z' },
        limit_7d: null,
        limit_month_total: { used_ratio: 1.02, reset_time: '' },
        limit_month_code: { used_ratio: '0.5', reset_time: null },
      }),
    ).toEqual([
      { name: '5h', usedPct: 25, resetsAt: new Date('2026-09-30T20:00:00Z') },
      { name: 'month', usedPct: 100, resetsAt: null },
    ])
  })
  it.each([
    ['limit_5h', 6, true],
    ['limit_5h', 6.01, false],
    ['limit_7d', 8 * 24, true],
    ['limit_7d', 8 * 24 + 0.01, false],
    ['limit_month_total', 32 * 24, true],
    ['limit_month_code', 32 * 24 + 0.01, false],
  ] as const)(
    'accepts a %s reset %s hours ahead: %s (a later one cannot belong to the window)',
    async (key, hours, accepted) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
      try {
        const reset_time = new Date(Date.now() + hours * 3_600_000).toISOString()
        const result = await backend.probe(
          credential,
          identity,
          responseHttp({ usages: { [key]: { used_ratio: 1, reset_time } } }),
        )
        expect(result.status).toBe(accepted ? 'ok' : 'unknown')
        if (accepted) expect(result.windows?.[0]?.resetsAt).toEqual(new Date(reset_time))
        else expect(result.windows).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    },
  )
  it('reads a reset in the far future as a broken report, not as years of cooling', async () => {
    const usages = { limit_5h: { used_ratio: 1, reset_time: '2126-01-01T00:00:00Z' } }
    expect(await backend.probe(credential, identity, responseHttp({ usages }))).toEqual({
      status: 'unknown',
      windows: null,
      plan: null,
      creditsBalance: null,
    })
  })
  it.each([
    {},
    [],
    { usages: {} },
    { usages: [] },
    { usages: { limit_5h: null } },
    { usages: { unknown: { used_ratio: 0.5 } } },
    { usages: { limit_5h: { used_ratio: -1 } } },
    { usages: { limit_5h: { used_ratio: 'garbage' } } },
    { usages: { limit_5h: { used_ratio: '' } } },
    { usages: { limit_5h: { used_ratio: '1e3' } } },
    { usages: { limit_5h: {} } },
    { usages: { limit_5h: 0.5 } },
    { usages: { limit_5h: { used_ratio: 0.5, reset_time: 'tomorrow' } } },
    { usages: { limit_5h: { used_ratio: 0.5, reset_time: '2026-02-31T00:00:00Z' } } },
    {
      usages: {
        limit_5h: { used_ratio: 0.1 },
        limit_7d: { used_ratio: 'garbage' },
      },
    },
  ])('does not turn malformed or unrecognized quota into a healthy snapshot %j', async (body) => {
    expect((await backend.probe(credential, identity, responseHttp(body))).status).toBe('unknown')
  })
  it('does not reinterpret monetary booster wallet as credits or trust an unconfirmed plan field', async () => {
    const result = await backend.probe(
      credential,
      identity,
      responseHttp({
        ...quota,
        plan_type: 'unconfirmed',
        boosterWallet: { balance: { amountLeft: 1234, type: 'BOOSTER' } },
      }),
    )
    expect(result.plan).toBeNull()
    expect(result.creditsBalance).toBeNull()
  })
  it.each([
    [401, { error: { message: 'Invalid Authentication' } }, 'auth'],
    [401, { error: { message: 'Key revoked in the console' } }, 'auth'],
    [401, '<html>Unauthorized</html>', 'auth'],
    [403, { error: { message: riskMessage } }, 'suspended'],
    [403, { error: { message: quota5hMessage } }, 'unknown'],
    // The limit is reached, yet the reply names no window: what the pool knew no longer holds.
    [429, { error: { type: 'exceeded_current_quota_error' } }, 'unknown'],
    // A content-free request refused by a page, not a provider error, is the egress.
    [403, '<html>blocked upstream-secret</html>', 'region'],
    [403, '', 'region'],
    [403, { title: 'Error 1009: Access denied', status: 403, error_code: 1009 }, 'region'],
  ])('reports HTTP %i %j without leaking a provider body', async (status, body, expected) => {
    const http = typeof body === 'string' ? rawHttp(status, body) : responseHttp(body, status)
    const result = await backend.probe(credential, identity, http)
    expect(result).toEqual({ status: expected, windows: null, plan: null, creditsBalance: null })
  })
  it.each([
    [401, { error: { message: profileMessage } }],
    [403, { error: { message: 'Unrecognized refusal upstream-secret' } }],
    [403, { error: { type: 'permission_denied_error' } }],
    [400, { error: { message: contentMessage } }],
    [402, { error: { message: 'membership upstream-secret' } }],
    [404, { error: { message: 'Not found' } }],
    [408, null],
    [429, { error: { type: 'engine_overloaded_error' } }],
    [500, null],
    [502, { error: { message: 'upstream-secret' } }],
    [503, null],
    [204, null],
    [302, { error: { message: 'redirect' } }],
  ])('rejects HTTP %i %j as no answer, so the pool keeps what it knew', async (status, body) => {
    const result = backend.probe(credential, identity, responseHttp(body, status as number))
    await expect(result).rejects.toBeInstanceOf(DomainError)
    await expect(result).rejects.not.toThrow(/upstream-secret/)
  })
  it('answers unknown for an unreadable 200 and rejects an oversized one', async () => {
    for (const body of [Uint8Array.of(0xff), new TextEncoder().encode('not-json-secret')]) {
      const http: EgressHttp = {
        request: async () => ({ status: 200, headers: new Headers(), body }),
      }
      expect((await backend.probe(credential, identity, http)).status).toBe('unknown')
    }
    const oversized: EgressHttp = {
      request: async () => ({
        status: 200,
        headers: new Headers(),
        body: new Uint8Array(64 * 1024 + 1),
      }),
    }
    await expect(backend.probe(credential, identity, oversized)).rejects.toBeInstanceOf(DomainError)
  })
  it('does not retry egress errors and rejects without quoting them', async () => {
    const request = vi.fn<EgressHttp['request']>().mockRejectedValue(new Error('secret-token'))
    const result = backend.probe(credential, identity, { request })
    await expect(result).rejects.toBeInstanceOf(DomainError)
    await expect(result).rejects.not.toThrow(/secret-token/)
    expect(request).toHaveBeenCalledOnce()
  })
  it('aborts a stalled probe by its own deadline and rejects', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const request: EgressHttp['request'] = (_request: EgressRequest, options) => {
        signal = options.signal
        return new Promise(() => undefined)
      }
      const result = backend.probe(credential, identity, { request })
      const settled = result.then(
        () => 'resolved',
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(20_000)
      expect(signal?.aborted).toBe(true)
      expect(await settled).toBeInstanceOf(DomainError)
    } finally {
      vi.useRealTimers()
    }
  })
})
