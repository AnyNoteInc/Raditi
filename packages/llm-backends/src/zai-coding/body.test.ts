import { DomainError } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { encodeJson } from '../shared.ts'
import {
  createZaiBodyPolicy,
  zaiMaxOutputTokens,
  zaiPolicyFields,
  zaiReasoningEfforts,
} from './body.ts'
import { chatSamples, sample } from './fixtures/samples.ts'

const route = { method: 'POST', path: '/zai/v4/chat/completions' } as const
const normalizeBody = createZaiBodyPolicy(route)
const ctx = { model: 'glm-5.3', reasoningEffort: 'high', cacheKey: `rdt_${'a'.repeat(32)}` }
const decode = (body: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
const normalize = (
  body: unknown,
  profile: typeof ctx | { [K in keyof typeof ctx]: (typeof ctx)[K] | null } = ctx,
) => normalizeBody(route, encodeJson(body), profile as typeof ctx)
const sent = (body: unknown, profile = ctx) => decode(normalize(body, profile).body)
/** What the CLI sends with the provider id `raditi`: no `thinking`, no `reasoning_effort`. */
const cli = (patch: Record<string, unknown> = {}) => ({
  model: 'glm-5.3',
  max_tokens: 32_000,
  messages: [
    { role: 'system', content: 'Synthetic instructions.' },
    { role: 'user', content: 'Synthetic request.' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Runs a command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
  ],
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true },
  ...patch,
})
/** The path the role would add to the refusal as `field`. */
function refusedField(body: unknown, profile = ctx): string {
  try {
    normalize(body, profile)
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    const details = (error as DomainError).details as { path?: unknown } | undefined
    return typeof details?.path === 'string' ? details.path : 'unknown'
  }
  throw new Error('The body was accepted')
}

describe('recorded requests of the CLI', () => {
  it.each(Object.values(chatSamples))('accepts %s and normalizes it idempotently', (name) => {
    const recorded = sample(name).request.body as Record<string, unknown>
    const first = normalize(recorded)
    const second = normalizeBody(route, first.body, ctx)
    expect(Buffer.from(second.body)).toEqual(Buffer.from(first.body))
    expect(second.estInputTokens).toBe(first.estInputTokens)
    const body = decode(first.body)
    expect(body).toMatchObject({
      model: 'glm-5.3',
      max_tokens: 32_000,
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
    // Nothing of the conversation or of the tools is rewritten.
    expect(body.messages).toEqual(recorded.messages)
    expect(body.tools).toEqual(recorded.tools)
    expect(body.tool_choice).toEqual(recorded.tool_choice)
    expect(first.estInputTokens).toBeGreaterThan(100)
  })

  it('accepts a request without tools: the title and the context compaction of the CLI', () => {
    const recorded = sample(chatSamples.withoutTools).request.body as Record<string, unknown>
    expect(Object.keys(recorded)).not.toContain('tools')
    const body = sent(recorded)
    expect(Object.keys(body)).toEqual([
      'model',
      'max_tokens',
      'thinking',
      'reasoning_effort',
      'messages',
      'stream',
      'stream_options',
    ])
  })

  it('writes the fields in one fixed order', () => {
    expect(Object.keys(sent(cli()))).toEqual([
      'model',
      'max_tokens',
      'thinking',
      'reasoning_effort',
      'messages',
      'tools',
      'tool_choice',
      'stream',
      'stream_options',
    ])
  })
})

describe('the turn profile in a Z.ai request', () => {
  it.each(zaiReasoningEfforts)('sets thinking and reasoning_effort %s itself', (effort) => {
    const profile = { ...ctx, reasoningEffort: effort }
    // The CLI with the provider id `raditi` sends neither field.
    expect(sent(cli(), profile)).toMatchObject({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: effort,
    })
    // What a request asks for does not count.
    for (const asked of zaiReasoningEfforts)
      expect(
        sent(cli({ reasoning_effort: asked, thinking: { type: 'disabled' } }), profile),
      ).toMatchObject({
        thinking: { type: 'enabled', clear_thinking: false },
        reasoning_effort: effort,
      })
  })

  it('leaves the defaults of the provider to a profile without an effort and lets no request choose', () => {
    const profile = { ...ctx, reasoningEffort: null }
    for (const body of [
      cli(),
      cli({ reasoning_effort: 'max', thinking: { type: 'enabled', clear_thinking: false } }),
    ]) {
      const normalized = decode(normalize(body, profile).body)
      expect(normalized).not.toHaveProperty('thinking')
      expect(normalized).not.toHaveProperty('reasoning_effort')
    }
  })

  it('refuses a profile with an effort the plan does not know', () => {
    for (const effort of ['medium', 'xhigh', 'none', ''])
      expect(() => normalize(cli(), { ...ctx, reasoningEffort: effort })).toThrow(DomainError)
  })

  it('admits only the model of the profile', () => {
    for (const model of ['glm-5.3-flash', 'glm-5-turbo', 'GLM-5.3', 'glm-5.3 ', ''])
      expect(refusedField(cli({ model }))).toBe('model')
    expect(sent(cli({ model: 'glm-5-turbo' }), { ...ctx, model: 'glm-5-turbo' }).model).toBe(
      'glm-5-turbo',
    )
  })

  it('always asks for a stream with usage', () => {
    for (const patch of [
      { stream: false },
      { stream: false, stream_options: { include_usage: false } },
      { stream_options: {} },
      { stream: undefined, stream_options: undefined },
    ])
      expect(sent(cli(patch))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      })
  })

  it('bounds the output: 32 000 when the request names none, never more', () => {
    expect(zaiMaxOutputTokens).toBe(32_000)
    expect(sent(cli({ max_tokens: undefined })).max_tokens).toBe(32_000)
    expect(sent(cli({ max_tokens: 131_072 })).max_tokens).toBe(32_000)
    expect(sent(cli({ max_tokens: 32_001 })).max_tokens).toBe(32_000)
    expect(sent(cli({ max_tokens: 64 })).max_tokens).toBe(64)
    expect(sent(cli({ max_tokens: 1 })).max_tokens).toBe(1)
    for (const max_tokens of [0, -1, 1.5, '64', null, 1e21])
      expect(refusedField(cli({ max_tokens }))).toBe('max_tokens')
  })
})

describe('the closed shape of a Z.ai request', () => {
  it.each([
    [{ temperature: 0.2 }, 'unknown'],
    [{ top_p: 0.9 }, 'unknown'],
    [{ response_format: { type: 'json_object' } }, 'unknown'],
    [{ user: 'client-7' }, 'unknown'],
    [{ prompt_cache_key: 'rdt_x' }, 'unknown'],
    [{ max_completion_tokens: 10 }, 'unknown'],
    [{ request_id: 'x' }, 'unknown'],
    [{ do_sample: true }, 'unknown'],
    [{ web_search: { enable: true } }, 'unknown'],
    [{ n: 2 }, 'unknown'],
    [{ stop: ['x'] }, 'unknown'],
  ])('refuses the extra field %j', (patch, field) => {
    expect(refusedField(cli(patch))).toBe(field)
  })

  it.each([
    ['web_search', { type: 'web_search', web_search: { enable: true } }],
    ['retrieval', { type: 'retrieval', retrieval: { knowledge_id: 'x' } }],
    ['code_interpreter', { type: 'code_interpreter' }],
  ])('refuses a tool of the type %s', (_type, tool) => {
    expect(refusedField(cli({ tools: [tool] }))).toMatch(/^tools\[\]/)
    const mixed = cli()
    expect(refusedField({ ...mixed, tools: [...mixed.tools, tool] })).toMatch(/^tools\[\]/)
  })

  it.each(['required', 'none', { type: 'function', function: { name: 'bash' } }, null, ''])(
    'refuses tool_choice %j',
    (tool_choice) => {
      expect(refusedField(cli({ tool_choice }))).toBe('tool_choice')
    },
  )

  it('refuses images and every content part that is not text', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    for (const content of [
      [image],
      [{ type: 'text', text: 'a' }, image],
      [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
      [{ type: 'video_url', video_url: { url: 'https://example.invalid/v.mp4' } }],
      [{ type: 'file_url', file_url: { url: 'https://example.invalid/f.pdf' } }],
      { type: 'text', text: 'a' },
      7,
    ])
      expect(refusedField(cli({ messages: [{ role: 'user', content }] }))).toBe(
        'messages[].content',
      )
    // Several text parts of one user message are text still.
    const parts = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(sent(cli({ messages: [{ role: 'user', content: parts }] })).messages).toEqual([
      { role: 'user', content: parts },
    ])
  })

  it.each([
    [{ messages: [] }, 'messages'],
    [{ messages: 'text' }, 'messages'],
    [{ messages: undefined }, 'messages'],
    [{ messages: [{ role: 'developer', content: 'x' }] }, 'messages[].role'],
    [{ messages: [{ role: 'user', content: 'x', name: 'n' }] }, 'messages[].unknown'],
    [
      { messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] },
      'messages[].content',
    ],
    [{ messages: [{ role: 'tool', content: 'x' }] }, 'messages[].tool_call_id'],
    [
      {
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'web_search' }] },
        ],
      },
      'messages[].tool_calls[].type',
    ],
    [
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: {} } }],
          },
        ],
      },
      'messages[].tool_calls[].function.arguments',
    ],
    [{ tools: [{ type: 'function', function: { name: '' } }] }, 'tools[].function.name'],
    [
      { tools: [{ type: 'function', function: { name: 'x', strict: true } }] },
      'tools[].function.unknown',
    ],
    [{ tools: {} }, 'tools'],
    [{ stream: 'yes' }, 'stream'],
    [{ stream_options: { include_usage: true, extra: 1 } }, 'stream_options.unknown'],
    [{ thinking: { type: 'auto' } }, 'thinking.type'],
    [{ thinking: { type: 'enabled', budget_tokens: 5 } }, 'thinking.unknown'],
    [{ reasoning_effort: 'ultra' }, 'reasoning_effort'],
    [{ model: 7 }, 'model'],
  ])('names the refused place of %j without an index', (patch, field) => {
    expect(refusedField(cli(patch))).toBe(field)
  })

  it('names only its own fields in a refusal, never a name or a value of the request', () => {
    const fields = [
      refusedField(cli({ SECRET_NAME_502: 1 })),
      refusedField(cli({ messages: [{ role: 'user', content: 'x', SECRET_NAME_502: 1 }] })),
      refusedField(
        cli({ tools: [{ type: 'function', function: { name: 'x', SECRET_NAME_502: {} } }] }),
      ),
      refusedField(cli({ messages: Array.from({ length: 503 }, () => ({ role: 'nobody' })) })),
    ]
    for (const field of fields) {
      expect(field).not.toMatch(/\d|SECRET/)
      for (const segment of field.split(/\.|\[\]/).filter(Boolean))
        expect(['unknown', ...zaiPolicyFields]).toContain(segment)
    }
  })

  it('keeps free-form tool schemas, tool arguments and long histories as they are', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'raditi_wp_rest',
          description: 'REST.',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { path: { type: 'string', pattern: '^/wp/v2/' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ]
    const messages = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'R',
        tool_calls: [
          {
            id: 'call_000000000000000000000001',
            type: 'function',
            function: { name: 'model.invented/name', arguments: '{"path":"/wp/v2/pages/7"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_000000000000000000000001', content: '{"ok":true}' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'Done.' },
    ]
    const body = sent(cli({ tools, messages }))
    expect(body.tools).toEqual(tools)
    expect(body.messages).toEqual(messages)
  })

  it('rejects other routes, malformed JSON and bodies that are no object without quoting them', () => {
    expect(() =>
      normalizeBody({ method: 'POST', path: '/kimi/v1/chat/completions' }, encodeJson(cli()), ctx),
    ).toThrow(DomainError)
    expect(() =>
      normalizeBody({ method: 'GET', path: route.path }, encodeJson(cli()), ctx),
    ).toThrow(DomainError)
    for (const bytes of [
      new TextEncoder().encode('{"model":"SECRET'),
      encodeJson(['SECRET']),
      encodeJson('SECRET'),
    ]) {
      let caught: unknown
      try {
        normalizeBody(route, bytes, ctx)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DomainError)
      expect(
        JSON.stringify([(caught as DomainError).message, (caught as DomainError).details]),
      ).not.toContain('SECRET')
    }
  })
})
