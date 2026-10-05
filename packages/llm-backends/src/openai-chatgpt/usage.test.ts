import { readFileSync } from 'node:fs'
import { meterResultSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createCodexUsageMeter } from './usage.ts'

const bytes = (value: string) => new TextEncoder().encode(value)
const frame = (value: unknown) => bytes(`data: ${JSON.stringify(value)}\n\n`)
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 30 },
}
const normalized = { input: 100, cacheRead: 60, cacheWrite: 10, output: 40, reasoning: 30 }
const fixture = readFileSync(new URL('./fixtures/completed.sse', import.meta.url))

describe('Codex usage meter', () => {
  it.each([1, 2, 7, 63, 1024, 65536])(
    'counts only deltas and terminal usage with chunk size %s',
    (size) => {
      const meter = createCodexUsageMeter()
      for (let i = 0; i < fixture.length; i += size) meter.push(fixture.subarray(i, i + size))
      const result = meter.end()
      expect(result).toEqual({
        usage: normalized,
        outcome: 'completed',
        signal: null,
        usageIssue: null,
        deltaTextBytes: bytes('Привет 🙂{"a":1}').length,
      })
      expect(meterResultSchema.parse(result)).toEqual(result)
    },
  )

  it('accepts absent optional counters and ignores unrelated provider metadata', () => {
    const meter = createCodexUsageMeter()
    meter.push(
      frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 2, output_tokens: 1, attribution: 'synthetic-secret' } },
      }),
    )
    expect(meter.end().usage).toEqual({
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(JSON.stringify(meter.end())).not.toContain('synthetic-secret')
  })

  it.each([undefined, null])('keeps missing usage explicit: %j', (raw) => {
    const meter = createCodexUsageMeter()
    meter.push(frame({ type: 'response.completed', response: { usage: raw } }))
    expect(meter.end()).toMatchObject({ outcome: 'completed', usage: null, usageIssue: 'no_usage' })
  })

  it.each([
    'secret-marker',
    [],
    {},
    { ...usage, input_tokens: 69 },
    { ...usage, input_tokens: -1 },
    { ...usage, output_tokens: 0.5 },
    { ...usage, output_tokens: '40' },
    { ...usage, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...usage, output_tokens_details: { reasoning_tokens: 41 } },
    { ...usage, input_tokens_details: null },
    { ...usage, input_tokens_details: { cached_tokens: null } },
  ])('separates invalid usage from absent usage: %j', (raw) => {
    const meter = createCodexUsageMeter()
    meter.push(frame({ type: 'response.completed', response: { usage: raw } }))
    expect(meter.end()).toMatchObject({
      outcome: 'completed',
      usage: null,
      usageIssue: 'invalid_usage',
    })
  })

  it.each([
    ['cyber_policy', { kind: 'policy_flagged', code: 'cyber_policy' }],
    ['bio_policy', { kind: 'policy_flagged', code: 'bio_policy' }],
    ['rate_limit_exceeded', { kind: 'transient', retryAfterMs: 30000 }],
    ['usage_limit_reached', { kind: 'window_exhausted', until: null }],
    ['unknown-secret-code', null],
  ])('retains only an allowlisted failure signal: %s', (code, signal) => {
    const meter = createCodexUsageMeter()
    meter.push(
      frame({ type: 'response.failed', response: { error: { code, message: 'secret-marker' } } }),
    )
    const result = meter.end()
    expect(result).toMatchObject({ outcome: 'failed', signal, usage: null, usageIssue: 'no_usage' })
    expect(meterResultSchema.parse(result)).toEqual(result)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('treats explicit response.incomplete as a failed terminal, not a disconnected stream', () => {
    const meter = createCodexUsageMeter()
    meter.push(frame({ type: 'response.incomplete', response: { usage } }))
    expect(meter.end()).toMatchObject({ outcome: 'failed', signal: null, usage: normalized })
  })

  it('keeps a committed terminal on client close and ignores repeated output/terminals', () => {
    const meter = createCodexUsageMeter()
    meter.push(fixture)
    meter.push(frame({ type: 'response.failed', response: {} }))
    meter.push(Uint8Array.of(255, 10))
    const first = meter.end()
    first.usage!.input = 999
    expect(meter.end().usage).toEqual(normalized)
    expect(meter.end().outcome).toBe('completed')
  })

  it('never invents a terminal from malformed JSON or a partial frame', () => {
    const meter = createCodexUsageMeter()
    meter.push(bytes('data: not-json\n\n'))
    meter.push(frame({ type: { toString: 'not a method' } }))
    meter.push(frame({ type: 'response.completed' }))
    meter.push(
      bytes(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n`),
    )
    expect(meter.end()).toMatchObject({
      outcome: 'incomplete',
      usage: null,
      usageIssue: 'no_usage',
    })
  })
})
