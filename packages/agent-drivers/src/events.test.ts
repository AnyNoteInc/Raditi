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
      { type: 'tool_call', tool: 'write', ok: true },
      { type: 'file_change', path: 'index.html', change: 'update' },
      { type: 'tool_call', tool: 'site_info', ok: true },
      {
        type: 'usage',
        usage: { inputUncached: 50, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5 },
      },
      { type: 'started', nativeSessionId: 'ses_test' },
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

  // What a finished turn's output looks like around its messages. OpenCode prints no
  // end-of-turn row, so its driver also requires the output to end with an answer step.
  const turn = (...messages: string[]): AgentEvent[] =>
    driver.id === 'opencode'
      ? [
          { type: 'started', nativeSessionId: 'ses_test' },
          ...messages.map((text): AgentEvent => ({ type: 'message', text })),
          { type: 'completed' },
        ]
      : messages.map((text): AgentEvent => ({ type: 'message', text }))

  it('accepts only the current, valid final JSON object, optionally in one code fence', () => {
    expect(driver.extractResult(turn(''), finalText)).toEqual(expectedResult)
    expect(driver.extractResult(turn(''), `\`\`\`json\n${finalText}\n\`\`\``)).toEqual(
      expectedResult,
    )
    expect(driver.extractResult(turn(finalText), null)).toEqual(expectedResult)
    expect(driver.extractResult(turn(finalText), 'broken final')).toBeNull()
    expect(driver.extractResult(turn(finalText, 'broken final'), null)).toBeNull()
    expect(
      driver.extractResult([...turn(''), { type: 'failed', reason: 'failed' }], finalText),
    ).toBeNull()
    // A failure reported before a complete answer is a failure of the turn all the same.
    expect(
      driver.extractResult([{ type: 'failed', reason: 'failed' }, ...turn(finalText)], null),
    ).toBeNull()
    for (const value of [
      '[]',
      '{}',
      finalText + finalText,
      `prefix ${finalText}`,
      '{"__proto__":{}}',
      'x'.repeat(MAX_JSONL_BYTES + 1),
    ]) {
      expect(driver.extractResult(turn(''), value)).toBeNull()
    }
    expect(
      driver.extractResult(turn(''), JSON.stringify({ ...expectedResult, risk: 'impossible' })),
    ).toBeNull()
    expect(
      driver.extractResult(
        turn(''),
        JSON.stringify({ ...expectedResult, secret: 'must not pass' }),
      ),
    ).toBeNull()
  })
})

describe('OpenCode 1.18.34 turns recorded by the G1 spike', () => {
  const turns = JSON.parse(
    readFileSync(new URL('./fixtures/opencode-turns.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown[]>
  const eventsOf = (name: string) => turns[name]!.flatMap((row) => parse(opencode, row))
  const types = (name: string) => eventsOf(name).map((event) => event.type)
  const failures = (name: string) =>
    eventsOf(name).flatMap((event) => (event.type === 'failed' ? [event.reason] : []))
  const session = (id: number) => `ses_${String(id).padStart(26, '0')}`
  const step = (text?: string): AgentEvent[] => [
    { type: 'started', nativeSessionId: 'ses_test' },
    ...(text === undefined ? [] : [{ type: 'message', text } as const]),
    { type: 'completed' },
  ]

  it('does not take the stop of a context compaction for the end of the turn', () => {
    const events = eventsOf('compaction')
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'tool_call',
      'command',
      'usage',
      // The compaction request: its summary, then the stop of that step.
      'started',
      'message',
      'usage',
      'completed',
      // The CLI's own «Continue if you have next steps…», outside any step.
      'message',
      'started',
      'message',
      'usage',
      'completed',
    ])
    expect(turnResultSchema.safeParse(opencode.extractResult(events, null)).success).toBe(true)
    // Cut after the compaction: neither its summary nor the CLI's own line is a result, and
    // once the CLI's line or a new step followed, no text of that output is.
    for (const cut of [8, 9, 10])
      expect(opencode.extractResult(events.slice(0, cut), null)).toBe(null)
    for (const cut of [9, 10])
      expect(opencode.extractResult(events.slice(0, cut), finalText)).toBeNull()
  })

  it('refuses a run that exits 0 without a final answer step', () => {
    // A rejected permission request ends the run after a tool-calls step, exit code 0.
    const rejected = eventsOf('permission-request-rejected')
    expect(rejected).toEqual([
      { type: 'started', nativeSessionId: session(422) },
      { type: 'tool_call', tool: 'bash', ok: false },
      { type: 'command', command: 'echo denied-marker', exitCode: null },
      expect.objectContaining({ type: 'usage' }),
    ])
    expect(opencode.extractResult(rejected, null)).toBeNull()
    // An earlier answer does not count once another step followed it.
    expect(opencode.extractResult([...step(finalText), ...rejected], null)).toBeNull()
    expect(opencode.extractResult([...step(finalText), ...rejected], finalText)).toBeNull()
    // A stop step without its own text, an answer outside a step, no step at all.
    expect(opencode.extractResult([...step(finalText), ...step()], null)).toBeNull()
    expect(opencode.extractResult([...step(), { type: 'message', text: finalText }], null)).toBe(
      null,
    )
    expect(opencode.extractResult([{ type: 'message', text: finalText }], null)).toBeNull()
    expect(opencode.extractResult([], finalText)).toBeNull()
    expect(opencode.extractResult(step(finalText), null)).toEqual(expectedResult)
  })

  it('takes no result from a turn that went on to an answer step after an error', () => {
    // What the CLI printed after a refused request it read as a context overflow (measured on
    // 1.18.34): the error, a compaction step, and one more step with a complete answer; the
    // process exits with code 1.
    const overflow = eventsOf('context-overflow').filter((event) => event.type === 'failed')
    expect(overflow).not.toHaveLength(0)
    const events = [...overflow.slice(0, 1), ...step('Summary of the session.'), ...step(finalText)]
    expect(opencode.extractResult(events, null)).toBeNull()
    expect(opencode.extractResult(events, finalText)).toBeNull()
    // The same two steps without the error are a turn with its result.
    expect(opencode.extractResult(events.slice(1), null)).toEqual(expectedResult)
  })

  it('names the kind, the status and the gateway code of a refusal, never the address', () => {
    expect(failures('refusal-http-403')).toEqual([
      'APIError 403 raditi_budget: The budget of this turn is spent.',
    ])
    expect(failures('refusal-in-stream')).toEqual([
      'UnknownError raditi_budget: The budget of this turn is spent.',
    ])
    expect(types('refusal-after-tool')).toEqual([
      'started',
      'tool_call',
      'command',
      'usage',
      'started',
      'failed',
    ])
    expect(failures('retry-exhausted')).toEqual(['APIError 503 raditi_busy: The gateway is busy.'])
    expect(failures('context-overflow')).toEqual([
      'ContextOverflowError raditi_policy: The request has too many tokens for this turn.',
      'ContextOverflowError raditi_policy: The request has too many tokens for this turn.',
    ])
    for (const name of Object.keys(turns))
      expect(JSON.stringify(eventsOf(name))).not.toMatch(/sandbox-gw|responseBody|metadata/)
  })

  it('fails a turn whose step ends with content-filter, length or an unknown reason', () => {
    expect(types('finish-content-filter')).toEqual([
      'started',
      'message',
      'usage',
      'failed',
      'failed',
    ])
    expect(failures('finish-content-filter')).toEqual([
      'OpenCode step ended with reason content-filter',
      "ContentFilterError: The response was blocked by the provider's content filter",
    ])
    expect(types('finish-length')).toEqual(['started', 'message', 'usage', 'failed'])
    expect(failures('finish-length')).toEqual(['OpenCode step ended with reason length'])
    // What the CLI prints, over and over, for a stream without a known finish reason.
    expect(failures('finish-unknown')).toEqual([
      'OpenCode step ended with reason unknown',
      'OpenCode step ended with reason unknown',
    ])
    for (const name of ['finish-content-filter', 'finish-length', 'finish-unknown'])
      expect(opencode.extractResult(eventsOf(name), finalText)).toBeNull()
    for (const reason of ['error', 'other', 'future-reason'])
      expect(
        parse(opencode, { type: 'step_finish', part: { type: 'step-finish', reason } }),
      ).toEqual([{ type: 'failed', reason: `OpenCode step ended with reason ${reason}` }])
    // Only a short lower-case word is quoted; anything else is CLI text nobody asked for.
    expect(
      parse(opencode, {
        type: 'step_finish',
        part: { type: 'step-finish', reason: 'Bearer secret-marker\n' },
      }),
    ).toEqual([{ type: 'failed', reason: 'OpenCode step ended with an unexpected reason' }])
    expect(
      parse(opencode, { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } }),
    ).toEqual([])
  })

  it('reports written and edited files of the working copy, and a tool the CLI did not have', () => {
    const tool = (name: string, state: Record<string, unknown>) =>
      parse(opencode, { type: 'tool_use', part: { type: 'tool', tool: name, state } })
    expect(
      tool('write', {
        status: 'completed',
        input: { filePath: '/workspace/repo/wp-content/new.php', content: 'private' },
        metadata: { filepath: '/workspace/repo/wp-content/new.php', exists: false },
      }),
    ).toEqual([
      { type: 'tool_call', tool: 'write', ok: true },
      { type: 'file_change', path: 'wp-content/new.php', change: 'add' },
    ])
    expect(
      tool('edit', {
        status: 'completed',
        input: { filePath: '/workspace/repo/index.php', oldString: 'a', newString: 'b' },
        metadata: { diff: 'private diff', filediff: { file: '/workspace/repo/index.php' } },
      }),
    ).toEqual([
      { type: 'tool_call', tool: 'edit', ok: true },
      { type: 'file_change', path: 'index.php', change: 'update' },
    ])
    // A refused or failed write changed nothing; a file outside the working copy is not a change
    // of the site.
    expect(
      tool('write', { status: 'error', input: { filePath: '/workspace/repo/a.txt' }, error: 'x' }),
    ).toEqual([{ type: 'tool_call', tool: 'write', ok: false }])
    for (const filePath of [
      '/workspace/inbox/a.txt',
      '/etc/passwd',
      '/workspace/repo/../inbox/a.txt',
      '/workspace/repo/a\nb',
      '/workspace/repo/',
      42,
    ])
      expect(tool('write', { status: 'completed', input: { filePath }, metadata: {} })).toEqual([
        { type: 'tool_call', tool: 'write', ok: true },
      ])
    expect(
      tool('invalid', {
        status: 'completed',
        input: { tool: 'webfetch', error: "Model tried to call unavailable tool 'webfetch'." },
        output: 'The arguments provided to the tool are invalid',
      }),
    ).toEqual([{ type: 'tool_call', tool: 'webfetch', ok: false }])
    expect(tool('invalid', { status: 'completed', input: {} })).toEqual([
      { type: 'tool_call', tool: 'invalid', ok: false },
    ])
  })

  it('names a tool of the platform MCP server by its own name, as the other drivers do', () => {
    const tool = (name: string, state: Record<string, unknown> = { status: 'completed' }) =>
      parse(opencode, { type: 'tool_use', part: { type: 'tool', tool: name, state } })
    // The pinned CLI names a tool of an MCP server `<server>_<tool>`; the server is the driver's.
    expect(tool('raditi_wp_rest')).toEqual([{ type: 'tool_call', tool: 'wp_rest', ok: true }])
    expect(tool('raditi_wp_rest', { status: 'error', error: 'private' })).toEqual([
      { type: 'tool_call', tool: 'wp_rest', ok: false },
    ])
    // Once: what follows the prefix is the tool's name, whatever it looks like.
    expect(tool('raditi_raditi_x')).toEqual([{ type: 'tool_call', tool: 'raditi_x', ok: true }])
    // A tool of the CLI itself, and a name that only begins with the same letters.
    for (const name of ['bash', 'read', 'raditixyz', 'raditi', 'raditi_', 'Raditi_wp_rest'])
      expect(tool(name)).toEqual([{ type: 'tool_call', tool: name, ok: true }])
    expect(tool('xraditi_wp_rest')).toEqual([
      { type: 'tool_call', tool: 'xraditi_wp_rest', ok: true },
    ])
    // A platform tool called like a tool of the CLI is no command and no change of a file.
    expect(
      tool('raditi_bash', {
        status: 'completed',
        input: { command: 'pwd' },
        metadata: { exit: 0 },
      }),
    ).toEqual([{ type: 'tool_call', tool: 'bash', ok: true }])
    expect(
      tool('raditi_write', {
        status: 'completed',
        input: { filePath: '/workspace/repo/a.txt' },
        metadata: { exists: false },
      }),
    ).toEqual([{ type: 'tool_call', tool: 'write', ok: true }])
    // The name the model wrote for a call the CLI refused is read the same way.
    expect(
      tool('invalid', { status: 'completed', input: { tool: 'raditi_wp_rest', error: 'x' } }),
    ).toEqual([{ type: 'tool_call', tool: 'wp_rest', ok: false }])
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
    ).toEqual([{ type: 'failed', reason: 'APIError: failed' }])
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
