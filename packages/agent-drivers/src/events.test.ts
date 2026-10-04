import { readFileSync } from 'node:fs'

import {
  agentEventSchema,
  agentOutputLimits,
  turnResultSchema,
  type AgentDriver,
  type AgentEvent,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createCodexDriver } from './codex.ts'
import { MAX_EVENTS_PER_LINE, MAX_JSONL_BYTES } from './jsonl.ts'
import { createKimiDriver } from './kimi.ts'
import { createOpencodeDriver } from './opencode.ts'
import { RESULT_SIZE_NOTE } from './output-schema.ts'
import { createQwenDriver } from './qwen.ts'

const drivers = [createCodexDriver, createKimiDriver, createQwenDriver, createOpencodeDriver].map(
  (create) => create({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` }),
)
const [codex, kimi, qwen, opencode] = drivers as [
  AgentDriver,
  AgentDriver,
  AgentDriver,
  AgentDriver,
]

const sid = '01960000-0000-7000-8000-000000000001'
const expectedResult = {
  summary: 'Обновлён заголовок',
  change_type: 'code',
  client_message: 'Заголовок обновлён. Вы можете применить изменение.',
  files_changed: ['index.html'],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
const finalText = JSON.stringify(expectedResult)

function fixture(driver: AgentDriver): AgentEvent[] {
  return readFileSync(new URL(`./fixtures/${driver.id}.jsonl`, import.meta.url), 'utf8')
    .trimEnd()
    .split('\n')
    .flatMap((line) => driver.parseEvent(line))
}
const parse = (driver: AgentDriver, value: unknown) => driver.parseEvent(JSON.stringify(value))

describe('pinned upstream JSONL fixtures', () => {
  it('normalizes Codex terminal items and inclusive token counts', () => {
    const result = fixture(codex)
    expect(result).toEqual([
      { type: 'started', nativeSessionId: sid },
      { type: 'command', command: 'pwd', exitCode: 0 },
      { type: 'file_change', path: 'index.html', change: 'update' },
      { type: 'file_change', path: 'obsolete.txt', change: 'delete' },
      { type: 'tool_call', tool: 'get_page', ok: true },
      { type: 'message', text: finalText },
      {
        type: 'usage',
        usage: { inputUncached: 50, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5 },
      },
      { type: 'completed' },
    ])
  })

  it('reads Kimi resume_hint and questions without inventing tool success or completion', () => {
    expect(fixture(kimi)).toEqual([
      { type: 'started', nativeSessionId: sid },
      { type: 'message', text: 'Проверяю страницу.' },
      { type: 'command', command: 'pwd', exitCode: null },
      { type: 'question', text: 'Какой заголовок выбрать?', options: ['Первый', 'Второй'] },
      { type: 'message', text: finalText },
    ])
  })

  it('reads Qwen message envelopes and terminal usage without repeating partial text', () => {
    expect(fixture(qwen)).toEqual([
      { type: 'started', nativeSessionId: sid },
      { type: 'message', text: 'Проверяю страницу.' },
      { type: 'command', command: 'pwd', exitCode: null },
      { type: 'message', text: finalText },
      {
        type: 'usage',
        usage: { inputUncached: 60, cacheRead: 40, cacheWrite: 0, output: 20, reasoning: 0 },
      },
      { type: 'completed' },
    ])
  })

  it('adds OpenCode reasoning once and does not complete after a tool-calls step', () => {
    expect(fixture(opencode)).toEqual([
      { type: 'started', nativeSessionId: 'ses_test' },
      { type: 'tool_call', tool: 'bash', ok: true },
      { type: 'command', command: 'pwd', exitCode: 0 },
      {
        type: 'usage',
        usage: { inputUncached: 50, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5 },
      },
      { type: 'message', text: finalText },
      {
        type: 'usage',
        usage: { inputUncached: 20, cacheRead: 10, cacheWrite: 0, output: 10, reasoning: 2 },
      },
      { type: 'completed' },
    ])
  })

  it.each(drivers)(
    '$id emits only domain events, keeps payloads private and extracts the final result',
    (driver) => {
      const result = fixture(driver)
      for (const event of result) expect(agentEventSchema.safeParse(event).success).toBe(true)
      expect(JSON.stringify(result)).not.toMatch(
        /private reasoning|private tool response|aggregated_output|cost|tool_calls/,
      )
      expect(driver.extractResult(result, null)).toEqual(expectedResult)
    },
  )
})

describe.each(drivers)('$id untrusted stdout boundary', (driver) => {
  it.each(['', 'not json', '{', '[]', 'null', '42', '"text"', '{}', '{"type":"future.event"}'])(
    'ignores unknown or malformed line %s',
    (line) => {
      expect(driver.parseEvent(line)).toEqual([])
    },
  )

  it('ignores prototype keys, excessive depth, non-finite numbers and oversized UTF-8 input', () => {
    const lines = [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"nested":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}',
      '{"value":1e999}',
      '{"text":"' + 'я'.repeat(MAX_JSONL_BYTES / 2) + '"}',
      ' '.repeat(MAX_JSONL_BYTES + 1),
    ]
    for (const line of lines) expect(driver.parseEvent(line)).toEqual([])
    expect({}).not.toHaveProperty('polluted')
  })

  it('does not throw for random JSON values and invalid known event fields', () => {
    for (const value of [
      false,
      [],
      { type: 1 },
      { type: 'item.completed', item: [] },
      { role: 'assistant', content: {}, tool_calls: [null, 1] },
    ]) {
      expect(() => parse(driver, value)).not.toThrow()
    }
  })

  it('accepts only the current, valid final JSON object, optionally in one code fence', () => {
    expect(driver.extractResult([], finalText)).toEqual(expectedResult)
    expect(driver.extractResult([], `\`\`\`json\n${finalText}\n\`\`\``)).toEqual(expectedResult)
    expect(driver.extractResult([{ type: 'message', text: finalText }], null)).toEqual(
      expectedResult,
    )
    expect(driver.extractResult([{ type: 'message', text: finalText }], 'broken final')).toBeNull()
    expect(
      driver.extractResult(
        [
          { type: 'message', text: finalText },
          { type: 'message', text: 'broken final' },
        ],
        null,
      ),
    ).toBeNull()
    expect(driver.extractResult([{ type: 'failed', reason: 'failed' }], finalText)).toBeNull()
    for (const value of [
      '[]',
      '{}',
      finalText + finalText,
      `prefix ${finalText}`,
      '{"__proto__":{}}',
      'x'.repeat(MAX_JSONL_BYTES + 1),
    ]) {
      expect(driver.extractResult([], value)).toBeNull()
    }
    expect(
      driver.extractResult([], JSON.stringify({ ...expectedResult, risk: 'impossible' })),
    ).toBeNull()
    expect(
      driver.extractResult([], JSON.stringify({ ...expectedResult, secret: 'must not pass' })),
    ).toBeNull()
  })
})

describe('adversarial known events', () => {
  it('bounds message text for every driver without copying opaque fields', () => {
    const long = 'x'.repeat(agentOutputLimits.messageText + 100)
    const samples: [AgentDriver, unknown][] = [
      [
        codex,
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: long, key: 'secret-marker' },
        },
      ],
      [kimi, { role: 'assistant', content: long, key: 'secret-marker' }],
      [
        qwen,
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: long }] },
          key: 'secret-marker',
        },
      ],
      [opencode, { type: 'text', part: { type: 'text', text: long, key: 'secret-marker' } }],
    ]
    for (const [driver, value] of samples) {
      const result = parse(driver, value)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'message',
        text: expect.stringMatching(/\n\[Вывод обрезан\]$/),
      })
      expect(result[0]?.type === 'message' && result[0].text.length).toBe(
        agentOutputLimits.messageText,
      )
      expect(JSON.stringify(result)).not.toContain('secret-marker')
    }
  })

  it.each([codex, kimi])(
    '$id cannot turn a truncated final message into a successful JSON result',
    (driver) => {
      const asLine = (content: string) =>
        driver.id === 'codex'
          ? { type: 'item.completed', item: { type: 'agent_message', text: content } }
          : { role: 'assistant', content }
      const earlier: AgentEvent[] = [{ type: 'message', text: finalText }]

      for (const prefix of [finalText, `\`\`\`json\n${finalText}\n\`\`\``]) {
        const raw = prefix.padEnd(agentOutputLimits.messageText, ' ') + 'INVALID FINAL SUFFIX'
        const latest = parse(driver, asLine(raw))
        expect(latest).toHaveLength(1)
        expect(latest[0]).toMatchObject({ type: 'message' })
        expect(driver.extractResult(latest, null)).toBeNull()
        expect(driver.extractResult([...earlier, ...latest], null)).toBeNull()
        expect(driver.extractResult(latest, raw)).toBeNull()
      }

      const exactLimit = finalText.padEnd(agentOutputLimits.messageText, ' ')
      expect(driver.extractResult(parse(driver, asLine(exactLimit)), null)).toEqual(expectedResult)
    },
  )

  it.each([codex, kimi])(
    '$id carries a result of exactly the size the model is told, and nothing longer',
    (driver) => {
      const asLine = (content: string) =>
        driver.id === 'codex'
          ? { type: 'item.completed', item: { type: 'agent_message', text: content } }
          : { role: 'assistant', content }
      const withFiles = (count: number, last = '') => ({
        ...expectedResult,
        files_changed: [
          ...Array.from({ length: count }, (_, n) => `wp-content/plugins/shop/includes/f${n}.php`),
          ...(last ? [last] : []),
        ],
      })
      // The schema alone would admit 500 paths; one `message` event holds far fewer of them.
      let count = 0
      while (JSON.stringify(withFiles(count + 1)).length < agentOutputLimits.messageText) count++
      const room = agentOutputLimits.messageText - JSON.stringify(withFiles(count, 'x')).length
      const fits = withFiles(count, 'x'.repeat(room + 1))
      expect(count).toBeLessThan(agentOutputLimits.filesChanged)
      expect(JSON.stringify(fits)).toHaveLength(agentOutputLimits.messageText)
      expect(RESULT_SIZE_NOTE).toContain(`${agentOutputLimits.messageText} characters`)
      expect(driver.extractResult(parse(driver, asLine(JSON.stringify(fits))), null)).toEqual(fits)
      const over = withFiles(count, 'x'.repeat(room + 2))
      expect(turnResultSchema.safeParse(over).success).toBe(true)
      expect(driver.extractResult(parse(driver, asLine(JSON.stringify(over))), null)).toBeNull()
    },
  )

  it('bounds fan-out and rejects traversal and overlong file paths without truncating paths', () => {
    const changes = Array.from({ length: MAX_EVENTS_PER_LINE + 10 }, (_, n) => ({
      path: `f${n}`,
      kind: 'add',
    }))
    expect(
      parse(codex, {
        type: 'item.completed',
        item: { type: 'file_change', status: 'completed', changes },
      }),
    ).toHaveLength(MAX_EVENTS_PER_LINE)
    for (const path of [
      '../auth.json',
      '/etc/passwd',
      'a/../../key',
      'a\\b',
      'x\u0000y',
      'x'.repeat(agentOutputLimits.path + 1),
    ]) {
      expect(
        parse(codex, {
          type: 'item.completed',
          item: { type: 'file_change', status: 'completed', changes: [{ path, kind: 'add' }] },
        }),
      ).toEqual([])
    }
    expect(
      parse(codex, {
        type: 'item.completed',
        item: {
          type: 'file_change',
          status: 'failed',
          changes: [{ path: 'index.html', kind: 'update' }],
        },
      }),
    ).toEqual([])
  })

  it('rejects invalid token counts and ignores agent-supplied monetary cost', () => {
    for (const input of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
      const result = parse(codex, {
        type: 'turn.completed',
        usage: { input_tokens: input, output_tokens: 2, cached_input_tokens: 0 },
      })
      expect(result).not.toContainEqual(expect.objectContaining({ type: 'usage' }))
    }
    expect(
      parse(codex, {
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 4, output_tokens: 2 },
      }),
    ).toEqual([{ type: 'completed' }])
    expect(
      parse(opencode, {
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost: 1000000,
          tokens: {
            input: 1,
            output: Number.MAX_SAFE_INTEGER,
            reasoning: 1,
            cache: { read: 0, write: 0 },
          },
        },
      }),
    ).toEqual([{ type: 'completed' }])
  })

  it('normalizes fatal failures but ignores reasoning, retry notices and subagent results', () => {
    expect(parse(codex, { type: 'turn.failed', error: { message: 'failed' } })).toEqual([
      { type: 'failed', reason: 'failed' },
    ])
    expect(
      parse(codex, {
        type: 'item.completed',
        item: { type: 'error', message: 'retryable item error' },
      }),
    ).toEqual([])
    // A top-level error is also how the CLI reports a reconnect; only turn.failed is terminal.
    expect(parse(codex, { type: 'error', message: 'Reconnecting... 1/5 (stream closed)' })).toEqual(
      [],
    )
    expect(parse(codex, { type: 'error' })).toEqual([])
    expect(
      parse(qwen, {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: { message: 'failed' },
      }),
    ).toEqual([{ type: 'failed', reason: 'failed' }])
    expect(
      parse(opencode, {
        type: 'error',
        error: { name: 'APIError', data: { message: 'failed', apiKey: 'secret-marker' } },
      }),
    ).toEqual([{ type: 'failed', reason: 'failed' }])
    expect(
      parse(qwen, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: finalText,
        parent_tool_use_id: 'subagent-call',
      }),
    ).toEqual([])
    expect(
      parse(qwen, {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { text: 'partial' } },
      }),
    ).toEqual([])
    expect(parse(kimi, { role: 'tool', tool_call_id: 'call_1', content: 'secret-marker' })).toEqual(
      [],
    )
  })

  it('fails closed on terminal errors without a usable reason', () => {
    const fallback = [{ type: 'failed', reason: 'Агент не смог завершить действие.' }]
    const samples: [AgentDriver, unknown][] = [
      [codex, { type: 'turn.failed', error: {} }],
      [codex, { type: 'turn.failed', error: { message: '' } }],
      [codex, { type: 'turn.failed' }],
      [qwen, { type: 'result', subtype: 'error', is_error: true, error: { message: 42 } }],
      [qwen, { type: 'result', subtype: 'error', is_error: true, error: 'text' }],
      [opencode, { type: 'error' }],
      [opencode, { type: 'error', error: { data: { message: {} } } }],
    ]
    for (const [driver, sample] of samples) expect(parse(driver, sample)).toEqual(fallback)
    expect(parse(codex, { type: 'item.completed', item: { type: 'error', message: 42 } })).toEqual(
      [],
    )
  })

  // Lines printed by the pinned Codex 0.158.0 when the provider stream is cut mid-response.
  const reconnect = (attempt: number) => ({
    type: 'error',
    message: `Reconnecting... ${attempt}/5 (stream disconnected before completion: Transport error: network error: error decoding response body)`,
  })
  const disconnected =
    'stream disconnected before completion: Transport error: network error: error decoding response body'

  it('keeps a Codex turn that reconnected and then completed', () => {
    const events = [
      { type: 'thread.started', thread_id: sid },
      { type: 'turn.started' },
      reconnect(1),
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: finalText } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: 12,
          reasoning_output_tokens: 3,
        },
      },
    ].flatMap((row) => parse(codex, row))
    expect(events.map((event) => event.type)).toEqual(['started', 'message', 'usage', 'completed'])
    expect(codex.extractResult(events, null)).toEqual(expectedResult)
  })

  it('fails a Codex turn once, by turn.failed, when every reconnect is exhausted', () => {
    const events = [
      { type: 'thread.started', thread_id: sid },
      { type: 'turn.started' },
      ...[1, 2, 3, 4, 5].map(reconnect),
      { type: 'error', message: disconnected },
      { type: 'turn.failed', error: { message: disconnected } },
    ].flatMap((row) => parse(codex, row))
    expect(events).toEqual([
      { type: 'started', nativeSessionId: sid },
      { type: 'failed', reason: disconnected },
    ])
    expect(codex.extractResult(events, null)).toBeNull()
  })

  it('never lets unknown native ids become snapshot path traversal', () => {
    for (const id of ['../secret', '/root', 'a/b', 'a\\b', '.', '..', 'x'.repeat(201)]) {
      expect(parse(codex, { type: 'thread.started', thread_id: id })).toEqual([])
      expect(parse(kimi, { role: 'meta', type: 'session.resume_hint', session_id: id })).toEqual([])
      expect(parse(qwen, { type: 'system', subtype: 'init', session_id: id })).toEqual([])
      expect(parse(opencode, { type: 'step_start', sessionID: id })).toEqual([])
    }
  })

  it('does not coerce hostile status objects or numeric counters', () => {
    const hostile = { toString: null, valueOf: null }
    const samples: [AgentDriver, unknown][] = [
      [
        codex,
        {
          type: 'item.completed',
          item: { type: 'command_execution', command: 'pwd', status: hostile, exit_code: 0 },
        },
      ],
      [
        codex,
        {
          type: 'item.completed',
          item: { type: 'mcp_tool_call', tool: 'get_page', status: hostile },
        },
      ],
      [
        opencode,
        { type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: hostile } } },
      ],
      [
        opencode,
        {
          type: 'step_finish',
          part: { type: 'step-finish', reason: hostile, tokens: { input: hostile } },
        },
      ],
    ]
    for (const [driver, sample] of samples) expect(parse(driver, sample)).toEqual([])
  })
})
