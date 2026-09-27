import { describe, expect, it } from 'vitest'
import {
  agentEventSchema,
  agentOutputLimits,
  preparedRunExposesSecret,
  preparedRunLimits,
  preparedFilesSchema,
  preparedRunSchema,
  turnCredentials,
  turnResultSchema,
  type PreparedRun,
} from './agent-driver.ts'
import { SANDBOX_SECRETS_DIR, SANDBOX_SECRETS_TMPFS_BYTES } from './sandbox-provider.ts'

describe('turnResultSchema', () => {
  it('accepts the example from spec §8', () => {
    const example = {
      summary: 'Добавил блок отзывов на главную',
      change_type: 'code',
      client_message: 'На главной появится блок «Отзывы» с тремя карточками.',
      files_changed: ['wp-content/themes/shop/front-page.php'],
      questions: [],
      needs_approval: true,
      risk: 'low',
    }
    expect(turnResultSchema.parse(example)).toEqual(example)
  })

  it('rejects an unknown change type and extra fields', () => {
    const base = {
      summary: 's',
      change_type: 'code',
      client_message: 'm',
      files_changed: [],
      questions: [],
      needs_approval: false,
      risk: 'low',
    }
    expect(turnResultSchema.safeParse({ ...base, change_type: 'deploy' }).success).toBe(false)
    expect(turnResultSchema.safeParse({ ...base, secret: 'x' }).success).toBe(false)
  })

  it('rejects an empty client message', () => {
    const result = turnResultSchema.safeParse({
      summary: 's',
      change_type: 'none',
      client_message: '',
      files_changed: [],
      questions: [],
      needs_approval: false,
      risk: 'low',
    })
    expect(result.success).toBe(false)
  })
})

describe('agentEventSchema', () => {
  it('covers exactly the nine common event types of CLAUDE.md rule 8', () => {
    const types = agentEventSchema.options.map((o) => o.shape.type.value)
    expect(types.sort()).toEqual(
      [
        'command',
        'completed',
        'failed',
        'file_change',
        'message',
        'question',
        'started',
        'tool_call',
        'usage',
      ].sort(),
    )
  })

  it('validates usage token counts', () => {
    const ok = agentEventSchema.safeParse({
      type: 'usage',
      usage: { inputUncached: 10, cacheRead: 5, cacheWrite: 0, output: 7, reasoning: 2 },
    })
    const negative = agentEventSchema.safeParse({
      type: 'usage',
      usage: { inputUncached: -1, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    })
    expect(ok.success).toBe(true)
    expect(negative.success).toBe(false)
  })
})

describe('limits on untrusted agent output', () => {
  const long = (n: number) => 'x'.repeat(n)
  const base = {
    summary: 's',
    change_type: 'code',
    client_message: 'm',
    files_changed: [],
    questions: [],
    needs_approval: false,
    risk: 'low',
  }
  const result = (patch: Record<string, unknown>) =>
    turnResultSchema.safeParse({ ...base, ...patch }).success

  it('bounds every string and array of the turn result', () => {
    expect(result({ summary: long(500) })).toBe(true)
    expect(result({ summary: long(501) })).toBe(false)
    expect(result({ client_message: long(2000) })).toBe(true)
    expect(result({ client_message: long(2001) })).toBe(false)
    expect(result({ files_changed: Array.from({ length: 500 }, (_, i) => `f${i}.php`) })).toBe(true)
    expect(result({ files_changed: Array.from({ length: 501 }, (_, i) => `f${i}.php`) })).toBe(
      false,
    )
    expect(result({ files_changed: [long(1024)] })).toBe(true)
    expect(result({ files_changed: [long(1025)] })).toBe(false)
    expect(result({ files_changed: [''] })).toBe(false)
    expect(result({ questions: ['q1', 'q2', 'q3', 'q4', 'q5'] })).toBe(true)
    expect(result({ questions: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] })).toBe(false)
    expect(result({ questions: [long(501)] })).toBe(false)
  })

  it.each([
    { type: 'started', nativeSessionId: long(201) },
    { type: 'message', text: long(20_001) },
    { type: 'command', command: long(10_001), exitCode: 0 },
    { type: 'file_change', path: long(1025), change: 'update' },
    { type: 'tool_call', tool: long(201), ok: true },
    { type: 'question', text: long(1001), options: [] },
    { type: 'question', text: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] },
    { type: 'question', text: 'q', options: [long(201)] },
    { type: 'failed', reason: long(2001) },
  ])('rejects an over-limit $type event', (event) => {
    expect(agentEventSchema.safeParse(event).success).toBe(false)
  })

  it.each([
    { type: 'started', nativeSessionId: long(200) },
    { type: 'message', text: long(20_000) },
    { type: 'command', command: long(10_000), exitCode: null },
    { type: 'file_change', path: long(1024), change: 'add' },
    { type: 'tool_call', tool: long(200), ok: false },
    { type: 'question', text: long(1000), options: Array.from({ length: 6 }, () => long(200)) },
    { type: 'failed', reason: long(2000) },
  ])('accepts a $type event at the limit', (event) => {
    expect(agentEventSchema.safeParse(event).success).toBe(true)
  })

  it.each(['thread.1', 'ses:1', '../escape', '-flag', ''])(
    'rejects a started event with native session id %j that is unsafe in snapshot paths',
    (nativeSessionId) => {
      expect(agentEventSchema.safeParse({ type: 'started', nativeSessionId }).success).toBe(false)
    },
  )

  it('exposes the limits for drivers that truncate before validation', () => {
    expect(agentOutputLimits).toMatchObject({ clientMessage: 2000, messageText: 20_000 })
    expect(Object.isFrozen(agentOutputLimits)).toBe(true)
  })
})

describe('prepared run credentials', () => {
  const context = {
    taskId: 't',
    sessionId: 's',
    turn: 1,
    llm: { baseUrl: 'http://gw.sandbox/llm', apiKey: 'llm-virtual-key', model: 'm' },
    mcp: { url: 'http://gw.sandbox/mcp', token: 'mcp-turn-token' },
    instructions: '',
  }
  const run = (overrides: Partial<PreparedRun> = {}): PreparedRun => ({
    context,
    files: [{ path: '/agent-home/codex/config.toml', content: 'model = "m"' }],
    env: { CODEX_HOME: '/agent-home/codex' },
    secrets: [{ path: `${SANDBOX_SECRETS_DIR}/extra`, content: 'extra-secret-value' }],
    ...overrides,
  })
  const credentials = (prepared: PreparedRun) => turnCredentials(context, prepared.secrets)

  it('lists the LLM key, the MCP token and every secret file, skipping empty values', () => {
    expect(credentials(run())).toEqual(['llm-virtual-key', 'mcp-turn-token', 'extra-secret-value'])
    expect(turnCredentials({ ...context, mcp: { url: 'u', token: '' } }, [])).toEqual([
      'llm-virtual-key',
    ])
  })

  it('accepts files and env that only point at the secrets tmpfs', () => {
    const prepared = run({ env: { LLM_KEY_FILE: `${SANDBOX_SECRETS_DIR}/llm` } })
    expect(preparedRunExposesSecret(prepared, credentials(prepared))).toBe(false)
  })

  it.each([
    [
      'a config file with the LLM key',
      { files: [{ path: '/agent-home/c', content: 'key = "llm-virtual-key"' }] },
    ],
    [
      'a config file with the MCP token',
      { files: [{ path: '/agent-home/c', content: 'Bearer mcp-turn-token' }] },
    ],
    [
      'a config file with a secret file value',
      { files: [{ path: '/agent-home/c', content: 'x=extra-secret-value' }] },
    ],
    ['an env value with the LLM key', { env: { OPENAI_BASE: 'llm-virtual-key' } }],
    ['an env value with the MCP token', { env: { MCP_HEADERS: 'Authorization: mcp-turn-token' } }],
  ] satisfies Array<[string, Partial<PreparedRun>]>)('refuses %s', (_, overrides) => {
    const prepared = run(overrides)
    expect(preparedRunExposesSecret(prepared, credentials(prepared))).toBe(true)
  })

  it('refuses a command argument with a turn credential: argv is visible to process listings', () => {
    const prepared = run()
    const argv = (value: string) => ['codex', 'exec', `--header=Authorization: ${value}`]
    expect(preparedRunExposesSecret(prepared, credentials(prepared), argv('file'))).toBe(false)
    for (const value of credentials(prepared))
      expect(preparedRunExposesSecret(prepared, credentials(prepared), argv(value))).toBe(true)
  })

  it('keeps prepared secrets within the secrets tmpfs, counted in whole pages', () => {
    expect(preparedRunLimits.secretBytes).toBeLessThanOrEqual(SANDBOX_SECRETS_TMPFS_BYTES)
    const fits = (count: number, bytes: number) =>
      preparedRunSchema.safeParse(
        run({
          files: [],
          secrets: Array.from({ length: count }, (_, i) => ({
            path: `${SANDBOX_SECRETS_DIR}/s${i}`,
            content: 'x'.repeat(bytes),
          })),
        }),
      ).success
    expect(fits(1, SANDBOX_SECRETS_TMPFS_BYTES)).toBe(true)
    expect(fits(1, SANDBOX_SECRETS_TMPFS_BYTES + 1)).toBe(false)
    // 170 and 200 files of three pages each: 1.6 MB of content alone would still pass.
    expect(fits(170, 2 * 4096 + 1)).toBe(true)
    expect(fits(200, 2 * 4096 + 1)).toBe(false)
  })
})

describe('preparedFilesSchema', () => {
  it('applies the prepared run rules without the run context', () => {
    const files = {
      files: [{ path: '/agent-home/codex/config.toml', content: 'model = "m"' }],
      env: { CODEX_HOME: '/agent-home/codex' },
      secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'key' }],
    }
    expect(preparedFilesSchema.parse(files)).toEqual(files)
    for (const invalid of [
      { ...files, context: {} },
      { ...files, files: [{ path: '/workspace/repo/AGENTS.md', content: 'x' }] },
      {
        ...files,
        secrets: [...files.secrets, { path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'y' }],
      },
      {
        ...files,
        secrets: [
          {
            path: `${SANDBOX_SECRETS_DIR}/big`,
            content: 'x'.repeat(SANDBOX_SECRETS_TMPFS_BYTES + 1),
          },
        ],
      },
    ])
      expect(preparedFilesSchema.safeParse(invalid).success).toBe(false)
  })
})
