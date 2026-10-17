import { callSignalSchema, gatewayRefusalSchema, type GatewayRefusal } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { zaiApiOffer, zaiCodingPlan } from './backend.ts'
import { zaiPolicyFields } from './body.ts'
import { zaiClassifier, zaiRefusal } from './errors.ts'
import { cliReadsOverflow, cliRetriesHttp, cliRetriesStreamError } from './fixtures/opencode-cli.ts'
import { envelopeSamples, errorBody, errorSamples, sample } from './fixtures/samples.ts'

const none = new Headers()
const error = (code: unknown, message = 'Synthetic provider text.') => ({
  error: { code, message },
})
const decode = (body: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(body)) as {
    error: { type: string; code: string; message: string }
  }
const finals = gatewayRefusalSchema.options.filter((kind) => kind !== 'transient')
// The plan reads every code by the shared table.
const { classify: classifyZai, classifyStreamError: classifyZaiStreamError } = zaiClassifier(
  zaiCodingPlan.answers,
)

describe('Z.ai answers with a status', () => {
  it.each([
    [errorSamples.invalidKey, { kind: 'auth' }],
    [errorSamples.invalidKeyPlain, { kind: 'auth' }],
    [errorSamples.noKey, { kind: 'auth' }],
    [errorSamples.unknownModel, { kind: 'profile', code: 'zai_1211' }],
    [errorSamples.badParameter, { kind: 'request_rejected', code: 'zai_1210' }],
    [errorSamples.noResourcePackage, { kind: 'account_risk', reason: 'zai_1113' }],
  ] as const)('reads the recorded answer %s', (name, signal) => {
    const record = sample(name)
    expect(classifyZai(record.response.status, none, errorBody(name))).toEqual(signal)
  })

  // The codes of the documentation (decision 9 of the plan); their HTTP statuses were not
  // observed, so the code decides whatever the status is.
  it.each([
    ['1302', { kind: 'transient', retryAfterMs: 30_000 }],
    ['1305', { kind: 'transient', retryAfterMs: 30_000 }],
    ['1308', { kind: 'window_exhausted', until: null }],
    ['1310', { kind: 'window_exhausted', until: null }],
    ['1316', { kind: 'window_exhausted', until: null }],
    ['1317', { kind: 'window_exhausted', until: null }],
    ['1309', { kind: 'account_risk', reason: 'zai_1309' }],
    ['1313', { kind: 'account_risk', reason: 'zai_1313' }],
    ['1113', { kind: 'account_risk', reason: 'zai_1113' }],
    ['1311', { kind: 'profile', code: 'zai_1311' }],
    ['1211', { kind: 'profile', code: 'zai_1211' }],
    ['1301', { kind: 'policy_flagged', code: 'zai_1301' }],
    ['1261', { kind: 'request_rejected', code: 'zai_1261' }],
  ] as const)('maps the code %s whatever the status', (code, signal) => {
    for (const status of [400, 403, 429, 500]) {
      expect(classifyZai(status, none, error(code))).toEqual(signal)
      // A number, and the envelope of the monitor paths, read the same.
      expect(classifyZai(status, none, error(Number(code)))).toEqual(signal)
      expect(classifyZai(status, none, { code: Number(code), msg: 'x', success: false })).toEqual(
        signal,
      )
    }
    expect(callSignalSchema.safeParse(signal).success).toBe(true)
  })

  it('reads 2xx as ok, 401 as the key, 408, 409 and 5xx as short-lived', () => {
    expect(classifyZai(200, none, null)).toEqual({ kind: 'ok' })
    expect(classifyZai(401, none, null)).toEqual({ kind: 'auth' })
    expect(classifyZai(401, none, error('9999'))).toEqual({ kind: 'auth' })
    for (const status of [408, 409, 500, 502, 503, 529])
      expect(classifyZai(status, none, null)).toEqual({ kind: 'transient', retryAfterMs: 30_000 })
  })

  it('keeps a pause of the provider within 30 seconds', () => {
    const retry = (value: string) => new Headers({ 'retry-after': value })
    expect(classifyZai(503, retry('2'), null)).toEqual({ kind: 'transient', retryAfterMs: 2000 })
    expect(classifyZai(429, retry('0.5'), error('1305'))).toEqual({
      kind: 'transient',
      retryAfterMs: 500,
    })
    for (const value of ['999999', '31', 'Wed, 21 Oct 2026 07:28:00 GMT', '-1', 'soon'])
      expect(classifyZai(503, retry(value), null)).toEqual({
        kind: 'transient',
        retryAfterMs: 30_000,
      })
  })

  it('ends the turn on any other 400 as a rejection of this request only', () => {
    expect(classifyZai(400, none, error('1210'))).toEqual({
      kind: 'request_rejected',
      code: 'zai_1210',
    })
    expect(classifyZai(400, none, null)).toEqual({ kind: 'request_rejected', code: 'zai_http_400' })
    expect(classifyZai(400, none, { error: 'plain text' })).toEqual({
      kind: 'request_rejected',
      code: 'zai_http_400',
    })
  })

  it('reads everything else as an unconfirmed block that names the code, never the text', () => {
    expect(classifyZai(429, none, error('1304'))).toEqual({
      kind: 'unconfirmed_block',
      code: 'zai_1304',
    })
    expect(classifyZai(403, none, error(1999))).toEqual({
      kind: 'unconfirmed_block',
      code: 'zai_1999',
    })
    for (const status of [402, 403, 404, 413, 429, 451])
      expect(classifyZai(status, none, null)).toEqual({ kind: 'unconfirmed_block' })
    // Not a code: text, a sign, a fraction, too many digits, another type.
    for (const code of [
      'quota exceeded for account 42',
      '1308 ',
      '-1308',
      '13.08',
      '1e3',
      '12345678',
      '',
      true,
      ['1308'],
      { value: 1308 },
      1308.5,
      -1,
    ]) {
      const signal = classifyZai(429, none, error(code, 'SECRET account text 1308'))
      expect(signal).toEqual({ kind: 'unconfirmed_block' })
      expect(JSON.stringify(signal)).not.toContain('SECRET')
    }
    const anything = classifyZai(418, none, error('31337', 'SECRET'))
    expect(anything).toEqual({ kind: 'unconfirmed_block', code: 'zai_31337' })
    expect(callSignalSchema.safeParse(anything).success).toBe(true)
  })

  it('never lets a known code inside free text decide', () => {
    expect(classifyZai(429, none, error(undefined, 'error 1308: limit reached'))).toEqual({
      kind: 'unconfirmed_block',
    })
    expect(classifyZai(429, none, { message: '1113', error: { message: '1113' } })).toEqual({
      kind: 'unconfirmed_block',
    })
  })
})

describe('a Z.ai error inside a started stream', () => {
  it('uses the same code table and an unconfirmed block for the rest', () => {
    expect(classifyZaiStreamError(error('1305'))).toEqual({
      kind: 'transient',
      retryAfterMs: 30_000,
    })
    expect(classifyZaiStreamError(error('1308'))).toEqual({ kind: 'window_exhausted', until: null })
    expect(classifyZaiStreamError(error('1301'))).toEqual({
      kind: 'policy_flagged',
      code: 'zai_1301',
    })
    expect(classifyZaiStreamError(error('401'))).toEqual({ kind: 'auth' })
    expect(classifyZaiStreamError(error('7777'))).toEqual({
      kind: 'unconfirmed_block',
      code: 'zai_7777',
    })
    for (const value of [{ error: 'SECRET' }, { error: {} }, {}, null, error('nope')])
      expect(classifyZaiStreamError(value)).toEqual({ kind: 'unconfirmed_block' })
  })

  it('reads the envelope of the monitor paths too', () => {
    expect(classifyZaiStreamError(errorBody(envelopeSamples.invalidKey))).toEqual({ kind: 'auth' })
  })
})

describe('what the pay-per-token API reads otherwise', () => {
  const api = zaiClassifier(zaiApiOffer.answers)
  const shared = [
    '401',
    '1302',
    '1305',
    '1308',
    '1309',
    '1310',
    '1311',
    '1313',
    '1316',
    '1317',
    '1211',
    '1301',
    '1261',
    '1304',
    '1999',
  ]

  it('reads 1113 as an empty balance whatever the status and the form', () => {
    for (const status of [400, 402, 403, 429, 500]) {
      expect(api.classify(status, none, error('1113'))).toEqual({ kind: 'balance_exhausted' })
      expect(api.classify(status, none, error(1113))).toEqual({ kind: 'balance_exhausted' })
      expect(api.classify(status, none, { code: 1113, msg: 'x', success: false })).toEqual({
        kind: 'balance_exhausted',
      })
    }
    expect(api.classifyStreamError(error('1113'))).toEqual({ kind: 'balance_exhausted' })
    expect(classifyZai(429, none, error('1113'))).toEqual({
      kind: 'account_risk',
      reason: 'zai_1113',
    })
  })

  it('reads a 429 that names no code as the provider throttling, with its pause', () => {
    expect(api.classify(429, none, null)).toEqual({ kind: 'transient', retryAfterMs: 30_000 })
    expect(api.classify(429, none, { error: 'Too much concurrency' })).toEqual({
      kind: 'transient',
      retryAfterMs: 30_000,
    })
    expect(api.classify(429, new Headers({ 'retry-after': '3' }), null)).toEqual({
      kind: 'transient',
      retryAfterMs: 3_000,
    })
    // Unnamed elsewhere it is no throttle, and a code nobody has seen stays unconfirmed.
    for (const status of [402, 403, 404, 413, 451])
      expect(api.classify(status, none, null)).toEqual({ kind: 'unconfirmed_block' })
    expect(classifyZai(429, none, null)).toEqual({ kind: 'unconfirmed_block' })
  })

  it.each(shared)('reads the code %s as the plan does', (code) => {
    for (const status of [400, 403, 429, 500])
      expect(api.classify(status, none, error(code))).toEqual(
        classifyZai(status, none, error(code)),
      )
    expect(api.classifyStreamError(error(code))).toEqual(classifyZaiStreamError(error(code)))
  })

  it('reads every status without a code as the plan does, but a 429', () => {
    for (const status of [200, 204, 400, 401, 402, 403, 404, 408, 409, 500, 502, 503])
      expect(api.classify(status, none, null)).toEqual(classifyZai(status, none, null))
  })

  it('takes no code from the text', () => {
    expect(api.classify(429, none, error(undefined, 'error 1113: recharge'))).toEqual({
      kind: 'transient',
      retryAfterMs: 30_000,
    })
    expect(api.classifyStreamError({ error: { message: '1113' } })).toEqual({
      kind: 'unconfirmed_block',
    })
    expect(callSignalSchema.safeParse(api.classify(429, none, error('1113'))).success).toBe(true)
  })
})

describe('refusals shaped for the OpenCode CLI', () => {
  it.each(['budget', 'subscription_limit', 'account', 'provider_off', 'egress'] as const)(
    'answers %s with a final 403',
    (kind) => {
      const refusal = zaiRefusal(kind, 5_000)
      expect(refusal.status).toBe(403)
      expect(Object.fromEntries(refusal.headers)).toEqual({ 'content-type': 'application/json' })
      expect(decode(refusal.body).error).toMatchObject({
        type: 'invalid_request_error',
        code: `raditi_${kind}`,
      })
    },
  )

  it.each(['policy', 'policy_flagged', 'profile', 'request_rejected'] as const)(
    'answers %s with a final 400',
    (kind) => {
      const refusal = zaiRefusal(kind, 5_000)
      expect(refusal.status).toBe(400)
      expect(Object.fromEntries(refusal.headers)).toEqual({ 'content-type': 'application/json' })
      expect(decode(refusal.body).error).toMatchObject({
        type: 'invalid_request_error',
        code: `raditi_${kind}`,
      })
    },
  )

  it.each([
    [undefined, '30'],
    [1, '1'],
    [1_500, '2'],
    [30_000, '30'],
    [999_999_000, '30'],
    // Zero would be five retries without a pause.
    [0, '1'],
    [-5, '1'],
    [Number.NaN, '30'],
    [Number.POSITIVE_INFINITY, '30'],
  ])('answers a short-lived refusal with 503 and retry-after: %s ms → %s s', (delay, seconds) => {
    const refusal = zaiRefusal('transient', delay)
    expect(refusal.status).toBe(503)
    expect(refusal.headers.get('retry-after')).toBe(seconds)
    expect(decode(refusal.body).error).toMatchObject({ code: 'raditi_transient' })
  })

  it('covers every refusal of the gateway with a body of three fixed fields', () => {
    for (const kind of gatewayRefusalSchema.options) {
      const { error: body } = decode(zaiRefusal(kind).body)
      expect(Object.keys(body)).toEqual(['type', 'code', 'message'])
      expect(body.message).toMatch(/^[A-Za-z ]+\.$/)
    }
  })

  // The field the role adds to a refused body: a path of the policy, without indexes.
  const fields = [
    undefined,
    'unknown',
    ...zaiPolicyFields,
    ...zaiPolicyFields.map((name) => `messages[].${name}`),
    ...zaiPolicyFields.map((name) => `tools[].function.${name}`),
    `${zaiPolicyFields.join('.')}`,
    `${zaiPolicyFields.join('[].')}[]`,
  ]
  const answer = (kind: GatewayRefusal, field?: string) => {
    const refusal = zaiRefusal(kind)
    const payload = decode(refusal.body) as { error: Record<string, string> }
    if (field) payload.error.field = field
    return {
      status: refusal.status,
      message: payload.error.message!,
      body: JSON.stringify(payload),
      code: payload.error.code,
    }
  }

  it.each(finals)('ends the turn in one request on %s, with any field of the policy', (kind) => {
    for (const field of fields) {
      const sent = answer(kind, field)
      expect(cliRetriesHttp(sent), `${kind} ${field}`).toBe(false)
      expect(cliReadsOverflow(sent), `${kind} ${field}`).toBe(false)
      // The same refusal as an event of a started stream.
      const event = { ...decode(zaiRefusal(kind).body).error, ...(field ? { field } : {}) }
      expect(cliRetriesStreamError(event), `${kind} ${field}`).toBe(false)
    }
  })

  it('is repeated by the CLI when short-lived, and never taken for a context overflow', () => {
    for (const field of fields) {
      const sent = answer('transient', field)
      expect(cliRetriesHttp(sent)).toBe(true)
      expect(cliReadsOverflow(sent)).toBe(false)
    }
    expect(cliRetriesStreamError(decode(zaiRefusal('transient').body).error)).toBe(true)
  })

  it('names fields of the policy without a digit', () => {
    for (const name of zaiPolicyFields) expect(name).toMatch(/^[a-z_]+$/)
  })
})
