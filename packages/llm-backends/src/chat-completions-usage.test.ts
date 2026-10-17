import { readFileSync } from 'node:fs'
import { meterResultSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createChatCompletionsUsageMeter } from './chat-completions-usage.ts'
import { zaiCodingBackend } from './zai-coding/backend.ts'

const bytes = (value: string) => new TextEncoder().encode(value)
const frame = (value: unknown) => bytes(`data: ${JSON.stringify(value)}\n\n`)
const usage = { prompt_tokens: 100, cached_tokens: 60, completion_tokens: 40 }
// The meter takes the inspector of its adapter: here the one of the plan.
const createMeter = () => createChatCompletionsUsageMeter(zaiCodingBackend.streamInspector)
const fixture = readFileSync(new URL('./fixtures/chat-completions-completed.sse', import.meta.url))

describe('chat completions usage meter', () => {
  it.each([1, 2, 7, 63, 1024, 65536])(
    'accepts the trailing usage chunk with chunk size %s',
    (size) => {
      const meter = createMeter()
      for (let i = 0; i < fixture.length; i += size) meter.push(fixture.subarray(i, i + size))
      const result = meter.end()
      expect(result).toEqual({
        usage: { input: 100, cacheRead: 60, cacheWrite: 0, output: 40, reasoning: 30 },
        outcome: 'completed',
        signal: null,
        usageIssue: null,
        deltaTextBytes: bytes('Готовомысль{"a":1}').length,
      })
      expect(meterResultSchema.parse(result)).toEqual(result)
    },
  )

  it.each(['root', 'choice'])('accepts %s usage with top-level cached_tokens', (location) => {
    const meter = createMeter()
    const choice = { delta: {}, finish_reason: 'stop', ...(location === 'choice' ? { usage } : {}) }
    meter.push(frame({ choices: [choice], ...(location === 'root' ? { usage } : {}) }))
    expect(meter.end()).toMatchObject({
      outcome: 'completed',
      usage: { input: 100, cacheRead: 60, cacheWrite: 0, output: 40, reasoning: 0 },
    })
  })

  it.each([
    [{ ...usage, prompt_tokens_details: null, completion_tokens_details: null }, 60, 0],
    [{ ...usage, cached_tokens: undefined, prompt_tokens_details: null }, 0, 0],
    [{ ...usage, completion_tokens_details: null }, 60, 0],
    [{ ...usage, completion_tokens_details: { reasoning_tokens: 30 } }, 60, 30],
  ])('reads null token details as none reported: %j', (raw, cacheRead, reasoning) => {
    const meter = createMeter()
    meter.push(frame({ usage: raw, choices: [{ finish_reason: 'stop' }] }))
    const result = meter.end()
    expect(result).toMatchObject({
      outcome: 'completed',
      usageIssue: null,
      usage: { input: 100, cacheRead, cacheWrite: 0, output: 40, reasoning },
    })
    expect(meterResultSchema.parse(result)).toEqual(result)
  })

  it('preserves usage received before a disconnect without reporting successful completion', () => {
    const meter = createMeter()
    meter.push(frame({ choices: [{ delta: { content: 'x' }, finish_reason: null }], usage }))
    const result = meter.end()
    expect(result).toMatchObject({ outcome: 'incomplete', usageIssue: null, usage: { input: 100 } })
    expect(meterResultSchema.parse(result)).toEqual(result)
  })

  it('keeps the final usage sample, without adding cumulative snapshots', () => {
    const meter = createMeter()
    meter.push(frame({ usage: { ...usage, completion_tokens: 10 } }))
    meter.push(frame({ choices: [{ finish_reason: 'stop' }], usage }))
    expect(meter.end().usage?.output).toBe(40)
  })

  it.each([
    'secret-marker',
    [],
    {},
    { ...usage, cached_tokens: 101 },
    { ...usage, prompt_tokens: -1 },
    { ...usage, completion_tokens: 0.1 },
    { ...usage, completion_tokens: '40' },
    { ...usage, cached_tokens: null },
    { ...usage, completion_tokens_details: { reasoning_tokens: 41 } },
  ])('marks invalid usage independently of a completed terminal: %j', (raw) => {
    const meter = createMeter()
    meter.push(frame({ usage: raw, choices: [{ finish_reason: 'stop' }] }))
    expect(meter.end()).toMatchObject({
      outcome: 'completed',
      usage: null,
      usageIssue: 'invalid_usage',
    })
  })

  it('does not hide an invalid last usage behind an earlier valid sample', () => {
    const meter = createMeter()
    meter.push(frame({ usage }))
    meter.push(frame({ usage: {}, choices: [{ finish_reason: 'stop' }] }))
    expect(meter.end()).toMatchObject({ usage: null, usageIssue: 'invalid_usage' })
  })

  it('keeps a finish_reason terminal without DONE and without usage', () => {
    const meter = createMeter()
    meter.push(frame({ choices: [{ finish_reason: 'stop' }] }))
    expect(meter.end()).toMatchObject({ outcome: 'completed', usage: null, usageIssue: 'no_usage' })
  })

  it('keeps the first terminal despite trailing errors and choices, while accepting trailing usage', () => {
    const meter = createMeter()
    meter.push(frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage }))
    meter.push(frame({ error: { code: 'unknown', message: 'synthetic-secret' } }))
    meter.push(
      frame({
        choices: [
          {
            delta: { content: 'ignored', reasoning_content: 'ignored' },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    meter.push(frame({ choices: [], usage: { ...usage, completion_tokens: 41 } }))
    expect(meter.end()).toMatchObject({
      outcome: 'completed',
      signal: null,
      usageIssue: null,
      deltaTextBytes: 1,
      usage: { input: 100, cacheRead: 60, cacheWrite: 0, output: 41, reasoning: 0 },
    })
  })

  it('validates trailing usage even after the terminal is fixed', () => {
    const meter = createMeter()
    meter.push(frame({ choices: [{ finish_reason: 'stop' }], usage }))
    meter.push(frame({ choices: [], usage: { ...usage, completion_tokens: -1 } }))
    expect(meter.end()).toMatchObject({
      outcome: 'completed',
      usage: null,
      usageIssue: 'invalid_usage',
    })
  })

  it('does not treat DONE without finish_reason or a partial finish frame as success', () => {
    const meter = createMeter()
    meter.push(bytes('data: [DONE]\n\n'))
    // What such an end is called is the inspector's rule (zai-coding/stream.test.ts): a failure.
    expect(meter.end().outcome).toBe('failed')
    const partial = createMeter()
    partial.push(bytes('data: {"choices":[{"finish_reason":"stop"}]}\n'))
    expect(partial.end().outcome).toBe('incomplete')
  })

  it('retains a structured unknown stream error as failed without exposing its message', () => {
    const meter = createMeter()
    meter.push(frame({ error: { message: 'secret-marker', code: 'unknown' } }))
    // The signal of the failure is the inspector's to name; the meter carries it and no text.
    expect(meter.end()).toMatchObject({ outcome: 'failed', usage: null })
    expect(JSON.stringify(meter.end())).not.toContain('secret-marker')
  })

  it('ignores post-DONE data without double-counting', () => {
    const meter = createMeter()
    meter.push(fixture)
    const before = meter.end()
    meter.push(fixture)
    expect(meter.end()).toEqual(before)
  })
})

describe('a failure inside a chat completions stream', () => {
  const complete =
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":999,"completion_tokens":888}}\n\ndata: [DONE]\n\n'

  it('stops accounting at the first failure in a shared chunk', () => {
    for (const failure of [
      'event: error\ndata: {"type":"error","error":"SECRET"}\n\n',
      'data: {"error":{"message":"SECRET"}}\n\n',
      'data: {"error":"SECRET"}\n\n',
    ]) {
      const meter = createMeter()
      meter.push(Buffer.from(failure + complete))
      expect(meter.end()).toMatchObject({
        outcome: 'failed',
        usage: null,
        usageIssue: 'no_usage',
      })
      expect(JSON.stringify(meter.end())).not.toContain('SECRET')
    }
  })

  it('never counts events after invalid JSON', () => {
    const meter = createMeter()
    meter.push(Buffer.from('data: {\n\n' + complete))
    expect(meter.end()).toMatchObject({ outcome: 'incomplete', usage: null })
  })
})
