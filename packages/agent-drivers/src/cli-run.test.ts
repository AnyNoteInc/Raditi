import {
  SANDBOX_AGENT_HOME,
  SANDBOX_INBOX,
  SANDBOX_SECRETS_DIR,
  turnInputSchema,
  turnPlanLimits,
  type AgentDriver,
  type PreparedRun,
  type RunContext,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { stageFiles, turnSecrets } from './cli-run.ts'
import { createCodexDriver } from './codex.ts'
import { createKimiDriver } from './kimi.ts'

const image = `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`
const context = (path: string, reasoningEffort: 'medium' | 'low'): RunContext => ({
  taskId: 'task',
  sessionId: 'session',
  turn: 1,
  llm: {
    baseUrl: `http://sandbox-gw:8080/${path}`,
    apiKey: 'synthetic-llm-token',
    model: 'model',
    reasoningEffort,
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'synthetic-mcp-token' },
  instructions: '',
})

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

describe.each([
  { driver: createCodexDriver({ image }), context: context('codex', 'medium') },
  { driver: createKimiDriver({ image }), context: context('kimi/v1', 'low') },
])('$driver.id attachments', ({ driver, context }) => {
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

describe('per-turn files of a CLI run', () => {
  it('carries the two turn credentials only as read-only files of the secrets tmpfs', () => {
    expect(turnSecrets(context('codex', 'medium'))).toEqual([
      { path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'synthetic-llm-token', mode: 0o400 },
      { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: 'synthetic-mcp-token', mode: 0o400 },
    ])
  })

  it('replaces a staged file in place and appends a new one', () => {
    const file = (name: string, content: string) => ({
      path: `${SANDBOX_AGENT_HOME}/codex/${name}`,
      content,
      mode: 0o600,
    })
    const run: PreparedRun = {
      context: context('codex', 'medium'),
      files: [file('config.toml', 'config'), file('prompt.txt', 'first'), file('run.mjs', 'run')],
      env: {},
      secrets: [],
    }
    stageFiles(run, [file('prompt.txt', 'second'), file('cli-args.json', '[]')])
    expect(run.files).toEqual([
      file('config.toml', 'config'),
      file('prompt.txt', 'second'),
      file('run.mjs', 'run'),
      file('cli-args.json', '[]'),
    ])
  })
})
