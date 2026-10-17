import { callSignalSchema, meterResultSchema, type LlmStreamInspection } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createChatCompletionsUsageMeter } from '../chat-completions-usage.ts'
import { createSseDecoder, type SseEvent } from '../sse.ts'
import { cliReadsOverflow, cliRetriesStreamError } from './fixtures/opencode-cli.ts'
import { chatSamples, liveSamples, sample } from './fixtures/samples.ts'
import { zaiCodingPlan } from './backend.ts'
import { createZaiStreamInspector as inspectorOf } from './stream.ts'

// The inspector of the plan; what the pay-per-token API reads otherwise is in backend.test.ts.
const createZaiStreamInspector = () => inspectorOf(zaiCodingPlan.answers)

const bytes = (text: string) => new TextEncoder().encode(text)
const frame = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const chunk = (delta: object, finish?: string, usage?: object) => ({
  id: '202601010000000000000000000001',
  created: 1767225600,
  object: 'chat.completion.chunk',
  model: 'glm-5.3',
  choices: [{ index: 0, ...(finish === undefined ? {} : { finish_reason: finish }), delta }],
  ...(usage ? { usage } : {}),
})
const text = chunk({ role: 'assistant', content: 'Partial answer of the stand. ' })
const usage = {
  prompt_tokens: 19,
  completion_tokens: 64,
  total_tokens: 83,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 61 },
}
const last = (finish: string) => chunk({ role: 'assistant', content: '' }, finish, usage)

/** What the role does with a stream: every event through the inspector, then the clean end. */
function run(stream: string) {
  const inspector = createZaiStreamInspector()
  const sent: SseEvent[] = []
  const inspections: LlmStreamInspection[] = []
  let stopped = false
  const decoder = createSseDecoder((event) => {
    const inspected = inspector.inspect(event)
    inspections.push(inspected)
    if (inspected.kind === 'forward' || inspected.kind === 'failure') sent.push(inspected.event)
    if (inspected.kind === 'failure' || (inspected.kind === 'forward' && inspected.terminal)) {
      stopped = true
      return false
    }
  })
  decoder.push(bytes(stream))
  decoder.end()
  if (!stopped) {
    const ending = inspector.end!()
    if (ending) {
      inspections.push(ending)
      sent.push(ending.event)
    }
  }
  const failures = inspections.filter((item) => item.kind === 'failure')
  return { sent, inspections, failures, inspector }
}
const errorOf = (event: SseEvent) =>
  (JSON.parse(event.data) as { error: { type: string; code: string; message: string } }).error

describe('recorded Z.ai streams', () => {
  it.each(Object.values(chatSamples))('passes %s through event for event', (name) => {
    const stream = sample(name).response.sse!
    const { sent, failures, inspections } = run(stream)
    expect(failures).toEqual([])
    expect(sent.map((event) => `data: ${event.data}\n\n`).join('')).toBe(stream)
    expect(inspections.at(-1)).toEqual({
      kind: 'forward',
      event: { event: 'message', data: '[DONE]' },
      terminal: true,
    })
  })

  it.each([
    [chatSamples.twoToolCalls, { input: 7105, cacheRead: 6784, output: 94, reasoning: 54 }],
    [chatSamples.withoutTools, { input: 584, cacheRead: 512, output: 99, reasoning: 89 }],
    [chatSamples.mcpToolCall, { input: 4193, cacheRead: 4032, output: 25, reasoning: 0 }],
    [chatSamples.plainText, { input: 5579, cacheRead: 0, output: 3, reasoning: 0 }],
  ])('meters %s by the numbers of the provider, in any chunking', (name, expected) => {
    const stream = bytes(sample(name).response.sse!)
    for (const size of [1, 7, 1024, stream.length]) {
      const meter = createChatCompletionsUsageMeter(createZaiStreamInspector)
      for (let at = 0; at < stream.length; at += size) meter.push(stream.subarray(at, at + size))
      const result = meter.end()
      expect(result).toMatchObject({
        outcome: 'completed',
        signal: null,
        usageIssue: null,
        // Reasoning is counted inside the completion, the cache inside the prompt.
        usage: { ...expected, cacheWrite: 0 },
      })
      expect(result.deltaTextBytes).toBeGreaterThan(0)
      expect(meterResultSchema.safeParse(result).success).toBe(true)
    }
  })
})

describe('an answer of the real model with text beside a tool call', () => {
  // The form no scripted answer had until the live run showed it (docs/plan/45-zai-live.md).
  const recorded = sample(liveSamples.textBesideToolCall).response.sse!
  // What the record itself says, read without the meter and the inspector.
  const payloads = recorded
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      expect(block.startsWith('event: message\ndata: ')).toBe(true)
      return block.slice('event: message\ndata: '.length)
    })
  interface Chunk {
    choices: {
      finish_reason?: string
      delta: {
        content?: string
        reasoning_content?: string
        tool_calls?: { function: { name: string; arguments: string } }[]
      }
    }[]
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      prompt_tokens_details: { cached_tokens: number }
      completion_tokens_details: { reasoning_tokens: number }
    }
  }
  const chunks = payloads.slice(0, -1).map((data) => JSON.parse(data) as Chunk)
  const deltas = chunks.map((chunk) => chunk.choices[0]!.delta)
  const said = deltas.map((delta) => delta.content ?? '').join('')
  const thought = deltas.map((delta) => delta.reasoning_content ?? '').join('')
  const called = deltas.flatMap((delta) => delta.tool_calls ?? [])
  const counted = chunks.flatMap((chunk) => (chunk.usage ? [chunk.usage] : []))

  it('holds the form: reasoning, a sentence and one tool call, finished as tool_calls', () => {
    expect(payloads.at(-1)).toBe('[DONE]')
    expect(said.trim().length).toBeGreaterThan(100)
    expect(thought.length).toBeGreaterThan(0)
    expect(called.map((call) => call.function.name)).toEqual(['raditi_wp_rest'])
    expect(chunks.flatMap((chunk) => chunk.choices[0]!.finish_reason ?? [])).toEqual(['tool_calls'])
    // The sentence comes before the call, and the finish reason with the usage after both.
    const firstCall = deltas.findIndex((delta) => delta.tool_calls)
    expect(deltas.findLastIndex((delta) => (delta.content ?? '') !== '')).toBeLessThan(firstCall)
    expect(counted).toHaveLength(1)
    expect(chunks.at(-1)!.usage).toBe(counted[0])
  })

  it('goes to the CLI event for event, with no failure and no signal', () => {
    const { sent, failures, inspections } = run(recorded)
    expect(failures).toEqual([])
    expect(sent.map((event) => event.data)).toEqual(payloads)
    expect(inspections.every((item) => item.kind === 'forward')).toBe(true)
    expect(inspections.at(-1)).toEqual({
      kind: 'forward',
      event: { event: 'message', data: '[DONE]' },
      terminal: true,
    })
  })

  it('is metered by the usage of the record itself, in any chunking and either framing', () => {
    const usage = counted[0]!
    const expected = {
      input: usage.prompt_tokens,
      cacheRead: usage.prompt_tokens_details.cached_tokens,
      cacheWrite: 0,
      output: usage.completion_tokens,
      reasoning: usage.completion_tokens_details.reasoning_tokens,
    }
    // The numbers of the record, written out: the provider counted the sentence and the call
    // in one completion.
    expect(expected).toEqual({
      input: 5084,
      cacheRead: 4928,
      cacheWrite: 0,
      output: 436,
      reasoning: 266,
    })
    const text = said + thought + called.map((call) => call.function.arguments).join('')
    // As the sandbox got it, and as the provider framed it for the role: `data:` lines alone.
    for (const framed of [recorded, payloads.map((data) => `data: ${data}\n\n`).join('')]) {
      const stream = bytes(framed)
      for (const size of [1, 7, 1024, stream.length]) {
        const meter = createChatCompletionsUsageMeter(createZaiStreamInspector)
        for (let at = 0; at < stream.length; at += size) meter.push(stream.subarray(at, at + size))
        const result = meter.end()
        expect(result).toEqual({
          outcome: 'completed',
          signal: null,
          usage: expected,
          usageIssue: null,
          // The sentence, the reasoning and the arguments of the call: all three were read.
          deltaTextBytes: bytes(text).byteLength,
        })
        expect(meterResultSchema.safeParse(result).success).toBe(true)
      }
    }
  })
})

describe('finish_reason of a Z.ai stream', () => {
  it.each(['stop', 'tool_calls', 'length'])('forwards %s', (finish) => {
    const { sent, failures } = run(frame(text) + frame(last(finish)) + frame('[DONE]'))
    expect(failures).toEqual([])
    expect(sent).toHaveLength(3)
    expect(JSON.parse(sent[1]!.data)).toEqual(last(finish))
  })

  it.each([
    [
      'sensitive',
      { kind: 'policy_flagged', code: 'zai_finish_sensitive' },
      'raditi_policy_flagged',
    ],
    [
      'content_filter',
      { kind: 'policy_flagged', code: 'zai_finish_content_filter' },
      'raditi_policy_flagged',
    ],
    [
      'model_context_window_exceeded',
      { kind: 'request_rejected', code: 'zai_finish_context_window' },
      'raditi_request_rejected',
    ],
    ['later_value', { kind: 'unconfirmed_block', code: 'zai_finish_reason' }, 'raditi_account'],
    ['STOP', { kind: 'unconfirmed_block', code: 'zai_finish_reason' }, 'raditi_account'],
  ] as const)('replaces %s by one final failure', (finish, signal, code) => {
    const { sent, failures } = run(frame(text) + frame(last(finish)) + frame('[DONE]'))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ signal })
    expect(callSignalSchema.safeParse(signal).success).toBe(true)
    // The text before it, then the error object: nothing of the refused chunk, no DONE.
    expect(sent).toHaveLength(2)
    expect(errorOf(sent[1]!)).toMatchObject({ type: 'invalid_request_error', code })
    expect(sent[1]!.data).not.toContain(finish)
    expect(cliRetriesStreamError(errorOf(sent[1]!))).toBe(false)
  })

  it('leaves a network error of the provider to the retries of the CLI', () => {
    const { sent, failures } = run(frame(text) + frame(last('network_error')) + frame('[DONE]'))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ signal: { kind: 'transient', retryAfterMs: 30_000 } })
    expect(errorOf(sent[1]!)).toMatchObject({ code: 'raditi_transient' })
    // Repeated with pauses, as the CLI does for its own `network_error`.
    expect(cliRetriesStreamError(errorOf(sent[1]!))).toBe(true)
    expect(sent[1]!.data).not.toContain('network_error')
  })

  it('refuses a finish_reason that is no string', () => {
    for (const finish of [1, true, { reason: 'stop' }, ['stop']]) {
      const value = chunk({ role: 'assistant', content: '' })
      ;(value.choices[0] as Record<string, unknown>).finish_reason = finish
      const { failures } = run(frame(value) + frame('[DONE]'))
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({
        signal: { kind: 'unconfirmed_block', code: 'zai_finish_reason' },
      })
    }
  })

  it('takes null and an empty string for a chunk that does not finish', () => {
    const open = chunk({ role: 'assistant', content: 'a' })
    for (const finish of [null, '']) {
      ;(open.choices[0] as Record<string, unknown>).finish_reason = finish
      const { failures, sent } = run(frame(open) + frame(last('stop')) + frame('[DONE]'))
      expect(failures).toEqual([])
      expect(sent).toHaveLength(3)
    }
  })
})

// docs/plan/40-opencode-spike.md, section 4: after each of these the CLI sends the same request
// again at once, thirteen times in a few seconds until the stand stops it.
describe('the forms the CLI answers with a request storm', () => {
  const partial = (finish: string) =>
    frame(chunk({ role: 'assistant', reasoning_content: 'Thinking.' })) +
    frame(text) +
    frame(last(finish)) +
    frame('[DONE]')
  const forms: [string, string][] = [
    ['finish_reason sensitive, with text', partial('sensitive')],
    ['finish_reason sensitive, without text', frame(last('sensitive')) + frame('[DONE]')],
    ['finish_reason model_context_window_exceeded', partial('model_context_window_exceeded')],
    ['a stream of DONE alone', frame('[DONE]')],
    ['text and DONE without a finish_reason', frame(text) + frame('[DONE]')],
    ['text without a finish_reason and without DONE', frame(text)],
    ['an empty stream', ''],
  ]

  it.each(forms)('turns %s into one final failure', (_name, stream) => {
    const { sent, failures } = run(stream)
    expect(failures).toHaveLength(1)
    // The last thing the sandbox reads is one error object, and nothing follows it.
    expect(sent.at(-1)).toBe(failures[0]!.event)
    const error = errorOf(sent.at(-1)!)
    expect(Object.keys(error)).toEqual(['type', 'code', 'message'])
    expect(error.type).toBe('invalid_request_error')
    expect(error.code).toMatch(/^raditi_(?:account|policy_flagged|request_rejected)$/)
    // The CLI ends the turn on it in one request: no word of its retry list, no overflow word.
    expect(cliRetriesStreamError(error)).toBe(false)
    expect(
      cliReadsOverflow({
        status: 200,
        message: JSON.stringify(error),
        body: JSON.stringify(error),
      }),
    ).toBe(false)
    // Neither a refused chunk nor a DONE reaches the sandbox.
    for (const event of sent) {
      expect(event.data).not.toBe('[DONE]')
      expect(event.data).not.toMatch(/sensitive|model_context_window_exceeded/)
    }
    expect(failures[0]!.signal.kind).not.toBe('transient')
    expect(callSignalSchema.safeParse(failures[0]!.signal).success).toBe(true)
  })

  it.each(forms)('meters %s as a failed call, never as a completed one', (_name, stream) => {
    const meter = createChatCompletionsUsageMeter(createZaiStreamInspector)
    meter.push(bytes(stream))
    const result = meter.end()
    expect(result.outcome).not.toBe('completed')
    expect(meterResultSchema.safeParse(result).success).toBe(true)
  })

  it('names a stream that ended without a finish_reason, by DONE or by its end', () => {
    for (const stream of [frame('[DONE]'), frame(text) + frame('[DONE]'), frame(text), '']) {
      const { failures } = run(stream)
      expect(failures[0]!.signal).toEqual({
        kind: 'unconfirmed_block',
        code: 'zai_stream_unfinished',
      })
    }
  })

  it('keeps the usage of a chunk it refuses: the provider has counted the call', () => {
    const meter = createChatCompletionsUsageMeter(createZaiStreamInspector)
    meter.push(bytes(frame(text) + frame(last('sensitive')) + frame('[DONE]')))
    expect(meter.end()).toMatchObject({
      outcome: 'failed',
      signal: { kind: 'policy_flagged', code: 'zai_finish_sensitive' },
      usage: { input: 19, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 61 },
      usageIssue: null,
    })
  })
})

describe('the end of a Z.ai stream', () => {
  it('asks for nothing after a finished stream without DONE, after a failure or after DONE', () => {
    const finished = createZaiStreamInspector()
    finished.inspect({ event: 'message', data: JSON.stringify(last('stop')) })
    expect(finished.end!()).toBeNull()

    const failed = createZaiStreamInspector()
    expect(failed.inspect({ event: 'message', data: '[DONE]' }).kind).toBe('failure')
    expect(failed.end!()).toBeNull()

    const complete = createZaiStreamInspector()
    complete.inspect({ event: 'message', data: JSON.stringify(last('stop')) })
    complete.inspect({ event: 'message', data: '[DONE]' })
    expect(complete.end!()).toBeNull()
  })

  it('answers the end once', () => {
    const inspector = createZaiStreamInspector()
    expect(inspector.end!()?.kind).toBe('failure')
    expect(inspector.end!()).toBeNull()
    expect(inspector.inspect({ event: 'message', data: JSON.stringify(text) })).toEqual({
      kind: 'skip',
    })
  })

  it('forwards a usage chunk and DONE after the finish_reason, and nothing after DONE', () => {
    const tail = { ...chunk({}), choices: [], usage }
    const { sent, failures, inspector } = run(
      frame(text) + frame(chunk({ content: '' }, 'stop')) + frame(tail) + frame('[DONE]'),
    )
    expect(failures).toEqual([])
    expect(sent).toHaveLength(4)
    expect(inspector.inspect({ event: 'message', data: JSON.stringify(text) })).toEqual({
      kind: 'skip',
    })
  })

  it('forwards a repeated finish_reason with its usage and drops one that contradicts the first', () => {
    const repeated = run(
      frame(chunk({ content: '' }, 'stop')) + frame(last('stop')) + frame('[DONE]'),
    )
    expect(repeated.failures).toEqual([])
    expect(repeated.sent).toHaveLength(3)
    const contradicting = run(frame(last('stop')) + frame(last('sensitive')) + frame('[DONE]'))
    expect(contradicting.failures).toEqual([])
    expect(contradicting.sent.map((event) => event.data)).toEqual([
      JSON.stringify(last('stop')),
      '[DONE]',
    ])
  })

  it('drops an object that is neither a completion chunk nor an error', () => {
    const { sent, failures } = run(
      frame({ type: 'ping', note: 'SECRET' }) + frame(last('stop')) + frame('[DONE]'),
    )
    expect(failures).toEqual([])
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent)).not.toContain('SECRET')
  })
})

describe('an error object inside a Z.ai stream', () => {
  const secret = 'SECRET provider text about account 42'

  it.each([
    [{ error: { code: '1308', message: secret } }, 'window_exhausted', 'raditi_subscription_limit'],
    [{ error: { code: '1301', message: secret } }, 'policy_flagged', 'raditi_policy_flagged'],
    [{ error: { code: '1311', message: secret } }, 'profile', 'raditi_profile'],
    [{ error: { code: '401', message: secret } }, 'auth', 'raditi_account'],
    [{ error: { code: '4242', message: secret } }, 'unconfirmed_block', 'raditi_account'],
    [{ error: secret }, 'unconfirmed_block', 'raditi_account'],
    [{ code: 500, msg: secret, success: false, error: {} }, 'unconfirmed_block', 'raditi_account'],
  ] as const)('ends the turn on %j without the text of the provider', (value, kind, code) => {
    const { sent, failures } = run(frame(text) + frame(value) + frame('[DONE]'))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.signal.kind).toBe(kind)
    expect(sent).toHaveLength(2)
    expect(errorOf(sent[1]!).code).toBe(code)
    expect(sent[1]!.data).not.toContain('SECRET')
    expect(cliRetriesStreamError(errorOf(sent[1]!))).toBe(false)
  })

  it('keeps a short-lived provider error repeatable', () => {
    const { sent, failures } = run(frame({ error: { code: '1305', message: secret } }))
    expect(failures[0]!.signal).toEqual({ kind: 'transient', retryAfterMs: 30_000 })
    expect(errorOf(sent[0]!).code).toBe('raditi_transient')
    expect(sent[0]!.data).not.toContain('SECRET')
    expect(cliRetriesStreamError(errorOf(sent[0]!))).toBe(true)
  })

  it('reads the HTTP 200 envelope of the monitor paths as an error too', () => {
    const { sent, failures } = run(
      frame({ code: 401, msg: secret, success: false }) + frame(last('stop')) + frame('[DONE]'),
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]!.signal).toEqual({ kind: 'auth' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.data).not.toContain('SECRET')
  })

  it('reads an event named error the same, whatever it holds', () => {
    const inspector = createZaiStreamInspector()
    const inspected = inspector.inspect({
      event: 'error',
      data: JSON.stringify({ detail: secret }),
    })
    expect(inspected).toMatchObject({ kind: 'failure', signal: { kind: 'unconfirmed_block' } })
    expect(JSON.stringify(inspected)).not.toContain('SECRET')
  })

  it('drops an error that comes after the finish_reason', () => {
    const { sent, failures } = run(
      frame(last('stop')) + frame({ error: { code: '1305', message: secret } }) + frame('[DONE]'),
    )
    expect(failures).toEqual([])
    expect(sent.map((event) => event.data)).toEqual([JSON.stringify(last('stop')), '[DONE]'])
  })

  it('rejects data that is no JSON object without reflecting it', () => {
    for (const data of ['{', '"text"', '[1]', 'null', 'SECRET']) {
      const inspected = createZaiStreamInspector().inspect({ event: 'message', data })
      expect(inspected).toEqual({ kind: 'invalid' })
    }
  })
})
