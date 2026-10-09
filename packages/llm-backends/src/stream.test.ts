import { describe, expect, it } from 'vitest'

import { kimiCodeBackend } from './kimi-code/backend.ts'
import { codexBackend } from './openai-chatgpt/backend.ts'
import { zaiCodingBackend } from './zai-coding/backend.ts'

describe('CLI header profiles', () => {
  it('accepts the pinned Codex clients and rejects arbitrary or future versions', () => {
    for (const ua of [
      'codex_exec/0.158.0',
      'codex_cli_rs/0.159.1 (Mac OS 26.0; arm64)',
      'codex_exec/0.154.0',
    ])
      expect(() =>
        codexBackend.validateClientHeaders(new Headers({ 'user-agent': ua })),
      ).not.toThrow()
    for (const ua of [
      '',
      'synthetic-codex',
      'codex_exec/0.158.1',
      'codex_exec/0.999.0',
      'codex_exec/0.158.0 extra',
    ])
      expect(() => codexBackend.validateClientHeaders(new Headers({ 'user-agent': ua }))).toThrow()
    expect(() =>
      codexBackend.validateClientHeaders(
        new Headers({
          'user-agent': 'codex_exec/0.158.0',
          'x-openai-internal-codex-responses-lite': 'false',
        }),
      ),
    ).toThrow()
  })

  it('keeps the Kimi CLI identity and bounds platform metadata', () => {
    expect(() =>
      kimiCodeBackend.validateClientHeaders(new Headers({ 'user-agent': 'kimi-code-cli/2.1.1' })),
    ).not.toThrow()
    for (const ua of ['codex_exec/0.158.0', 'kimi-code-cli/2.2.0', 'kimi-code-cli/2.1.1 spoofed'])
      expect(() =>
        kimiCodeBackend.validateClientHeaders(new Headers({ 'user-agent': ua })),
      ).toThrow()
    expect(() =>
      kimiCodeBackend.validateClientHeaders(
        new Headers({
          'user-agent': 'kimi-code-cli/2.1.1',
          'x-msh-platform': 'x'.repeat(257),
        }),
      ),
    ).toThrow()
  })
})

describe('native stream failure envelopes', () => {
  it.each(['response.failed', 'response.incomplete'])(
    'sanitizes failure event %s without trusting a data type',
    (eventName) => {
      const result = codexBackend.streamInspector().inspect({
        event: eventName,
        data: JSON.stringify({
          response: { status: 'incomplete', incomplete_details: { reason: 'SECRET_METADATA' } },
        }),
      })
      expect(result.kind).toBe('failure')
      if (result.kind === 'failure') expect(result.event.data).not.toContain('SECRET_METADATA')
    },
  )

  it.each([codexBackend, kimiCodeBackend, zaiCodingBackend])(
    'stops %s accounting at the first failure in a shared chunk',
    (backend) => {
      const complete =
        backend === codexBackend
          ? 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":999,"output_tokens":888}}}\n\n'
          : 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":999,"completion_tokens":888}}\n\ndata: [DONE]\n\n'
      for (const failure of [
        'event: error\ndata: {"type":"error","error":"SECRET"}\n\n',
        'data: {"error":{"message":"SECRET"}}\n\n',
        'data: {"error":"SECRET"}\n\n',
      ]) {
        const meter = backend.usageMeter()
        meter.push(Buffer.from(failure + complete))
        expect(meter.end()).toMatchObject({
          outcome: 'failed',
          usage: null,
          usageIssue: 'no_usage',
        })
        expect(JSON.stringify(meter.end())).not.toContain('SECRET')
      }
    },
  )

  it.each([codexBackend, kimiCodeBackend, zaiCodingBackend])(
    'never counts events after invalid JSON for %s',
    (backend) => {
      const meter = backend.usageMeter()
      const complete =
        backend === codexBackend
          ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":999,"output_tokens":888}}}\n\n'
          : 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":999,"completion_tokens":888}}\n\ndata: [DONE]\n\n'
      meter.push(Buffer.from('data: {\n\n' + complete))
      expect(meter.end()).toMatchObject({ outcome: 'incomplete', usage: null })
    },
  )

  it('keeps failed native Codex usage before dropping later successful usage', () => {
    const meter = codexBackend.usageMeter()
    meter.push(
      Buffer.from(
        'event: response.failed\ndata: {"response":{"error":{"code":"usage_limit_reached"},"usage":{"input_tokens":3,"output_tokens":2}}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":999,"output_tokens":888}}}\n\n',
      ),
    )
    expect(meter.end()).toMatchObject({
      outcome: 'failed',
      usage: { input: 3, output: 2 },
      signal: { kind: 'window_exhausted' },
    })
  })
  it('sanitizes Codex failures while retaining their structural classification', () => {
    // A reset within the weekly horizon of a signal that names no window.
    const reset = Math.floor(Date.now() / 1000) + 3 * 86_400
    const inspector = codexBackend.streamInspector()
    const result = inspector.inspect({
      event: 'response.failed',
      data: JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'provider-private-id',
          error: {
            code: 'usage_limit_reached',
            message: 'SECRET_TOKEN plan=pro account-private',
            resets_at: reset,
          },
        },
      }),
    })
    expect(result.kind).toBe('failure')
    if (result.kind !== 'failure') throw new Error('Missing failure envelope')
    expect(result.signal).toEqual({ kind: 'window_exhausted', until: new Date(reset * 1000) })
    expect(JSON.parse(result.event.data)).toEqual({
      type: 'response.failed',
      response: {
        id: 'raditi_failure',
        status: 'failed',
        error: {
          type: 'usage_limit_reached',
          code: 'insufficient_quota',
          message: 'Subscription capacity unavailable',
        },
      },
    })
    expect(result.event.data).not.toMatch(
      new RegExp(`SECRET_TOKEN|plan=pro|account-private|provider-private|${reset}`),
    )
    expect(inspector.inspect({ event: 'error', data: '{"error":"late-secret"}' })).toEqual({
      kind: 'skip',
    })
  })

  it('keeps a failed Codex stream exhausted but drops a reset no window can have', () => {
    const failed = (resets_at: number) =>
      codexBackend.streamInspector().inspect({
        event: 'response.failed',
        data: JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'usage_limit_reached', resets_at } },
        }),
      })
    // Milliseconds where seconds are expected: the year 255479 is not a reset.
    expect(failed(8_000_000_000_000)).toMatchObject({
      kind: 'failure',
      signal: { kind: 'window_exhausted', until: null },
    })
    expect(failed(Math.floor(Date.now() / 1000) + 9 * 86_400)).toMatchObject({
      signal: { kind: 'window_exhausted', until: null },
    })
  })

  // Codex CLI 0.158.0 reconnects `stream_max_retries` times after `response.failed` unless
  // `error.code` is one it ends the turn on; `error.type` and unknown codes do not count.
  // Measured with the pinned CLI on a loopback provider and kept proven by verify:llm-gateway.
  it.each([
    ['cyber_policy', 'policy_flagged', 'invalid_prompt', 'Request rejected by content policy'],
    ['bio_policy', 'policy_flagged', 'invalid_prompt', 'Request rejected by content policy'],
    ['invalid_prompt', 'policy_flagged', 'invalid_prompt', 'Request rejected by content policy'],
    [
      'misalignment_policy_violation',
      'policy_flagged',
      'invalid_prompt',
      'Request rejected by content policy',
    ],
    [
      'usage_limit_reached',
      'window_exhausted',
      'insufficient_quota',
      'Subscription capacity unavailable',
    ],
    [
      'insufficient_quota',
      'account_risk',
      'insufficient_quota',
      'Subscription account unavailable',
    ],
    [
      'usage_not_included',
      'account_risk',
      'insufficient_quota',
      'Subscription account unavailable',
    ],
    [
      'unsupported_country_region_territory',
      'region',
      'insufficient_quota',
      'Provider connection unavailable',
    ],
  ])(
    'sends a final Codex stream failure %s as a code the CLI does not retry',
    (code, kind, sent, message) => {
      const result = codexBackend.streamInspector().inspect({
        event: 'response.failed',
        data: JSON.stringify({
          type: 'response.failed',
          response: { id: 'resp_private', error: { code, message: 'SECRET provider text' } },
        }),
      })
      if (result.kind !== 'failure') throw new Error('Missing failure envelope')
      expect(result.signal.kind).toBe(kind)
      const error = JSON.parse(result.event.data).response.error
      expect(error.code).toBe(sent)
      expect(error.message).toBe(message)
      expect(result.event.data).not.toMatch(/raditi_(?!failure)|SECRET|resp_private/)
    },
  )

  it('ends the turn on a context overflow without pausing or probing the account', () => {
    const result = codexBackend.streamInspector().inspect({
      event: 'response.failed',
      data: JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'context_length_exceeded', message: 'SECRET provider text' } },
      }),
    })
    if (result.kind !== 'failure') throw new Error('Missing failure envelope')
    // Neither `transient` (an account pause and CLI reconnects) nor an account-level signal,
    // and not `profile`: the model is available, this request does not fit it.
    expect(result.signal).toEqual({ kind: 'request_rejected', code: 'context_length_exceeded' })
    expect(JSON.parse(result.event.data).response.error).toEqual({
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: 'Request rejected by the provider',
    })
  })

  it.each(['rate_limit_exceeded', 'server_is_overloaded', 'slow_down', 'not_in_any_list'])(
    'keeps the short-lived Codex stream failure %s retryable by the CLI',
    (code) => {
      const result = codexBackend.streamInspector().inspect({
        event: 'response.failed',
        data: JSON.stringify({ type: 'response.failed', response: { error: { code } } }),
      })
      if (result.kind !== 'failure') throw new Error('Missing failure envelope')
      expect(result.signal).toEqual({ kind: 'transient', retryAfterMs: 30_000 })
      expect(JSON.parse(result.event.data).response.error).toEqual({
        type: 'server_error',
        code: 'raditi_transient',
        message: 'Service temporarily unavailable',
      })
    },
  )

  it('sanitizes unknown string errors and incomplete Codex terminals', () => {
    for (const value of [
      { error: 'SECRET' },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'SECRET' },
        },
      },
    ]) {
      const result = codexBackend
        .streamInspector()
        .inspect({ event: 'message', data: JSON.stringify(value) })
      expect(result.kind).toBe('failure')
      if (result.kind === 'failure') {
        expect(result.signal.kind).toBe('transient')
        expect(result.event.data).not.toContain('SECRET')
      }
    }
  })

  it('forwards successful Codex events and ignores events after completion', () => {
    const inspector = codexBackend.streamInspector()
    const event = {
      event: 'response.completed',
      data: '{"type":"response.completed","response":{"usage":{"input_tokens":2}}}',
    }
    expect(inspector.inspect(event)).toEqual({ kind: 'forward', event, terminal: true })
    expect(inspector.inspect({ event: 'error', data: '{"error":{"message":"SECRET"}}' })).toEqual({
      kind: 'skip',
    })
  })

  // Kimi CLI 2.1.1 retries every in-stream error object (up to 10 attempts, each a provider
  // request), whatever its type, code or text. The one in-stream shape it ends the turn on is a
  // choice stopped by the provider's filter. Measured with the pinned CLI on a loopback provider.
  it.each([
    [
      'The request was rejected because it was considered high risk',
      { kind: 'policy_flagged', code: 'high_risk' },
    ],
    ['Invalid Authentication', { kind: 'auth' }],
    [
      'Your current plan supports only k3 up to 256K context. 1M context is available on higher-tier Kimi Code plans. Upgrade: https://www.kimi.com/code?from=server_k3_error#pricing',
      { kind: 'profile', code: 'model_access' },
    ],
    [
      "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
      { kind: 'window_exhausted', until: null },
    ],
    [
      "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
      { kind: 'account_risk', reason: 'concurrent_request_limit' },
    ],
  ])(
    'ends the Kimi turn on the final stream failure %#, as a filtered choice',
    (message, signal) => {
      const inspector = kimiCodeBackend.streamInspector()
      const result = inspector.inspect({
        event: 'message',
        data: JSON.stringify({
          error: { message, type: 'SECRET_TYPE', account: 'SECRET_ACCOUNT' },
        }),
      })
      if (result.kind !== 'failure') throw new Error('Missing failure envelope')
      expect(result.signal).toEqual(signal)
      expect(result.event).toEqual({
        event: 'message',
        data: '{"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}',
      })
      expect(inspector.inspect({ event: 'message', data: '[DONE]' })).toEqual({ kind: 'skip' })
    },
  )

  it('keeps an unrecognized Kimi stream failure retryable and scrubbed', () => {
    for (const event of [
      { event: 'error', data: '{"error":"SECRET"}' },
      {
        event: 'message',
        data: '{"error":{"type":"engine_overloaded_error","message":"SECRET overloaded"}}',
      },
    ]) {
      const result = kimiCodeBackend.streamInspector().inspect(event)
      if (result.kind !== 'failure') throw new Error('Missing failure envelope')
      expect(result.signal).toEqual({ kind: 'transient', retryAfterMs: 30_000 })
      expect(JSON.parse(result.event.data)).toEqual({
        error: {
          type: 'server_error',
          code: 'raditi_transient',
          message: 'Service temporarily unavailable.',
        },
      })
    }
  })

  it('keeps Kimi tail usage and DONE while dropping a late error after finish_reason', () => {
    const inspector = kimiCodeBackend.streamInspector()
    const finish = { event: 'message', data: '{"choices":[{"finish_reason":"stop"}]}' }
    const usage = { event: 'message', data: '{"usage":{"prompt_tokens":5,"completion_tokens":2}}' }
    expect(inspector.inspect(finish)).toEqual({ kind: 'forward', event: finish })
    expect(inspector.inspect({ event: 'error', data: '{"error":{"message":"SECRET"}}' })).toEqual({
      kind: 'skip',
    })
    expect(inspector.inspect(usage)).toEqual({ kind: 'forward', event: usage })
    expect(inspector.inspect({ event: 'message', data: '[DONE]' }).kind).toBe('forward')
    expect(inspector.inspect(usage)).toEqual({ kind: 'skip' })
  })

  it('rejects malformed or non-object event data without reflecting it', () => {
    for (const backend of [codexBackend, kimiCodeBackend]) {
      for (const data of ['{', '"SECRET"', '{"__proto__":{}}'])
        expect(backend.streamInspector().inspect({ event: 'message', data })).toEqual({
          kind: 'invalid',
        })
    }
  })
})
