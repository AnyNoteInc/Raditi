import {
  callSignalSchema,
  limitWindowSnapshotSchema,
  probeResultSchema,
  type EgressHttp,
  type EgressResponse,
} from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeJson } from '../shared.ts'
import { syntheticCodexCredential } from './fixtures/auth.ts'
import {
  classifyCodexResponse,
  codexFailureSignal,
  codexRefusal,
  codexWindowsFromHeaders,
  probeCodexAccount,
} from './responses.ts'

const headers = new Headers()
const error = (code: string, extras = {}) => ({ error: { code, ...extras } })
const response = (status = 200, body: unknown = {}): EgressResponse => ({
  status,
  headers: new Headers(),
  body: encodeJson(body),
})
const identity = { installationId: 'synthetic-installation' }
const unknownCapacity = (creditsBalance: string | null) => ({ windows: [], creditsBalance })
const validProbe = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12.5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 36, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
  },
  credits: { has_credits: true, unlimited: false, balance: '17.000001' },
}

// One hour before the 5h reset of the fixtures (1 800 000 000 s); their week ends 5.8 days later.
const clock = new Date(1_799_996_400_000)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
})
afterEach(() => vi.useRealTimers())

describe('Codex structured response classification', () => {
  it.each([
    [200, error('insufficient_quota'), { kind: 'ok' }],
    [401, error('usage_not_included'), { kind: 'auth' }],
    [
      429,
      { error: { type: 'usage_limit_reached', resets_at: 1_800_000_000 } },
      { kind: 'window_exhausted', until: new Date(1_800_000_000_000) },
    ],
    [
      429,
      error('usage_limit_reached', { resets_at: 'not-a-number' }),
      { kind: 'window_exhausted', until: null },
    ],
    [429, error('usage_not_included'), { kind: 'account_risk', reason: 'usage_not_included' }],
    [
      429,
      { error: { type: 'insufficient_quota' } },
      { kind: 'account_risk', reason: 'insufficient_quota' },
    ],
    [503, error('server_is_overloaded'), { kind: 'transient', retryAfterMs: 30_000 }],
    [503, error('slow_down'), { kind: 'transient', retryAfterMs: 30_000 }],
    [429, error('rate_limit_exceeded'), { kind: 'transient', retryAfterMs: 30_000 }],
    [403, error('unsupported_country_region_territory'), { kind: 'region' }],
    [403, '<html>Cloudflare blocked account</html>', { kind: 'unconfirmed_block' }],
    [
      403,
      { error: { message: 'unsupported_country_region_territory' } },
      { kind: 'unconfirmed_block' },
    ],
    [403, { code: 'unsupported_country_region_territory' }, { kind: 'unconfirmed_block' }],
    [
      429,
      { error: { message: 'usage_limit_reached' } },
      { kind: 'transient', retryAfterMs: 30_000 },
    ],
    [500, null, { kind: 'transient', retryAfterMs: 30_000 }],
    // The provider rejected this one request: final for the turn, and neither the model
    // profile nor the account, its limits or the egress is at fault.
    [
      400,
      error('synthetic-secret-code@example.invalid'),
      { kind: 'request_rejected', code: 'provider_request_rejected' },
    ],
    [
      400,
      error('context_length_exceeded'),
      { kind: 'request_rejected', code: 'context_length_exceeded' },
    ],
    [
      413,
      { error: { type: 'context_length_exceeded' } },
      { kind: 'request_rejected', code: 'context_length_exceeded' },
    ],
  ])('maps status %i and structural errors %#', (status, body, expected) => {
    const result = classifyCodexResponse(status as number, headers, body)
    expect(result).toEqual(expected)
    expect(callSignalSchema.safeParse(result).success).toBe(true)
  })

  it.each(['cyber_policy', 'bio_policy', 'invalid_prompt', 'misalignment_policy_violation'])(
    'preserves only allowlisted policy code %s in HTTP and SSE',
    (code) => {
      expect(classifyCodexResponse(400, headers, error(code))).toEqual({
        kind: 'policy_flagged',
        code,
      })
      expect(codexFailureSignal({ type: code, message: 'synthetic-private-message' })).toEqual({
        kind: 'policy_flagged',
        code,
      })
    },
  )

  // An exhaustion signal names no window: a reset more than 8 days ahead is a broken report.
  it.each([
    ['in seconds, within the weekly horizon: kept', clock.getTime() / 1000 + 8 * 86_400, true],
    ['in seconds, past the weekly horizon: void', clock.getTime() / 1000 + 8 * 86_400 + 1, false],
    ['in milliseconds: void', 1_790_000_000_000, false],
    ['already past: kept', 1_790_000_000, true],
  ])('reads a limit reset %s', (_name, resets_at, usable) => {
    const until = usable ? new Date(resets_at * 1000) : null
    const failure = { type: 'usage_limit_reached', resets_at }
    expect(classifyCodexResponse(429, new Headers(), { error: failure })).toEqual({
      kind: 'window_exhausted',
      until,
    })
    // The same error object ends a stream as `response.failed`.
    expect(codexFailureSignal({ code: 'usage_limit_reached', resets_at })).toEqual({
      kind: 'window_exhausted',
      until,
    })
  })

  it('does not invent success or expose data for unrecognized SSE failure', () => {
    expect(codexFailureSignal({ code: 'unknown', message: 'synthetic-secret' })).toBeNull()
    expect(codexFailureSignal({ message: 'context_length_exceeded' })).toBeNull()
    expect(codexFailureSignal('cyber_policy')).toBeNull()
    expect(codexFailureSignal({ code: 'usage_limit_reached', resets_at: 8.64e15 })).toEqual({
      kind: 'window_exhausted',
      until: null,
    })
  })

  it.each([
    ['0', 0],
    ['1.25', 1250],
    ['180', 30_000],
    ['not a date', 30_000],
    ['Infinity', 30_000],
  ])('bounds Retry-After %s', (value, delay) => {
    expect(classifyCodexResponse(503, new Headers({ 'retry-after': value }), null)).toEqual({
      kind: 'transient',
      retryAfterMs: delay,
    })
  })

  it('bounds an HTTP-date Retry-After', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
    expect(
      classifyCodexResponse(
        429,
        new Headers({ 'retry-after': 'Wed, 30 Sep 2026 00:00:05 GMT' }),
        null,
      ),
    ).toEqual({ kind: 'transient', retryAfterMs: 5000 })
  })
})

describe('Codex window headers', () => {
  // Numeric header shape observed locally with the owner's authorized synthetic test.
  // No tokens, account identifiers, arbitrary header values, or model content are retained.
  const weeklyOnly = {
    'x-codex-primary-used-percent': '11',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1791325751',
    'x-codex-primary-reset-after-seconds': '603316',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-secondary-reset-at': '',
    'x-codex-secondary-reset-after-seconds': '0',
    'x-codex-credits-balance': '0',
  }
  const known = {
    'X-Codex-Primary-Used-Percent': '12.5',
    'X-Codex-Primary-Window-Minutes': '300',
    'X-Codex-Primary-Reset-At': '1800000000',
    'X-Codex-Secondary-Used-Percent': '100',
    'X-Codex-Secondary-Window-Minutes': '10080',
    'X-Codex-Secondary-Reset-At': '1800500000',
    'X-Codex-Credits-Balance': '123456789012345678901234567890.000001',
  }
  it('preserves limiting windows including 100% and exact decimal credits', () => {
    const result = codexWindowsFromHeaders(new Headers(known))
    expect(result).toEqual({
      windows: [
        { name: '5h', usedPct: 12.5, resetsAt: new Date(1_800_000_000_000) },
        { name: 'week', usedPct: 100, resetsAt: new Date(1_800_500_000_000) },
      ],
      creditsBalance: known['X-Codex-Credits-Balance'],
    })
    expect(limitWindowSnapshotSchema.safeParse(result).success).toBe(true)
  })

  it('can report a window with unknown reset or credits without window headers', () => {
    const candidate = new Headers({
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '300',
    })
    expect(codexWindowsFromHeaders(candidate)).toEqual({
      windows: [{ name: '5h', usedPct: 0, resetsAt: null }],
      creditsBalance: null,
    })
    expect(codexWindowsFromHeaders(new Headers())).toBeNull()
  })

  it('reports credits without window headers as no window report, so known windows stand', () => {
    const result = codexWindowsFromHeaders(new Headers({ 'x-codex-credits-balance': '0.000' }))
    expect(result).toEqual({ windows: null, creditsBalance: '0.000' })
    expect(limitWindowSnapshotSchema.safeParse(result).success).toBe(true)
    // A balance it cannot read is a broken report: capacity becomes unknown.
    expect(codexWindowsFromHeaders(new Headers({ 'x-codex-credits-balance': '1e3' }))).toEqual(
      unknownCapacity(null),
    )
  })

  it.each(['', null])(
    'recognizes the unused zero-valued slot only with absent reset %j',
    (reset) => {
      const candidate = new Headers(weeklyOnly)
      if (reset === null) candidate.delete('x-codex-secondary-reset-at')
      else candidate.set('x-codex-secondary-reset-at', reset)
      expect(codexWindowsFromHeaders(candidate)).toEqual({
        windows: [{ name: 'week', usedPct: 11, resetsAt: new Date(1_791_325_751_000) }],
        creditsBalance: '0',
      })
    },
  )

  it.each([
    ['used-percent', '1'],
    ['used-percent', 'NaN'],
    ['used-percent', null],
    ['window-minutes', '60'],
    ['window-minutes', 'not-a-number'],
    ['window-minutes', null],
    ['reset-after-seconds', '1'],
    ['reset-after-seconds', '-1'],
    ['reset-after-seconds', 'NaN'],
    ['reset-after-seconds', null],
    ['reset-at', '0'],
    ['reset-at', '1791325751'],
    ['reset-at', 'invalid'],
  ])('never treats an incomplete or contradictory unused slot as absent: %s=%j', (key, value) => {
    const candidate = new Headers(weeklyOnly)
    if (value === null) candidate.delete(`x-codex-secondary-${key}`)
    else candidate.set(`x-codex-secondary-${key}`, value!)
    expect(codexWindowsFromHeaders(candidate)).toEqual(unknownCapacity('0'))
  })

  it.each([
    ['300', '5h'],
    ['10080', 'week'],
  ] as const)(
    'retains an active %s-minute window even with zero usage and epoch reset',
    (minutes, name) => {
      const candidate = new Headers({
        'x-codex-primary-used-percent': '0',
        'x-codex-primary-window-minutes': minutes,
        'x-codex-primary-reset-at': '0',
        'x-codex-primary-reset-after-seconds': '0',
      })
      expect(codexWindowsFromHeaders(candidate)).toEqual({
        windows: [{ name, usedPct: 0, resetsAt: new Date(0) }],
        creditsBalance: null,
      })
    },
  )

  it('does not invent any available window when both slots are absent', () => {
    const candidate = new Headers(weeklyOnly)
    for (const part of ['used-percent', 'window-minutes', 'reset-after-seconds'])
      candidate.set(`x-codex-primary-${part}`, '0')
    candidate.set('x-codex-primary-reset-at', '')
    expect(codexWindowsFromHeaders(candidate)).toEqual({ windows: [], creditsBalance: '0' })
  })

  // The consumer keeps the previous snapshot on `null` (nothing reported) and drops known
  // capacity on an empty window list: a malformed snapshot must be the latter.
  it.each([
    ['x-codex-primary-used-percent', '-1'],
    ['x-codex-primary-used-percent', 'NaN'],
    ['x-codex-primary-used-percent', '1, 2'],
    ['x-codex-primary-window-minutes', '60'],
    ['x-codex-primary-window-minutes', '284'],
    ['x-codex-primary-window-minutes', '316'],
    ['x-codex-primary-window-minutes', '1440'],
    ['x-codex-primary-reset-at', 'Infinity'],
    ['x-codex-secondary-window-minutes', '300'],
    ['x-codex-secondary-window-minutes', '9575'],
    ['x-codex-secondary-reset-at', '1.5'],
  ])('reports a malformed window %s=%s as unknown capacity, not as no report', (key, value) => {
    const candidate = new Headers(known)
    candidate.set(key, value)
    expect(codexWindowsFromHeaders(candidate)).toEqual(
      unknownCapacity(known['X-Codex-Credits-Balance']),
    )
    expect(limitWindowSnapshotSchema.safeParse(codexWindowsFromHeaders(candidate)).success).toBe(
      true,
    )
  })

  // A malformed snapshot now drops known capacity, so a length the pinned CLI itself
  // accepts (within 5% of the window, tui/src/chatwidget/rate_limits.rs) must not count as one.
  it.each([
    ['primary', '299'],
    ['primary', '285'],
    ['primary', '315'],
    ['secondary', '10079'],
    ['secondary', '9576'],
    ['secondary', '10584'],
  ])('names the %s window by a declared length of %s minutes', (slot, minutes) => {
    const candidate = new Headers(known)
    candidate.set(`x-codex-${slot}-window-minutes`, minutes)
    expect(codexWindowsFromHeaders(candidate)?.windows?.map((window) => window.name)).toEqual([
      '5h',
      'week',
    ])
  })

  // A reset further ahead than its window is long cannot be true: the report is unreadable,
  // so it can neither cool the account for years nor outrank later, correct snapshots.
  it.each([
    ['primary', 6 * 3_600, true],
    ['primary', 6 * 3_600 + 1, false],
    ['secondary', 8 * 86_400, true],
    ['secondary', 8 * 86_400 + 1, false],
  ] as const)('accepts a %s reset %i s ahead: %s', (slot, seconds, accepted) => {
    const candidate = new Headers(known)
    const reset = clock.getTime() / 1000 + seconds
    candidate.set(`x-codex-${slot}-reset-at`, String(reset))
    const result = codexWindowsFromHeaders(candidate)
    if (accepted)
      expect(result?.windows?.map((window) => window.resetsAt?.getTime())).toContain(reset * 1000)
    else expect(result).toEqual(unknownCapacity(known['X-Codex-Credits-Balance']))
  })

  it('reads a reset given in milliseconds as a broken report, not as the year 58692', () => {
    const candidate = new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1790000000000',
    })
    expect(codexWindowsFromHeaders(candidate)).toEqual(unknownCapacity(null))
  })

  it.each(['100.4', '101', '104', '250'])(
    'treats a window reported above its limit (%s%%) as exhausted',
    (usedPct) => {
      const candidate = new Headers(known)
      candidate.set('x-codex-primary-used-percent', usedPct)
      expect(codexWindowsFromHeaders(candidate)?.windows?.[0]).toEqual({
        name: '5h',
        usedPct: 100,
        resetsAt: new Date(1_800_000_000_000),
      })
    },
  )

  it('reads the windows when the credit balance header is present but empty', () => {
    const candidate = new Headers(known)
    candidate.set('x-codex-credits-balance', '')
    const result = codexWindowsFromHeaders(candidate)
    expect(result?.windows).toHaveLength(2)
    expect(result?.creditsBalance).toBeNull()
    expect(codexWindowsFromHeaders(new Headers({ 'x-codex-credits-balance': '' }))).toBeNull()
  })

  it.each(['-1', '01', 'NaN', '1e9', 'secret-account-id'])(
    'does not expose invalid credit data %s or keep the capacity reported with it',
    (balance) => {
      expect(codexWindowsFromHeaders(new Headers({ 'x-codex-credits-balance': balance }))).toEqual(
        unknownCapacity(null),
      )
      const candidate = new Headers(known)
      candidate.set('x-codex-credits-balance', balance)
      expect(codexWindowsFromHeaders(candidate)).toEqual(unknownCapacity(null))
    },
  )
})

describe('Codex gateway refusals', () => {
  it.each(['budget', 'subscription_limit', 'account', 'provider_off', 'egress'] as const)(
    'makes %s final for Codex CLI',
    (kind) => {
      const result = codexRefusal(kind, 90_000)
      expect(result.status).toBe(429)
      expect(result.headers.has('retry-after')).toBe(false)
      expect(JSON.parse(new TextDecoder().decode(result.body))).toMatchObject({
        error: { code: `raditi_${kind}`, type: 'usage_limit_reached' },
      })
    },
  )
  it.each(['policy', 'policy_flagged', 'profile', 'request_rejected'] as const)(
    'returns safe 400 for %s',
    (kind) => {
      const result = codexRefusal(kind)
      expect(result.status).toBe(400)
      expect(result.headers.has('retry-after')).toBe(false)
      expect(JSON.parse(new TextDecoder().decode(result.body))).toMatchObject({
        error: { code: `raditi_${kind}`, type: 'invalid_request_error' },
      })
    },
  )
  it.each(['policy', 'policy_flagged', 'profile'] as const)('scrubs the 400 for %s', (kind) => {
    const result = codexRefusal(kind)
    expect(result.status).toBe(400)
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(new TextDecoder().decode(result.body)).not.toMatch(/plan_type|resets_at|account_id/)
  })
  it.each([
    [undefined, '30'],
    [1501, '2'],
    [60_000, '30'],
    [-1, '0'],
    [Number.NaN, '30'],
  ])('clamps retryable refusals %#', (delay, expected) => {
    const result = codexRefusal('transient', delay as number | undefined)
    expect(result.status).toBe(503)
    expect(result.headers.get('retry-after')).toBe(expected)
  })
})

describe('Codex metadata probe', () => {
  it('makes one bounded content-free request using the account identity and reads limits', async () => {
    const credential = syntheticCodexCredential()
    const request = vi
      .fn<EgressHttp['request']>()
      .mockResolvedValue(response(200, { ...validProbe, email: 'private@example.invalid' }))
    const result = await probeCodexAccount(credential, identity, { request })
    expect(request).toHaveBeenCalledTimes(1)
    const [outgoing, options] = request.mock.calls[0]!
    expect(outgoing).toMatchObject({
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/usage',
    })
    expect(outgoing.body).toBeUndefined()
    expect(outgoing.headers.get('authorization')).toBe(`Bearer ${credential.accessToken}`)
    expect(outgoing.headers.get('chatgpt-account-id')).toBe(credential.chatgptAccountId)
    expect(outgoing.headers.get('x-codex-installation-id')).toBe(identity.installationId)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      status: 'ok',
      plan: 'pro',
      creditsBalance: '17.000001',
      windows: [
        { name: '5h', usedPct: 12.5, resetsAt: new Date(1_800_000_000_000) },
        { name: 'week', usedPct: 36, resetsAt: new Date(1_800_500_000_000) },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/private|account_id/)
    expect(probeResultSchema.safeParse(result).success).toBe(true)
  })

  it.each([
    [401, {}, 'auth'],
    [403, '<html>WAF</html>', 'region'],
    [403, { error: { message: 'No structured code' } }, 'region'],
    [403, { detail: 'Forbidden' }, 'region'],
    [403, error('unsupported_country_region_territory'), 'region'],
    // A structured refusal of this account's own metadata request is not an egress block.
    [403, error('account_deactivated'), 'suspended'],
    [403, { error: { type: 'forbidden' } }, 'suspended'],
    [429, error('insufficient_quota'), 'suspended'],
    // An answer about the account without its windows: the capacity the pool knew is void.
    [429, error('usage_limit_reached', { resets_at: 1_800_000_000 }), 'unknown'],
    [200, {}, 'unknown'],
    [200, 'not json', 'unknown'],
    [200, { plan_type: 'Secret Value' }, 'unknown'],
    [200, { plan_type: 'a'.repeat(65) }, 'unknown'],
    [200, { plan_type: 7 }, 'unknown'],
    [
      200,
      {
        ...validProbe,
        rate_limit: { primary_window: { used_percent: -1, limit_window_seconds: 18_000 } },
      },
      'unknown',
    ],
    // A reset further ahead than the window is long (here in milliseconds) voids the answer.
    [
      200,
      {
        ...validProbe,
        rate_limit: {
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 18_000,
            reset_at: 1_790_000_000_000,
          },
        },
      },
      'unknown',
    ],
    [
      200,
      {
        ...validProbe,
        rate_limit: {
          secondary_window: {
            used_percent: 100,
            limit_window_seconds: 604_800,
            reset_at: clock.getTime() / 1000 + 8 * 86_400 + 1,
          },
        },
      },
      'unknown',
    ],
  ])('maps content-free confirmation %#', async (status, body, expected) => {
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(response(status as number, body)),
    })
    expect(result).toEqual({ status: expected, windows: null, plan: null, creditsBalance: null })
  })

  // Like the response headers: past its limit the backend answers on credits, and the window
  // itself is exhausted. The probe then gives the pool the reset to cool the account until.
  it.each([100.4, 101, 250])('reads a probed window used %s percent as exhausted', async (used) => {
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(
        response(200, {
          ...validProbe,
          rate_limit: {
            primary_window: {
              used_percent: used,
              limit_window_seconds: 18_000,
              reset_at: 1_800_000_000,
            },
          },
        }),
      ),
    })
    expect(result).toMatchObject({
      status: 'ok',
      windows: [{ name: '5h', usedPct: 100, resetsAt: new Date(1_800_000_000_000) }],
    })
  })

  // `unknown` makes the pool drop the account's known windows, so it is reserved for an
  // answer that cannot be trusted. No answer at all is a rejection the pool ignores.
  it.each([
    [500, {}],
    [503, error('server_is_overloaded')],
    [429, {}],
    [429, error('rate_limit_exceeded')],
    [408, {}],
    [404, {}],
    [400, error('cyber_policy')],
    [302, {}],
  ])(
    'rejects instead of reporting capacity for a %i reply without an answer %#',
    async (status, body) => {
      const request = vi.fn<EgressHttp['request']>().mockResolvedValue(response(status, body))
      await expect(
        probeCodexAccount(syntheticCodexCredential(), identity, { request }),
      ).rejects.toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
      expect(request).toHaveBeenCalledTimes(1)
    },
  )

  it('accepts a plan slug introduced after this build; the pool compares it with the login', async () => {
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi
        .fn()
        .mockResolvedValue(response(200, { ...validProbe, plan_type: 'pro_plus_2027' })),
    })
    expect(result.status).toBe('ok')
    expect(result.plan).toBe('pro_plus_2027')
    expect(result.windows).toHaveLength(2)
  })

  it('keeps absent usage unknown, instead of inventing spare capacity', async () => {
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(response(200, { plan_type: 'plus' })),
    })
    expect(result).toEqual({ status: 'ok', plan: 'plus', windows: null, creditsBalance: null })
  })

  it.each(['primary_window', 'secondary_window'])(
    'accepts a weekly-only plan reported in %s without inventing an absent five-hour window',
    async (slot) => {
      const body = {
        ...validProbe,
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: null,
          secondary_window: null,
          [slot]: { used_percent: 7, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
        },
      }
      const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
        request: vi.fn().mockResolvedValue(response(200, body)),
      })
      expect(result.status).toBe('ok')
      expect(result.windows).toEqual([
        { name: 'week', usedPct: 7, resetsAt: new Date(1_800_500_000_000) },
      ])
    },
  )

  it.each([
    [17_940, ['5h', 'week']],
    [18_900, ['5h', 'week']],
    [86_400, null],
    [17_099, null],
  ])('names a probe window of %i seconds as the pinned CLI does', async (seconds, names) => {
    const body = {
      ...validProbe,
      rate_limit: {
        ...validProbe.rate_limit,
        primary_window: { ...validProbe.rate_limit.primary_window, limit_window_seconds: seconds },
      },
    }
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(response(200, body)),
    })
    expect(result.status).toBe(names === null ? 'unknown' : 'ok')
    expect(result.windows?.map((window) => window.name) ?? null).toEqual(names)
  })

  it.each([
    'prolite',
    'promax',
    'ent26',
    'self_serve_business_prolite',
    'guest',
    'free_workspace',
    'quorum',
    'k12',
  ])('recognizes the pinned WHAM raw plan slug %s', async (plan_type) => {
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(response(200, { ...validProbe, plan_type })),
    })
    expect(result.status).toBe('ok')
    expect(result.plan).toBe(plan_type)
  })

  it.each([
    { rate_limit: 'malformed' },
    { rate_limit: { ...validProbe.rate_limit, allowed: 'true' } },
    { rate_limit: { ...validProbe.rate_limit, allowed: false } },
    { rate_limit: { ...validProbe.rate_limit, limit_reached: true } },
    { credits: { balance: 'NaN' } },
    { credits: 'malformed' },
  ])(
    'does not reopen capacity with malformed or contradictory probe metadata %#',
    async (patch) => {
      const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
        request: vi.fn().mockResolvedValue(response(200, { ...validProbe, ...patch })),
      })
      expect(result.status).toBe('unknown')
      expect(result.windows).toBeNull()
    },
  )

  it('preserves a fully exhausted window confirmed by the probe flags', async () => {
    const body = {
      ...validProbe,
      rate_limit: {
        ...validProbe.rate_limit,
        allowed: false,
        limit_reached: true,
        primary_window: { ...validProbe.rate_limit.primary_window, used_percent: 100 },
      },
    }
    const result = await probeCodexAccount(syntheticCodexCredential(), identity, {
      request: vi.fn().mockResolvedValue(response(200, body)),
    })
    expect(result.status).toBe('ok')
    expect(result.windows?.[0]?.usedPct).toBe(100)
  })

  it('contains transport errors and times out without retrying a stalled injected transport', async () => {
    const request = vi
      .fn<EgressHttp['request']>()
      .mockRejectedValueOnce(new Error('synthetic-token'))
    const failed = await probeCodexAccount(syntheticCodexCredential(), identity, { request }).catch(
      (error: unknown) => error,
    )
    expect(failed).toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
    expect(String((failed as Error).message)).not.toContain('synthetic-token')
    vi.useFakeTimers()
    request.mockImplementationOnce(() => new Promise(() => {}))
    const pending = probeCodexAccount(syntheticCodexCredential(), identity, { request }).catch(
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
    expect(request.mock.calls[1]![1].signal.aborted).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
