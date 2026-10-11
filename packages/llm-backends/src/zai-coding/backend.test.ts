import {
  DomainError,
  llmEgressOriginSchema,
  probeResultSchema,
  type EgressHttp,
  type LlmBackend,
} from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { llmBackends } from '../index.ts'
import { encodeJson } from '../shared.ts'
import {
  createZaiBackend,
  opencodeUserAgent,
  zaiCodingBackend as backend,
  zaiCodingPlan,
  zaiCredentialSchema,
} from './backend.ts'
import { envelopeSamples, errorSamples, quotaSamples, sample } from './fixtures/samples.ts'

const route = { method: 'POST', path: '/zai/v4/chat/completions' } as const
const credential = { v: '1', kind: 'zai_api_key', apiKey: 'synthetic-zai-plan-key' }
const quotaUrl = 'https://api.z.ai/api/monitor/usage/quota/limit'
const chatUrl = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const body = { body: encodeJson({}), estInputTokens: 1 }
const cliHeaders = () => new Headers({ 'user-agent': opencodeUserAgent })
function answering(status: number, payload: unknown, headers = new Headers()) {
  const request = vi.fn<EgressHttp['request']>().mockResolvedValue({
    status,
    headers,
    body: typeof payload === 'string' ? new TextEncoder().encode(payload) : encodeJson(payload),
  })
  return { request }
}
const probe = (status: number, payload: unknown) =>
  backend.probe(credential, answering(status, payload))
const unknown = { status: 'unknown', windows: null, plan: null }
const limit = (patch: Record<string, unknown> = {}) => ({
  type: 'CREDIT_LIMIT',
  unit: 3,
  number: 5,
  usage: 2000,
  currentValue: 20,
  remaining: 1979,
  percentage: 1,
  nextResetTime: Date.now() + 3_600_000,
  ...patch,
})
const week = (patch: Record<string, unknown> = {}) =>
  limit({
    unit: 6,
    number: 1,
    usage: 10_000,
    remaining: 9979,
    nextResetTime: Date.now() + 5 * 86_400_000,
    ...patch,
  })
const quota = (limits: unknown) => ({
  code: 200,
  msg: 'Operation successful',
  data: { limits, level: 'lite' },
  success: true,
})
const windowsOf = async (limits: unknown) => (await probe(200, quota(limits))).windows

describe('the zai-coding backend as the platform sees it', () => {
  it('is the one backend the platform registers', () => {
    expect(llmBackends).toEqual([backend])
  })

  it('serves one gateway route and declares every request it sends', () => {
    expect(backend.id).toBe('zai-coding')
    expect(backend.routes).toEqual([route])
    expect(backend.egress).toEqual([
      {
        origin: 'https://api.z.ai',
        overrideEnv: 'LLM_BACKEND_URL_ZAI_CODING',
        requests: [`POST ${chatUrl}`, `GET ${quotaUrl}`],
        // The owner's decision of 05.10.2026: Z.ai needs no egress node.
        direct: true,
      },
    ])
    for (const entry of backend.egress)
      expect(llmEgressOriginSchema.safeParse(entry).success).toBe(true)
  })

  it('reads one client header and returns no provider header', () => {
    expect(backend.clientHeaders).toEqual(['user-agent'])
    expect(backend.responseHeaders).toEqual([])
  })

  it('admits only the pinned CLI', () => {
    expect(opencodeUserAgent).toBe(
      'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    )
    expect(() => backend.validateClientHeaders(cliHeaders())).not.toThrow()
    for (const agent of [
      '',
      'opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      'opencode/1.18.34',
      `${opencodeUserAgent} extra`,
      `x ${opencodeUserAgent}`,
      opencodeUserAgent.toUpperCase(),
      'another-cli/2.1.1',
      'curl/8.0',
    ])
      expect(() => backend.validateClientHeaders(new Headers({ 'user-agent': agent }))).toThrow(
        DomainError,
      )
    expect(() => backend.validateClientHeaders(new Headers())).toThrow(DomainError)
  })
})

describe('Z.ai credential and the request to the provider', () => {
  it('keeps the plan key in a versioned shape and knows nothing else about the account', () => {
    expect(backend.importCredential!('synthetic-zai-plan-key')).toEqual(credential)
    expect(backend.credentialSchema.parse(credential)).toEqual(credential)
    expect(backend.credentialMetadata(credential)).toEqual({
      externalAccountId: null,
      plan: null,
      accessExpiresAt: null,
      accessIssuedAt: null,
    })
    for (const secret of ['', 'two words', 'line\nbreak', 'ключ', 'x'.repeat(8193)])
      expect(() => backend.importCredential!(secret)).toThrow(DomainError)
    for (const value of [
      { ...credential, v: '2' },
      { ...credential, kind: 'another_api_key' },
      { ...credential, extra: 1 },
      { v: '1', kind: 'zai_api_key' },
    ]) {
      expect(zaiCredentialSchema.safeParse(value).success).toBe(false)
      expect(() => backend.credentialMetadata(value)).toThrow(DomainError)
    }
  })

  it('never quotes the key in a refused import', () => {
    let caught: unknown
    try {
      backend.importCredential!('SECRET with space')
    } catch (error) {
      caught = error
    }
    expect(
      JSON.stringify([(caught as DomainError).message, (caught as DomainError).details]),
    ).not.toContain('SECRET')
  })

  it('sends the plan key and four fixed headers to the one chat address, and nothing of the client', () => {
    const client = new Headers({
      'user-agent': opencodeUserAgent,
      authorization: 'Bearer sk-rdt-turn-key-of-the-sandbox',
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'content-type': 'application/json',
      'x-opencode-session-id': 'ses_1',
      'x-session-affinity': 'ses_1',
      'x-session-id': 'ses_1',
      cookie: 'acw_tc=1',
    })
    const target = backend.upstream(route, body, client, credential)
    expect(target.url).toBe(chatUrl)
    expect(target.method).toBe('POST')
    expect(Object.fromEntries(target.headers)).toEqual({
      authorization: 'Bearer synthetic-zai-plan-key',
      'user-agent': opencodeUserAgent,
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'content-type': 'application/json',
    })
  })

  it('builds no request for another route, another client or a broken credential', () => {
    expect(() =>
      backend.upstream(
        { method: 'POST', path: '/other/v1/chat/completions' },
        body,
        cliHeaders(),
        credential,
      ),
    ).toThrow(DomainError)
    expect(() =>
      backend.upstream(route, body, new Headers({ 'user-agent': 'curl/8.0' }), credential),
    ).toThrow(DomainError)
    expect(() => backend.upstream(route, body, cliHeaders(), { ...credential, v: '2' })).toThrow(
      DomainError,
    )
  })
})

describe('the quota of the plan as the windows of the pool', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const at = (name: string) => {
    // Each record is read at the moment it was made: a reset in the past means something else.
    const recorded = (sample(name) as unknown as { at?: string }).at
    vi.setSystemTime(new Date(recorded ?? '2026-10-04T18:30:00Z'))
    return sample(name)
  }
  const fiveHourReset = new Date(1791154059203)
  const weekReset = new Date(1791740593998)

  it.each([
    // usedPct = max(currentValue, usage − remaining) / usage: one credit above currentValue.
    ['46-quota-limit-raw.json', 21 / 20, 21 / 100],
    ['46-quota-limit-bearer.json', 21 / 20, 21 / 100],
    ['46-quota-limit-after-27.json', 24 / 20, 24 / 100],
    ['46-quota-limit-recheck.json', 24 / 20, 24 / 100],
    ['46-quota-limit-after-29.json', 25 / 20, 25 / 100],
    ['46-quota-limit-final.json', 26 / 20, 26 / 100],
  ])('reads the active window of %s', async (name, fiveHour, weekly) => {
    const record = at(name)
    const result = await probe(record.response.status, record.response.body)
    expect(result).toEqual({
      status: 'ok',
      plan: null,
      windows: [
        { name: '5h', usedPct: fiveHour, resetsAt: fiveHourReset },
        { name: 'week', usedPct: weekly, resetsAt: weekReset },
      ],
    })
    expect(probeResultSchema.safeParse(result).success).toBe(true)
  })

  it('reads a window nobody has started as known and free, not as unknown', async () => {
    const record = at('60-quota-idle-before.json')
    expect(await probe(record.response.status, record.response.body)).toEqual({
      status: 'ok',
      plan: null,
      windows: [
        { name: '5h', usedPct: 0, resetsAt: null },
        { name: 'week', usedPct: 26 / 100, resetsAt: weekReset },
      ],
    })
  })

  it('reads the window the first request has just started', async () => {
    const record = at('62-quota-idle-after.json')
    expect((await probe(record.response.status, record.response.body)).windows).toEqual([
      // currentValue is still 0, remaining already 1999.
      { name: '5h', usedPct: 1 / 20, resetsAt: new Date(1791198895596) },
      { name: 'week', usedPct: 26 / 100, resetsAt: weekReset },
    ])
  })

  it('covers the eight recorded answers', () => {
    expect(quotaSamples).toHaveLength(8)
  })

  it('reads an exhausted window as full, whichever of the three numbers says so', async () => {
    const reset = Date.now() + 3_600_000
    for (const patch of [
      { currentValue: 2000, remaining: 0 },
      { currentValue: 2100, remaining: -100 },
      { currentValue: 1990, remaining: 0 },
      { currentValue: 2000, remaining: 5 },
      { currentValue: 0, remaining: -1 },
    ])
      expect(await windowsOf([limit({ ...patch, nextResetTime: reset })])).toEqual([
        { name: '5h', usedPct: 100, resetsAt: new Date(reset) },
      ])
  })

  it('takes the larger of the two counts and needs no equality between the three numbers', async () => {
    const reset = Date.now() + 60_000
    expect(
      await windowsOf([limit({ currentValue: 500, remaining: 1900, nextResetTime: reset })]),
    ).toEqual([{ name: '5h', usedPct: 25, resetsAt: new Date(reset) }])
    expect(
      await windowsOf([limit({ currentValue: 0, remaining: 1000, nextResetTime: reset })]),
    ).toEqual([{ name: '5h', usedPct: 50, resetsAt: new Date(reset) }])
    // `percentage` is rounded up by the provider and is not read.
    expect(
      await windowsOf([
        limit({ currentValue: 1, remaining: 1999, percentage: 99, nextResetTime: reset }),
      ]),
    ).toEqual([{ name: '5h', usedPct: 0.05, resetsAt: new Date(reset) }])
  })

  it('takes a window whose reset has passed for one that waits for its next request', async () => {
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'))
    // The window of the records ended at 22:47 UTC the evening before.
    expect(
      await windowsOf([limit({ currentValue: 1900, remaining: 99, nextResetTime: 1791154059203 })]),
    ).toEqual([{ name: '5h', usedPct: 0, resetsAt: null }])
  })

  it('reports only the windows the plan has', async () => {
    expect(await windowsOf([week()])).toEqual([
      { name: 'week', usedPct: 0.21, resetsAt: expect.any(Date) as Date },
    ])
  })

  it.each([
    ['no limits', []],
    ['limits that are no list', { unit: 3 }],
    ['a pair of unit and number nobody has seen', [limit({ unit: 5, number: 1 })]],
    ['an hour window of another length', [limit({ number: 4 })]],
    ['a limit of another type', [limit({ type: 'TIME_LIMIT' })]],
    ['a known window next to an unknown one', [limit(), limit({ unit: 5, number: 1 })]],
    ['the same window twice', [limit(), limit()]],
    ['a limit that is no object', [limit(), 'x']],
    ['no size of the window', [limit({ usage: undefined })]],
    ['a window of size zero', [limit({ usage: 0 })]],
    ['a negative size', [limit({ usage: -2000 })]],
    ['numbers as strings', [limit({ usage: '2000', currentValue: '20', remaining: '1979' })]],
    ['no spend counter', [limit({ currentValue: undefined })]],
    ['a negative spend', [limit({ currentValue: -1 })]],
    ['no remainder', [limit({ remaining: undefined })]],
    ['a remainder that is no number', [limit({ remaining: null })]],
    ['a fractional reset time', [limit({ nextResetTime: 1791154059203.5 })]],
    ['a reset time as text', [limit({ nextResetTime: '2026-10-05T00:00:00Z' })]],
    ['a reset time of zero', [limit({ nextResetTime: 0 })]],
    // Seconds read as milliseconds would look like a window that ended long ago.
    ['a reset in seconds', [limit({ nextResetTime: Math.floor(Date.now() / 1000) + 3600 })]],
    [
      'a reset further ahead than the window is long',
      [limit({ nextResetTime: Date.now() + 7 * 3_600_000 })],
    ],
    ['a weekly reset a month ahead', [week({ nextResetTime: Date.now() + 30 * 86_400_000 })]],
    ['a spent window without a reset time', [limit({ nextResetTime: undefined })]],
    [
      'a started window without a reset time',
      [limit({ currentValue: 0, remaining: 1999, nextResetTime: undefined })],
    ],
    ['a null reset time of a spent window', [limit({ nextResetTime: null })]],
  ])('answers unknown for %s, never spare capacity', async (_name, limits) => {
    expect(await probe(200, quota(limits))).toEqual(unknown)
  })

  it.each([
    ['an envelope without data', { code: 200, msg: 'ok', success: true }],
    ['data that is no object', { code: 200, msg: 'ok', success: true, data: [] }],
    ['success without the code', { success: true, data: { limits: [limit()] } }],
    ['a body that is no JSON', '<html>'],
    ['an empty body', ''],
    ['a list', [1]],
  ])('answers unknown for %s', async (_name, payload) => {
    expect(await probe(200, payload)).toEqual(unknown)
  })

  it('reads the HTTP 200 envelope of a refused key as the key itself', async () => {
    const record = sample(envelopeSamples.invalidKey)
    expect(record.response.status).toBe(200)
    expect(await probe(200, record.response.body)).toEqual({ ...unknown, status: 'auth' })
    expect(await probe(401, sample(errorSamples.invalidKey).response.body)).toEqual({
      ...unknown,
      status: 'auth',
    })
    expect(await probe(401, '')).toEqual({ ...unknown, status: 'auth' })
  })

  it('reads the codes of a lost plan as a suspended account', async () => {
    for (const code of [1113, 1309, 1313]) {
      expect(await probe(200, { code, msg: 'x', success: false })).toEqual({
        ...unknown,
        status: 'suspended',
      })
      expect(await probe(429, { error: { code: String(code), message: 'x' } })).toEqual({
        ...unknown,
        status: 'suspended',
      })
    }
  })

  it('drops the known windows when the provider says the limit is reached without naming one', async () => {
    expect(await probe(429, { error: { code: '1308', message: 'x' } })).toEqual(unknown)
    expect(await probe(200, { code: 1310, msg: 'x', success: false })).toEqual(unknown)
  })

  it('reads a 403 that is no provider error as the channel', async () => {
    expect(await probe(403, '<html>blocked</html>')).toEqual({ ...unknown, status: 'region' })
    await expect(probe(403, { error: { code: '9999', message: 'x' } })).rejects.toBeInstanceOf(
      DomainError,
    )
  })

  it.each([
    // The monitor path answered «no key» to a request that carried one, and «not found».
    [200, sample(envelopeSamples.noKey).response.body],
    [200, sample(envelopeSamples.unknownPath).response.body],
    [200, { code: 1305, msg: 'x', success: false }],
    [200, { code: 200, msg: 'x', success: false }],
    [500, { error: { code: '500', message: 'x' } }],
    [502, ''],
    [429, { error: { code: '1305', message: 'x' } }],
    [404, ''],
    [302, ''],
  ])('rejects when %s %j says nothing about the account', async (status, payload) => {
    await expect(probe(status, payload)).rejects.toBeInstanceOf(DomainError)
  })

  it('asks the one quota address with the key and names nobody but the pinned CLI', async () => {
    const http = answering(200, quota([limit(), week()]))
    await backend.probe(credential, http)
    expect(http.request).toHaveBeenCalledOnce()
    const [request, options] = http.request.mock.calls[0]!
    expect(request.url).toBe(quotaUrl)
    expect(request.method).toBe('GET')
    expect(request.body).toBeUndefined()
    expect(Object.fromEntries(request.headers)).toEqual({
      authorization: 'Bearer synthetic-zai-plan-key',
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': opencodeUserAgent,
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not retry a failed request, quote its error or outlive its deadline', async () => {
    const failing = {
      request: vi.fn<EgressHttp['request']>().mockRejectedValue(new Error('SECRET')),
    }
    const error = await backend.probe(credential, failing).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as Error).message).not.toContain('SECRET')
    expect(failing.request).toHaveBeenCalledOnce()
    await expect(
      backend.probe(credential, answering(200, 'x'.repeat(64 * 1024 + 1))),
    ).rejects.toBeInstanceOf(DomainError)
    await expect(backend.probe({ ...credential, v: '2' }, failing)).rejects.toBeInstanceOf(
      DomainError,
    )
  })
})

describe('a Z.ai offer is data', () => {
  // The pay-per-token API of the same provider speaks the same protocol on another path and has
  // no plan windows (owner's question П15). It is not offered; the shape must allow it.
  const offer = {
    ...zaiCodingPlan,
    route: { method: 'POST', path: '/zai-paygo/v4/chat/completions' },
    chatPath: '/api/paas/v4/chat/completions',
    quota: {
      path: '/api/monitor/usage/quota/other',
      windows: [{ unit: 9, number: 2, name: 'month' }],
    },
    overrideEnv: 'LLM_BACKEND_URL_ZAI_PAYGO',
    direct: false,
  } as const
  const other: LlmBackend = createZaiBackend(offer)

  it('describes the plan in use', () => {
    expect(zaiCodingPlan).toEqual({
      id: 'zai-coding',
      route,
      origin: 'https://api.z.ai',
      chatPath: '/api/coding/paas/v4/chat/completions',
      quota: {
        path: '/api/monitor/usage/quota/limit',
        windows: [
          { unit: 3, number: 5, name: '5h' },
          { unit: 6, number: 1, name: 'week' },
        ],
      },
      overrideEnv: 'LLM_BACKEND_URL_ZAI_CODING',
      direct: true,
    })
    expect(Object.isFrozen(zaiCodingPlan)).toBe(true)
  })

  it('takes the route, both addresses and the windows from the description alone', async () => {
    expect(other.routes).toEqual([offer.route])
    // The description said the egress node is needed: the declaration opens no direct way.
    expect(other.egress).toEqual([
      {
        origin: 'https://api.z.ai',
        overrideEnv: 'LLM_BACKEND_URL_ZAI_PAYGO',
        requests: [
          'POST https://api.z.ai/api/paas/v4/chat/completions',
          'GET https://api.z.ai/api/monitor/usage/quota/other',
        ],
      },
    ])
    expect(llmEgressOriginSchema.safeParse(other.egress[0]).success).toBe(true)
    expect(other.upstream(offer.route, body, cliHeaders(), credential).url).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions',
    )
    expect(() => other.upstream(route, body, cliHeaders(), credential)).toThrow(DomainError)
    const http = answering(
      200,
      quota([limit({ unit: 9, number: 2, nextResetTime: Date.now() + 86_400_000 })]),
    )
    expect((await other.probe(credential, http)).windows).toEqual([
      { name: 'month', usedPct: 1.05, resetsAt: expect.any(Date) as Date },
    ])
    expect(http.request.mock.calls[0]![0].url).toBe(
      'https://api.z.ai/api/monitor/usage/quota/other',
    )
    // The plan in use does not know that pair.
    expect(await probe(200, quota([limit({ unit: 9, number: 2 })]))).toEqual(unknown)
  })

  it('normalizes a body for its own route only', () => {
    const request = encodeJson({ model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }] })
    const profile = { model: 'glm-5.3', reasoningEffort: 'low' }
    expect(() => other.normalizeBody(offer.route, request, profile)).not.toThrow()
    expect(() => other.normalizeBody(route, request, profile)).toThrow(DomainError)
    expect(() => backend.normalizeBody(offer.route, request, profile)).toThrow(DomainError)
  })
})
