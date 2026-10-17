import { describe, expect, it } from 'vitest'
import {
  callSignalSchema,
  callUsageSchema,
  credentialMetadataSchema,
  gatewayRefusalSchema,
  limitResetHorizonMs,
  limitResetPlausible,
  limitWindowSchema,
  limitWindowsSchema,
  llmBackendIdSchema,
  llmBackendIds,
  llmCapacitySchema,
  llmEgressOriginSchema,
  meterResultSchema,
  normalizedBodySchema,
  probeResultSchema,
  refusalForSignal,
  type CallSignal,
  type CallUsage,
  type GatewayRefusal,
  type LimitWindow,
} from './llm-backend.ts'

const usage: CallUsage = { input: 100, cacheRead: 60, cacheWrite: 20, output: 40, reasoning: 30 }
const window: LimitWindow = {
  name: '5h',
  usedPct: 75.5,
  resetsAt: new Date('2026-09-29T15:00:00.000Z'),
}

describe('gateway usage validation', () => {
  it('counts cached input and reasoning inside their totals', () => {
    expect(callUsageSchema.parse(usage)).toEqual(usage)
    expect(
      callUsageSchema.parse({
        input: 80,
        cacheRead: 60,
        cacheWrite: 20,
        output: 30,
        reasoning: 30,
      }),
    ).toEqual({ input: 80, cacheRead: 60, cacheWrite: 20, output: 30, reasoning: 30 })
    expect(
      callUsageSchema.safeParse({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
        .success,
    ).toBe(true)
  })

  it.each([{ input: 79 }, { cacheRead: 101 }, { cacheWrite: 101 }, { reasoning: 41 }])(
    'refuses inconsistent usage %j rather than silently clamping it',
    (patch) => {
      expect(callUsageSchema.safeParse({ ...usage, ...patch }).success).toBe(false)
    },
  )

  it.each(['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const)(
    'refuses invalid %s counts before cost calculation',
    (field) => {
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
        expect(callUsageSchema.safeParse({ ...usage, [field]: value }).success).toBe(false)
    },
  )

  it('checks the cache total without rounding or overflowing at the integer boundary', () => {
    const large = {
      input: Number.MAX_SAFE_INTEGER,
      cacheRead: Number.MAX_SAFE_INTEGER - 1,
      cacheWrite: 1,
      output: Number.MAX_SAFE_INTEGER,
      reasoning: Number.MAX_SAFE_INTEGER,
    }
    expect(callUsageSchema.safeParse(large).success).toBe(true)
    expect(callUsageSchema.safeParse({ ...large, cacheWrite: 2 }).success).toBe(false)
    expect(
      callUsageSchema.safeParse({ ...large, cacheWrite: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(false)
  })

  it('does not accept a CLI event usage shape or extra data from a provider', () => {
    expect(
      callUsageSchema.safeParse({
        inputUncached: 20,
        cacheRead: 60,
        cacheWrite: 20,
        output: 40,
        reasoning: 30,
      }).success,
    ).toBe(false)
    expect(callUsageSchema.safeParse({ ...usage, providerPayload: {} }).success).toBe(false)
    const { reasoning: _reasoning, ...missingReasoning } = usage
    expect(callUsageSchema.safeParse(missingReasoning).success).toBe(false)
  })
})

describe('subscription windows', () => {
  it('preserves fractional percentages, exhausted windows and an unknown reset time', () => {
    expect(limitWindowSchema.parse(window)).toEqual(window)
    expect(limitWindowSchema.parse({ ...window, usedPct: 100, resetsAt: null })).toEqual({
      ...window,
      usedPct: 100,
      resetsAt: null,
    })
    expect(limitWindowSchema.safeParse({ ...window, usedPct: 0 }).success).toBe(true)
  })

  it.each([
    { name: 'day' },
    { usedPct: -0.01 },
    { usedPct: 100.01 },
    { usedPct: Infinity },
    { usedPct: NaN },
    { usedPct: '70' },
    { resetsAt: new Date(NaN) },
    { resetsAt: '2026-09-29T15:00:00.000Z' },
    { resetsAt: undefined },
    { providerPayload: 'untrusted' },
  ])('refuses invalid window data %j', (patch) => {
    expect(limitWindowSchema.safeParse({ ...window, ...patch }).success).toBe(false)
  })

  it('accepts each supported window once and rejects duplicate names', () => {
    const windows = [window, { ...window, name: 'week' }, { ...window, name: 'month' }]
    expect(limitWindowsSchema.parse(windows)).toEqual(windows)
    expect(limitWindowsSchema.safeParse([]).success).toBe(true)
    expect(limitWindowsSchema.safeParse([window, window]).success).toBe(false)
    expect(limitWindowsSchema.safeParse([...windows, window]).success).toBe(false)
  })
})

describe('the outgoing requests an adapter declares', () => {
  const declared = {
    origin: 'https://provider.invalid',
    requests: ['POST https://provider.invalid/v1/generate', 'GET https://provider.invalid/usage'],
    overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
  }

  it('accepts a fixed https origin with exact METHOD URL requests under it', () => {
    expect(llmEgressOriginSchema.parse(declared)).toEqual(declared)
  })

  it('lets an adapter say that its origin needs no egress node, by a flag alone', () => {
    const direct = { ...declared, direct: true }
    expect(llmEgressOriginSchema.parse(direct)).toEqual(direct)
    expect(llmEgressOriginSchema.parse({ ...declared, direct: false }).direct).toBe(false)
    for (const value of ['true', 1, null, 'https://provider.invalid'])
      expect(llmEgressOriginSchema.safeParse({ ...declared, direct: value }).success).toBe(false)
  })

  it.each([
    { origin: 'http://provider.invalid' },
    { origin: 'https://provider.invalid/' },
    { origin: 'https://user:secret@provider.invalid' },
    { requests: [] },
    { requests: ['POST https://other.invalid/v1/generate'] },
    { requests: ['POST https://provider.invalid.evil.invalid/v1/generate'] },
    { requests: ['DELETE https://provider.invalid/v1/generate'] },
    { requests: ['POST https://provider.invalid/v1/generate?key=secret'] },
    { requests: ['POST https://provider.invalid/v1/generate#fragment'] },
    { requests: ['POST  https://provider.invalid/v1/generate'] },
    { requests: ['https://provider.invalid/v1/generate'] },
    { overrideEnv: 'PATH' },
    { overrideEnv: 'llm_backend_url' },
    { extra: true },
  ])('refuses a declaration the transport could read too widely: %j', (patch) => {
    expect(llmEgressOriginSchema.safeParse({ ...declared, ...patch }).success).toBe(false)
  })
})

describe('the refusal a provider signal stands for', () => {
  // One mapping for the HTTP answer, the stream event and llm_keys.last_refusal.
  const table: [CallSignal, GatewayRefusal][] = [
    [{ kind: 'ok' }, 'transient'],
    [{ kind: 'transient', retryAfterMs: 1_000 }, 'transient'],
    [{ kind: 'window_exhausted', until: null }, 'subscription_limit'],
    // No capacity until a top-up: final for the turn, the account itself is fine.
    [{ kind: 'balance_exhausted' }, 'subscription_limit'],
    [{ kind: 'auth' }, 'account'],
    [{ kind: 'account_risk', reason: 'usage_not_included' }, 'account'],
    [{ kind: 'unconfirmed_block' }, 'account'],
    [{ kind: 'unconfirmed_block', code: 'zai_1234' }, 'account'],
    [{ kind: 'region' }, 'egress'],
    [{ kind: 'policy_flagged', code: 'cyber_policy' }, 'policy_flagged'],
    [{ kind: 'profile', code: 'model_access' }, 'profile'],
    // Final for the turn; says nothing about the profile, the account or the egress.
    [{ kind: 'request_rejected', code: 'context_length_exceeded' }, 'request_rejected'],
  ]

  it.each(table)('maps %j to %s', (signal, refusal) => {
    expect(callSignalSchema.safeParse(signal).success).toBe(true)
    expect(refusalForSignal(signal)).toBe(refusal)
    expect(gatewayRefusalSchema.safeParse(refusal).success).toBe(true)
  })

  it('covers every signal kind and never guesses for one it does not know', () => {
    const kinds = callSignalSchema.options.map((option) => option.shape.kind.value)
    expect(new Set(table.map(([signal]) => signal.kind))).toEqual(new Set(kinds))
    expect(() => refusalForSignal({ kind: 'later_kind' } as unknown as CallSignal)).toThrow(
      'Unknown call signal',
    )
  })
})

describe('backend signals', () => {
  it.each([
    { kind: 'ok' },
    { kind: 'transient', retryAfterMs: 45 * 60_000 },
    { kind: 'window_exhausted', until: window.resetsAt },
    { kind: 'window_exhausted', until: null },
    { kind: 'balance_exhausted' },
    { kind: 'auth' },
    { kind: 'account_risk', reason: 'risk_confirmed' },
    { kind: 'region' },
    { kind: 'unconfirmed_block' },
    // The provider's own code of a block nobody has confirmed yet, for the log of the role.
    { kind: 'unconfirmed_block', code: 'zai_1234' },
    { kind: 'policy_flagged', code: 'cyber_policy' },
    { kind: 'profile', code: 'model_unavailable' },
    { kind: 'request_rejected', code: 'context_length_exceeded' },
  ])('preserves the normalized $kind outcome', (signal) => {
    expect(callSignalSchema.parse(signal)).toEqual(signal)
  })

  it.each([
    { kind: 'unknown' },
    { kind: 'auth', providerBody: { error: 'secret account details' } },
    { kind: 'auth', reason: 'provider_specific_reason' },
    { kind: 'transient', retryAfterMs: -1 },
    { kind: 'transient', retryAfterMs: 0.5 },
    { kind: 'transient', retryAfterMs: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'window_exhausted' },
    { kind: 'window_exhausted', until: new Date(NaN) },
    { kind: 'window_exhausted', until: '2026-09-29T15:00:00.000Z' },
    // The provider's text or a sum of money never travels with it.
    { kind: 'balance_exhausted', code: 'zai_1113' },
    { kind: 'balance_exhausted', balance: '0.00' },
    { kind: 'account_risk', reason: '<html>blocked</html>' },
    { kind: 'account_risk', reason: 'a'.repeat(65) },
    { kind: 'policy_flagged', code: '' },
    { kind: 'policy_flagged', code: 'provider message with account details' },
    { kind: 'unconfirmed_block', code: 'provider message with account details' },
    { kind: 'unconfirmed_block', code: '' },
    { kind: 'unconfirmed_block', reason: 'zai_1234' },
    { kind: 'profile', code: 'model\nunavailable' },
  ])('rejects invalid or unsanitized signal %j', (signal) => {
    expect(callSignalSchema.safeParse(signal).success).toBe(false)
  })

  it('keeps a gateway refusal separate from an unconfirmed provider signal', () => {
    for (const kind of [
      'transient',
      'budget',
      'subscription_limit',
      'account',
      'provider_off',
      'egress',
      'policy',
      'policy_flagged',
      'profile',
    ])
      expect(gatewayRefusalSchema.parse(kind)).toBe(kind)
    for (const kind of [
      'auth',
      'account_risk',
      'unconfirmed_block',
      'region',
      'ok',
      'balance_exhausted',
    ])
      expect(gatewayRefusalSchema.safeParse(kind).success).toBe(false)
  })
})

describe('probe and metering boundaries', () => {
  const probe = { status: 'ok', windows: [window], plan: 'provider-plan' }

  it('keeps missing probe data explicit without assuming a provider plan', () => {
    expect(probeResultSchema.parse(probe)).toEqual(probe)
    const unknown = { status: 'unknown', windows: null, plan: null }
    expect(probeResultSchema.parse(unknown)).toEqual(unknown)
  })

  it.each([
    { status: 'account_risk' },
    { windows: [window, window] },
    { plan: '' },
    { plan: 2 },
    { providerPayload: 'untrusted' },
  ])('rejects malformed probe data %j', (patch) => {
    expect(probeResultSchema.safeParse({ ...probe, ...patch }).success).toBe(false)
  })

  it('bounds how far ahead a window reset may lie by the length of its window', () => {
    const now = new Date('2026-10-03T00:00:00Z')
    const ahead = (ms: number) => new Date(now.getTime() + ms)
    const day = 86_400_000
    expect(limitResetHorizonMs).toEqual({ '5h': day / 4, week: 8 * day, month: 32 * day })
    for (const [name, horizon] of Object.entries(limitResetHorizonMs) as [
      LimitWindow['name'],
      number,
    ][]) {
      expect(limitResetPlausible(ahead(horizon), now, name)).toBe(true)
      expect(limitResetPlausible(ahead(horizon + 1), now, name)).toBe(false)
    }
    // An exhaustion signal names no window: a week. A reset already past is plausible.
    expect(limitResetPlausible(ahead(8 * day), now)).toBe(true)
    expect(limitResetPlausible(ahead(8 * day + 1), now)).toBe(false)
    expect(limitResetPlausible(new Date(0), now, '5h')).toBe(true)
    // Seconds mistaken for milliseconds land tens of thousands of years ahead.
    expect(limitResetPlausible(new Date(1_790_000_000_000_000), now, 'month')).toBe(false)
  })

  it('separates provider terminals, interrupted streams and unusable usage', () => {
    for (const outcome of ['completed', 'failed', 'incomplete']) {
      const result = {
        usage: null,
        outcome,
        signal: null,
        usageIssue: 'no_usage',
        deltaTextBytes: 12,
      }
      expect(meterResultSchema.parse(result)).toEqual(result)
    }
    expect(
      meterResultSchema.parse({
        usage,
        outcome: 'completed',
        signal: null,
        usageIssue: null,
        deltaTextBytes: 12,
      }).usage,
    ).toEqual(usage)
    const failed = {
      usage: null,
      outcome: 'failed',
      signal: { kind: 'policy_flagged', code: 'cyber_policy' },
      usageIssue: 'invalid_usage',
      deltaTextBytes: 12,
    }
    expect(meterResultSchema.parse(failed)).toEqual(failed)
  })

  it('rejects contradictory stream outcomes and usage reasons', () => {
    const meter = {
      usage,
      outcome: 'completed',
      signal: null,
      usageIssue: null,
      deltaTextBytes: 12,
    }
    for (const patch of [
      { usage: null },
      { usageIssue: 'invalid_usage' },
      { signal: { kind: 'auth' } },
      { outcome: 'incomplete', signal: { kind: 'profile', code: 'model_unavailable' } },
      { outcome: 'failed', signal: { kind: 'ok' } },
      { completedNormally: true },
    ])
      expect(meterResultSchema.safeParse({ ...meter, ...patch }).success).toBe(false)
  })

  it('refuses invalid usage or byte counts before an estimate is charged', () => {
    const meter = {
      usage,
      outcome: 'completed',
      signal: null,
      usageIssue: null,
      deltaTextBytes: 12,
    }
    for (const deltaTextBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(meterResultSchema.safeParse({ ...meter, deltaTextBytes }).success).toBe(false)
    expect(
      meterResultSchema.safeParse({ ...meter, usage: { ...usage, reasoning: 41 } }).success,
    ).toBe(false)
    expect(meterResultSchema.safeParse({ ...meter, providerPayload: {} }).success).toBe(false)
  })

  it('accepts only byte bodies and whole nonnegative safe input estimates', () => {
    const normalized = { body: new Uint8Array([123, 125]), estInputTokens: 1 }
    expect(normalizedBodySchema.parse(normalized)).toEqual(normalized)
    for (const body of ['{}', [123, 125], null])
      expect(normalizedBodySchema.safeParse({ ...normalized, body }).success).toBe(false)
    for (const estInputTokens of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(normalizedBodySchema.safeParse({ ...normalized, estInputTokens }).success).toBe(false)
  })
})

describe('backend ids', () => {
  it('knows the plan and the pay-per-token API of Z.ai, in this order', () => {
    expect(llmBackendIds).toEqual(['zai-coding', 'zai-api'])
    expect(llmBackendIdSchema.parse('zai-coding')).toBe('zai-coding')
    expect(llmBackendIdSchema.parse('zai-api')).toBe('zai-api')
  })
  // The slug is the backend, not its provider, shell or model.
  it.each(['zai', 'opencode', 'glm-5.3', 'litellm', 'gigachat'])(
    'refuses %s, which never was a backend id',
    (id) => expect(llmBackendIdSchema.safeParse(id).success).toBe(false),
  )
  it.each(['openai-chatgpt', 'kimi-code'])('refuses the removed backend %s', (id) =>
    expect(llmBackendIdSchema.safeParse(id).success).toBe(false),
  )

  it('describes the capacity of an account in two words only', () => {
    expect(llmCapacitySchema.options).toEqual(['windows', 'none'])
    for (const value of ['balance', 'unknown', '', null])
      expect(llmCapacitySchema.safeParse(value).success).toBe(false)
  })
})

describe('provider-neutral credential metadata', () => {
  const datedMetadata = {
    externalAccountId: 'synthetic-account',
    plan: 'synthetic-plan',
    accessIssuedAt: new Date('2026-09-29T12:00:00.000Z'),
    accessExpiresAt: new Date('2026-09-30T12:00:00.000Z'),
  }

  it('represents a credential with no known expiry without inventing a lifetime', () => {
    const metadata = {
      externalAccountId: null,
      plan: null,
      accessExpiresAt: null,
      accessIssuedAt: null,
    }
    expect(credentialMetadataSchema.parse(metadata)).toEqual(metadata)
  })

  it('preserves the lifetime a credential names and permits a partially unknown one', () => {
    expect(credentialMetadataSchema.parse(datedMetadata)).toEqual(datedMetadata)
    for (const field of ['accessIssuedAt', 'accessExpiresAt'])
      expect(credentialMetadataSchema.safeParse({ ...datedMetadata, [field]: null }).success).toBe(
        true,
      )
  })

  it.each([
    { accessExpiresAt: new Date('2026-09-29T11:59:59.000Z') },
    { accessExpiresAt: new Date('2026-09-29T12:00:00.000Z') },
    { accessIssuedAt: new Date(NaN) },
    { accessExpiresAt: new Date(NaN) },
    { accessExpiresAt: '2026-09-30T12:00:00.000Z' },
    { accessIssuedAt: undefined },
    { accessToken: 'synthetic-secret' },
  ])('rejects an impossible lifetime or credential payload %j', (patch) => {
    expect(credentialMetadataSchema.safeParse({ ...datedMetadata, ...patch }).success).toBe(false)
  })
})
