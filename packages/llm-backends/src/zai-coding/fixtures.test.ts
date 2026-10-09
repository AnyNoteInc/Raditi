import { describe, expect, it } from 'vitest'

import {
  cliReadsOverflow,
  cliRetriesHttp,
  cliRetriesStreamError,
  opencodeCliVersion,
  overflowExceptions,
  overflowPatterns,
  overflowWithoutBody,
  retryPatterns,
  streamRetryWords,
} from './fixtures/opencode-cli.ts'
import {
  chatSamples,
  envelopeSamples,
  errorSamples,
  quotaSamples,
  sample,
  sampleText,
} from './fixtures/samples.ts'

describe('the transcription of the CLI retry and overflow rules', () => {
  const retryExtract = sampleText(`opencode-${opencodeCliVersion}/ctx-retry.txt`)
  const overflowExtract = (
    JSON.parse(sampleText('75-g1-binary/overflow.text.json')) as { text: string }
  ).text

  it('equals the retry list of the executable, pattern for pattern', () => {
    expect(retryExtract).toContain(`Rd=[${retryPatterns.map(String).join(',')}];`)
    // An error that is no HTTP answer is matched by plain words first.
    expect(retryExtract).toContain('if(i.includes("too_many_requests"))')
    expect(retryExtract).toContain('if(i.includes("exhausted")||i.includes("unavailable"))')
    expect(streamRetryWords).toEqual(['too_many_requests', 'exhausted', 'unavailable'])
  })

  it('equals the overflow list of the executable, pattern for pattern', () => {
    expect(overflowPatterns).toHaveLength(27)
    expect(overflowExtract).toContain(`b$=[${overflowPatterns.map(String).join(',')}]`)
    expect(overflowExtract).toContain(`X$=[${overflowExceptions.map(String).join(',')}]`)
    expect(overflowExtract).toContain(`${String(overflowWithoutBody)}.test(x)`)
    expect(overflowExtract).toContain('Q.error.statusCode===413')
    expect(overflowExtract).toContain('K?.error?.code==="context_length_exceeded"')
  })

  // What the CLI really did with these answers: docs/plan/40-opencode-spike.md, section 4.
  it('reproduces the measured reactions of the CLI', () => {
    const policy = 'The request is not allowed by the policy of this turn.'
    const body = (extra: object = {}) =>
      JSON.stringify({
        error: { type: 'invalid_request_error', code: 'raditi_policy', message: policy, ...extra },
      })
    // One request, exit 1.
    expect(cliRetriesHttp({ status: 400, message: policy, body: body() })).toBe(false)
    expect(
      cliRetriesHttp({ status: 400, message: policy, body: body({ field: 'messages[].content' }) }),
    ).toBe(false)
    expect(cliRetriesHttp({ status: 403, message: 'x', body: '{}' })).toBe(false)
    expect(cliRetriesHttp({ status: 402, message: 'x', body: '{}' })).toBe(false)
    // Six requests: the index is one of the numbers of the list.
    expect(
      cliRetriesHttp({
        status: 400,
        message: policy,
        body: body({ field: 'messages[502].content' }),
      }),
    ).toBe(true)
    expect(cliRetriesHttp({ status: 503, message: 'The gateway is busy.', body: '{}' })).toBe(true)
    // A compaction request instead of the end of the turn.
    const overflow = 'The request has too many tokens for this turn.'
    expect(cliReadsOverflow({ status: 400, message: overflow, body: '{}' })).toBe(true)
    expect(cliReadsOverflow({ status: 400, message: policy, body: body() })).toBe(false)
    // Inside a started stream: one request, and six with words of the list.
    expect(
      cliRetriesStreamError({
        type: 'invalid_request_error',
        code: 'raditi_budget',
        message: 'The budget of this turn is spent.',
      }),
    ).toBe(false)
    expect(
      cliRetriesStreamError({
        type: 'invalid_request_error',
        code: 'raditi_busy',
        message: 'The service is overloaded, try again later.',
      }),
    ).toBe(true)
  })
})

describe('recorded exchanges', () => {
  const names = [
    ...Object.values(chatSamples),
    ...quotaSamples,
    ...Object.values(errorSamples),
    ...Object.values(envelopeSamples),
    '61-chat-first-after-idle.json',
  ]

  it.each(names)('%s keeps only the two allowed headers and no credential', (name) => {
    const text = sampleText(name)
    const record = sample(name)
    for (const headers of [
      record.response.headers,
      (record.request as { headers?: object }).headers ?? {},
    ])
      for (const header of Object.keys(headers))
        expect(['content-type', 'retry-after']).toContain(header)
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._~+/=-]{12,}/)
    expect(text).not.toMatch(/[0-9a-f]{32}\.[A-Za-z0-9_-]{12,}/i)
    expect(text).not.toMatch(/sk-[\w-]{20,}/)
  })

  it('holds the eight quota answers: six of one active window and the two around an idle night', () => {
    expect(quotaSamples).toHaveLength(8)
    for (const name of quotaSamples) {
      const body = sample(name).response.body as { success: boolean; data: { limits: unknown[] } }
      expect(body.success).toBe(true)
      expect(body.data.limits).toHaveLength(2)
    }
  })

  it.each(Object.values(chatSamples))(
    '%s is a stream closed by finish_reason, usage and DONE',
    (name) => {
      const record = sample(name)
      expect(record.response.status).toBe(200)
      expect(record.response.headers['content-type']).toBe('text/event-stream;charset=UTF-8')
      const frames = record.response.sse!.split('\n\n').filter(Boolean)
      expect(frames.at(-1)).toBe('data: [DONE]')
      const last = JSON.parse(frames.at(-2)!.slice('data: '.length)) as {
        choices: { finish_reason: string }[]
        usage: Record<string, unknown>
      }
      expect(['stop', 'tool_calls']).toContain(last.choices[0]!.finish_reason)
      expect(Object.keys(last.usage).sort()).toEqual([
        'completion_tokens',
        'completion_tokens_details',
        'prompt_tokens',
        'prompt_tokens_details',
        'total_tokens',
      ])
    },
  )
})
