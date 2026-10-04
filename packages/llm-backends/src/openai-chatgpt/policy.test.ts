import { DomainError, estimateLlmInputTokens, type JsonObject, type LlmRoute } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { encodeJson } from '../shared.ts'
import { normalizeCodexBody } from './policy.ts'

const route = { method: 'POST', path: '/codex/responses' } as const
const ctx = { model: 'synthetic-codex', reasoningEffort: 'high', cacheKey: `rdt_${'a'.repeat(32)}` }
const base = { model: ctx.model, store: false, stream: true, input: 'synthetic prompt' }
const normalize = (value: unknown, context: Parameters<typeof normalizeCodexBody>[2] = ctx) =>
  normalizeCodexBody(route, encodeJson(value), context)
const read = (body: Uint8Array): JsonObject =>
  JSON.parse(new TextDecoder().decode(body)) as JsonObject

describe('Codex body policy', () => {
  it('keeps the approved CLI subset and is idempotent, without output caps', () => {
    const value = {
      ...base,
      instructions: 'Edit the synthetic site',
      include: ['reasoning.encrypted_content'],
      service_tier: 'priority',
      client_metadata: { sensitive: 'removed' },
      prompt_cache_key: 'untrusted-shared-cache',
      reasoning: { effort: 'low', summary: 'auto' },
      parallel_tool_calls: false,
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          name: 'inspect',
          strict: false,
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
        },
        {
          type: 'custom',
          name: 'patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' },
        },
        { type: 'namespace', name: 'site', tools: [{ type: 'function', name: 'read' }] },
      ],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'result',
          strict: true,
          schema: { type: 'object', additionalProperties: false },
        },
      },
    }
    const once = normalize(value)
    const result = read(once.body)
    expect(result).toEqual({
      ...value,
      service_tier: undefined,
      client_metadata: undefined,
      prompt_cache_key: ctx.cacheKey,
    })
    expect(result).not.toHaveProperty('service_tier')
    expect(result).not.toHaveProperty('max_output_tokens')
    expect(normalizeCodexBody(route, once.body, ctx)).toEqual(once)
  })

  it('preserves native resume message/tool shapes and nullable encrypted reasoning', () => {
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'Test' }] },
      {
        type: 'reasoning',
        id: 'r',
        summary: [{ type: 'summary_text', text: 'Plan' }],
        encrypted_content: null,
        content: null,
      },
      {
        type: 'reasoning',
        encrypted_content: 'synthetic-cipher',
        content: [
          { type: 'reasoning_text', text: 'Plan' },
          { type: 'text', text: 'Additional thought' },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done' }],
        phase: 'final_answer',
      },
      { type: 'function_call', call_id: 'f', name: 'read', namespace: 'site', arguments: '{}' },
      { type: 'function_call_output', call_id: 'f', name: 'read', namespace: 'site', output: 'ok' },
      { type: 'custom_tool_call', call_id: 'c', name: 'patch', input: 'change' },
      {
        type: 'custom_tool_call_output',
        call_id: 'c',
        output: [{ type: 'input_text', text: 'ok' }],
      },
    ]
    expect(read(normalize({ ...base, input }).body).input).toEqual(input)
  })

  it.each(['auto', 'current_turn', 'all_turns'])(
    'supports Responses Lite tools in input and reasoning context %s, stripping internal metadata',
    (context) => {
      const tools = [
        {
          type: 'namespace',
          name: 'functions',
          description: '',
          tools: [
            {
              type: 'function',
              name: 'exec',
              parameters: { type: 'object', properties: { command: { type: 'string' } } },
              strict: false,
            },
          ],
        },
        { type: 'custom', name: 'patch', format: { type: 'text' } },
      ]
      const value = {
        ...base,
        reasoning: { effort: 'low', context },
        input: [
          { type: 'additional_tools', id: 'at_synthetic', role: 'developer', tools },
          {
            type: 'message',
            id: 'msg_synthetic',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Synthetic instructions' }],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ['model.base_instructions'],
              client_path: 'synthetic-private-path',
            },
          },
          {
            type: 'reasoning',
            encrypted_content: 'synthetic-cipher',
            summary: [],
            internal_chat_message_metadata_passthrough: { attribution: 'synthetic-private-id' },
          },
        ],
      }
      const first = normalize(value)
      const result = read(first.body)
      expect(result.tools).toBeUndefined()
      expect(result.instructions).toBeUndefined()
      expect(result.input).toEqual([
        value.input[0],
        {
          type: 'message',
          id: 'msg_synthetic',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Synthetic instructions' }],
        },
        { type: 'reasoning', encrypted_content: 'synthetic-cipher', summary: [] },
      ])
      expect(result.reasoning).toEqual(value.reasoning)
      expect(new TextDecoder().decode(first.body)).not.toContain('synthetic-private')
      expect(normalizeCodexBody(route, first.body, ctx)).toEqual(first)
    },
  )

  it.each(['top-level', 'additional_tools'] as const)(
    'accepts strict custom grammar tools alongside functions in a %s namespace',
    (placement) => {
      const tools = [
        {
          type: 'namespace',
          name: 'functions',
          tools: [
            { type: 'function', name: 'exec', parameters: { type: 'object' } },
            {
              type: 'custom',
              name: 'apply_patch',
              format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch"' },
            },
          ],
        },
      ]
      const value =
        placement === 'top-level'
          ? { ...base, tools }
          : { ...base, input: [{ type: 'additional_tools', role: 'developer', tools }] }
      const first = normalize(value)
      const result = read(first.body)
      const actualTools =
        placement === 'top-level' ? result.tools : (result.input as JsonObject[])[0]!.tools
      expect(actualTools).toEqual(tools)
      expect(normalizeCodexBody(route, first.body, ctx)).toEqual(first)
    },
  )

  it.each([
    { type: 'namespace', name: 'nested', tools: [] },
    { type: 'web_search' },
    { type: 'mcp', server_url: 'https://remote.invalid' },
    { type: 'custom', name: 'patch', url: 'https://remote.invalid' },
    {
      type: 'custom',
      name: 'patch',
      format: { type: 'grammar', syntax: 'shell', definition: 'bad' },
    },
    {
      type: 'custom',
      name: 'patch',
      format: {
        type: 'grammar',
        syntax: 'lark',
        definition: 'ok',
        remote: 'https://remote.invalid',
      },
    },
  ])('preserves nested namespace and custom tool restrictions %#', (tool) => {
    const tools = [{ type: 'namespace', name: 'functions', tools: [tool] }]
    expect(() => normalize({ ...base, tools })).toThrow(DomainError)
    expect(() =>
      normalize({ ...base, input: [{ type: 'additional_tools', role: 'developer', tools }] }),
    ).toThrow(DomainError)
  })

  it.each([
    { reasoning: { effort: 'low', context: 'unrestricted' } },
    { reasoning: { effort: 'ultra', context: 'current_turn' } },
    { reasoning: { context: null } },
    { reasoning: { context: { type: 'auto' } } },
    { input: [{ type: 'additional_tools', role: 'user', tools: [] }] },
    { input: [{ type: 'additional_tools', role: 'developer' }] },
    { input: [{ type: 'additional_tools', role: 'developer', tools: [], unexpected: 'private' }] },
    { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search' }] }] },
    {
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'mcp', server_url: 'https://remote.invalid' }],
        },
      ],
    },
    {
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'exec', unexpected: 'private' }],
        },
      ],
    },
    {
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'hidden',
              tools: [{ type: 'namespace', name: 'nested', tools: [] }],
            },
          ],
        },
      ],
    },
    {
      input: [
        {
          type: 'message',
          role: 'developer',
          content: 'safe',
          internal_chat_message_metadata_passthrough: {},
          unexpected: 'private',
        },
      ],
    },
  ])('keeps Responses Lite fields and nested tools strict %#', (patch) => {
    expect(() => normalize({ ...base, ...patch })).toThrow(DomainError)
  })

  it('estimates encrypted payloads and inline images only at accepted paths', () => {
    const value = {
      ...base,
      input: [
        { type: 'reasoning', encrypted_content: 'cipher'.repeat(100), summary: [] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `data:image/png;base64,${'YQ=='.repeat(100)}` },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${'YWFh'.repeat(100)}`,
              detail: 'original',
            },
          ],
        },
      ],
    }
    const normalized = normalize(value)
    const result = read(normalized.body)
    expect(normalized.estInputTokens).toBe(
      estimateLlmInputTokens(result, {
        encryptedContentPaths: [['input', 0, 'encrypted_content']],
        imagePaths: [['input', 1, 'content', 1, 'image_url']],
      }),
    )
    const input = result.input as JsonObject[]
    input[0]!.encrypted_content = ''
    const content = input[1]!.content as JsonObject[]
    content[1]!.image_url = ''
    expect(normalized.estInputTokens).toBe(Math.ceil(encodeJson(result).byteLength / 3) + 2000)
    expect(normalized.estInputTokens).toBeGreaterThan(2000 + 100)
  })

  it.each([
    'max_output_tokens',
    'metadata',
    'previous_response_id',
    'conversation',
    'background',
    'prompt',
    'user',
    'truncation',
    'temperature',
    'base_url',
    'api_key',
    'stream_options',
  ])('rejects top-level field %s', (key) => {
    expect(() => normalize({ ...base, [key]: 'secret-synthetic' })).toThrow(DomainError)
  })

  it.each([
    { model: 'another-model' },
    { store: true },
    { stream: false },
    { store: null },
    { include: ['web_search_call.action.sources'] },
    { reasoning: { effort: 'ultra' } },
    { reasoning: { effort: 'made-up' } },
    { reasoning: { secret: 'leak' } },
    { input: [{ role: 'admin', content: 'no' }] },
    { input: [{ type: 'item_reference', id: 'prior-server-state' }] },
    { input: [{ type: 'local_shell_call', action: { command: 'not observed' } }] },
    {
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }],
        },
      ],
    },
    {
      input: [{ type: 'reasoning', content: [{ type: 'input_text', text: 'wrong nested kind' }] }],
    },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }] },
    {
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'ok', url: 'https://remote.invalid' }],
        },
      ],
    },
    { input: [{ type: 'function_call_output', call_id: 'c', output: { arbitrary: true } }] },
    { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'mcp', server_url: 'https://remote.invalid' }] },
    { tools: [{ type: 'namespace', name: 'hidden', tools: [{ type: 'web_search' }] }] },
    { tools: [{ type: 'function', name: 'tool', parameters: [], strict: 'yes' }] },
    {
      tools: [
        {
          type: 'custom',
          name: 'tool',
          format: { type: 'grammar', syntax: 'shell', definition: 'x' },
        },
      ],
    },
    { tool_choice: { type: 'web_search' } },
    { text: { format: { type: 'image' } } },
    { text: { format: { type: 'json_schema', name: 's', schema: [] } } },
  ])('rejects malformed or unsafe nested shape %#', (patch) => {
    expect(() => normalize({ ...base, ...patch })).toThrow(DomainError)
  })

  it.each([
    'https://remote.invalid/a.png',
    'file:///etc/passwd',
    'data:text/html;base64,YQ==',
    'data:image/svg+xml;base64,YQ==',
    'data:image/png;base64,',
    'data:image/png;base64,%%%',
  ])('rejects non-inline or malformed image %s', (image_url) => {
    expect(() =>
      normalize({
        ...base,
        input: [{ role: 'user', content: [{ type: 'input_image', image_url }] }],
      }),
    ).toThrow(DomainError)
  })

  it('accepts a 12 MiB inline image in a message and in a tool output', () => {
    // The CLI re-encodes a large PNG attachment or `view_image` result into megabytes of base64.
    const image_url = `data:image/png;base64,${'iVBORw0K'.repeat((12 * 1024 * 1024) / 8)}AA==`
    expect(image_url.length).toBeGreaterThan(12 * 1024 * 1024)
    for (const input of [
      [{ role: 'user', content: [{ type: 'input_image', image_url }] }],
      [
        {
          type: 'function_call_output',
          call_id: 'call_synthetic',
          output: [{ type: 'input_image', image_url }],
        },
      ],
    ]) {
      const normalized = normalize({ ...base, input })
      expect(normalized.body.byteLength).toBeGreaterThan(12 * 1024 * 1024)
      // An image is billed as a fixed estimate, never by its base64 length.
      expect(normalized.estInputTokens).toBeLessThan(10_000)
    }
  })

  it('fills the trusted reasoning ceiling when the CLI omits effort', () => {
    expect(read(normalize(base).body).reasoning).toEqual({ effort: 'high' })
    expect(read(normalize({ ...base, reasoning: { summary: 'auto' } }).body).reasoning).toEqual({
      summary: 'auto',
      effort: 'high',
    })
    expect(read(normalize({ ...base, reasoning: { effort: 'none' } }).body).reasoning).toEqual({
      effort: 'none',
    })
    expect(() =>
      normalize(
        { ...base, reasoning: { effort: 'low' } },
        {
          ...ctx,
          reasoningEffort: null,
        },
      ),
    ).toThrow(DomainError)
  })

  it('fails closed for missing required fields and wrong routes', () => {
    for (const key of ['model', 'input', 'store', 'stream']) {
      const value: Record<string, unknown> = { ...base }
      delete value[key]
      expect(() => normalize(value)).toThrow(DomainError)
    }
    for (const other of [
      { method: 'GET', path: route.path },
      { method: 'POST', path: '/codex/responses/compact' },
      { method: 'POST', path: '/codex/responses?url=https://remote.invalid' },
    ] as LlmRoute[])
      expect(() => normalizeCodexBody(other, encodeJson(base), ctx)).toThrow(DomainError)
  })

  it('rejects invalid UTF-8/JSON and redacts untrusted property names', () => {
    for (const bytes of [
      new Uint8Array([0xff]),
      encodeJson([]),
      encodeJson(null),
      encodeJson('text'),
    ])
      expect(() => normalizeCodexBody(route, bytes, ctx)).toThrow(DomainError)
    const secret = 'synthetic-private-email@example.invalid'
    try {
      normalize({
        ...base,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'safe', [secret]: secret }] },
        ],
      })
      expect.fail('request must be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(JSON.stringify(error)).toContain('unknown')
    }
  })
})
