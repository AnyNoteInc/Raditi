import {
  envVarLimits,
  envVarValueSchema,
  preparedFilesSchema,
  SANDBOX_AGENT_HOME,
  SANDBOX_INBOX,
  SANDBOX_SECRET_CHARS,
  SANDBOX_SECRET_FILES,
  SANDBOX_SECRETS_DIR,
  turnInputSchema,
  turnPlanLimits,
  type AgentDriver,
  type PreparedRun,
  type RunContext,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { envFiles, stageFiles, turnSecrets } from './cli-run.ts'
import { createAgentDrivers } from './registry.ts'

const image = `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`
const context: RunContext = {
  taskId: 'task',
  sessionId: 'session',
  turn: 1,
  llm: {
    baseUrl: 'http://sandbox-gw:8080/zai/v4',
    apiKey: 'synthetic-llm-token',
    model: 'model',
    reasoningEffort: 'high',
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'synthetic-mcp-token' },
  instructions: '',
}

const names = (count: number) =>
  Array.from({ length: count }, (_, index) => `${SANDBOX_INBOX}/${index}.png`)

/** The driver launches exactly when the plan accepts the input, and refuses as a bad request. */
async function agrees(driver: AgentDriver, context: RunContext, attachments: string[]) {
  const input = { prompt: 'p', attachments }
  const run = await driver.prepare(context)
  let launched = true
  try {
    driver.command(run, input)
  } catch (error) {
    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid attachment path' })
    launched = false
  }
  expect(launched).toBe(turnInputSchema.safeParse(input).success)
}

describe.each(createAgentDrivers({ image }))('$id attachments', (driver) => {
  // The plan is validated before the site lease and the turn key, the driver after both: a
  // path the plan accepts must launch, and a path it refuses must never reach the CLI.
  it.each([
    ['a plain name', `${SANDBOX_INBOX}/a.png`],
    ['spaces, a comma and Cyrillic', `${SANDBOX_INBOX}/Фото 1, 2.png`],
    ['a parent segment', `${SANDBOX_INBOX}/../x`],
    ['a backslash', `${SANDBOX_INBOX}/a\\b`],
    ['a control character', `${SANDBOX_INBOX}/a\u0007`],
    ['an empty segment', `${SANDBOX_INBOX}//x`],
    ['the longest path of the plan', `${SANDBOX_INBOX}/`.padEnd(1024, 'x')],
    ['one character more', `${SANDBOX_INBOX}/`.padEnd(1025, 'x')],
  ])('agrees with the turn plan about %s', (_name, path) => agrees(driver, context, [path]))

  // The plan bounds the list as well as each path in it.
  it.each<[string, unknown]>([
    ['no attachments', []],
    ['the longest list of the plan', names(turnPlanLimits.attachments)],
    ['one attachment more', names(turnPlanLimits.attachments + 1)],
    ['a refused path after an accepted one', [...names(1), `${SANDBOX_INBOX}/../x`]],
    ['a list with a hole', Object.assign(names(1), { length: 2 })],
    ['an entry that is not text', [7]],
    ['a value that is not a list', `${SANDBOX_INBOX}/a.png`],
  ])('agrees with the turn plan about %s', (_name, attachments) =>
    agrees(driver, context, attachments as string[]),
  )
})

/** The driver refuses the context as a bad request, and its message holds none of the value. */
async function refuses(driver: AgentDriver, context: RunContext) {
  const error: unknown = await driver.prepare(context).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toMatchObject({ code: 'BAD_REQUEST' })
  expect((error as Error).message).not.toContain('leaked')
}

describe.each(createAgentDrivers({ image }))('$id run context', (driver) => {
  // The plan refuses such an address before the driver; the driver is the second line.
  const addresses = [
    ['credentials', 'https://user:leaked@other.example/zai/v4'],
    ['another scheme', 'file:///leaked'],
    ['a query', 'http://sandbox-gw:8080/zai/v4?key=leaked'],
    ['a fragment', 'http://sandbox-gw:8080/zai/v4#leaked'],
  ]
  it.each(addresses)('refuses a gateway address with %s', (_name, baseUrl) =>
    refuses(driver, { ...context, llm: { ...context.llm, baseUrl } }),
  )
  it.each(addresses)('refuses an MCP address with %s', (_name, url) =>
    refuses(driver, { ...context, mcp: { ...context.mcp, url } }),
  )

  // Each credential goes into a file of its own and from there into the CLI's configuration:
  // only one line of printable ASCII is a value the driver can hand over whole.
  const credentials = [
    ['a newline', 'leaked\nheader'],
    ['a space', 'leaked header'],
  ]
  it.each(credentials)('refuses a turn key with %s', (_name, apiKey) =>
    refuses(driver, { ...context, llm: { ...context.llm, apiKey } }),
  )
  it.each(credentials)('refuses an MCP token with %s', (_name, token) =>
    refuses(driver, { ...context, mcp: { ...context.mcp, token } }),
  )

  it('refuses a native session id that is not a safe name', () =>
    refuses(driver, { ...context, nativeSessionId: '../leaked' }))
})

describe('per-turn files of a CLI run', () => {
  it('carries the two turn credentials only as read-only files of the secrets tmpfs', () => {
    expect(turnSecrets(context)).toEqual([
      { path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'synthetic-llm-token', mode: 0o400 },
      { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: 'synthetic-mcp-token', mode: 0o400 },
    ])
  })

  it("carries the client's variables as NUL-separated pairs, names in order", () => {
    const envValues = { PAYMENT_KEY: 'pay-secret-0001', HOOK_TOKEN: 'line one\nline "two"' }
    expect(turnSecrets({ ...context, envValues }).slice(2)).toEqual([
      {
        path: `${SANDBOX_SECRETS_DIR}/env.0`,
        content: 'HOOK_TOKEN\0line one\nline "two"\0PAYMENT_KEY\0pay-secret-0001\0',
        mode: 0o400,
      },
    ])
    expect(envFiles({})).toEqual([])
  })

  it('fits every set of variables a site may have into the secrets of one sandbox', () => {
    // As much of what JSON or a shell script would escape as 8 KiB of text holds.
    const value = (index: number) => {
      let text = `${index}:`
      for (const unit of ["'", '\\', '\n', '\u0001', '$', '"', 'ж', '😀']) {
        while (Buffer.byteLength(text + unit) <= envVarLimits.valueMaxBytes) text += unit
      }
      return text
    }
    const envValues = Object.fromEntries(
      Array.from({ length: envVarLimits.perSite }, (_, index) => [`VAR_${index}`, value(index)]),
    )
    for (const text of Object.values(envValues))
      expect(envVarValueSchema.safeParse(text).success).toBe(true)
    const secrets = turnSecrets({ ...context, envValues })
    expect(secrets.length).toBeLessThanOrEqual(SANDBOX_SECRET_FILES)
    for (const secret of secrets)
      expect(secret.content.length).toBeLessThanOrEqual(SANDBOX_SECRET_CHARS)
    // Within the tmpfs, as the runner and the local executor check it.
    expect(preparedFilesSchema.safeParse({ files: [], env: {}, secrets }).success).toBe(true)
    // Read back as the launch wrapper does: every pair, in order.
    const pairs = secrets
      .slice(2)
      .flatMap((secret) => secret.content.split('\0').slice(0, -1))
      .reduce<[string, string][]>(
        (all, part, index, parts) => (index % 2 ? all : [...all, [part, parts[index + 1]!]]),
        [],
      )
    expect(Object.fromEntries(pairs)).toEqual(envValues)
    expect(pairs.map(([name]) => name)).toEqual(Object.keys(envValues).sort())
  })

  it('refuses more variables than the secrets of a sandbox hold, and a value it cannot carry', () => {
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`VAR_${index}`, 'x'.repeat(8000)]),
    )
    expect(() => envFiles(many)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    expect(() => envFiles({ SHORT_ONE: 'short' })).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })

  it('replaces a staged file in place and appends a new one', () => {
    const file = (name: string, content: string) => ({
      path: `${SANDBOX_AGENT_HOME}/opencode/${name}`,
      content,
      mode: 0o600,
    })
    const run: PreparedRun = {
      context,
      files: [file('opencode.json', 'config'), file('prompt.txt', 'first'), file('run.mjs', 'run')],
      env: {},
      secrets: [],
    }
    stageFiles(run, [file('prompt.txt', 'second'), file('cli-args.json', '[]')])
    expect(run.files).toEqual([
      file('opencode.json', 'config'),
      file('prompt.txt', 'second'),
      file('run.mjs', 'run'),
      file('cli-args.json', '[]'),
    ])
  })
})
